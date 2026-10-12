/**
 * `ctx.browser`: the provider runtime's browser (docs/design/browser-runtime.md
 * #browser-launch-ctxbrowser). One **headed** system Chrome per account, drawn on the
 * invisible `ctx.display` and driven by patchright-core; never headless, no fingerprint
 * spoofing, no debugging port (the default pipe transport). Each turn gets a fresh
 * context from the account's portable state; capture filters state back to the
 * driver's origins. Ported from tsuuanmi/internet `src/browser/runtime.ts` and
 * `chrome.ts`; launch and filter patterns from `@anweat/dsh-browser`
 * (docs/research/dsh-community-plugins-review.md#browser-runtime-second-pass-2026-10-11).
 * @module @tsuuanmi/system-browser-patchright
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { abortReason, Browser as BrowserSeam, type PortableState, type PreparedDisplay, ProviderError } from '@tsuuanmi/system-provider-core'
import { lstatSync, readlinkSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { ensurePrivateDir } from '@tsuuanmi/system-libs'
import { type Browser, type BrowserContext, type Page, chromium } from 'patchright-core'
import { discoverChrome } from './chrome.ts'
import { type StorageState, fromStorageState, toStorageState } from './state.ts'

export { CHROME_LOCK, type ChromeChoice, type ChromeLock, discoverChrome, engineChromiumMajor, installManagedChrome, managedBrowsersDir, managedChromePath } from './chrome.ts'
export { type CaptureOptions, type StorageState, fromStorageState, toStorageState } from './state.ts'


/** Pages render and update as if in the foreground (docs/design/browser-runtime.md#display-modes-ctxdisplay). */
export const CHROME_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
]
/** Keep the sandbox and the OS keyring; never advertise automation. */
export const IGNORED_DEFAULT_ARGS = ['--no-sandbox', '--password-store=basic', '--use-mock-keychain', '--enable-automation']

export interface Config {
  /** Chrome executable; defaults to `CHROME_PATH`, a recent system Chrome, then the managed build. */
  chromePath?: string
  /** Close an account's browser after this long without an open turn (default 30 min). */
  closeAfterMs?: number
  /** Serialized IndexedDB above this size keeps the previous capture (default 16 MiB). */
  maxIndexedDbBytes?: number
}

export interface OpenTurnOptions {
  /** The account's portable state; absent for a signed-out probe. */
  state?: PortableState | undefined
  /** Closes the turn's context when aborted, e.g. a lease invalidation. */
  signal?: AbortSignal | undefined
}

export interface Turn {
  context: BrowserContext
  page: Page
  close(): Promise<void>
}

/** The engine's typed storage state; `state.ts` keeps entries as plain records. */
type EngineStorageState = NonNullable<NonNullable<Parameters<Browser['newContext']>[0]>['storageState']>

interface Managed {
  browser: Browser
  display: PreparedDisplay
  turns: number
  idle?: NodeJS.Timeout | undefined
}

export class BrowserPool extends BrowserSeam<Page, BrowserContext> {
  static inject = ['display']

  static Config: z<Config> = z.object({
    chromePath: z.string().description('Chrome executable; defaults to CHROME_PATH, a recent system Chrome, then the managed build'),
    closeAfterMs: z.natural().default(30 * 60_000).description('Idle time before an account browser closes, in milliseconds'),
    maxIndexedDbBytes: z.natural().default(16 * 1024 * 1024).description('IndexedDB capture size cap in bytes'),
  })

