import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { childEnvironment, confinedCommand } from '../src/index.ts'
import { BWRAP, BWRAP_REFUSED, CAN_CONFINE, PROBES, type ProbeRun, createdMode, needsBubblewrap, refusal } from './host.ts'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

describe('the suite decides what its environment can do by doing it, the same on the host and inside a run\'s check (T174)', () => {
  it('names why real bubblewrap cannot confine here, and nothing when it can', () => {
    if (CAN_CONFINE) expect(BWRAP_REFUSED).toBeUndefined()
    else expect(BWRAP_REFUSED).toMatch(BWRAP ? / cannot run .+ here/ : /no bwrap on PATH/)
  })

  // The classification itself, apart from this host (T197): each outcome given by a stand-in for bubblewrap.
  describe('classifies a probe run on its own: success, a missing bwrap, a failing bwrap', () => {
    const failing = (stderr: string | undefined, at = 0): ProbeRun => {
      let n = 0
      return () => {
        if (n++ < at) return
        throw Object.assign(new Error('Command failed'), stderr === undefined ? {} : { stderr: Buffer.from(stderr) })
      }
    }

    it('confines when every probe runs: each one\'s command line, ending in true, and nothing named', () => {
      const ran: Array<{ bwrap: string; args: string[] }> = []
      expect(refusal('/usr/bin/bwrap', (bwrap, args) => {
        ran.push({ bwrap, args })
      })).toBeUndefined()
      expect(ran).toEqual(PROBES.map((probe) => ({ bwrap: '/usr/bin/bwrap', args: [...probe.args, '--', 'true'] })))
    })

    it('names a missing bwrap without running anything', () => {
      const ran: string[][] = []
      expect(refusal(undefined, (_bwrap, args) => {
        ran.push(args)
      })).toBe('no bwrap on PATH')
      expect(ran).toEqual([])
    })

    it('names a failing bwrap: the first probe that failed, with the first line bubblewrap said, and runs none after it', () => {
      expect(refusal('/usr/bin/bwrap', failing('bwrap: setting up uid map: Permission denied\nmore'))).toBe(`/usr/bin/bwrap cannot run ${PROBES[0]!.what} here (bwrap: setting up uid map: Permission denied)`)
      expect(refusal('/usr/bin/bwrap', failing('bwrap: No permissions to create new namespace', 1))).toBe(`/usr/bin/bwrap cannot run ${PROBES[1]!.what} here (bwrap: No permissions to create new namespace)`)
      // Said nothing (a timeout, a signal): the probe is still named, with no reason in parentheses.
      expect(refusal('/usr/bin/bwrap', failing(undefined))).toBe(`/usr/bin/bwrap cannot run ${PROBES[0]!.what} here`)
      expect(refusal('/usr/bin/bwrap', failing('  \n'))).toBe(`/usr/bin/bwrap cannot run ${PROBES[0]!.what} here`)
      let calls = 0
      refusal('/usr/bin/bwrap', () => {
        calls += 1
        throw new Error('x')
      })
      expect(calls).toBe(1)
    })
  })

  it('reads the mode a created file gets as the file system gives it: never more than asked, the umask taken off', () => {
    expect(createdMode(0o444) & ~0o444).toBe(0)
    expect(createdMode(0o700) & ~0o700).toBe(0)
    // What the umask takes from one mode it takes from every other.
    expect(createdMode(0o777) & 0o444).toBe(createdMode(0o444))
  })

  describe('inside a check\'s confinement (the host read-only, no network, umask 077)', { timeout: 180_000 }, () => {
    needsBubblewrap()
    // As a check is confined (packages/plugins/agent-workers/src/setup.ts, confineIn): the DSH home hidden, the worktree and Node bound back read-only.
    const confinement = { bwrap: BWRAP ?? 'bwrap', hide: [join(homedir(), '.dsh')], readOnly: [ROOT, realpathSync(process.execPath)], writable: [] }
    const check = (script: string, views: Array<{ source: string; path: string; writable: boolean }> = []) => {
      const c = confinedCommand('sh', ['-c', `umask 077 && ${script}`], confinement, { readOnly: true, network: false, chdir: ROOT, views })
      // A check's environment (the daemon's, scrubbed), with plain output to read; no CI requirement, and none of this run's vitest.
      const env: Record<string, string> = { ...childEnvironment(), NO_COLOR: '1' }
      for (const name of Object.keys(env)) if (name.startsWith('VITEST') || name === 'SYSTEM_REQUIRE_BWRAP' || name === 'FORCE_COLOR') delete env[name]
      return promisify(execFile)(c.command, c.args, { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 })
    }

    it('a file created 0o444 is 0o400 there, and /dev/ptmx leads into /dev/pts', async () => {
      const { stdout } = await check(`${process.execPath} -e "const f = require('node:fs'); const fd = f.openSync('/tmp/m', 'wx', 0o444); console.log((f.fstatSync(fd).mode & 0o777).toString(8))" && readlink -f /dev/ptmx`)
      expect(stdout.split('\n').filter(Boolean)).toEqual(['400', '/dev/pts/ptmx'])
    })

    it('the tests that once failed only there pass there: the Codex launcher\'s command line and the brief\'s file mode', async () => {
      // vitest keeps no results cache here; anything else under node_modules/.vite goes to a private directory, as a check's checkScratch.
      const cache = join(ROOT, 'node_modules', '.vite')
      // vite also bundles the config into node_modules/.vite-temp: a check needs it writable too (checkScratch).
      const temp = join(ROOT, 'node_modules', '.vite-temp')
      mkdirSync(temp, { recursive: true })
      const scratch = mkdtempSync(join(tmpdir(), 'system-host-cache-'))
      const tempScratch = mkdtempSync(join(tmpdir(), 'system-host-vite-temp-'))
      try {
        const files = ['packages/plugins/runtime-codex-sdk/tests/runtime.spec.ts', 'packages/plugins/agent-workers/tests/worktrees.spec.ts']
        const only = 'starts Codex through bubblewrap|writes a board task brief|replaces the brief'
        const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
        const { stdout } = await check(`exec ${process.execPath} ${vitest} run --no-cache ${files.join(' ')} -t '${only}'`, [...(existsSync(cache) ? [{ source: scratch, path: cache, writable: true }] : []), { source: tempScratch, path: temp, writable: true }])
        expect(stdout).toMatch(/Tests\s+3 passed/)
      } finally {
        rmSync(scratch, { recursive: true, force: true })
        rmSync(tempScratch, { recursive: true, force: true })
      }
    })
  })
})
