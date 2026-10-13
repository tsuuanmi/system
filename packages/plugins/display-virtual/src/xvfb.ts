/**
 * One Xvfb process, ported from tsuuanmi/internet `src/browser/display.ts`. Xvfb picks a
 * free display itself (`-displayfd`), so there is no port-guessing race; TCP is off.
 */
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { registerSecretPath } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'

export const XVFB_SCREEN = '1920x1080x24'
const MAX_DIAGNOSTIC_CHARS = 4096

export type SpawnXvfb = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: Array<'ignore' | 'pipe'> },
) => ChildProcess

export interface XvfbOptions {
  executable: string
  startupTimeoutMs: number
  /** Per-signal wait before escalating SIGTERM → SIGKILL (default 2 s). */
  shutdownTimeoutMs?: number
  spawn?: SpawnXvfb
}

export interface XvfbExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface XvfbHandle {
  /** `:N` */
  display: string
  /** Xauthority file (0600) holding the only cookie this server accepts; give it to X clients as XAUTHORITY. */
  authority: string
  /** Settles when the process exits, for any reason. */
  exited: Promise<XvfbExit>
  /** SIGTERM, then SIGKILL; throws only if the process survives both. */
  stop(): Promise<void>
}

const unavailable = (detail: string): ProviderError => new ProviderError(
  'config_error',
  `Xvfb is unavailable (Ubuntu/Debian: sudo apt install xvfb). Xvfb reported: ${detail.trim() || 'nothing'}`,
)

/** A child that failed to spawn has no pid and will never emit `exit`. */
/**
 * An Xauthority file with one FamilyWild record and no display number, which libXau matches
 * for any host and display (so it works with `-displayfd`), and which the server loads via
 * `-auth`. Without it any local user could connect, screenshot, and inject input.
 */
function writeAuthority(): { path: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'system-xauth-'))
  // With the cookie, a process can screenshot and drive the accounts' browsers: agent Workers
  // never read it (ADR-0024).
  const unregister = registerSecretPath(dir)
  const path = join(dir, 'Xauthority')
  const field = (b: Buffer): Buffer => Buffer.concat([Buffer.from([b.length >> 8, b.length & 0xff]), b])
  const record = Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.alloc(0)), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(randomBytes(16))])
  writeFileSync(path, record, { mode: 0o600 })
  return { path, remove: () => (rmSync(dir, { recursive: true, force: true }), unregister()) }
}

const running = (child: ChildProcess): boolean => child.pid !== undefined && child.exitCode === null && child.signalCode === null

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!running(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

async function terminate(child: ChildProcess, timeoutMs: number): Promise<void> {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (!running(child)) return
    child.kill(signal)
    if (await waitForExit(child, timeoutMs)) return
  }
  throw new ProviderError('config_error', `Xvfb process ${String(child.pid ?? 'unknown')} did not terminate`)
}

export function startXvfb(options: XvfbOptions): Promise<XvfbHandle> {
  const spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions))
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 2000
  const authority = writeAuthority()
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    let output = ''
    let diagnostic = ''
    let settled = false
    const fail = (reason: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const detail = diagnostic || reason
      terminate(child, shutdownTimeoutMs).then(
        () => reject(unavailable(detail)),
        (error: unknown) => reject(unavailable(`${detail}; ${(error as Error).message}`)),
      )
    }
    const timer = setTimeout(() => fail('startup timed out'), options.startupTimeoutMs)

    try {
      child = spawn(options.executable, ['-displayfd', '3', '-screen', '0', XVFB_SCREEN, '-nolisten', 'tcp', '-auth', authority.path], {
        env: { ...process.env },
        stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      settled = true
      clearTimeout(timer)
      authority.remove()
      reject(unavailable((error as Error).message))
      return
    }
    const exited = new Promise<XvfbExit>((resolveExit) => {
      child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        authority.remove()
        resolveExit({ code, signal })
      })
    })
    const stderr = child.stdio[2] as Readable | null
    const displayFd = child.stdio[3] as Readable | null
    stderr?.on('data', (chunk) => {
      diagnostic = `${diagnostic}${String(chunk)}`.slice(-MAX_DIAGNOSTIC_CHARS)
    })
    child.once('error', (error) => fail(error.message))
    child.once('exit', (code, signal) => fail(`exited before ready (code ${String(code)}, signal ${String(signal)})`))
    if (!displayFd) {
      fail('Xvfb did not expose displayfd 3')
      return
    }
    displayFd.on('data', (chunk) => {
      if (settled) return
      output = `${output}${String(chunk)}`.slice(-MAX_DIAGNOSTIC_CHARS)
      const newline = output.indexOf('\n')
      if (newline < 0) return
      const number = output.slice(0, newline).trim()
      if (!/^\d+$/.test(number)) {
        fail(`invalid display number ${JSON.stringify(number)}`)
        return
      }
      settled = true
      clearTimeout(timer)
      resolve({ display: `:${number}`, authority: authority.path, exited, stop: () => terminate(child, shutdownTimeoutMs) })
    })
  })
}
