import type { ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import VirtualDisplay, { type SpawnXvfb, startXvfb } from '../src/index.ts'
import { removeStaleDisplay } from '../src/xvfb.ts'

/** A scripted Xvfb: tests decide when it reports a display, writes stderr, or exits. */
class FakeXvfb extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly pid = 4242
  readonly stdio = [null, null, new PassThrough(), new PassThrough()] as const
  readonly kills: string[] = []
  ignoreTerm = false

  ready(display: string): void {
    this.stdio[3].write(`${display}\n`)
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.kills.push(signal)
    if (signal === 'SIGTERM' && this.ignoreTerm) return true
    setImmediate(() => this.exit(null, signal))
    return true
  }
}

function fakeSpawner(onSpawn: (child: FakeXvfb) => void = (c) => setImmediate(() => c.ready('7'))) {
  const calls: Array<{ command: string; args: readonly string[]; child: FakeXvfb }> = []
  const spawn: SpawnXvfb = (command, args) => {
    const child = new FakeXvfb()
    calls.push({ command, args, child })
    onSpawn(child)
    return child as unknown as ChildProcess
  }
  return { spawn, calls }
}

afterEach(async () => {
  vi.unstubAllEnvs()
})

async function boot(spawn: SpawnXvfb, platform: NodeJS.Platform = 'linux', config: Record<string, unknown> = {}): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  class TestDisplay extends VirtualDisplay {
    protected override platform = platform
    protected override spawnXvfb = spawn
  }
  const ctx = new Context()
  const fiber = ctx.plugin(TestDisplay, { startupTimeoutMs: 200, shutdownTimeoutMs: 50, ...config })
  await fiber
  onTestFinished(() => fiber.dispose())
  return { ctx, dispose: () => fiber.dispose() }
}

