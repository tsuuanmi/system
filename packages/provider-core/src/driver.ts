/**
 * The provider driver contract (ADR-0005, docs/design/provider-turns.md#driver-interface,
 * docs/design/browser-runtime.md#accounts-ctxaccounts-provider-agnostic-multi-account).
 * Generic over the page type so this package stays engine-free.
 */
export type AuthState = 'signed-in' | 'signed-out' | 'unknown'
export type ConversationMode = 'temporary' | 'persistent'

export interface AskOptions {
  conversation: ConversationMode
  /** Persistent conversation to continue. */
  binding?: string | undefined
  signal?: AbortSignal
  /**
   * Called after the prompt is in the composer and the mode is verified, immediately
   * before the send. The runtime persists the turn receipt here (INV-4); a throw aborts
   * the turn without sending. `previousResponse` is the last answer already in the
   * conversation (null for a new one), the boundary used by reconciliation.
   */
  beforeSend?: (boundary: { previousResponse: string | null }) => void | Promise<void>
}

export interface AskResult {
  text: string
  /** Canonical conversation id for persistent turns; undefined for temporary ones. */
  binding: string | undefined
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
}
