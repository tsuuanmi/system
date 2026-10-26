// The unix sockets a writing run's confinement masks before its commands may make unix sockets
// (T265): every one the host has bound (the kernel's list), wherever it lies, and every one on disk
// under the scanned roots, that this account could connect to, by its real path; never one it cannot
// write, one the child does not see, or one reached through a link on disk; a scan that may have
// missed one says it is incomplete; and a mask lies over a socket under a path bound back too.
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { boundUnixSockets, confinedCommand, homeSocketDirectories, SOCKET_ROOTS, socketCovers, socketDirectories, writableUnixSockets } from '../src/index.ts'
import { BWRAP, needsBubblewrap } from './host.ts'

// Short: a unix socket's path is bound to about 107 bytes.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ss-')))
const servers: Server[] = []
afterAll(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
})

const listen = async (path: string): Promise<string> => {
  const server = createServer(() => undefined)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(path, resolve))
  return path
}

/** A kernel's list naming `paths`, as /proc/net/unix shows them, with an abstract socket and an unbound one among them. */
const listing = (paths: readonly string[]): string => [
  'Num       RefCount Protocol Flags    Type St Inode Path',
  '0000000000000000: 00000002 00000000 00010000 0001 01 20001 @/tmp/.X11-unix/X0',
  ...paths.map((path, i) => `0000000000000000: 00000002 00000000 00010000 0001 01 ${30000 + i} ${path}`),
  '0000000000000000: 00000003 00000000 00000000 0001 03 40001',
].join('\n')
const NONE = (): string => listing([])

