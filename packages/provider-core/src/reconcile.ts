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
export function reconcileTurn(receipt: TurnReceipt, snapshot: TurnSnapshot, options: { maxResubmits?: number } = {}): Reconciliation {
  const text = snapshot.text.trim()
  const current = responseHash(text)
  if (snapshot.running) return receipt.status === 'SUBMITTED' ? 'WAIT' : 'AMBIGUOUS'
  if (receipt.status === 'COMPLETED') return text !== '' && receipt.responseHash === current ? 'RECOVER' : 'AMBIGUOUS'
  if (text !== '' && current !== receipt.previousResponseHash) return 'RECOVER'
  return receipt.resubmits < (options.maxResubmits ?? 2) ? 'RESUBMIT' : 'AMBIGUOUS'
}
