/**
 * Login profiles as the automation uses them (ADR-0030): one persistent context per
 * session-bound account, the operator's reservations, the Save flow's captures, and who holds
 * a profile directory.
 *
 * A profile counts as in use only while a process on this host runs Chrome on it
 * (`--user-data-dir=<dir>` in its command line, read from /proc). A lock file proves nothing on
 * its own: its pid may have been reused, or it may name another host. Elsewhere than Linux, the
 * lock's pid is all there is to go on, so a process holding a profile is refused and never stopped.
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ensurePrivateDir } from '@tsuuanmi/system-libs'
import { type ProfileState, ProviderError } from '@tsuuanmi/system-provider-core'
import type { BrowserContext, Page } from 'patchright-core'
import { abortable, closeWithin } from './async.ts'

/** How long a closed profile's Chrome may take to exit before it is killed. */
const EXIT_WAIT_MS = 10_000
/** How long a stopped process may take to go after SIGTERM, then after SIGKILL. */
const STOP_GRACE_MS = 3000
const KILL_WAIT_MS = 5000

export interface ProfileHost {
  /** Launch Chrome on a login profile, headed on the invisible display. `restore` reopens the last session. */
  launch(dir: string, restore: boolean): Promise<{ context: BrowserContext; lost: AbortSignal }>
  closeAfterMs(): number
  /** An operator-visible event (an orphaned browser stopped, say). */
  report(type: string, data: Record<string, unknown>): void
}

export interface ProfileTurn {
  context: BrowserContext
  page: Page
  close(): Promise<void>
}

interface Held {
  context: BrowserContext
  dir: string
  pages: number
  /** When the next page may open (page opens are spaced by the caller's gap). */
  nextOpen: number
  idle?: NodeJS.Timeout | undefined
}

/** Processes on this host running Chrome on `dir`: the browser, and the children still exiting with it. */
export function profileUsers(dir: string): number[] {
  if (process.platform !== 'linux') return lockHolder(dir)
  const flags = new Set([`--user-data-dir=${dir}`, `--user-data-dir=${resolve(dir)}`])
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return lockHolder(dir)
  }
  const users: number[] = []
  for (const name of entries) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
    let args: string[]
    try {
      args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0')
    } catch {
      continue
    }
    if (args.some((arg) => flags.has(arg))) users.push(Number(name))
  }
  return users
}

/** Without /proc: the live local pid Chrome's `SingletonLock` (`<host>-<pid>`) names, if any. */
function lockHolder(dir: string): number[] {
  try {
    const lock = join(dir, 'SingletonLock')
    if (!lstatSync(lock).isSymbolicLink()) return []
    const match = /^(.*)-(\d+)$/.exec(readlinkSync(lock))
    return match && match[1] === hostname() && alive(Number(match[2])) ? [Number(match[2])] : []
  } catch {
    return []
  }
}

/** Remove the lock files of a browser that is gone; only when no process uses the profile. */
export function clearLockFiles(dir: string): void {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) rmSync(join(dir, name), { force: true })
}

/** Until nobody uses `dir`, or `ms` has passed: who still does. */
async function waitFree(dir: string, ms: number): Promise<number[]> {
  const deadline = Date.now() + ms
  for (;;) {
    const users = profileUsers(dir)
    if (!users.length || Date.now() >= deadline) return users
    await sleep(100)
  }
}

