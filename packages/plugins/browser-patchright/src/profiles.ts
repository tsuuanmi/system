/**
 * Login profiles as the automation uses them (ADR-0030): one persistent context per
 * session-bound account, the operator's reservations, the Save flow's captures, and who holds
 * a profile directory.
 *
 * - **In use.** A profile counts as in use only while a process on this host runs Chrome on it
 *   (`--user-data-dir=<dir>` in its command line, read from /proc). A lock file proves nothing
 *   on its own: its pid may have been reused, or it may name another host. Elsewhere than Linux,
 *   the lock's live local pid is all there is.
 * - **Stopped.** Only a browser `system` started is ever stopped: it carries
 *   `OWNED_PROFILE_SWITCH`, as the automation's launches and the remote login's browser do. Any
 *   other process on a profile, such as a browser the operator opened, blocks the account until it
 *   closes. It is never signalled.
 * - **One at a time.** Launches, standalone captures, and a reservation's close-and-evict run one
 *   at a time per account.
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ensurePrivateDir } from '@tsuuanmi/system-libs'
import { OWNED_PROFILE_SWITCH, type ProfileState, ProviderError } from '@tsuuanmi/system-provider-core'
import type { BrowserContext, Page } from 'patchright-core'
import { abortable, closeWithin } from './async.ts'

/** How long a closed profile's Chrome may take to exit before it is stopped. */
const EXIT_WAIT_MS = 10_000
/** How long a stopped process may take to go after SIGTERM, then after SIGKILL. */
const STOP_GRACE_MS = 3000
const KILL_WAIT_MS = 5000
/** A page that does not open in a held context within this is a wedged browser (INV-9). */
const PAGE_OPEN_MS = 30_000

export interface ProfileHost {
  /** Launch Chrome on a login profile, headed on the invisible display, marked as owned, with session restore. */
  launch(dir: string): Promise<{ context: BrowserContext; lost: AbortSignal }>
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

export interface ProfileUser {
  pid: number
  /** The browser process itself, not one of its children (`--type=…`), which exit with it. */
  browser: boolean
  /** A browser `system` started (it carries `OWNED_PROFILE_SWITCH`): it may be stopped. */
  owned: boolean
}

/**
 * Processes on this host running Chrome on `dir`: the browser, and its children (which name the
 * profile too, but carry no switch of the browser's). Chrome rewrites its command line into one
 * space-separated string, so arguments are matched by their space boundaries, not as NUL-separated
 * entries.
 */
export function profileUsers(dir: string): ProfileUser[] {
  if (process.platform !== 'linux') return lockHolder(dir)
  const dirs = [...new Set([dir, resolve(dir)])]
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return lockHolder(dir)
  }
  const users: ProfileUser[] = []
  for (const name of entries) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
    let cmdline: string
    try {
      cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8')
    } catch {
      continue
    }
    const user = profileUser(cmdline, dirs)
    if (user) users.push({ pid: Number(name), ...user })
  }
  return users
}

/**
 * Whether a process's `/proc/<pid>/cmdline` runs Chrome on one of `dirs`, and as what.
 * - A NUL-separated command line is matched argument by argument, exactly.
 * - Chrome rewrites its own into one space-separated string. There, the profile path runs from
 *   `--user-data-dir=` to the next ` --` switch (or a last URL argument) and must equal a profile
 *   path. So a path with spaces, a path at the end of the line, a sibling such as `<dir>2`, and
 *   `/x/a` against `/x/a b` are all told apart.
 */
export function profileUser(cmdline: string, dirs: readonly string[]): { browser: boolean; owned: boolean } | undefined {
  const args = cmdline.replace(/\0+$/, '').split('\0')
  if (args.length > 1) {
    if (!args.some((arg) => dirs.some((dir) => arg === `--user-data-dir=${dir}`))) return undefined
    const browser = !args.some((arg) => arg.startsWith('--type='))
    return { browser, owned: browser && args.includes(OWNED_PROFILE_SWITCH) }
  }
  const line = ` ${args[0]} `
  const at = line.indexOf(' --user-data-dir=')
  if (at < 0) return undefined
  const rest = line.slice(at + ' --user-data-dir='.length)
  const next = rest.indexOf(' --')
  const value = (next < 0 ? rest : rest.slice(0, next)).trimEnd()
  // A last argument that is a URL (`about:blank`, `https://…`) may follow the path.
  const path = (candidate: string): boolean => dirs.some((dir) => candidate === dir || (candidate.startsWith(`${dir} `) && /^\S+:\S*$/.test(candidate.slice(dir.length + 1))))
  if (!path(value)) return undefined
  const browser = !line.includes(' --type=')
  return { browser, owned: browser && line.includes(` ${OWNED_PROFILE_SWITCH} `) }
}

