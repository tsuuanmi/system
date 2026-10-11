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
import { existsSync } from 'node:fs'
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { type PortableState, type PreparedDisplay, ProviderError } from '@tsuuanmi/system-provider-core'
import { type Browser, type BrowserContext, type Page, chromium } from 'patchright-core'
import { type StorageState, fromStorageState, toStorageState } from './state.ts'

export { type CaptureOptions, type StorageState, fromStorageState, toStorageState } from './state.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browser: BrowserPool
  }
}

const STANDARD_CHROME_PATHS = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']

/**
 * The configured path, then `CHROME_PATH`, then standard locations. There is no bundled
 * fallback: provider turns run the operator's real Chrome (ADR-0016).
 */
export function discoverChrome(configured: string | undefined, standard: readonly string[] = STANDARD_CHROME_PATHS): string | undefined {
  if (configured !== undefined) {
    if (!existsSync(configured)) throw new ProviderError('config_error', `configured Chrome path does not exist: ${configured}`)
    return configured
  }
  return [process.env.CHROME_PATH ?? '', ...standard].find((path) => path.length > 0 && existsSync(path))
}

/** Pages render and update as if in the foreground (docs/design/browser-runtime.md#display-modes-ctxdisplay). */
const CHROME_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
]
/** Keep the sandbox and the OS keyring; never advertise automation. */
const IGNORED_DEFAULT_ARGS = ['--no-sandbox', '--password-store=basic', '--use-mock-keychain', '--enable-automation']

export interface Config {
  /** Chrome executable; defaults to `CHROME_PATH`, then standard install locations. */
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

export class BrowserPool extends Service {
  static inject = ['display']

  static Config: z<Config> = z.object({
    chromePath: z.string().description('Chrome executable; defaults to CHROME_PATH, then standard locations'),
    closeAfterMs: z.natural().default(30 * 60_000).description('Idle time before an account browser closes, in milliseconds'),
    maxIndexedDbBytes: z.natural().default(16 * 1024 * 1024).description('IndexedDB capture size cap in bytes'),
  })

  private readonly browsers = new Map<string, Managed>()
  private readonly launches = new Map<string, Promise<Managed>>()
  private disposed = false

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'browser')
    ctx.effect(() => async () => {
      this.disposed = true
      await Promise.allSettled(this.launches.values())
      await Promise.allSettled([...this.browsers.keys()].map((account) => this.close(account)))
    })
  }

  /** Accounts with a running browser. */
  openAccounts(): string[] {
    return [...this.browsers.keys()]
  }

  /** A fresh, isolated context and page for one turn on the account's browser. */
  async openTurn(account: string, options: OpenTurnOptions = {}): Promise<Turn> {
    options.signal?.throwIfAborted()
    const managed = await this.ensure(account)
    managed.turns++
    clearTimeout(managed.idle)
    let context: BrowserContext
    try {
      context = await managed.browser.newContext({
        storageState: toStorageState(options.state) as EngineStorageState,
        viewport: managed.display.viewport,
      })
    } catch (error) {
      this.release(account, managed)
      throw error
    }
    const onAbort = (): void => void context.close().catch(() => undefined)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    let closed = false
    const close = async (): Promise<void> => {
      if (closed) return
      closed = true
      options.signal?.removeEventListener('abort', onAbort)
      await context.close().catch(() => undefined)
      this.release(account, managed)
    }
    context.once('close', () => void close())
    try {
      // The engine enables focus emulation on every page, so background windows still
      // behave as focused; tests/browser.spec.ts guards that.
      const page = await context.newPage()
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
    const executablePath = discoverChrome(this.config.chromePath)
    if (!executablePath) {
      throw new ProviderError('config_error', 'Google Chrome was not found: install Chrome (stable) or set chromePath / CHROME_PATH')
    }
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

export default BrowserPool
