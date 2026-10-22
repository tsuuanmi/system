// Reconciliation ported from tsuuanmi/internet src/browser/turn-receipts.ts, over system's
// provider-turn-receipt@1.0 record (schemas/provider-turn-receipt.v1.json).
import { type ContentId, sha256 } from '@tsuuanmi/system-libs'

export type Tier = 'economy' | 'standard' | 'frontier'

/** Body of a provider turn receipt artifact. */
export interface TurnReceipt {
  schema: 'provider-turn-receipt@1.0'
  account: string
  requestId: string
  conversation: { provider: string; binding: string }
  promptHash: ContentId
  /** Hash of the last response before this turn; null for a new conversation. */
  previousResponseHash: ContentId | null
  mode: { verified: true; tier: Tier; model?: string; effort?: string; feature?: 'chat' | 'web-search' | 'deep-research' }
  status: 'SUBMITTED' | 'COMPLETED'
  providerTurnId?: string
  responseHash?: ContentId
  resubmits: number
  reconciliations?: ContentId[]
}

/** What the provider page shows now: the last assistant response and whether it is generating. */
export interface TurnSnapshot {
  text: string
  running: boolean
  /** False when the conversation cannot be observed (temporary, never bound, or not rendered): never resend blind. */
  observable?: boolean
  /** Text of the conversation's last user turn, as shown. */
  lastPrompt?: string
}

export type Reconciliation = 'WAIT' | 'RECOVER' | 'RESUBMIT' | 'AMBIGUOUS'

/** Responses are compared by the hash of their trimmed text. */
export function responseHash(text: string): ContentId {
  return sha256(text.trim())
}

/**
 * Decide what to do with an existing receipt after a restart or retry
 * (docs/design/provider-turns.md#reconciliation). Never resends a prompt the provider
 * may already have accepted unless nothing new exists after the boundary.
 */
export function reconcileTurn(receipt: TurnReceipt, snapshot: TurnSnapshot, options: { maxResubmits?: number; prompt?: string } = {}): Reconciliation {
  if (snapshot.observable === false) return 'AMBIGUOUS'
  const text = snapshot.text.trim()
  const current = responseHash(text)
  if (snapshot.running) return receipt.status === 'SUBMITTED' ? 'WAIT' : 'AMBIGUOUS'
  if (receipt.status === 'COMPLETED') return text !== '' && receipt.responseHash === current ? 'RECOVER' : 'AMBIGUOUS'
  if (text !== '' && current !== receipt.previousResponseHash) return 'RECOVER'
  // The page loaded but no longer shows the response this turn followed: it contradicts the
  // receipt, so whether the prompt was sent cannot be told. Absence is not evidence of non-submission.
  if (boundaryMissing(receipt, snapshot)) return 'AMBIGUOUS'
  // The provider shows our prompt as the last user turn: it has it, so resending would duplicate it.
  if (options.prompt !== undefined && promptShown(snapshot.lastPrompt, options.prompt)) return 'AMBIGUOUS'
  return receipt.resubmits < (options.maxResubmits ?? 2) ? 'RESUBMIT' : 'AMBIGUOUS'
}

/**
 * Whether an observed page shows no response although the receipt recorded one before this turn.
 * A page still hydrating looks the same, so a caller may observe it again, a bounded number of
 * times, before it fails closed.
 */
export function boundaryMissing(receipt: TurnReceipt, snapshot: TurnSnapshot): boolean {
  return receipt.previousResponseHash !== null && snapshot.observable !== false && !snapshot.running && snapshot.text.trim() === ''
}

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Whether a shown user turn carries `prompt` (spacing ignored; a tool chip's label may precede it). */
export function promptShown(shown: string | undefined, prompt: string): boolean {
  return shown !== undefined && flat(prompt) !== '' && flat(shown).includes(flat(prompt))
}
