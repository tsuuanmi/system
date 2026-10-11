/**
 * The provider driver contract (ADR-0005, docs/design/provider-turns.md#driver-interface,
 * docs/design/browser-runtime.md#accounts-ctxaccounts-provider-agnostic-multi-account).
 * Generic over the page type so this package stays engine-free.
 */
import type { TurnSnapshot } from './reconcile.ts'

export type AuthState = 'signed-in' | 'signed-out' | 'unknown'
export type ConversationMode = 'temporary' | 'persistent'

/** A model selection as the website names it; either part may be left to the site. */
export interface ProviderMode {
  model?: string
  /** Reasoning effort level (ChatGPT calls it Power: Instant, Medium, High). */
  effort?: string
}

export type ProviderFeature = 'chat' | 'deep-research'

export interface AskOptions {
  conversation: ConversationMode
  /** Name of a configured mode preset; the driver's default preset when absent. */
  mode?: string | undefined
  /** `deep-research` needs a persistent conversation. Default `chat`. */
  feature?: ProviderFeature | undefined
  /** Persistent conversation to continue. */
  binding?: string | undefined
  signal?: AbortSignal
  /** Two-clock completion deadlines for this turn; the driver's defaults when absent. */
  deadlines?: { timeoutMs: number; stallTimeoutMs: number } | undefined
  /**
   * Called after the prompt is in the composer and the mode is verified, immediately
   * before the send. The runtime persists the turn receipt here (INV-4); a throw aborts
   * the turn without sending. `previousResponse` is the last answer already in the
   * conversation (null for a new one), the boundary used by reconciliation.
   */
  beforeSend?: (boundary: { previousResponse: string | null; mode: ProviderMode }) => void | Promise<void>
  /**
   * Called once, as soon as a new persistent conversation has its canonical id (before the
   * answer completes), so a crash mid-answer can still be reconciled by reopening it.
   */
  onBinding?: (binding: string) => void
}

export interface AskResult {
  text: string
  /** Canonical conversation id for persistent turns; undefined for temporary ones. */
  binding: string | undefined
  /** The mode read back from the page before sending (never assumed). */
  mode: ProviderMode
}

export interface ProviderDriver<Page = unknown> {
  readonly provider: string
  /** Where an interactive login starts. */
  readonly loginUrl: string
  /** Origins whose cookies, localStorage, and IndexedDB make up the portable state. */
  readonly stateOrigins: readonly string[]
  checkAuth(page: Page): Promise<AuthState>
  /** A stable identity hint for the signed-in account; only its hash is ever stored. */
  identity(page: Page): Promise<string>
  ask(page: Page, prompt: string, options: AskOptions): Promise<AskResult>
  /**
   * Optional credential sign-in on a signed-out page (ADR-0017): a bounded state machine
   * that asks `code` for one-time codes (`totp` computed locally, or `email`), stops at any
   * challenge (never solved), and gives up after two code submissions.
   */
  signIn?(page: Page, credentials: { email: string; password: string }, code: (kind: 'totp' | 'email') => Promise<string>): Promise<void>
  /** Reopen a bound conversation and report its last answer and whether it is still generating. */
  snapshot(page: Page, binding: string): Promise<TurnSnapshot>
}