  private readonly browsers = new Map<string, Managed>()
  private readonly launches = new Map<string, Promise<Managed>>()
  private disposed = false

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    ctx.effect(() => async () => {
      this.disposed = true
      await Promise.allSettled(this.launches.values())
      await Promise.allSettled([...this.browsers.keys()].map((account) => this.close(account)))
    })
  }

  executablePath(): string | undefined {
    return discoverChrome(this.config.chromePath)?.path
  }

  /** Accounts with a running browser. */
  openAccounts(): string[] {
    return [...this.browsers.keys()]
  }

  /** A fresh, isolated context and page for one turn on the account's browser. */
  async openTurn(account: string, options: OpenTurnOptions = {}): Promise<Turn> {
    options.signal?.throwIfAborted()
    // A launch can stall (display, Chrome, a new context under load); an aborted turn never waits
    // for it. A browser that arrives late stays pooled (closed when idle); a late context is closed.
    const managed = await abortable(this.ensure(account), options.signal)
    managed.turns++
    clearTimeout(managed.idle)
    let context: BrowserContext
    try {
      context = await abortable(managed.browser.newContext({
        storageState: toStorageState(options.state) as EngineStorageState,
        viewport: managed.display.viewport,
      }), options.signal, (late) => void late.close().catch(() => undefined))
    } catch (error) {
      this.release(account, managed)
      throw error
    }
    if (options.signal?.aborted) {
      await closeWithin(context)
      this.release(account, managed)
      options.signal.throwIfAborted()
    }
    const onAbort = (): void => void closeWithin(context)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    let closed = false
    const close = async (): Promise<void> => {
      if (closed) return
      closed = true
      options.signal?.removeEventListener('abort', onAbort)
      await closeWithin(context)
      this.release(account, managed)
    }
    context.once('close', () => void close())
    try {
      // The engine enables focus emulation on every page, so background windows still
      // behave as focused; tests/browser.spec.ts guards that.
      // newPage can hang if the context closes under it (an abort racing it, live 2026-10-12).
      const page = await abortable(context.newPage(), options.signal)
      return { context, page, close }
    } catch (error) {
      await close()
      throw error
    }
  }

  /** The turn's state for `origins` only; IndexedDB over the cap keeps `previous`. */
  async capture(turn: Turn, options: { origins: string[]; previous?: PortableState | undefined }): Promise<PortableState> {
    const raw = await turn.context.storageState({ indexedDB: true })
    return fromStorageState(raw as unknown as StorageState, {
      origins: options.origins,
      previous: options.previous,
      now: new Date().toISOString(),
      maxIndexedDbBytes: this.config.maxIndexedDbBytes ?? 16 * 1024 * 1024,
    })
  }

  /**
   * The Save flow's capture step (docs/design/browser-runtime.md#save-both-modes): reopen an
   * account's login profile headed on the invisible display, let the driver `inspect` the
   * page (auth, identity), and capture the portable state for `origins`. The state stays
   * in memory; the caller verifies it and stores it encrypted.
   */
  async captureProfile<T>(profileDir: string, options: { url: string; origins: string[]; previous?: PortableState | undefined; inspect: (page: Page) => Promise<T> }): Promise<{ state: PortableState; result: T }> {
    ensurePrivateDir(profileDir)
    releaseStaleProfileLock(profileDir)
    const display = await this.ctx.display.prepare('invisible')
    const chrome = discoverChrome(this.config.chromePath)
    if (!chrome) throw new ProviderError('config_error', 'no usable Chrome: run `system init` or set chromePath / CHROME_PATH')
    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath: chrome.path,
      headless: false,
      env: { ...process.env, ...display.env },
      viewport: display.viewport,
      ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
      // Session cookies survive the operator's browser → automated reopen only with session restore.
      args: ['--restore-last-session', '--disable-background-mode', ...CHROME_ARGS, ...display.windowArgs],
    })
    try {
      const page = context.pages()[0] ?? (await context.newPage())
      await page.goto(options.url, { waitUntil: 'domcontentloaded' })
      const result = await options.inspect(page)
      const raw = await context.storageState({ indexedDB: true })
      const state = fromStorageState(raw as unknown as StorageState, {
        origins: options.origins,
        previous: options.previous,
        now: new Date().toISOString(),
        maxIndexedDbBytes: this.config.maxIndexedDbBytes ?? 16 * 1024 * 1024,
      })
      return { state, result }
    } finally {
      await context.close().catch(() => undefined)
      releaseStaleProfileLock(profileDir)
    }
  }

  /** Closes the account's browser and every context on it. */
  async close(account: string): Promise<void> {
    const managed = this.browsers.get(account)
    if (!managed) return
    this.browsers.delete(account)
    clearTimeout(managed.idle)
    await managed.browser.close().catch(() => undefined)
  }

  private ensure(account: string): Promise<Managed> {
    if (this.disposed) return Promise.reject(new ProviderError('session_broken', 'browser-patchright is disposed'))
    const existing = this.browsers.get(account)
    if (existing?.browser.isConnected() && !existing.display.lost.aborted) return Promise.resolve(existing)
    let launch = this.launches.get(account)
    if (!launch) {
      launch = this.launch(account).finally(() => this.launches.delete(account))
      this.launches.set(account, launch)
    }
    return launch
  }

  private async launch(account: string): Promise<Managed> {
    if (this.browsers.has(account)) await this.close(account)
    const display = await this.ctx.display.prepare('invisible')
    const chrome = discoverChrome(this.config.chromePath)
    if (!chrome) {
      throw new ProviderError('config_error', 'no usable Chrome: run `system init` (installs the pinned managed Chrome), install a recent Chrome stable, or set chromePath / CHROME_PATH')
    }
    const executablePath = chrome.path
    let browser: Browser
    try {
      browser = await chromium.launch({
        executablePath,
        headless: false,
        env: { ...process.env, ...display.env },
        ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
        args: [...CHROME_ARGS, ...display.windowArgs],
      })
    } catch (error) {
      throw new ProviderError('config_error', `Chrome failed to launch (${executablePath}): ${(error as Error).message}`, { cause: error })
    }
    const managed: Managed = { browser, display, turns: 0 }
    const onLost = (): void => {
      if (this.browsers.get(account) === managed) void this.close(account)
      else void browser.close().catch(() => undefined)
    }
    display.lost.addEventListener('abort', onLost, { once: true })
    browser.once('disconnected', () => {
      display.lost.removeEventListener('abort', onLost)
      // A late event from an older process must not drop its replacement.
      if (this.browsers.get(account) === managed) {
        this.browsers.delete(account)
        clearTimeout(managed.idle)
      }
    })
    if (this.disposed || display.lost.aborted) {
      await browser.close().catch(() => undefined)
      throw new ProviderError('session_broken', this.disposed ? 'browser-patchright is disposed' : 'display was lost during launch')
    }
    this.browsers.set(account, managed)
    return managed
  }

  private release(account: string, managed: Managed): void {
    managed.turns = Math.max(0, managed.turns - 1)
    if (managed.turns > 0 || this.browsers.get(account) !== managed) return
    clearTimeout(managed.idle)
    managed.idle = setTimeout(() => {
      if (managed.turns === 0 && this.browsers.get(account) === managed) void this.close(account)
    }, this.config.closeAfterMs ?? 30 * 60_000)
    managed.idle.unref()
  }
}

