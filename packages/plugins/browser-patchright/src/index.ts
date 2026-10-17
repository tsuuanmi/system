/**
 * `ctx.browser`: the provider runtime's browser (docs/design/browser-runtime.md
 * #browser-launch-ctxbrowser). One **headed** system Chrome per account, drawn on the
 * invisible `ctx.display` and driven by patchright-core; never headless, no fingerprint
 * spoofing, no debugging port (the default pipe transport). Each turn gets a fresh
 * context from the account's portable state; capture filters state back to the
 * driver's origins. A session-bound account's turns are pages of one persistent context on
 * its login profile instead (ADR-0030). Ported from tsuuanmi/internet `src/browser/runtime.ts` and
 * `chrome.ts`; launch and filter patterns from `@anweat/dsh-browser`
 * (docs/research/dsh-community-plugins-review.md#browser-runtime-second-pass-2026-10-11).
 * @module @tsuuanmi/system-browser-patchright
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Browser as BrowserSeam, OWNED_PROFILE_SWITCH, type PortableState, type PreparedDisplay, type ProfileState, ProviderError } from '@tsuuanmi/system-provider-core'
import { type Browser, type BrowserContext, type Page, chromium } from 'patchright-core'
import { abortable, closeWithin } from './async.ts'
import { discoverChrome } from './chrome.ts'
import { ProfileContexts } from './profiles.ts'
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
  /** The account's portable state; absent for a signed-out probe. Ignored with `profile`. */
  state?: PortableState | undefined
  /** A page of the account's persistent login-profile context, page opens spaced `gapMs` apart (ADR-0030). */
  profile?: { dir: string; gapMs?: number | undefined } | undefined
  /** Closes the turn's context when aborted, e.g. a lease invalidation; a profile turn's page. */
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
  /** Session-bound accounts' login profiles (ADR-0030). */
  private readonly profiles: ProfileContexts
  private disposed = false

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    this.profiles = new ProfileContexts({
      launch: async (dir) => {
        const display = await this.ctx.display.prepare('invisible')
        const chrome = discoverChrome(this.config.chromePath)
        if (!chrome) throw new ProviderError('config_error', 'no usable Chrome: run `system init` or set chromePath / CHROME_PATH')
        return { context: await launchProfile(dir, chrome.path, display), lost: display.lost }
      },
      closeAfterMs: () => this.config.closeAfterMs ?? 30 * 60_000,
      report: (type, data) => void this.ctx.get('eventLog')?.append({ type, data }),
    })
    ctx.effect(() => async () => {
      this.disposed = true
      await Promise.allSettled(this.launches.values())
      await this.profiles.dispose()
      await Promise.allSettled([...this.browsers.keys()].map((account) => this.close(account)))
    })
  }

  executablePath(): string | undefined {
    return discoverChrome(this.config.chromePath)?.path
  }

  /** Accounts with a running browser (a turn browser, or a login-profile context). */
  openAccounts(): string[] {
    return [...new Set([...this.browsers.keys(), ...this.profiles.accounts()])]
  }

  /** A fresh, isolated context and page for one turn on the account's browser (or a profile page). */
  async openTurn(account: string, options: OpenTurnOptions = {}): Promise<Turn> {
    options.signal?.throwIfAborted()
    if (options.profile) return this.profiles.open(account, options.profile.dir, options.profile.gapMs ?? 0, options.signal)
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
    return this.stateOf(await turn.context.storageState({ indexedDB: true }), options)
  }

  /**
   * The Save flow's capture step (docs/design/browser-runtime.md#save-both-modes): reopen an
   * account's login profile headed on the invisible display, let the driver `inspect` the
   * page (auth, identity), and capture the portable state for `origins`. The state stays
   * in memory; the caller verifies it and stores it encrypted. A profile already held open
   * for turns is used in place, in a page of its own, and stays open.
   */
  async captureProfile<T>(account: string, profileDir: string, options: { url: string; origins: string[]; previous?: PortableState | undefined; inspect: (page: Page) => Promise<T> }): Promise<{ state: PortableState; result: T }> {
    return this.profiles.capture(account, profileDir, async (page, context) => {
      await page.goto(options.url, { waitUntil: 'domcontentloaded' })
      const result = await options.inspect(page)
      return { state: this.stateOf(await context.storageState({ indexedDB: true }), options), result }
    })
  }

  /**
   * Reserve the account's login profile for the operator's own browser: refused while profile
   * turns are open; otherwise its context is closed (its browser exited) and profile turns fail
   * as `overloaded` until the release is called.
   */
  reserveProfile(account: string, dir: string): Promise<() => void> {
    return this.profiles.reserve(account, dir)
  }

  profileStates(): ProfileState[] {
    return this.profiles.states()
  }

  /** Closes the account's browser, its login-profile context, and every context on them. */
  async close(account: string): Promise<void> {
    await this.profiles.close(account).catch(() => undefined)
    const managed = this.browsers.get(account)
    if (!managed) return
    this.browsers.delete(account)
    clearTimeout(managed.idle)
    await managed.browser.close().catch(() => undefined)
  }

  private stateOf(raw: unknown, options: { origins: string[]; previous?: PortableState | undefined }): PortableState {
    return fromStorageState(raw as StorageState, {
      origins: options.origins,
      previous: options.previous,
      now: new Date().toISOString(),
      maxIndexedDbBytes: this.config.maxIndexedDbBytes ?? 16 * 1024 * 1024,
    })
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
 * A login profile, headed on the invisible display, marked as a browser `system` started. It
 * reopens the last session, so the profile's session-only cookies survive.
 */
function launchProfile(dir: string, executablePath: string, display: PreparedDisplay): Promise<BrowserContext> {
  return chromium.launchPersistentContext(dir, {
    executablePath,
    headless: false,
    env: { ...process.env, ...display.env },
    viewport: display.viewport,
    ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
    args: ['--restore-last-session', '--disable-background-mode', OWNED_PROFILE_SWITCH, ...CHROME_ARGS, ...display.windowArgs],
  })
}

export default BrowserPool