describe('startXvfb (ported from tsuuanmi/internet)', () => {
  it('asks Xvfb to pick a free display through -displayfd and reads it back', async () => {
    const { spawn, calls } = fakeSpawner()
    const xvfb = await startXvfb({ executable: 'Xvfb', startupTimeoutMs: 200, spawn })
    expect(xvfb.display).toBe(':7')
    expect(calls[0]!.args).toEqual(['-displayfd', '3', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-auth', xvfb.authority])
    await xvfb.stop()
    await xvfb.exited
    expect(existsSync(xvfb.authority)).toBe(false)
  })

  it('fails closed with Xvfb diagnostics when it exits before reporting a display', async () => {
    const { spawn } = fakeSpawner((c) => setImmediate(() => {
      c.stdio[2].write('Fatal server error: no screens found\n')
      setImmediate(() => c.exit(1))
    }))
    const failure = startXvfb({ executable: 'Xvfb', startupTimeoutMs: 200, spawn })
    await expect(failure).rejects.toBeInstanceOf(ProviderError)
    await expect(failure).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/no screens found/) })
  })

  it('kills a Xvfb that never reports a display', async () => {
    const { spawn, calls } = fakeSpawner(() => undefined)
    await expect(startXvfb({ executable: 'Xvfb', startupTimeoutMs: 20, shutdownTimeoutMs: 20, spawn })).rejects.toThrow(/timed out/)
    expect(calls[0]!.child.kills).toEqual(['SIGTERM'])
  })

  it('rejects a malformed display number', async () => {
    const { spawn } = fakeSpawner((c) => setImmediate(() => c.ready('7; rm -rf')))
    await expect(startXvfb({ executable: 'Xvfb', startupTimeoutMs: 200, shutdownTimeoutMs: 20, spawn })).rejects.toThrow(/invalid display/)
  })

  it('reports a missing executable as a config error with an install hint', async () => {
    const failure = startXvfb({ executable: '/nonexistent/Xvfb', startupTimeoutMs: 1000 })
    await expect(failure).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/apt install xvfb/) })
  })

  it('escalates to SIGKILL when Xvfb ignores SIGTERM', async () => {
    const { spawn, calls } = fakeSpawner()
    // A private display root: the stale-display cleanup after the SIGKILL never reads the host's /tmp.
    const root = mkdtempSync(join(tmpdir(), 'system-xroot-'))
    const xvfb = await startXvfb({ executable: 'Xvfb', startupTimeoutMs: 200, shutdownTimeoutMs: 20, spawn, displayRoot: root })
    calls[0]!.child.ignoreTerm = true
    await xvfb.stop().finally(() => rmSync(root, { recursive: true, force: true }))
    expect(calls[0]!.child.kills).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('removes the socket and lock a killed Xvfb left behind, only while the lock names it', () => {
    const root = mkdtempSync(join(tmpdir(), 'x11-'))
    try {
      mkdirSync(join(root, '.X11-unix'))
      const leave = (number: string, owner: string): void => {
        writeFileSync(join(root, `.X${number}-lock`), `${owner.padStart(10)}\n`)
        writeFileSync(join(root, '.X11-unix', `X${number}`), '')
      }
      leave('7', '4242')
      leave('8', '9999')
      removeStaleDisplay('7', 4242, root)
      removeStaleDisplay('8', 4242, root)
      expect(['.X7-lock', '.X11-unix/X7', '.X8-lock', '.X11-unix/X8'].map((f) => existsSync(join(root, f)))).toEqual([false, false, true, true])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('cleans up after its own SIGKILL on stop, never after a clean exit', async () => {
    const number = '987654'
    const root = mkdtempSync(join(tmpdir(), 'system-xroot-'))
    mkdirSync(join(root, '.X11-unix'), { mode: 0o700 })
    const files = [join(root, `.X${number}-lock`), join(root, '.X11-unix', `X${number}`)]
    try {
      for (const kill of [true, false]) {
        writeFileSync(files[0]!, '      4242\n', { mode: 0o600 })
        writeFileSync(files[1]!, '', { mode: 0o600 })
        const { spawn, calls } = fakeSpawner((c) => setImmediate(() => c.ready(number)))
        const xvfb = await startXvfb({ executable: 'Xvfb', startupTimeoutMs: 200, shutdownTimeoutMs: 20, spawn, displayRoot: root })
        calls[0]!.child.ignoreTerm = kill
        await xvfb.stop()
        // A clean exit removes its own files (a real Xvfb does); the fake leaves them, so they stay.
        expect(files.map((f) => existsSync(f))).toEqual(kill ? [false, false] : [true, true])
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('ctx.display: display-virtual', () => {
  it('prepares an invisible headed display on a plugin-owned Xvfb (REQ-ACC-6)', async () => {
    const { spawn } = fakeSpawner()
    const { ctx } = await boot(spawn)
    const display = await ctx.display.prepare('invisible')
    expect(display).toMatchObject({ kind: 'virtual', env: { DISPLAY: ':7' }, windowArgs: ['--window-size=1920,1080'], viewport: null, generation: 1 })
    expect(display.lost.aborted).toBe(false)
  })

  it('shares one Xvfb between concurrent callers', async () => {
    const { spawn, calls } = fakeSpawner()
    const { ctx } = await boot(spawn)
    const [a, b] = await Promise.all([ctx.display.prepare('invisible'), ctx.display.prepare('invisible')])
    expect(calls).toHaveLength(1)
    expect(a.generation).toBe(b.generation)
  })

  it('signals loss when Xvfb dies and starts a new generation on the next prepare', async () => {
    let n = 7
    const { spawn, calls } = fakeSpawner((c) => setImmediate(() => c.ready(String(n++))))
    const { ctx } = await boot(spawn)
    const first = await ctx.display.prepare('invisible')
    calls[0]!.child.exit(1)
    await vi.waitFor(() => expect(first.lost.aborted).toBe(true))
    expect(first.lost.reason).toMatchObject({ kind: 'session_broken' })
    const second = await ctx.display.prepare('invisible')
    expect(second).toMatchObject({ env: { DISPLAY: ':8' }, generation: 2 })
  })

  it('never falls back to the operator DISPLAY when Xvfb cannot start (QA-3)', async () => {
    vi.stubEnv('DISPLAY', ':0')
    const { spawn } = fakeSpawner((c) => setImmediate(() => c.exit(1)))
    const { ctx } = await boot(spawn)
    await expect(ctx.display.prepare('invisible')).rejects.toMatchObject({ kind: 'config_error' })
  })

  it('retries Xvfb on a later prepare instead of caching a startup failure', async () => {
    let fail = true
    const { spawn, calls } = fakeSpawner((c) => setImmediate(() => (fail ? c.exit(1) : c.ready('9'))))
    const { ctx } = await boot(spawn)
    await expect(ctx.display.prepare('invisible')).rejects.toThrow()
    fail = false
    await expect(ctx.display.prepare('invisible')).resolves.toMatchObject({ env: { DISPLAY: ':9' } })
    expect(calls).toHaveLength(2)
  })

  it('stops Xvfb when the plugin is disposed', async () => {
    const { spawn, calls } = fakeSpawner()
    const { ctx, dispose } = await boot(spawn)
    const display = await ctx.display.prepare('invisible')
    await dispose()
    expect(calls[0]!.child.kills).toEqual(['SIGTERM'])
    expect(display.lost.aborted).toBe(true)
  })

  it('refuses invisible mode off Linux (the MVP is Linux-only)', async () => {
    const { spawn, calls } = fakeSpawner()
    const { ctx } = await boot(spawn, 'darwin')
    await expect(ctx.display.prepare('invisible')).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/Linux/) })
    expect(calls).toHaveLength(0)
  })

  it('uses the operator DISPLAY for visible mode, and requires one', async () => {
    const { spawn, calls } = fakeSpawner()
    const { ctx } = await boot(spawn)
    vi.stubEnv('DISPLAY', '')
    await expect(ctx.display.prepare('visible')).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/DISPLAY/) })
    vi.stubEnv('DISPLAY', ':0')
    await expect(ctx.display.prepare('visible')).resolves.toMatchObject({ kind: 'visible', env: { DISPLAY: ':0' }, viewport: { width: 1280, height: 900 } })
    expect(calls).toHaveLength(0)
  })
})

const hasXvfb = process.platform === 'linux' && (() => {
  try {
    execFileSync('sh', ['-c', 'command -v Xvfb'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** X11 connection setup over the display's socket: 1 = Success, 0 = Failed (e.g. no valid cookie). */
async function x11Handshake(display: string, cookie?: Buffer): Promise<number> {
  const { connect } = await import('node:net')
  const name = cookie ? Buffer.from('MIT-MAGIC-COOKIE-1') : Buffer.alloc(0)
  const data = cookie ?? Buffer.alloc(0)
  const pad = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)])
  const head = Buffer.alloc(12)
  head.write('l', 0)
  head.writeUInt16LE(11, 2)
  head.writeUInt16LE(name.length, 6)
  head.writeUInt16LE(data.length, 8)
  return new Promise((resolve, reject) => {
    const socket = connect(`/tmp/.X11-unix/X${display.slice(1)}`)
    socket.once('error', reject)
    socket.once('data', (reply) => { socket.destroy(); resolve(reply[0]!) })
    socket.write(Buffer.concat([head, pad(name), pad(data)]))
  })
}

/**
 * The process serving an X display, as its pid and start time (a reused pid is another
 * process): the owner of the socket listening at the display's path, found through
 * `/proc/net/unix` (listening: `__SO_ACCEPTCON` flag, unconnected state) and `/proc/<pid>/fd`.
 */
function xServerOf(display: string): { pid: number; start: string } {
  const path = `/tmp/.X11-unix/X${display.slice(1)}`
  const listening = new Set(readFileSync('/proc/net/unix', 'utf8').split('\n').slice(1).flatMap((line) => {
    const [, , , flags, , state, inode, name] = line.trim().split(/\s+/)
    return name === path && (Number.parseInt(flags ?? '0', 16) & 0x10000) !== 0 && state === '01' ? [`socket:[${inode}]`] : []
  }))
  const owners = readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).filter((pid) => {
    try {
      return readdirSync(`/proc/${pid}/fd`).some((fd) => listening.has(readlinkSync(`/proc/${pid}/fd/${fd}`)))
    } catch {
      return false
    }
  })
  expect(owners).toHaveLength(1)
  const pid = Number(owners[0])
  const start = startTimeOf(pid)
  expect(start).toBeDefined()
  return { pid, start: start! }
}

/** Field 22 of `/proc/<pid>/stat`, or `undefined` once the process is gone. */
function startTimeOf(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch {
    return undefined
  }
}

/** The single cookie of an Xauthority file written by display-virtual (FamilyWild record). */
function cookieOf(path: string): Buffer {
  const file = readFileSync(path)
  let at = 2
  const field = (): Buffer => { const n = file.readUInt16BE(at); at += 2; const v = file.subarray(at, at + n); at += n; return v }
  field(); field(); field()
  return field()
}

describe.runIf(hasXvfb)('display-virtual with a real Xvfb', () => {
  it('requires the X authority cookie, so other local users cannot see or drive the browser', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(VirtualDisplay, {})
    await fiber
    try {
      const display = await ctx.display.prepare('invisible')
      const authority = display.env.XAUTHORITY!
      expect(statSync(authority).mode & 0o777).toBe(0o600)
      expect(await x11Handshake(display.env.DISPLAY!)).toBe(0)
      expect(await x11Handshake(display.env.DISPLAY!, cookieOf(authority))).toBe(1)
    } finally {
      await fiber.dispose()
    }
  }, 15_000)

  it('starts a private X server and stops it on dispose', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(VirtualDisplay, {})
    await fiber
    const display = await ctx.display.prepare('invisible')
    const server = xServerOf(display.env.DISPLAY!)
    expect(readFileSync(`/proc/${server.pid}/comm`, 'utf8').trim()).toBe('Xvfb')
    await fiber.dispose()
    // This server's process is gone (dispose awaits its exit). Its display number and socket path
    // are no evidence: a parallel test file's Xvfb may take them at once, on a recycled inode.
    expect(startTimeOf(server.pid)).not.toBe(server.start)
    expect(display.lost.aborted).toBe(true)
  }, 15_000)
})

if (hasXvfb) {
  const { displayConformance } = await import('../../../provider-core/conformance/display.ts')
  displayConformance('display-virtual (real Xvfb)', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(VirtualDisplay, {})
    await fiber
    return { ctx, dispose: () => fiber.dispose() }
  })
}