describe('the host\'s unix sockets a writing run could connect to (T265)', () => {
  it('finds every socket this account may write under the roots, within their depth; never one it cannot write, one already hidden, one past a link, or a plain file', async () => {
    mkdirSync(join(root, 'run', 'docker'), { recursive: true })
    mkdirSync(join(root, 'run', 'deep', 'a', 'b'), { recursive: true })
    mkdirSync(join(root, 'hidden'))
    const docker = await listen(join(root, 'run', 'docker', 'docker.sock'))
    const bus = await listen(join(root, 'run', 'bus.sock'))
    const closed = await listen(join(root, 'run', 'root-only.sock'))
    chmodSync(closed, 0o400)
    await listen(join(root, 'hidden', 'agent.sock'))
    await listen(join(root, 'run', 'deep', 'a', 'b', 'far.sock'))
    writeFileSync(join(root, 'run', 'plain.sock'), '')
    symlinkSync(join(root, 'hidden'), join(root, 'run', 'link'))
    const found = writableUnixSockets([{ path: join(root, 'run'), depth: 3 }, { path: join(root, 'hidden'), depth: 1 }], [join(root, 'hidden')], NONE)
    // As root every socket is writable; the one this account cannot write is left out only for another account.
    const expected = process.getuid?.() === 0 ? [bus, docker, closed] : [bus, docker]
    expect(found).toEqual({ sockets: expected.sort(), complete: true })
    // Deep enough, the far one too.
    expect(writableUnixSockets([{ path: join(root, 'run'), depth: 4 }], [join(root, 'hidden')], NONE).sockets).toContain(join(root, 'run', 'deep', 'a', 'b', 'far.sock'))
  })

  it('finds a socket the host has bound wherever it lies, past any depth the disk scan reaches (Docker Desktop\'s ~/.docker/desktop/docker.sock, say); a stale or hidden one is left', async () => {
    mkdirSync(join(root, 'home', '.docker', 'desktop'), { recursive: true })
    mkdirSync(join(root, 'hidden'), { recursive: true })
    const desktop = await listen(join(root, 'home', '.docker', 'desktop', 'docker.sock'))
    const hiddenOne = await listen(join(root, 'hidden', 'bound.sock'))
    // The disk scan alone, two levels into the home, misses it; the kernel's list does not.
    expect(writableUnixSockets([{ path: join(root, 'home'), depth: 2 }], [], NONE).sockets).not.toContain(desktop)
    const found = writableUnixSockets([], [join(root, 'hidden')], () => listing([desktop, hiddenOne, join(root, 'gone.sock')]))
    expect(found).toEqual({ sockets: [desktop], complete: true })
  })

  it('finds a socket under a hidden directory whose child the confinement binds back (a run\'s worktree under the hidden DSH home), through the real kernel\'s list and the disk scan alike; one the bind does not bring back stays passed over', async () => {
    // The DSH home, hidden; a run's worktree in it, bound back; a socket in each.
    const dsh = join(root, 'dsh')
    const worktree = join(dsh, 'worktrees', 'run_one')
    mkdirSync(worktree, { recursive: true })
    mkdirSync(join(dsh, 'vault'))
    const inWorktree = await listen(join(worktree, 'w.sock'))
    const inVault = await listen(join(dsh, 'vault', 'v.sock'))
    // The real scanner, on the kernel's own list (this process listens on both).
    const listed = writableUnixSockets([], [dsh], undefined, [worktree])
    expect(listed.complete).toBe(true)
    expect(listed.sockets).toContain(inWorktree)
    expect(listed.sockets).not.toContain(inVault)
    // The disk scan alone finds it too: a bound-back path under a hidden one is a root of its own,
    // though a scan from the hidden directory itself passes over it.
    expect(writableUnixSockets([{ path: dsh, depth: 6 }], [dsh], NONE, [worktree]).sockets).toEqual([inWorktree])
    // Bound back from nothing, both stay passed over, as the child sees neither.
    expect(writableUnixSockets([{ path: dsh, depth: 6 }], [dsh], NONE).sockets).toEqual([])
    expect(writableUnixSockets([], [dsh], () => listing([inWorktree, inVault])).sockets).toEqual([])
    // And the confinement masks it, after its bind: the child sees the worktree, never the socket.
    const line = confinedCommand('true', [], { bwrap: '/usr/bin/bwrap', hide: [dsh], readOnly: [], writable: [worktree], masks: listed.sockets }).args.join(' ')
    expect(line).toContain(`--ro-bind /dev/null ${inWorktree}`)
    expect(line.indexOf(`/dev/null ${inWorktree}`)).toBeGreaterThan(line.indexOf(`--bind ${worktree} ${worktree}`))
  })

  it('names, as the directories covered for a writing run, the socket roots but the home itself; one in the home that does not exist yet is made now, empty and owner-only, so it can be covered before a daemon makes it', () => {
    const home = join(root, 'dirs', 'home')
    mkdirSync(join(root, 'dirs', 'run'), { recursive: true })
    mkdirSync(join(home, '.docker'), { recursive: true })
    const roots = [
      { path: join(root, 'dirs', 'run'), depth: 4 }, { path: home, depth: 2 }, { path: join(home, '.docker'), depth: 4 },
      // Docker Desktop's, Podman's, absent so far: a daemon could make them, and a socket in them, during the run.
      { path: join(home, '.local', 'share', 'containers'), depth: 8 }, { path: join(home, '.colima'), depth: 4 },
      // Outside the home and absent: left (only what may write `/` could make it).
      { path: join(root, 'dirs', 'missing'), depth: 4 },
    ]
    const found = socketDirectories(roots, home)
    expect(found).toEqual({ directories: [join(root, 'dirs', 'run'), join(home, '.docker'), join(home, '.local', 'share', 'containers'), join(home, '.colima')], complete: true })
    expect(statSync(join(home, '.colima')).isDirectory()).toBe(true)
    expect(statSync(join(home, '.colima')).mode & 0o777).toBe(0o700)
    expect(existsSync(join(root, 'dirs', 'missing'))).toBe(false)
    // Those in the home are hidden from the agent's own confinement besides; the system's stay seen there.
    expect(homeSocketDirectories(found.directories, home)).toEqual([join(home, '.docker'), join(home, '.local', 'share', 'containers'), join(home, '.colima')])
  })

  it('is incomplete, so unix sockets stay refused, when a socket directory in the home cannot be made, or is no directory', () => {
    const home = join(root, 'dirs2', 'home')
    mkdirSync(home, { recursive: true })
    // A file holds the place of `.local`: `.local/share/containers` cannot be made, nor covered.
    writeFileSync(join(home, '.local'), '')
    expect(socketDirectories([{ path: join(home, '.local', 'share', 'containers'), depth: 8 }], home)).toEqual({ directories: [], complete: false })
    writeFileSync(join(home, '.docker'), '')
    expect(socketDirectories([{ path: join(home, '.docker'), depth: 4 }], home)).toEqual({ directories: [], complete: false })
  })

  it('reads the kernel\'s list by the path each line ends with; abstract and unbound sockets have none', () => {
    expect(boundUnixSockets(listing(['/run/docker.sock', '/home/u/.docker/run/docker.sock', '/run/with space.sock']))).toEqual(['/run/docker.sock', '/home/u/.docker/run/docker.sock', '/run/with space.sock'])
  })

  it('is incomplete, so unix sockets stay refused, when the kernel\'s list cannot be read', () => {
    expect(writableUnixSockets([], [], () => {
      throw new Error('EACCES')
    })).toEqual({ sockets: [], complete: false })
  })

  it('looks in the system\'s runtime directories, the account\'s home, and container engines\' own directories by default', () => {
    expect(SOCKET_ROOTS.map((r) => r.path)).toEqual(expect.arrayContaining(['/run', '/var/run', homedir(), join(homedir(), '.docker'), join(homedir(), '.local', 'share', 'containers')]))
    expect(SOCKET_ROOTS.find((r) => r.path === join(homedir(), '.docker'))!.depth).toBeGreaterThanOrEqual(3)
    expect(writableUnixSockets([{ path: join(root, 'missing'), depth: 2 }], [], NONE)).toEqual({ sockets: [], complete: true })
  })

  it('masks a socket under a path the confinement binds back, read-only or writable, after the bind; one the child does not see is left; a directory is refused', async () => {
    // The socket lies under a directory bound back, so the child sees it whatever the host's temporary
    // directory is (the confinement replaces the host's /tmp with a private tmpfs, where an unbound path is not seen).
    mkdirSync(join(root, 'bound'))
    const socket = await listen(join(root, 'bound', 'tool.sock'))
    for (const bind of [{ readOnly: [join(root, 'bound')], writable: [] }, { readOnly: [], writable: [join(root, 'bound')] }]) {
      const c = confinedCommand('true', [], { bwrap: '/usr/bin/bwrap', hide: [], ...bind, masks: [socket] })
      const line = c.args.join(' ')
      expect(line).toContain(`--ro-bind /dev/null ${socket}`)
      expect(line.indexOf(`/dev/null ${socket}`)).toBeGreaterThan(line.indexOf(` ${join(root, 'bound')} ${join(root, 'bound')}`))
    }
    // Hidden, and bound back by nothing: the child does not see it, so nothing is mounted over it.
    expect(confinedCommand('true', [], { bwrap: '/usr/bin/bwrap', hide: [join(root, 'bound')], readOnly: [], writable: [], masks: [socket] }).args.join(' ')).not.toContain(`/dev/null ${socket}`)
    // A directory the child would see (bound back), given as a mask, is refused.
    expect(() => confinedCommand('true', [], { bwrap: '/usr/bin/bwrap', hide: [], readOnly: [root], writable: [], masks: [join(root, 'bound')] })).toThrow(/is a directory/)
  })

  it('covers each socket by its own directory where a socket cannot be masked one by one (bubblewrap 0.4); none for one under a denied directory; incomplete when a directory would hide what the run works in', () => {
    const home = join(root, 'cover-home')
    const workspace = join(home, 'work', 'repo')
    const tools = join(root, 'cover-tools')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(tools, { recursive: true })
    const binds = [workspace, tools]
    // A tool's runtime directory in the home, and one outside it: each hidden whole; one under /run-like denied directories needs none.
    expect(socketCovers([join(home, '.cache', 'zed', 'a.sock'), join(home, '.cache', 'zed', 'b.sock'), join(root, 'var', 'db.sock'), join(root, 'run', 'docker.sock')], binds, [join(root, 'run')], home))
      .toEqual({ directories: [join(home, '.cache', 'zed'), join(root, 'var')].sort(), complete: true })
    // In the home itself, in the workspace or under it, or in a directory that holds the workspace: hiding it would hide the run's own work.
    for (const socket of [join(home, 'x.sock'), join(workspace, 'x.sock'), join(workspace, 'sub', 'x.sock'), join(home, 'work', 'x.sock'), join(tools, 'x.sock'), '/x.sock']) {
      expect(socketCovers([socket], binds, [], home)).toEqual({ directories: [], complete: false })
    }
  })
})

