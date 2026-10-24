import type { WorkRequirement } from '@tsuuanmi/system-workers'
import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { account, ask, turnsStack } from './stack.ts'

const { boot } = turnsStack()

describe.runIf(canRunBrowser)('ctx.turns: persistent sessions and Deep research', () => {
  it('starts Deep research at once in a persistent session and delivers the report through result (REQ-PRV-6)', async () => {
    const { ctx, fake } = await boot({ fake: { report: 'Research report', thinkMs: 1500 } })
    const started = await ask(ctx, { research: true, prompt: 'Survey the plugin catalog' })
    expect(started).toMatchObject({ status: 'queued', mode: 'persistent', feature: 'deep-research' })
    expect(started.sessionId).toMatch(/^ses_/)
    const done = await ctx.turns.wait(started.turnId, 60_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'Research findings\nResearch report' })
    expect(fake.sent[0]).toMatchObject({ deepResearch: true, temporary: false, prompt: 'Survey the plugin catalog' })
  }, 90_000)

  it('accepts a follow-up on a new persistent session before its first turn has finished', async () => {
    const { ctx } = await boot({ fake: { thinkMs: 1500 } })
    const first = await ask(ctx, { prompt: 'one', persist: true })
    const second = await ask(ctx, { prompt: 'two', sessionId: first.sessionId! })
    expect((await ctx.turns.wait(second.turnId, 60_000)).status).toBe('completed')
    expect((await ctx.turns.wait(first.turnId, 1000)).status).toBe('completed')
  }, 90_000)

  it('keeps a persistent session on one conversation across asks', async () => {
    const { ctx, fake } = await boot({ fake: { answer: 'first' } })
    const first = await ctx.turns.wait((await ask(ctx, { prompt: 'one', persist: true })).turnId, 30_000)
    expect(first).toMatchObject({ status: 'completed', mode: 'persistent', answer: 'first' })
    expect(first.sessionId).toMatch(/^ses_/)
    fake.options.answer = 'second'
    const second = await ctx.turns.wait((await ask(ctx, { prompt: 'two', sessionId: first.sessionId! })).turnId, 30_000)
    expect(second).toMatchObject({ status: 'completed', sessionId: first.sessionId, answer: 'second', binding: first.binding })
    expect(first.binding).toMatch(/^[0-9a-f-]{36}$/)
    expect(fake.sent[1]).toMatchObject({ conversationId: first.binding, temporary: false })
  }, 120_000)

  it('holds a session to its account only once something was sent, so an unsent first turn may move to a sibling (ADR-0034)', async () => {
    const { ctx, fake } = await boot({ accounts: [account('chatgpt-main'), account('chatgpt-2')], ready: ['chatgpt-main', 'chatgpt-2'], fake: { captcha: true } })
    const requirement: WorkRequirement = { schema: 'work-requirement@1.0', objective: 'test', egressPolicy: 'egress.classification-and-secrets', capabilities: ['reason', 'persistent-conversation'],
      data: { classification: 'operator-shared', refs: [] }, tier: { min: 'standard', source: 'default' }, acceptance: { contract: 'acceptance.answer' } }
    // Each start carries the decisions of a real route to its Worker.
    const routed = async (worker: string) => {
      const admitted = await ctx.workers.route(requirement, { restrict: { workers: [worker], reason: 'this test' } })
      admitted.release()
      return admitted.decisions
    }
    const first = ctx.turns.ask({ key: 'first', worker: 'worker:chatgpt-2/standard', prompt: 'one', sessionId: 'ses_move', requirement, decisions: await routed('worker:chatgpt-2/standard') })
    expect(await ctx.turns.wait(first.turnId, 30_000)).toMatchObject({ status: 'failed', error: { kind: 'challenge' } })
    expect(fake.sent).toEqual([])
    // Nothing was sent: the session holds no account, and its next turn may run on another one.
    expect(ctx.workers.affinity('ses_move')).toBeUndefined()
    fake.options.captcha = false
    const moved = ctx.turns.ask({ key: 'moved', worker: 'worker:chatgpt-main/standard', prompt: 'one', sessionId: 'ses_move', requirement, decisions: await routed('worker:chatgpt-main/standard') })
    expect(await ctx.turns.wait(moved.turnId, 30_000)).toMatchObject({ status: 'completed', account: 'chatgpt-main' })
    // Sent now: held to its account.
    expect(ctx.workers.affinity('ses_move')).toEqual(['worker:chatgpt-main/economy', 'worker:chatgpt-main/standard', 'worker:chatgpt-main/frontier'])
    const stray = await routed('worker:chatgpt-main/frontier')
    expect(() => ctx.turns.ask({ key: 'stray', worker: 'worker:chatgpt-2/standard', prompt: 'two', sessionId: 'ses_move', requirement, decisions: stray })).toThrow(/bound to chatgpt-main/)
  }, 120_000)
})