/** Without /proc: the live local pid Chrome's `SingletonLock` (`<host>-<pid>`) names, if any; never stopped. */
function lockHolder(dir: string): ProfileUser[] {
  try {
    const lock = join(dir, 'SingletonLock')
    if (!lstatSync(lock).isSymbolicLink()) return []
    const match = /^(.*)-(\d+)$/.exec(readlinkSync(lock))
    return match && match[1] === hostname() && alive(Number(match[2])) ? [{ pid: Number(match[2]), browser: true, owned: false }] : []
  } catch {
    return []
  }
}

/** Remove the lock files of a browser that is gone; only when no process uses the profile. */
export function clearLockFiles(dir: string): void {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) rmSync(join(dir, name), { force: true })
}

/** Until none of `pids` (or, without `pids`, nobody) uses `dir`, or `ms` has passed: who still does. */
async function waitFree(dir: string, ms: number, pids?: readonly number[]): Promise<ProfileUser[]> {
  const deadline = Date.now() + ms
  for (;;) {
    const users = profileUsers(dir).filter((u) => !pids || pids.includes(u.pid))
    if (!users.length || Date.now() >= deadline) return users
    await sleep(100)
  }
}

/**
 * Stop exactly `pids` (browsers `system` started): SIGTERM, then SIGKILL for those of them still
 * there. A process that appeared meanwhile is never signalled. Returns those that could not be stopped.
 */
async function stopOwned(dir: string, pids: readonly number[]): Promise<number[]> {
  for (const pid of pids) signal(pid, 'SIGTERM')
  const left = await waitFree(dir, STOP_GRACE_MS, pids)
  for (const { pid } of left) signal(pid, 'SIGKILL')
  return (await waitFree(dir, KILL_WAIT_MS, pids)).map((u) => u.pid)
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

function within<T>(promise: Promise<T>, ms: number, what: string, onLate: (value: T) => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void promise.then(onLate, () => undefined)
        reject(new ProviderError('session_broken', what))
      }, ms)
      timer.unref()
    }),
  ])
}

const reservedError = (account: string): ProviderError =>
  new ProviderError('overloaded', `${account}'s login profile is reserved by the operator's login; the operation fails now and is retried later`)

export class ProfileContexts {
  private readonly held = new Map<string, Held>()
  private readonly launching = new Map<string, Promise<Held>>()
  private readonly closing = new Map<string, Promise<void>>()
  /** The tail of each account's one-at-a-time work: launches, standalone captures, a reservation's close-and-evict. */
  private readonly chains = new Map<string, Promise<unknown>>()
  /** Open reservations per account (each release ends one). */
  private readonly reservations = new Map<string, number>()
  /** Accounts whose profile a process holds that may not or could not be stopped, and what to do. */
  private readonly blocked = new Map<string, { dir: string; why: string }>()
  private disposed = false

  constructor(private readonly host: ProfileHost) {}

  /** Accounts whose profile context is open. */
  accounts(): string[] {
    return [...this.held.keys()]
  }