describe('a socket a daemon makes after the run started, in a directory the run\'s commands are denied (T265)', { timeout: 60_000 }, () => {
  needsBubblewrap()

  /**
   * In a child under real bubblewrap, started before the socket exists, then connected to it once the
   * host made it: 0 when it connects, 3 when it cannot. The socket's directory is the host's own,
   * bound back live (as `/run` is seen); `covered`: a mount lies over it inside besides, as a denied
   * directory of the command sandbox has.
   */
  const connectAfterStart = async (covered: boolean, absentBefore = false): Promise<number> => {
    const base = mkdtempSync(join(root, covered ? 'cov-' : 'live-'))
    const daemonDir = join(base, 'run')
    const markerDir = join(base, 'marker')
    const empty = join(base, 'empty')
    // A daemon's directory in the home that is not there when the run starts is made by
    // socketDirectories, before the run, so it can be covered.
    if (absentBefore) expect(socketDirectories([{ path: daemonDir, depth: 2 }], base)).toEqual({ directories: [daemonDir], complete: true })
    else mkdirSync(daemonDir)
    mkdirSync(markerDir)
    mkdirSync(empty)
    const socket = join(daemonDir, 'd.sock')
    const marker = join(markerDir, 'made')
    const script = [
      "const { existsSync } = require('node:fs'); const net = require('node:net')",
      'const [socket, marker] = process.argv.slice(-2)',
      "process.stdout.write('ready\\n')",
      "const tick = setInterval(() => { if (!existsSync(marker)) return; clearInterval(tick); net.connect(socket).on('connect', () => process.exit(0)).on('error', () => process.exit(3)) }, 20)",
    ].join('\n')
    const node = realpathSync(process.execPath)
    const c = confinedCommand(node, ['-e', script, '--', socket, marker], { bwrap: BWRAP ?? 'bwrap', hide: [], readOnly: [node, markerDir, daemonDir], writable: [] }, {
      views: covered ? [{ source: empty, path: daemonDir, writable: false }] : [],
    })
    const child = spawn(c.command, c.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 1)))
    // The child has started, and the socket is not there yet: the daemon makes it now.
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => chunk.toString().includes('ready') && resolve())
      child.on('exit', (code) => reject(new Error(`the child ended before it was ready (${code})`)))
    })
    await listen(socket)
    writeFileSync(marker, '')
    return exited
  }

  it('cannot be reached through a covered directory, while the same socket in the host\'s live directory can (the control)', async () => {
    expect(await connectAfterStart(false)).toBe(0)
    expect(await connectAfterStart(true)).toBe(3)
  })

  it('cannot be reached either when its directory did not exist before the run (Docker Desktop started for the first time): the directory was made before the run and covered', async () => {
    expect(await connectAfterStart(true, true)).toBe(3)
  })

  it('cannot be reached through its directory hidden as socketCovers names it, under the real bubblewrap of any version (bubblewrap 0.4 cannot mount over the socket itself), while it can be without (the control)', async () => {
    const dir = mkdtempSync(join(root, 'tool-'))
    const socket = await listen(join(dir, 't.sock'))
    const node = realpathSync(process.execPath)
    const script = "require('node:net').connect(process.argv.at(-1)).on('connect', () => process.exit(0)).on('error', () => process.exit(3))"
    const connect = (hide: readonly string[]): Promise<number> => {
      // The socket's directory is bound back (the host's /tmp is a private tmpfs inside), then hidden or not.
      const c = confinedCommand(node, ['-e', script, '--', socket], { bwrap: BWRAP ?? 'bwrap', hide: [...hide], readOnly: [node, ...(hide.length ? [] : [dir])], writable: [] })
      const child = spawn(c.command, c.args, { stdio: 'ignore' })
      return new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 1)))
    }
    const covers = socketCovers([socket], [node])
    expect(covers).toEqual({ directories: [dir], complete: true })
    expect(await connect([])).toBe(0)
    expect(await connect(covers.directories)).toBe(3)
  })
})
