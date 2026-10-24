import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { AdmissionFailure } from '@tsuuanmi/system-workers'
import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { account, ask, turnsStack } from './stack.ts'

const { boot } = turnsStack()

describe.runIf(canRunBrowser)('ctx.turns: routing to an account\'s Workers', () => {
  it('makes a tier mapped to a preset the driver does not have unavailable, so routing never picks it (PROP-0004: the removed site preset)', async () => {
    const { ctx } = await boot({ accounts: [account('chatgpt-free', { economy: 'site', standard: 'site' }), account('chatgpt-main')] })
    const states = Object.fromEntries((await ctx.workers.list()).map((w) => [w.worker, w.state]))
    expect(states).toMatchObject({ 'worker:chatgpt-free/economy': 'unavailable', 'worker:chatgpt-free/standard': 'unavailable', 'worker:chatgpt-main/standard': 'ready' })
    const admitted = await ctx.workers.route({ schema: 'work-requirement@1.0', objective: 'x', capabilities: ['reason'], data: { classification: 'public', refs: [] }, egressPolicy: 'default', tier: { min: 'economy', source: 'default' }, acceptance: { contract: 'acceptance.answer' } })
    expect(admitted.worker.worker).toBe('worker:chatgpt-main/economy')
  }, 60_000)

  it('describes each tier\'s Worker with its account\'s description and the tier (capability-descriptor@1.7), and its site\'s title from the driver (@1.8, T116)', async () => {
    const { ctx } = await boot({ accounts: [{ ...account('chatgpt-main', { economy: 'instant', frontier: 'high' }), description: 'The studio\'s chat subscription' }, account('chatgpt-2', { standard: 'medium' })] })
    const listed = new Map((await ctx.workers.list()).map((w) => [w.worker, w]))
    expect(listed.get('worker:chatgpt-main/economy')).toMatchObject({ schema: 'capability-descriptor@1.8', title: 'ChatGPT', description: 'The studio\'s chat subscription (economy tier)' })
    expect(listed.get('worker:chatgpt-main/frontier')).toMatchObject({ description: 'The studio\'s chat subscription (frontier tier)' })
    expect(listed.get('worker:chatgpt-2/standard')).toMatchObject({ schema: 'capability-descriptor@1.8', title: 'ChatGPT' })
    expect(listed.get('worker:chatgpt-2/standard')).not.toHaveProperty('description')
    const schemas = new SchemaRegistry()
    for (const w of listed.values()) schemas.assertRecord(w)
    expect((await ctx.accounts.get('chatgpt-main')).description).toBe('The studio\'s chat subscription')
  }, 60_000)

  it('maps the requested tier through the account catalog to a mode preset, verifies it, and records it', async () => {
    const { ctx, fake } = await boot()
    const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'hard question', tier: 'frontier' })).turnId, 30_000)
    expect(turn).toMatchObject({ status: 'completed', tier: 'frontier', mode: 'temporary' })
    expect(fake.sent[0]).toMatchObject({ model: 'GPT-6', power: 'High' })
    const receipt = ctx.turnReceipts.read({ account: 'chatgpt-main', sessionId: turn.turnId, requestId: turn.turnId })
    expect(receipt?.mode).toEqual({ verified: true, tier: 'frontier', model: 'GPT-6', effort: 'High', feature: 'chat' })
    expect(turn.worker).toBe('worker:chatgpt-main/frontier')
    const tier = ctx.artifacts.get(turn.tierDecision!)?.body
    expect(tier).toMatchObject({ decisionType: 'tier', outcome: { option: 'frontier' } })
    const plain = await ctx.turns.wait((await ask(ctx, { prompt: 'default tier' })).turnId, 30_000)
    expect(plain.tier).toBe('standard')
    expect(fake.sent[1]).toMatchObject({ model: 'Latest', power: 'Medium' })
  }, 90_000)

  it('reports each account\'s load, busy at its limit, and routes the next turn to the least busy account (ADR-0033)', async () => {
    const { ctx } = await boot({ accounts: [account('chatgpt-main'), account('chatgpt-2')], ready: ['chatgpt-main', 'chatgpt-2'], capacity: 1, fake: { thinkMs: 4000 } })
    const loadOf = async (id: string) => (await ctx.workers.list()).find((w) => w.worker === `worker:${id}/standard`)!
    // With equal loads the id decides: chatgpt-2 first.
    const first = await ask(ctx, { prompt: 'one' })
    expect(first.account).toBe('chatgpt-2')
    await expect.poll(async () => (await loadOf('chatgpt-2')).load, { timeout: 30_000 }).toEqual({ running: 1, queued: 0, pending: 0, slots: 1 })
    expect((await loadOf('chatgpt-2')).state).toBe('busy')
    // Routed and not started yet: pending on its account until released.
    const routed = await ctx.workers.route({ schema: 'work-requirement@1.0', objective: 'test', egressPolicy: 'egress.classification-and-secrets', capabilities: ['reason'],
      data: { classification: 'operator-shared', refs: [] }, tier: { min: 'standard', source: 'default' }, acceptance: { contract: 'acceptance.answer' } })
    expect(routed.worker.worker).toBe('worker:chatgpt-main/standard')
    expect((await loadOf('chatgpt-main')).load).toEqual({ running: 0, queued: 0, pending: 1, slots: 1 })
    routed.release()
    expect((await loadOf('chatgpt-main')).load).toEqual({ running: 0, queued: 0, pending: 0, slots: 1 })
    const second = await ask(ctx, { prompt: 'two' })
    expect(second.account).toBe('chatgpt-main')
    const route = ctx.artifacts.get(second.routeDecision!)?.body as { candidates: Array<{ option: string; reasons: string[] }> }
    expect(route.candidates.find((c) => c.option === 'worker:chatgpt-2/standard')!.reasons).toEqual(['admitted; worker:chatgpt-main/standard is less busy (load 0 of 1; this one load 1 of 1)'])
    await Promise.all([ctx.turns.wait(first.turnId, 30_000), ctx.turns.wait(second.turnId, 30_000)])
  }, 90_000)

  it('names a pooled provider\'s accounts pooled, only with the operator\'s recorded terms, recorded at start as a gate decision (REQ-ACC-10, ADR-0052)', async () => {
    const pooledTerms = { confirmedBy: 'operator', confirmedAt: '2026-10-24T09:00:00Z', terms: 'Team plan terms, read 2026-10-24' }
    const { ctx } = await boot({ providers: [{ provider: 'chatgpt-web', accounts: 'pooled', pooledTerms }] })
    expect((await ctx.workers.list()).find((w) => w.worker === 'worker:chatgpt-main/standard')!.account).toEqual({ id: 'chatgpt-main', group: 'chatgpt-web', mode: 'pooled' })
    const gates = ctx.artifacts.list({ kind: 'decision', decisionType: 'gate', limit: 10 }).map((a) => a.body as { decider: { id: string }; outcome: unknown })
    expect(gates.filter((g) => g.decider.id === 'turns.pooled-terms').map((g) => g.outcome)).toEqual([{ option: 'pooled', detail: { provider: 'chatgpt-web', ...pooledTerms } }])
  })

  it('routes through ctx.workers to an admitted Worker and records why every other one was not chosen (REQ-WRK-1, REQ-ART-1)', async () => {
    const { ctx } = await boot({ accounts: [account('chatgpt-main'), account('chatgpt-2')], ready: ['chatgpt-2'] })
    const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'route me' })).turnId, 30_000)
    expect(turn).toMatchObject({ status: 'completed', account: 'chatgpt-2', worker: 'worker:chatgpt-2/standard' })
    const route = ctx.artifacts.get(turn.routeDecision!)?.body as { candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }
    const reasons = Object.fromEntries(route.candidates.map((c) => [c.option, c.reasons]))
    expect(reasons['worker:chatgpt-2/standard']).toContain('proves reason')
    expect(reasons['worker:chatgpt-2/frontier']).toEqual(['admitted; worker:chatgpt-2/standard has the lower tier standard'])
    expect(reasons['worker:chatgpt-main/standard']).toEqual(['state reauth-required'])
    expect(reasons['worker:chatgpt-main/economy']).toEqual(['state reauth-required', 'tier economy is below the minimum standard'])
  }, 90_000)

  it('treats the tier as a minimum, and fails closed when no Worker serves it (REQ-WRK-9)', async () => {
    const { ctx, fake } = await boot({ accounts: [account('chatgpt-main', { economy: 'instant', frontier: 'high' })] })
    const up = await ctx.turns.wait((await ask(ctx, { prompt: 'standard or better', tier: 'standard' })).turnId, 30_000)
    expect(up).toMatchObject({ status: 'completed', tier: 'frontier', worker: 'worker:chatgpt-main/frontier' })
    expect(fake.sent[0]).toMatchObject({ model: 'GPT-6', power: 'High' })
    const cheap = await ctx.turns.wait((await ask(ctx, { prompt: 'easy', tier: 'economy' })).turnId, 30_000)
    expect(cheap.worker).toBe('worker:chatgpt-main/economy')
    const none = await boot({ accounts: [account('chatgpt-main', { economy: 'instant' })] })
    const refused = await ask(none.ctx, { prompt: 'too hard', tier: 'frontier' }).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(AdmissionFailure)
    expect(none.ctx.artifacts.get((refused as AdmissionFailure).decision)?.body).toMatchObject({ decisionType: 'admission', outcome: { option: 'none' } })
    expect(none.fake.sent).toEqual([])
  }, 90_000)
})
