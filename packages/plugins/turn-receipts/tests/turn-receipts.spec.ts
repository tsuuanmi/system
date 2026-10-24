// Ported from tsuuanmi/internet test/provider-turn-receipts.test.ts onto ctx.store, plus
// decision artifacts for every reconciliation (INV-13).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it, onTestFinished } from 'vitest'
import TurnReceipts, { receiptId } from '../src/index.ts'

async function boot(): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'system-receipts-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(TurnReceipts, {})]
  await Promise.all(fibers)
  onTestFinished(() => fibers[0]!.dispose())
  return ctx
}

const id = { account: 'chatgpt-main', sessionId: 'session-a', requestId: 'call-42' }
const submission = {
  ...id, prompt: 'first prompt', previousResponse: 'old response',
  conversation: { provider: 'chatgpt-web', binding: 'https://chatgpt.com/c/example' },
  mode: { verified: true as const, tier: 'frontier' as const, feature: 'deep-research' as const },
}

// The seam's contract is held by its conformance suite (conformance.spec.ts); these tests pin what
// only this provider does.
describe('ctx.turnReceipts', () => {
  it('derives identity from account, owning session, and request id', () => {
    const first = receiptId(id)
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(receiptId({ ...id, sessionId: 'session-b' })).not.toBe(first)
    expect(receiptId({ ...id, account: 'chatgpt-2' })).not.toBe(first)
    expect(receiptId({ ...id, requestId: 'call-43' })).not.toBe(first)
    expect(() => receiptId({ ...id, sessionId: '' })).toThrow(/session/)
    expect(() => receiptId({ ...id, requestId: ' ' })).toThrow(/request/)
  })

  it('says why each rejected outcome lost, from the rule and the snapshot (INV-13)', async () => {
    const ctx = await boot()
    ctx.turnReceipts.submit(submission)
    const reasons = (decision: string): Record<string, string[]> => Object.fromEntries((ctx.artifacts.get(decision)?.body as { candidates: Array<{ option: string; reasons: string[] }> }).candidates.map((c) => [c.option, c.reasons]))
    // The page shows only the boundary, and the prompt as its last user turn: resending would duplicate it.
    const shown = ctx.turnReceipts.reconcile(id, { text: 'old response', running: false, lastPrompt: 'first prompt' }, { prompt: 'first prompt' })
    expect(shown.outcome).toBe('AMBIGUOUS')
    expect(reasons(shown.decision)).toEqual({
      WAIT: ['not WAIT: the provider is not generating'],
      RECOVER: ['not RECOVER: the page shows only the response this turn followed'],
      RESUBMIT: ['not RESUBMIT: the page shows the prompt as its last user turn'],
      AMBIGUOUS: ['the page shows the prompt as the last user turn, without an answer yet; resending would duplicate it'],
    })
    const recovered = ctx.turnReceipts.reconcile(id, { text: 'late answer', running: false })
    expect(recovered.outcome).toBe('RECOVER')
    expect(reasons(recovered.decision)).toMatchObject({
      RESUBMIT: ['not RESUBMIT: a new response follows the boundary'],
      AMBIGUOUS: ['not AMBIGUOUS: a new response follows the boundary'],
    })
  })

})