  /** Open profiles, reservations, and profiles held by a process that could not be stopped (health). */
  states(): ProfileState[] {
    // A blocked profile its process has since let go of is free again.
    for (const [account, { dir }] of this.blocked) if (!profileUsers(dir).length) this.blocked.delete(account)
    const ids = [...new Set([...this.held.keys(), ...this.reservations.keys(), ...this.blocked.keys()])].sort()
    return ids.map((account) => ({
      account,
      open: this.held.has(account),
      pages: this.held.get(account)?.pages ?? 0,
      reserved: this.reservations.has(account),
      ...(this.blocked.has(account) ? { blocked: this.blocked.get(account)!.why } : {}),
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
      page = await abortable(this.newPage(account, held), signal, (late) => void late.close().catch(() => undefined))
      // The turn's page is the active tab of its window, whatever else the profile has open.
      await abortable(page.bringToFront(), signal)
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
   * it), else in a launch of its own that is closed afterwards (the Save after a remote login).
   */
  async capture<T>(account: string, dir: string, run: (page: Page, context: BrowserContext) => Promise<T>): Promise<T> {
    if (!this.reservations.has(account) && (this.held.has(account) || this.launching.has(account))) {
      const held = await this.ensure(account, dir)
      held.pages++
      clearTimeout(held.idle)
      try {
        const page = await this.newPage(account, held)
        try {
          return await run(page, held.context)
        } finally {
          await page.close().catch(() => undefined)
        }
      } finally {
        this.release(account, held)
      }
    }
    return this.serial(account, async () => {
      await this.closing.get(account)?.catch(() => undefined)
      ensurePrivateDir(dir)
      // The operator's own browser may still be exiting: it is waited for, never stopped.
      const users = await waitFree(dir, EXIT_WAIT_MS)
      if (users.length) throw new ProviderError('session_broken', `login profile ${dir} is in use by process ${users.map((u) => u.pid).join(', ')}; close that browser first`)
      clearLockFiles(dir)
      const { context } = await this.host.launch(dir)
      try {
        const page = context.pages()[0] ?? (await context.newPage())
        return await run(page, context)
      } finally {
        await this.shutDown(account, dir, context).catch(() => undefined)
      }
    })
  }

  /**
   * Reserve the profile for the operator's own browser (a remote login). Refused while pages are
   * open. Otherwise the context is closed, and its Chrome has exited (or been stopped) before this
   * returns. A browser `system` left on the profile in a crash is stopped too. Until every
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
      // Under an earlier reservation the profile is the operator's already: nothing to free.
      if (first) {
        await this.serial(account, async () => {
          await this.close(account)
          await this.evict(account, dir)
        })
      }
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
    await Promise.allSettled([...this.launching.values(), ...this.chains.values()])
    await Promise.allSettled([...this.held.keys()].map((account) => this.close(account)))
    await Promise.allSettled(this.closing.values())
  }

  /** Run `task` after the account's earlier one-at-a-time work, and before its later work. */
  private serial<T>(account: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(account)
    const run = (async () => {
      await previous?.catch(() => undefined)
      return task()
    })()
    this.chains.set(account, run)
    void run.catch(() => undefined).finally(() => {
      if (this.chains.get(account) === run) this.chains.delete(account)
    })
    return run
  }

  private newPage(account: string, held: Held): Promise<Page> {
    return within(held.context.newPage(), PAGE_OPEN_MS, `the login profile of ${account} did not open a page in ${PAGE_OPEN_MS / 1000} s`, (late) => void late.close().catch(() => undefined))
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
      launch = this.serial(account, () => this.launchHeld(account, dir)).finally(() => this.launching.delete(account))
      this.launching.set(account, launch)
    }
    return launch
  }

  private async launchHeld(account: string, dir: string): Promise<Held> {
    // Never beside a close still using the directory.
    await this.closing.get(account)?.catch(() => undefined)
    if (this.reservations.has(account)) throw reservedError(account)
    ensurePrivateDir(dir)
    await this.evict(account, dir)
    let context: BrowserContext
    let lost: AbortSignal
    try {
      ;({ context, lost } = await this.host.launch(dir))
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError('session_broken', `the login profile of ${account} failed to open: ${(error as Error).message}`, { cause: error })
    }
    // Opened with session restore, so the profile's session-only cookies survive. The restored
    // tabs are blanked: each turn opens its own page, spaced.
    for (const restored of context.pages()) await restored.goto('about:blank').catch(() => undefined)
    const held: Held = { context, dir, pages: 0, nextOpen: 0 }
    const onLost = (): void => void this.close(account).catch(() => undefined)
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
   * Free a profile nothing here holds before using it. A browser `system` started and left in a
   * crash (an automation or a login browser) is stopped within a bound. Any other process on it,
   * such as a browser the operator opened, blocks the account until it closes, and is never signalled.
   */
  private async evict(account: string, dir: string): Promise<void> {
    const owned = profileUsers(dir).filter((u) => u.owned).map((u) => u.pid)
    if (owned.length) {
      this.host.report('browser.profile-orphan', { account, pids: owned })
      await stopOwned(dir, owned)
    }
    // A stopped browser's children exit after it.
    const users = await this.settle(dir)
    if (users.length) throw this.block(account, dir, users)
    this.blocked.delete(account)
    clearLockFiles(dir)
  }

  /** Who is left on `dir`: the processes of a browser that is gone may take a moment to follow it. */
  private async settle(dir: string): Promise<ProfileUser[]> {
    const users = profileUsers(dir)
    return users.length && !users.some((u) => u.browser) ? waitFree(dir, KILL_WAIT_MS) : users
  }

  /** Close a context and wait until its Chrome has exited; that browser, if still there after the bound, is stopped. */
  private async shutDown(account: string, dir: string, context: BrowserContext): Promise<void> {
    await closeWithin(context)
    const lingering = (await waitFree(dir, EXIT_WAIT_MS)).filter((u) => u.owned).map((u) => u.pid)
    if (lingering.length) await stopOwned(dir, lingering)
    const users = await this.settle(dir)
    if (users.length) throw this.block(account, dir, users)
    clearLockFiles(dir)
  }

  private block(account: string, dir: string, users: ProfileUser[]): ProviderError {
    const pids = users.map((u) => u.pid).join(', ')
    const browsers = users.filter((u) => u.browser)
    const why = browsers.length && browsers.every((u) => u.owned)
      ? `process ${pids} (a browser system started) still runs on ${account}'s login profile and could not be stopped: stop it, then retry`
      : browsers.length
        ? `process ${pids} has ${account}'s login profile open and was not started by system, so it is never stopped: close that browser, then retry`
        : `process ${pids} (left from a browser that is gone) still holds ${account}'s login profile: stop it, then retry`
    this.blocked.set(account, { dir, why })
    return new ProviderError('overloaded', why)
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
