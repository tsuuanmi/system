import { execFile, execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { type Confinement, confinedCommand, proveConfinement, writeLauncher } from '../src/index.ts'

const PASSTHROUGH = fileURLToPath(new URL('../conformance/passthrough-bwrap.sh', import.meta.url))

function findBwrap(): string | undefined {
  try {
    return execFileSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}
const BWRAP = findBwrap()
// CI requires the real bubblewrap, so a missing one fails instead of skipping silently.
const REQUIRED = process.env.SYSTEM_REQUIRE_BWRAP === '1'
const OPTIONS = ['--die-with-parent', '--unshare-pid', '--new-session', '--dev-bind', '/', '/', '--proc', '/proc']

/** A fake DSH home: host state to hide, operator tools to keep readable, a Worker home to keep writable. */
function host(): { root: string; home: string; tools: string; workerHome: string; vaultKey: string; keyFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'system-confine-'))
  const home = join(root, 'dsh')
  const tools = join(home, 'system', 'tools')
  const workerHome = join(home, 'system', 'codex-home')
  mkdirSync(join(tools, 'bin'), { recursive: true })
  mkdirSync(workerHome, { recursive: true })
  writeFileSync(join(home, '.credentials.yaml'), 'dsh credentials')
  const vaultKey = join(home, 'system', 'vault.key')
  writeFileSync(vaultKey, 'vault key')
  writeFileSync(join(home, 'system', 'mcp.token'), 'control token')
  writeFileSync(join(tools, 'bin', 'tool'), 'a tool')
  const keyFile = join(root, 'elsewhere.key')
  writeFileSync(keyFile, 'a key kept outside the DSH home')
  return { root, home, tools, workerHome, vaultKey, keyFile }
}

describe('confinedCommand: the bubblewrap command line (ADR-0024)', () => {
  const h = host()
  afterAll(() => rmSync(h.root, { recursive: true, force: true }))

  it('runs in its own PID namespace and session, dies with its parent, and mounts shallowest first: hidden directories as tmpfs, hidden files as the null device, binds back over them', () => {
    const link = join(h.root, 'home-link')
    symlinkSync(h.home, link)
    // The registered vault key lies inside the hidden home already: no extra mount for it.
    const c: Confinement = { bwrap: 'bwrap', hide: [h.keyFile, link, h.vaultKey], readOnly: [h.tools, join(h.root, 'missing')], writable: [h.workerHome] }
    expect(confinedCommand('codex', ['exec', '--json'], c)).toEqual({
      command: 'bwrap',
      args: [
        ...OPTIONS,
        '--ro-bind', '/dev/null', h.keyFile, '--tmpfs', h.home,
        '--ro-bind', h.tools, h.tools, '--bind', h.workerHome, h.workerHome,
        '--', 'codex', 'exec', '--json',
      ],
    })
  })

  it('refuses a bind that would re-expose a hidden path: one that holds a secret, or is one', () => {
    const run = (c: Partial<Confinement>) => () => confinedCommand('true', [], { bwrap: 'bwrap', hide: [h.home, h.vaultKey], readOnly: [], writable: [], ...c })
    expect(run({ readOnly: [join(h.home, 'system')] })).toThrow(`binding back ${join(h.home, 'system')} would expose ${h.vaultKey}`)
    expect(run({ writable: [join(h.workerHome, '..')] })).toThrow(/would expose/)
    expect(run({ readOnly: [h.home] })).toThrow(/would expose/)
  })
})

