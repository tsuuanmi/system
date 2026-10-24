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
/** Every confined command's temporary directory: its own tmpfs at /tmp, named by TMPDIR, TMP, and TEMP (T113). */
const TEMP_ENV = ['--setenv', 'TMPDIR', '/tmp', '--setenv', 'TMP', '/tmp', '--setenv', 'TEMP', '/tmp']

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
        // A confinement that does not hide /tmp still gets a private one, first (the shallowest).
        '--tmpfs', '/tmp',
        '--ro-bind', '/dev/null', h.keyFile, '--tmpfs', h.home,
        '--ro-bind', h.tools, h.tools, '--bind', h.workerHome, h.workerHome,
        ...TEMP_ENV,
        '--', 'codex', 'exec', '--json',
      ],
    })
    // One that hides /tmp has it hidden once, as its own.
    expect(confinedCommand('true', [], { bwrap: 'bwrap', hide: ['/tmp'], readOnly: [], writable: [] }).args).toEqual([...OPTIONS, '--tmpfs', '/tmp', ...TEMP_ENV, '--', 'true'])
  })

  it('with options: a read-only host with its own /dev, no network, a start directory, and views mounted last, in order', () => {
    const view = join(h.root, 'view')
    const store = join(h.root, 'store')
    mkdirSync(join(store, 'files'), { recursive: true })
    mkdirSync(view)
    const c: Confinement = { bwrap: 'bwrap', hide: [h.home], readOnly: [], writable: [h.workerHome] }
    expect(confinedCommand('sh', ['-c', 'true'], c, {
      readOnly: true, network: false, chdir: h.workerHome,
      views: [{ source: view, path: store, writable: true }, { source: join(store, 'files'), path: join(store, 'files'), writable: false }],
    })).toEqual({
      command: 'bwrap',
      args: [
        '--die-with-parent', '--unshare-pid', '--unshare-net', '--new-session', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
        '--tmpfs', '/tmp', '--tmpfs', h.home, '--bind', h.workerHome, h.workerHome,
        '--bind', view, store, '--ro-bind', join(store, 'files'), join(store, 'files'), '--chdir', h.workerHome,
        ...TEMP_ENV,
        '--', 'sh', '-c', 'true',
      ],
    })
    // No options: exactly an agent child's command line.
    expect(confinedCommand('true', [], c, {}).args.slice(0, 8)).toEqual(OPTIONS)
  })

  it('refuses a view that would expose a hidden path, one whose source is missing, and a relative path', () => {
    const c: Confinement = { bwrap: 'bwrap', hide: [h.home, h.vaultKey], readOnly: [], writable: [] }
    const view = (source: string, path = join(h.root, 'somewhere')) => () => confinedCommand('true', [], c, { views: [{ source, path, writable: false }] })
    expect(view(join(h.home, 'system'))).toThrow(`the view of ${join(h.home, 'system')} would expose ${h.vaultKey}`)
    expect(view(h.root)).toThrow(/would expose/)
    expect(view(join(h.root, 'missing'))).toThrow(/does not exist/)
    expect(view(h.tools, 'relative')).toThrow(/not absolute/)
    expect(() => confinedCommand('true', [], c, { chdir: 'relative' })).toThrow(/not absolute/)
  })

  it('refuses a bind that would re-expose a hidden path: one that holds a secret, or is one', () => {
    const run = (c: Partial<Confinement>) => () => confinedCommand('true', [], { bwrap: 'bwrap', hide: [h.home, h.vaultKey], readOnly: [], writable: [], ...c })
    expect(run({ readOnly: [join(h.home, 'system')] })).toThrow(`binding back ${join(h.home, 'system')} would expose ${h.vaultKey}`)
    expect(run({ writable: [join(h.workerHome, '..')] })).toThrow(/would expose/)
    expect(run({ readOnly: [h.home] })).toThrow(/would expose/)
    // Nor the host's /tmp, which the confinement does not name: as a bind, or as a view's source.
    expect(run({ writable: ['/tmp'] })).toThrow('binding back /tmp would expose /tmp')
    expect(() => confinedCommand('true', [], { bwrap: 'bwrap', hide: [], readOnly: [], writable: [] }, { views: [{ source: '/tmp', path: join(h.root, 'tmp-view'), writable: true }] })).toThrow('the view of /tmp would expose /tmp')
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
    // In a directory bound back: the rest of /tmp, where the fixture lies, is the child's own.
    const marker = join(h.workerHome, 'orphan-alive')
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

  it('with options: the host is read-only but for its binds, there is no network but loopback, and a view shows another directory there', async () => {
    const elsewhere = mkdtempSync(join(h.root, 'store-'))
    try {
      const view = join(h.root, 'view')
      mkdirSync(view)
      writeFileSync(join(view, 'index'), 'private copy')
      mkdirSync(join(elsewhere, 'files'))
      writeFileSync(join(elsewhere, 'files', 'pkg'), 'content')
      const options = {
        readOnly: true, network: false as const, chdir: h.workerHome,
        views: [{ source: view, path: elsewhere, writable: true }, { source: join(elsewhere, 'files'), path: join(elsewhere, 'files'), writable: false }],
      }
      const run = (script: string) => {
        const c = confinedCommand('sh', ['-c', script], confinement(), options)
        return promisify(execFile)(c.command, c.args, { encoding: 'utf8' })
      }
      // Its start directory is the bound one, which it writes; the rest of the host it cannot.
      expect((await run('pwd && touch made && echo ok')).stdout).toBe(`${h.workerHome}\nok\n`)
      expect(statSync(join(h.workerHome, 'made')).isFile()).toBe(true)
      // A host directory outside /tmp (this test's own) is read-only; one inside /tmp is its private tmpfs, not the host's.
      const planted = join(fileURLToPath(new URL('.', import.meta.url)), `planted-${process.pid}`)
      try {
        await expect(run(`touch ${planted}`)).rejects.toThrow()
      } finally {
        rmSync(planted, { force: true })
      }
      await run(`touch ${join(elsewhere, '..', 'planted')}`)
      expect(existsSync(join(elsewhere, '..', 'planted'))).toBe(false)
      // Only its own loopback.
      const devices = (await run('cat /proc/net/dev')).stdout.split('\n').slice(2).filter(Boolean).map((line) => line.trim().split(':')[0])
      expect(devices).toEqual(['lo'])
      // The view: the private directory at the host path, writable; the host's files back in it, read-only.
      expect((await run(`cat ${join(elsewhere, 'index')} ${join(elsewhere, 'files', 'pkg')}`)).stdout).toBe('private copycontent')
      await run(`touch ${join(elsewhere, 'written')}`)
      expect(existsSync(join(view, 'written'))).toBe(true)
      expect(existsSync(join(elsewhere, 'written'))).toBe(false)
      await expect(run(`touch ${join(elsewhere, 'files', 'planted')}`)).rejects.toThrow()
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('gives every confined command a private, writable /tmp as TMPDIR, TMP, and TEMP: a unix socket listens there as tsx\'s IPC pipe does, and the host\'s /tmp is neither seen nor written (T113)', async () => {
    const marker = `system-t113-${process.pid}-${Date.now()}`
    const hostOnly = mkdtempSync(join(tmpdir(), 'system-t113-host-'))
    writeFileSync(join(hostOnly, 'secret'), 'the host\'s')
    // In the child: its temporary directory, a pipe made as tsx makes its own (`<tmpdir>/tsx-<uid>/<pid>.pipe`), one message through it, then a file in /tmp.
    const script = [
      "const { mkdirSync, writeFileSync } = require('node:fs'); const net = require('node:net'); const os = require('node:os'); const path = require('node:path')",
      "const dir = path.join(os.tmpdir(), 'tsx-' + os.userInfo().uid); mkdirSync(dir, { recursive: true }); const pipe = path.join(dir, process.pid + '.pipe')",
      "const server = net.createServer((s) => s.on('data', (d) => { s.end(); server.close(); writeFileSync(path.join('/tmp', process.argv[1]), 'x'); console.log([process.env.TMPDIR, process.env.TMP, process.env.TEMP, os.tmpdir(), pipe.startsWith('/tmp/tsx-'), String(d)].join(' ')) }))",
      "server.on('error', (e) => { console.log('error ' + e.code); process.exit(1) }); server.listen(pipe, () => net.connect(pipe, function () { this.end('through the pipe') }))",
    ].join('\n')
    try {
      const options: Array<Parameters<typeof confinedCommand>[3]> = [{}, { readOnly: true, network: false, chdir: h.workerHome }]
      for (const c of [confinement(), confinement({ hide: [h.home, h.keyFile, h.vaultKey, '/tmp'] })]) {
        for (const extra of options) {
          const command = confinedCommand(process.execPath, ['-e', script, marker], c, extra)
          // The daemon's own TMPDIR (a host path) is not the child's.
          const { stdout } = await promisify(execFile)(command.command, command.args, { encoding: 'utf8', env: { ...process.env, TMPDIR: hostOnly, TMP: hostOnly, TEMP: hostOnly } })
          expect(stdout, JSON.stringify(extra)).toBe('/tmp /tmp /tmp /tmp true through the pipe\n')
          expect(existsSync(join('/tmp', marker)), 'the host /tmp was written').toBe(false)
        }
        // What the host keeps in /tmp is not there; what is bound back still is.
        const seen = confinedCommand('sh', ['-c', `ls -A ${hostOnly} 2>&1; cat ${join(h.workerHome, '..', 'tools', 'bin', 'tool')}`], c)
        const { stdout } = await promisify(execFile)(seen.command, seen.args, { encoding: 'utf8' })
        expect(stdout).not.toContain('secret')
        expect(stdout).toContain('a tool')
      }
    } finally {
      rmSync(hostOnly, { recursive: true, force: true })
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
