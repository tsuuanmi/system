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

export type ProviderFeature = 'chat' | 'deep-research' | 'web-search'

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
  /**
   * Routing capabilities this driver implements and its tests prove (docs/design/routing.md
   * #capability-vocabulary), e.g. `reason`, `persistent-conversation`, `deep-research`.
   */
  readonly capabilities: readonly string[]
  /**
   * Website features an account may or may not have (REQ-PRV-7), each a routing capability once
   * `probeFeatures` proved it on that account, e.g. `deep-research`, `web-search`.
   */
  readonly features?: readonly string[]
  /**
   * The names of the configured mode presets. An account tier mapped to another name could never
   * run, so its Worker is unavailable rather than failing each turn (`config_error`).
   */
  readonly modes?: readonly string[]
  /** Which of `features` this signed-in account offers now, read from the site without sending anything. */
  probeFeatures?(page: Page): Promise<string[]>
  /** Where an interactive login starts. */
  readonly loginUrl: string
  /**
   * The site ties a session to the browser profile that signed it in (ADR-0030): every operation
   * on the account runs as a page of its persistent login profile, and its portable state is
   * never loaded or written back.
   */
  readonly sessionBound?: boolean
  /** A session-bound account's page loads are spaced at least this far apart, in milliseconds. */
  readonly pageGapMs?: number
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
  snapshot(page: Page, binding: string, options?: { feature?: ProviderFeature }): Promise<TurnSnapshot>
  /**
   * The features whose conversations `deleteConversation` is proven to delete (a live check per
   * feature, PROP-0004 Phase 5). A conversation of another feature is kept, and reported so.
   */
  readonly deletes?: readonly ProviderFeature[]
  /**
   * Delete one bound conversation from the account's history: open it, verify the page shows
   * exactly that conversation, delete it from its own menu (never a bulk deletion), confirm when
   * the site asks, and check that it is gone. `gone` when the site shows positively that it no
   * longer exists, before anything is clicked. Anything else throws a ProviderError: a deletion
   * is never assumed.
   */
  deleteConversation?(page: Page, binding: string, options?: DeleteOptions): Promise<'deleted' | 'gone'>
  /**
   * The deletion's UI map entries not yet checked on the live site. While any is, the runtime
   * deletes nothing (an irreversible click on a guessed entry could reach another chat).
   */
  deletionUnverified?(): readonly string[]
  /**
   * Read-only evidence of how a conversation is deleted (PROP-0004 Phase 5): open it, outline the
   * page, open its own menu, outline that, and close it with Escape; no menu item is ever chosen.
   * Outlines hold structure only, never text (`ui-outline@1.0`).
   */
  inspectConversation?(page: Page, binding: string): Promise<PageOutline[]>
}

/** How one deletion runs (PROP-0004 Phase 5). */
export interface DeleteOptions {
  /** Called once, immediately before the irreversible confirm; a throw confirms nothing. */
  beforeConfirm?: () => void | Promise<void>
  /** A confirm was already recorded for it: only check that it is gone, and never click again. */
  confirmed?: boolean
}

/** A structural page outline (`ui-outline@1.0`, docs/design/ui-operations.md#drift-evidence): never text. */
export interface PageOutline {
  schema: 'ui-outline@1.0'
  root: string
  nodes: unknown[]
  truncated: boolean
}
