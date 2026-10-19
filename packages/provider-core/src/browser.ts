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
  /** The account's portable state; absent for a signed-out probe. Ignored with `profile`. */
  state?: PortableState | undefined
  /**
   * A session-bound account (ADR-0030): the turn is a page (tab) of one persistent context on
   * the account's login profile `dir`, never a fresh context from portable state. Page opens of
   * one account are spaced at least `gapMs` apart. With `keep` (a session id), the session's kept
   * tab is handed back (brought to the front, no new page, not paced) when there is one, and the
   * turn's `close` keeps its page for the session's next turn. With `pace`, page opens of every
   * account sharing its `key` (one provider's accounts, which share the host's address) are also
   * spaced `pace.gapMs` apart (PROP-0007).
   */
  profile?: { dir: string; gapMs?: number | undefined; keep?: string | undefined; pace?: { key: string; gapMs: number } | undefined } | undefined
  /** Closes the turn's context when aborted (e.g. a lease invalidation); a profile turn's page. */
  signal?: AbortSignal | undefined
}

export interface BrowserTurn<Page = unknown, BrowserContext = unknown> {
  context: BrowserContext
  page: Page
  /** Closes the turn; a profile turn opened with `keep` keeps its page instead, as the session's tab. */
  close(): Promise<void>
  /** Closes the turn's page for good, kept or not (after a failure, or a page left busy). */
  discard?(): Promise<void>
  /** The page is the session's kept tab, handed back. */
  reused?: boolean
}

/**
 * A command-line switch on every browser `system` starts on a login profile: the automation's,
 * and the remote login's. Only a process carrying it is ever stopped to free a profile. Chrome
 * ignores a switch it does not know.
 */
export const OWNED_PROFILE_SWITCH = '--system-owned-profile'

/** A login profile the browser holds, reserves, or cannot free (ADR-0030; health shows it). */
export interface ProfileState {
  account: string
  /** Its persistent context is open. */
  open: boolean
  /** Pages open in it now, in use by an operation. */
  pages: number
  /** Kept tabs: sessions' idle pages, waiting for their next turn (ADR-0030). */
  kept: number
  /** The operator's login holds it: its operations fail as `overloaded` meanwhile. */
  reserved: boolean
  /** A process holds it that could not be stopped, and what to do. */
  blocked?: string
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

  /**
   * A fresh, isolated context and page for one turn on the account's browser; with `profile`,
   * a page of the account's persistent login-profile context. A profile turn while the profile
   * is reserved fails as `overloaded`.
   */
  abstract openTurn(account: string, options?: OpenTurnOptions): Promise<BrowserTurn<Page, BrowserContext>>
  /**
   * Reserve the account's login profile `dir` for the operator's own browser (a remote login).
   * Refused (`overloaded`) while profile turns are open. Otherwise the persistent context is
   * closed and its browser has exited before this returns, and profile turns fail as `overloaded`
   * until the returned release is called (each reservation releases once).
   */
  abstract reserveProfile(account: string, dir: string): Promise<() => void>
  /** Login profiles held open, reserved, or held by a process that could not be stopped. */
  abstract profileStates(): ProfileState[]
  /** The most login-profile browsers it keeps open at once; 0 is no cap (PROP-0007). */
  browserCap(): number {
    return 0
  }
  /** Close a session's kept tab, if any (the session ended, or its conversation was lost). */
  abstract discardTab(account: string, keep: string): Promise<void>
  /** The turn's state for `origins` only; IndexedDB over the cap keeps `previous`. */
  abstract capture(turn: BrowserTurn<Page, BrowserContext>, options: { origins: string[]; previous?: PortableState | undefined }): Promise<PortableState>
  /**
   * Reopen the account's login profile invisibly, let `inspect` read it, and capture its state in
   * memory (the Save flow). A profile the pool already holds open for turns is used in place, in a
   * new page. One capture per account at a time.
   */
  abstract captureProfile<T>(account: string, profileDir: string, options: CaptureProfileOptions<Page, T>): Promise<{ state: PortableState; result: T }>
  /** Close the account's browser and every context on it. */
  abstract close(account: string): Promise<void>
  /** Accounts with a running browser. */
  abstract openAccounts(): string[]
  /** The browser executable this provider launches (remote login starts the same browser, without automation). */
  abstract executablePath(): string | undefined
}
