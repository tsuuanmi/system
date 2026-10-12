/**
 * The `ctx.browser` seam (docs/design/browser-runtime.md#browser-launch-ctxbrowser): headed
 * browsers per account on the invisible `ctx.display`. Generic over the engine's page and
 * context types, so this definition names no engine; `@tsuuanmi/system-browser-patchright`
 * provides it.
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import type { PortableState } from './state.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browser: Browser
  }
}

export interface OpenTurnOptions {
  /** The account's portable state; absent for a signed-out probe. */
  state?: PortableState | undefined
  /** Closes the turn's context when aborted (e.g. a lease invalidation). */
  signal?: AbortSignal | undefined
}

export interface BrowserTurn<Page = unknown, BrowserContext = unknown> {
  context: BrowserContext
  page: Page
  close(): Promise<void>
}

export interface CaptureProfileOptions<Page, T> {
  url: string
  origins: string[]
  previous?: PortableState | undefined
  inspect: (page: Page) => Promise<T>
}

export abstract class Browser<Page = unknown, BrowserContext = unknown> extends Service {
  constructor(ctx: Context) {
    super(ctx, 'browser')
  }

  /** A fresh, isolated context and page for one turn on the account's browser. */
  abstract openTurn(account: string, options?: OpenTurnOptions): Promise<BrowserTurn<Page, BrowserContext>>
  /** The turn's state for `origins` only; IndexedDB over the cap keeps `previous`. */
  abstract capture(turn: BrowserTurn<Page, BrowserContext>, options: { origins: string[]; previous?: PortableState | undefined }): Promise<PortableState>
  /** Reopen a login profile invisibly, let `inspect` read it, and capture its state in memory (the Save flow). */
  abstract captureProfile<T>(profileDir: string, options: CaptureProfileOptions<Page, T>): Promise<{ state: PortableState; result: T }>
  /** Close the account's browser and every context on it. */
  abstract close(account: string): Promise<void>
  /** Accounts with a running browser. */
  abstract openAccounts(): string[]
  /** The browser executable this provider launches (remote login starts the same browser, without automation). */
  abstract executablePath(): string | undefined
}