/**
 * Chrome's `SingletonLock` names `<host>-<pid>` of the browser that owns a profile. A lock
 * held by a live process means the operator's login browser is still open: refuse. A lock
 * left by a dead process (or another host's leftover) is removed, as tsuuanmi/internet does.
 */
function releaseStaleProfileLock(profileDir: string): void {
  const lock = join(profileDir, 'SingletonLock')
  let target: string
  try {
    if (!lstatSync(lock).isSymbolicLink()) return
    target = readlinkSync(lock)
  } catch {
    return
  }
  const match = /^(.*)-(\d+)$/.exec(target)
  if (match && match[1] === hostname() && processAlive(Number(match[2]))) {
    throw new ProviderError('session_broken', `login profile ${profileDir} is in use by process ${match[2]}; close that browser first`)
  }
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) rmSync(join(profileDir, name), { force: true })
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export default BrowserPool

/** Close a context, but never wait more than `ms` for a wedged browser. */
async function closeWithin(context: BrowserContext, ms = 5000): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    context.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
      timer.unref()
    }),
  ])
  clearTimeout(timer)
}

/** `promise`, unless `signal` aborts first; then it rejects at once, and a late value goes to `onLate`. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, onLate?: (value: T) => void): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    void promise.then((value) => onLate?.(value), () => undefined)
    return Promise.reject(abortReason(signal, 'browser turn aborted'))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      void promise.then((value) => onLate?.(value), () => undefined)
      reject(abortReason(signal, 'browser turn aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) onLate?.(value)
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