/** Stop every process on `dir`: SIGTERM, then SIGKILL. Who is left (none, unless it cannot be stopped). */
async function stopUsers(dir: string, pids: number[]): Promise<number[]> {
  for (const pid of pids) signal(pid, 'SIGTERM')
  const left = await waitFree(dir, STOP_GRACE_MS)
  for (const pid of left) signal(pid, 'SIGKILL')
  return waitFree(dir, KILL_WAIT_MS)
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name)
  } catch {
    // gone already, or not ours to signal: what is left is reported
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const reservedError = (account: string): ProviderError =>
  new ProviderError('overloaded', `${account}'s login profile is reserved by the operator's login; the operation fails now and is retried later`)

export class ProfileContexts {
  private readonly held = new Map<string, Held>()
  private readonly launching = new Map<string, Promise<Held>>()
  private readonly closing = new Map<string, Promise<void>>()
  private readonly capturing = new Map<string, Promise<unknown>>()
  /** Open reservations per account (each release ends one). */
  private readonly reservations = new Map<string, number>()
  /** Accounts whose profile a process holds that could not be stopped, with what to do. */
  private readonly blocked = new Map<string, string>()
  private disposed = false

  constructor(private readonly host: ProfileHost) {}

  /** Accounts whose profile context is open. */
  accounts(): string[] {
    return [...this.held.keys()]
  }

  /** Open profiles, reservations, and profiles held by a process that could not be stopped (health). */
  states(): ProfileState[] {
    const ids = [...new Set([...this.held.keys(), ...this.reservations.keys(), ...this.blocked.keys()])].sort()
    return ids.map((account) => ({
      account,
      open: this.held.has(account),
      pages: this.held.get(account)?.pages ?? 0,
      reserved: this.reservations.has(account),
      ...(this.blocked.has(account) ? { blocked: this.blocked.get(account)! } : {}),
    }))
  }

  /**
   * A page of the account's persistent context on its login profile, opened lazily, one launch at
   * a time. Closing the turn closes its page only; the context closes when idle.
   */
  async open(account: string, dir: string, gapMs: number, signal: AbortSignal | undefined): Promise<ProfileTurn> {
    if (this.reservations.has(account)) throw reservedError(account)
    const held = await abortable(this.ensure(account, dir), signal)
    // Reserved, or closed, while it launched: never a page in a context that is going away.
    if (this.reservations.has(account)) throw reservedError(account)
    if (this.held.get(account) !== held) throw new ProviderError('session_broken', `the login profile of ${account} closed while it opened`)
    held.pages++
    clearTimeout(held.idle)
    let page: Page
    try {
      // Spaced page loads: each open takes the next free slot, so concurrent opens queue.
      const at = Math.max(Date.now(), held.nextOpen)
      held.nextOpen = at + gapMs
      if (at > Date.now()) await abortable(sleep(at - Date.now(), undefined, { ref: false }), signal)
      page = await abortable(held.context.newPage(), signal, (late) => void late.close().catch(() => undefined))
    } catch (error) {
      this.release(account, held)
      throw error
    }
    const onAbort = (): void => void page.close().catch(() => undefined)
    signal?.addEventListener('abort', onAbort, { once: true })
    let closed = false
    const close = async (): Promise<void> => {
      if (closed) return
      closed = true
      signal?.removeEventListener('abort', onAbort)
      await page.close().catch(() => undefined)
      this.release(account, held)
    }
    page.once('close', () => void close())
    return { context: held.context, page, close }
  }

  /**
   * Run `run` in a page of the profile: in place when the account holds it open (or is opening
   * it), else in a launch of its own that restores the operator's last session and is closed
   * afterwards (the Save after a remote login). One capture per account at a time, and no launch
   * for turns meanwhile.
   */
  async capture<T>(account: string, dir: string, run: (page: Page, context: BrowserContext) => Promise<T>): Promise<T> {
    if (!this.reservations.has(account) && (this.held.has(account) || this.launching.has(account))) {
      const held = await this.ensure(account, dir)
      held.pages++
      clearTimeout(held.idle)
      try {
        const page = await held.context.newPage()
        try {
          return await run(page, held.context)
        } finally {
          await page.close().catch(() => undefined)
        }
      } finally {
        this.release(account, held)
      }
    }
    const previous = this.capturing.get(account)
    const task = (async () => {
      await previous?.catch(() => undefined)
      await this.closing.get(account)?.catch(() => undefined)
      ensurePrivateDir(dir)
      // The operator's own browser may still be exiting: it is waited for, never stopped.
      const users = await waitFree(dir, EXIT_WAIT_MS)
      if (users.length) throw new ProviderError('session_broken', `login profile ${dir} is in use by process ${users.join(', ')}; close that browser first`)
      clearLockFiles(dir)
      const { context } = await this.host.launch(dir, true)
      try {
        const page = context.pages()[0] ?? (await context.newPage())
        return await run(page, context)
      } finally {
        await this.shutDown(account, dir, context).catch(() => undefined)
      }
    })()
    this.capturing.set(account, task)
    try {
      return await task
    } finally {
      if (this.capturing.get(account) === task) this.capturing.delete(account)
    }
  }

  /**
   * Reserve the profile for the operator's own browser (a remote login). Refused while pages are
   * open. Otherwise the context is closed, and its Chrome has exited (or been stopped) before this
   * returns. A browser left on the profile by a crashed host is stopped too. Until every
   * reservation is released, profile turns fail as `overloaded`.
   */
  async reserve(account: string, dir: string): Promise<() => void> {
    const pages = this.held.get(account)?.pages ?? 0
    if (pages > 0) throw new ProviderError('overloaded', `${account}'s login profile has ${pages} operation(s) running; try the login again when they finish`)
    const first = !this.reservations.has(account)
    this.reservations.set(account, (this.reservations.get(account) ?? 0) + 1)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      const left = (this.reservations.get(account) ?? 1) - 1
      if (left > 0) this.reservations.set(account, left)
      else this.reservations.delete(account)
    }
    try {
      await this.launching.get(account)?.catch(() => undefined)
      await this.capturing.get(account)?.catch(() => undefined)
      await this.close(account)
      // Under an earlier reservation, a browser on the profile is the operator's own: never stopped.
      if (first) await this.evict(account, dir)
    } catch (error) {
      release()
      throw error
    }
    return release
  }

  /** Close the account's context and wait until its Chrome has exited (stopped after a bound). */
  close(account: string): Promise<void> {
    const pending = this.closing.get(account)
    if (pending) return pending
    const held = this.held.get(account)
    if (!held) return Promise.resolve()
    this.held.delete(account)
    clearTimeout(held.idle)
    const done = this.shutDown(account, held.dir, held.context).finally(() => this.closing.delete(account))
    this.closing.set(account, done)
    return done
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.launching.values(), ...this.capturing.values()])
    await Promise.allSettled([...this.held.keys()].map((account) => this.close(account)))
    await Promise.allSettled(this.closing.values())
  }

  private ensure(account: string, dir: string): Promise<Held> {
    if (this.disposed) return Promise.reject(new ProviderError('session_broken', 'browser-patchright is disposed'))
    const existing = this.held.get(account)
    if (existing) {
      if (existing.dir !== dir) return Promise.reject(new ProviderError('internal', `${account}'s login profile is already open at another path`))
      return Promise.resolve(existing)
    }
    let launch = this.launching.get(account)
    if (!launch) {
      launch = this.launchHeld(account, dir).finally(() => this.launching.delete(account))
      this.launching.set(account, launch)
    }
    return launch
  }

  private async launchHeld(account: string, dir: string): Promise<Held> {
    // Never beside a close or a Save still using the directory.
    await this.closing.get(account)?.catch(() => undefined)
    await this.capturing.get(account)?.catch(() => undefined)
    if (this.reservations.has(account)) throw reservedError(account)
    ensurePrivateDir(dir)
    await this.evict(account, dir)
    let context: BrowserContext
    let lost: AbortSignal
    try {
      // No session restore: restored tabs would all load the site at once, unpaced.
      ;({ context, lost } = await this.host.launch(dir, false))
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError('session_broken', `the login profile of ${account} failed to open: ${(error as Error).message}`, { cause: error })
    }
    const held: Held = { context, dir, pages: 0, nextOpen: 0 }
    const onLost = (): void => void this.close(account)
    lost.addEventListener('abort', onLost, { once: true })
    context.once('close', () => {
      lost.removeEventListener('abort', onLost)
      if (this.held.get(account) === held) {
        this.held.delete(account)
        clearTimeout(held.idle)
      }
    })
    if (this.disposed || this.reservations.has(account) || lost.aborted) {
      await this.shutDown(account, dir, context).catch(() => undefined)
      throw this.reservations.has(account) ? reservedError(account) : new ProviderError('session_broken', 'browser-patchright is disposed or the display was lost')
    }
    this.held.set(account, held)
    return held
  }

  /**
   * A process still running Chrome on a profile that nothing here holds was left by a crashed
   * host: an automation browser, or a login browser. It is stopped within a bound. One that cannot
   * be stopped blocks the account, and health shows what to do.
   */
  private async evict(account: string, dir: string): Promise<void> {
    const users = profileUsers(dir)
    if (users.length) {
      if (process.platform !== 'linux') throw new ProviderError('session_broken', `login profile ${dir} is in use by process ${users.join(', ')}; close that browser first`)
      this.host.report('browser.profile-orphan', { account, pids: users })
      const left = await stopUsers(dir, users)
      if (left.length) {
        const why = `process ${left.join(', ')} still runs Chrome on ${account}'s login profile and could not be stopped: stop it, then retry`
        this.blocked.set(account, why)
        throw new ProviderError('session_broken', why)
      }
    }
    this.blocked.delete(account)
    clearLockFiles(dir)
  }

  /** Close a context and wait until its Chrome has exited; one that will not, within the bound, is stopped. */
  private async shutDown(account: string, dir: string, context: BrowserContext): Promise<void> {
    await closeWithin(context)
    let users = await waitFree(dir, EXIT_WAIT_MS)
    // Nothing else can run on a profile this context held: what is left is its own wedged browser.
    if (users.length && process.platform === 'linux') users = await stopUsers(dir, users)
    if (users.length) {
      const why = `process ${users.join(', ')} still runs Chrome on ${account}'s login profile after it was closed: stop it, then retry`
      this.blocked.set(account, why)
      throw new ProviderError('session_broken', why)
    }
    clearLockFiles(dir)
  }

  private release(account: string, held: Held): void {
    held.pages = Math.max(0, held.pages - 1)
    if (held.pages > 0 || this.held.get(account) !== held) return
    clearTimeout(held.idle)
    held.idle = setTimeout(() => {
      if (held.pages === 0 && this.held.get(account) === held) void this.close(account).catch(() => undefined)
    }, this.host.closeAfterMs())
    held.idle.unref()
  }
}
