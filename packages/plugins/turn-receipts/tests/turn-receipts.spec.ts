// Ported from tsuuanmi/internet test/provider-turn-receipts.test.ts onto ctx.store, plus
// decision artifacts for every reconciliation (INV-13).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import { ProviderError, responseHash } from '@tsuuanmi/system-provider-core'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'
import TurnReceipts, { receiptId } from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function boot(): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'system-receipts-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(TurnReceipts, {})]
  await Promise.all(fibers)
  cleanups.push(() => fibers[0]!.dispose())
  return ctx
}

const id = { account: 'chatgpt-main', sessionId: 'session-a', requestId: 'call-42' }
const submission = {
  ...id, prompt: 'first prompt', previousResponse: 'old response',
  conversation: { provider: 'chatgpt-web', binding: 'https://chatgpt.com/c/example' },
  mode: { verified: true as const, tier: 'frontier' as const, feature: 'deep-research' as const },
}

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

  it('persists one schema-valid submitted request and rejects prompt or boundary drift', async () => {
    const ctx = await boot()
    const submitted = ctx.turnReceipts.submit(submission)
    expect(submitted).toMatchObject({ schema: 'provider-turn-receipt@1.0', status: 'SUBMITTED', resubmits: 0, previousResponseHash: responseHash('old response') })
    expect(ctx.turnReceipts.read(id)).toEqual(submitted)
    expect(() => ctx.turnReceipts.submit({ ...submission, prompt: 'different prompt' })).toThrow(/different prompt/)
    expect(() => ctx.turnReceipts.submit({ ...submission, previousResponse: 'moved on' })).toThrow(/boundary/)
  })

  it('counts resubmissions of the same logical request and stops at the schema bound (QA-8)', async () => {
    const ctx = await boot()
    ctx.turnReceipts.submit(submission)
    expect(ctx.turnReceipts.submit(submission).resubmits).toBe(1)
    expect(ctx.turnReceipts.submit(submission).resubmits).toBe(2)
    expect(() => ctx.turnReceipts.submit(submission)).toThrow(ProviderError)
  })

  it('treats a new conversation as a null boundary', async () => {
    const ctx = await boot()
    const fresh = ctx.turnReceipts.submit({ ...submission, previousResponse: null, conversation: { provider: 'chatgpt-web', binding: '' } })
    expect(fresh.previousResponseHash).toBeNull()
  })

  it('binds a conversation once and never rebinds it', async () => {
    const ctx = await boot()
    ctx.turnReceipts.submit({ ...submission, conversation: { provider: 'chatgpt-web', binding: '' } })
    expect(ctx.turnReceipts.bindConversation(id, 'https://chatgpt.com/c/1').conversation.binding).toBe('https://chatgpt.com/c/1')
    expect(ctx.turnReceipts.bindConversation(id, 'https://chatgpt.com/c/1').conversation.binding).toBe('https://chatgpt.com/c/1')
    expect(() => ctx.turnReceipts.bindConversation(id, 'https://chatgpt.com/c/2')).toThrow(/rebound/)
  })

  it('completes idempotently and refuses conflicting content', async () => {
    const ctx = await boot()
    ctx.turnReceipts.submit(submission)
    const completed = ctx.turnReceipts.complete(id, { response: 'late answer', providerTurnId: 'turn-1' })
    expect(completed).toMatchObject({ status: 'COMPLETED', responseHash: responseHash('late answer'), providerTurnId: 'turn-1' })
    expect(ctx.turnReceipts.complete(id, { response: '  late answer ', providerTurnId: 'turn-1' })).toEqual(completed)
    expect(() => ctx.turnReceipts.complete(id, { response: 'other', providerTurnId: 'turn-1' })).toThrow(/conflicting/)
    expect(() => ctx.turnReceipts.complete({ ...id, requestId: 'missing' }, { response: 'x', providerTurnId: 't' })).toThrow(/does not exist/)
  })

  it('records every reconciliation as a decision artifact referenced by the receipt (INV-13)', async () => {
    const ctx = await boot()
    ctx.turnReceipts.submit(submission)
    const { outcome, decision } = ctx.turnReceipts.reconcile(id, { text: 'late answer', running: false })
    expect(outcome).toBe('RECOVER')
    expect(ctx.artifacts.get(decision)?.body).toMatchObject({ decisionType: 'reconciliation', outcome: { option: 'RECOVER' }, deterministic: true })
    expect(ctx.turnReceipts.read(id)?.reconciliations).toEqual([decision])
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

  it('records waiting once: a repeated WAIT reuses its decision, and a change of outcome is recorded (INV-9)', async () => {
    const ctx = await boot()
    ctx.turnReceipts.submit(submission)
    const first = ctx.turnReceipts.reconcile(id, { text: '', running: true })
    const again = ctx.turnReceipts.reconcile(id, { text: '', running: true })
    expect([first.outcome, again.outcome]).toEqual(['WAIT', 'WAIT'])
    expect(again.decision).toBe(first.decision)
    expect(ctx.turnReceipts.read(id)?.reconciliations).toEqual([first.decision])
    const done = ctx.turnReceipts.reconcile(id, { text: 'the answer', running: false })
    expect(done.outcome).toBe('RECOVER')
    expect(ctx.turnReceipts.read(id)?.reconciliations).toEqual([first.decision, done.decision])
  })

  it('deletes one receipt without touching the session\'s other turns (retention, INV-9)', async () => {
    const ctx = await boot()
    ctx.turnReceipts.submit(submission)
    ctx.turnReceipts.submit({ ...submission, requestId: 'turn-2' })
    expect(ctx.turnReceipts.delete(id)).toBe(true)
    expect(ctx.turnReceipts.delete(id)).toBe(false)
    expect(ctx.turnReceipts.read(id)).toBeUndefined()
    expect(ctx.turnReceipts.read({ ...id, requestId: 'turn-2' })).toBeDefined()
  })
})