describe.skipIf(!BWRAP && !REQUIRED)('an agent child under the real bubblewrap cannot read host state (ADR-0024, REQ-WRK-6, INV-8)', () => {
  const h = host()
  afterAll(() => rmSync(h.root, { recursive: true, force: true }))
  const confinement = (extra: Partial<Confinement> = {}): Confinement => ({ bwrap: BWRAP ?? 'bwrap', hide: [h.home, h.keyFile, h.vaultKey], readOnly: [h.tools], writable: [h.workerHome], ...extra })
  const run = async (command: string, args: string[]) => {
    const c = confinedCommand(command, args, confinement())
    return promisify(execFile)(c.command, c.args, { encoding: 'utf8' })
  }

  it('sees only the way down to what is bound back; credentials, keys, and tokens are gone', async () => {
    expect((await run('ls', ['-A', h.home])).stdout.split('\n').filter(Boolean)).toEqual(['system'])
    expect((await run('ls', ['-A', join(h.home, 'system')])).stdout.split('\n').filter(Boolean).sort()).toEqual(['codex-home', 'tools'])
    await expect(run('cat', [h.vaultKey])).rejects.toThrow()
    await expect(run('cat', [h.keyFile])).rejects.toThrow()
  })

  it('reads operator tools but cannot change them, and writes its own home', async () => {
    expect((await run('cat', [join(h.tools, 'bin', 'tool')])).stdout).toBe('a tool')
    await expect(run('touch', [join(h.tools, 'bin', 'planted')])).rejects.toThrow()
    await run('touch', [join(h.workerHome, 'session')])
    expect(statSync(join(h.workerHome, 'session')).isFile()).toBe(true)
  })

  it('sees only its own processes, and nothing it starts outlives it', async () => {
    expect((await run('ls', ['/proc'])).stdout.split('\n').filter((e) => /^\d+$/.test(e)).length).toBeLessThan(5)
    const marker = join(h.root, 'orphan-alive')
    // A background child keeps writing; killing bubblewrap must end the whole namespace.
    const c = confinedCommand('sh', ['-c', `(while true; do date > ${marker}; sleep 0.1; done) & sleep 60`], confinement({ hide: [h.home] }))
    const child = spawn(c.command, c.args, { stdio: 'ignore' })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(existsSync(marker)).toBe(true)
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
    await new Promise((resolve) => setTimeout(resolve, 300))
    rmSync(marker, { force: true })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(existsSync(marker)).toBe(false)
  })

  it('proves the confinement on this host: the masked directories are not the host\'s, and hidden files are the null device', async () => {
    expect(await proveConfinement(confinement())).toEqual({ confined: true, detail: `host state hidden by ${BWRAP}` })
  })

  it('does not prove a confinement whose binds would expose a secret (each of these let the vault key be read before)', async () => {
    for (const extra of [{ readOnly: [join(h.home, 'system')] }, { writable: [join(h.home, 'system')] }, { writable: [join(h.workerHome, '..')] }]) {
      expect(await proveConfinement(confinement(extra))).toMatchObject({ confined: false, detail: expect.stringMatching(/would expose/) })
    }
  })

  it('names an operator hide entry that does not exist, rather than passing it silently', async () => {
    expect((await proveConfinement(confinement({ hide: [h.home, join(h.root, 'typo')] }))).detail).toContain(`not present, nothing to hide: ${join(h.root, 'typo')}`)
  })
})

describe('proveConfinement fails closed', () => {
  const h = host()
  afterAll(() => rmSync(h.root, { recursive: true, force: true }))

  it('when bubblewrap is missing', async () => {
    const result = await proveConfinement({ bwrap: join(h.root, 'no-bwrap'), hide: [h.home], readOnly: [], writable: [] })
    expect(result).toMatchObject({ confined: false, detail: expect.stringMatching(/^reads cannot be confined/) })
  })

  it('when the command runs but masks nothing: the directory is the host\'s own', async () => {
    const result = await proveConfinement({ bwrap: PASSTHROUGH, hide: [h.home], readOnly: [h.tools], writable: [] })
    expect(result).toEqual({ confined: false, detail: `${h.home} is the host directory under ${PASSTHROUGH}, not masked` })
  })

  it('when a hidden file is not the null device', async () => {
    const result = await proveConfinement({ bwrap: PASSTHROUGH, hide: [h.keyFile], readOnly: [], writable: [] })
    expect(result).toEqual({ confined: false, detail: `${h.keyFile} is not masked by the null device under ${PASSTHROUGH}` })
  })
})

describe('writeLauncher: a program path for SDKs that take no arguments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'system-launcher-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const command = confinedCommand('printf', ['%s|'], { bwrap: PASSTHROUGH, hide: [], readOnly: [], writable: [] })

  it('writes an owner-only script, named by its content, that execs the command with its own and the caller\'s arguments', async () => {
    const path = writeLauncher(dir, 'agent', command)
    expect(path).toMatch(/agent-[0-9a-f]{16}\.sh$/)
    // Mode and content are read through one descriptor, so they are of the same file.
    const fd = openSync(path, 'r')
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o700)
      expect(readFileSync(fd, 'utf8')).toContain(`exec '${PASSTHROUGH}' '--die-with-parent'`)
    } finally {
      closeSync(fd)
    }
    expect(writeLauncher(dir, 'agent', command)).toBe(path)
    expect((await promisify(execFile)(path, ["it's", 'two words'], { encoding: 'utf8' })).stdout).toBe("it's|two words|")
  })

  it('replaces a launcher a crash left short, or a symlink planted at its name, instead of running it', () => {
    const path = writeLauncher(dir, 'agent', command)
    const whole = readFileSync(path, 'utf8')
    writeFileSync(path, whole.slice(0, 20))
    expect(readFileSync(writeLauncher(dir, 'agent', command), 'utf8')).toBe(whole)
    rmSync(path)
    writeFileSync(join(dir, 'planted'), '#!/bin/sh\necho planted\n', { mode: 0o700 })
    symlinkSync(join(dir, 'planted'), path)
    expect(readFileSync(writeLauncher(dir, 'agent', command), 'utf8')).toBe(whole)
    expect(statSync(path).isFile()).toBe(true)
  })
})
