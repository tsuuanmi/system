// Reconciliation semantics ported from tsuuanmi/internet test/provider-turn-receipts.test.ts,
// expressed over system's provider-turn-receipt@1.0 record (docs/design/provider-turns.md).
import { contentId, sha256 } from '@tsuuanmi/system-libs'
import { describe, expect, it } from 'vitest'
import { type TurnReceipt, reconcileTurn, responseHash } from '../src/index.ts'

const previous = 'Earlier answer'
const base: TurnReceipt = {
  schema: 'provider-turn-receipt@1.0', account: 'chatgpt-main', requestId: 'req-1',
  conversation: { provider: 'chatgpt-web', binding: 'https://chatgpt.com/c/1' },
  promptHash: sha256('prompt'), previousResponseHash: responseHash(previous),
  mode: { verified: true, tier: 'frontier' }, status: 'SUBMITTED', resubmits: 0,
}

describe('reconcileTurn', () => {
  it('waits while the provider is still generating a submitted turn', () => {
    expect(reconcileTurn(base, { text: previous, running: true })).toBe('WAIT')
  })

  it('recovers a new completed response after the boundary instead of resending', () => {
    expect(reconcileTurn(base, { text: 'Late answer', running: false })).toBe('RECOVER')
  })

  it('resubmits only when nothing new exists after the boundary, within the bound', () => {
    expect(reconcileTurn(base, { text: previous, running: false })).toBe('RESUBMIT')
    expect(reconcileTurn({ ...base, resubmits: 1 }, { text: '', running: false })).toBe('RESUBMIT')
    expect(reconcileTurn({ ...base, resubmits: 2 }, { text: previous, running: false })).toBe('AMBIGUOUS')
    expect(reconcileTurn({ ...base, resubmits: 1 }, { text: previous, running: false }, { maxResubmits: 1 })).toBe('AMBIGUOUS')
  })

  it('treats a new conversation (null boundary) as fresh: any response is new', () => {
    const fresh = { ...base, previousResponseHash: null }
    expect(reconcileTurn(fresh, { text: 'Answer', running: false })).toBe('RECOVER')
    expect(reconcileTurn(fresh, { text: '', running: false })).toBe('RESUBMIT')
  })

  it('fails closed when a completed receipt no longer matches the conversation', () => {
    const completed: TurnReceipt = { ...base, status: 'COMPLETED', responseHash: responseHash('Final'), providerTurnId: 't1' }
    expect(reconcileTurn(completed, { text: 'Final', running: false })).toBe('RECOVER')
    expect(reconcileTurn(completed, { text: 'Different', running: false })).toBe('AMBIGUOUS')
    expect(reconcileTurn(completed, { text: 'Final', running: true })).toBe('AMBIGUOUS')
  })

  it('hashes responses over trimmed text as content addresses', () => {
    expect(responseHash('  x  ')).toBe(sha256('x'))
    expect(responseHash('x')).not.toBe(contentId('x'))
  })
})
