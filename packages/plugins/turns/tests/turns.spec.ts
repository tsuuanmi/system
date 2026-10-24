import { AdmissionFailure } from '@tsuuanmi/system-workers'
import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { ask, turnsStack } from './stack.ts'

const { boot } = turnsStack()

describe.runIf(canRunBrowser)('ctx.turns: ask through a saved account', () => {
  it('answers a one-shot ask in Temporary chat, in Chat mode, with a receipt, a route decision, and an answer artifact', async () => {
    const { ctx, fake } = await boot({ fake: { answer: 'Hello' } })
    const started = await ask(ctx, { prompt: 'Say hello' })
    // The first turn launches the browser; a loaded CI runner can take longer than 30 s.
    const turn = await ctx.turns.wait(started.turnId, 90_000)
    expect(turn).toMatchObject({ status: 'completed', account: 'chatgpt-main', mode: 'temporary', answer: 'Hello', submitted: true })
    expect(turn.sessionId).toBeUndefined()
    expect(fake.sent).toEqual([expect.objectContaining({ prompt: 'Say hello', mode: 'chat', temporary: true })])
    const answer = ctx.artifacts.get(turn.answerArtifact!)
    expect(answer?.body).toMatchObject({ schema: 'provider-answer@1.0', text: 'Hello', conversation: { mode: 'temporary' } })
    const route = ctx.artifacts.get(turn.routeDecision!)
    expect(route?.body).toMatchObject({ decisionType: 'route', outcome: { option: 'worker:chatgpt-main/standard' } })
    expect(ctx.turnReceipts.read({ account: 'chatgpt-main', sessionId: turn.turnId, requestId: turn.turnId })).toMatchObject({ status: 'COMPLETED' })
  }, 150_000)

  it('is idempotent on clientRequestId and sends once (REQ-PRV-1)', async () => {
    const { ctx, fake } = await boot()
    const a = await ask(ctx, { prompt: 'once', key: 'req-1' })
    const b = await ask(ctx, { prompt: 'once', key: 'req-1' })
    expect(b.turnId).toBe(a.turnId)
    await ctx.turns.wait(a.turnId, 30_000)
    expect(fake.sent).toHaveLength(1)
    await expect(ask(ctx, { prompt: 'different', key: 'req-1' })).rejects.toThrow(/different prompt/)
  }, 90_000)

  it('checks egress before sending: credentials or local-private content never leave (INV-12)', async () => {
    const { ctx, fake } = await boot()
    const pem = String((await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }))
    const leaked = await ctx.turns.wait((await ask(ctx, { prompt: `why does this key fail?\n${pem}` })).turnId, 30_000)
    expect(leaked).toMatchObject({ status: 'failed', error: { kind: 'egress_denied', disposition: 'USER_ACTION' } })
    // Routing keeps local-private work off remote Workers; the turn's own egress check holds even if a caller skipped that.
    await expect(ask(ctx, { prompt: 'my notes', classification: 'local-private' })).rejects.toBeInstanceOf(AdmissionFailure)
    const admitted = await ask(ctx, { prompt: 'warm-up', classification: 'public' })
    const turn = await ctx.turns.wait(admitted.turnId, 30_000)
    const bypass = ctx.turns.ask({
      key: 'bypass', worker: turn.worker!, prompt: 'my notes', decisions: { tier: turn.tierDecision!, route: turn.routeDecision! },
      requirement: { schema: 'work-requirement@1.0', objective: 'test', egressPolicy: 'egress.classification-and-secrets', capabilities: ['reason'],
        data: { classification: 'local-private', refs: [] }, tier: { min: 'standard', source: 'caller' }, acceptance: { contract: 'acceptance.answer' } },
    })
    expect(await ctx.turns.wait(bypass.turnId, 30_000)).toMatchObject({ status: 'failed', error: { kind: 'egress_denied' } })
    expect(fake.sent.map((s) => s.prompt)).toEqual(['warm-up'])
    const fine = await ctx.turns.wait((await ask(ctx, { prompt: 'public question' })).turnId, 30_000)
    expect(fine.status).toBe('completed')
    expect(ctx.artifacts.get(fine.egressDecision!)?.body).toMatchObject({ decisionType: 'egress', outcome: { option: 'allow' } })
  }, 90_000)
})
