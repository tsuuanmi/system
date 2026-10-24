import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkRequirement } from '@tsuuanmi/system-workers'
import { describe, expect, it, onTestFinished } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { ask, turnsStack } from './stack.ts'

const { boot } = turnsStack()

describe.runIf(canRunBrowser)('ctx.turns: website features and usage limits', () => {
  it('proves an account\'s website features by a probe that sends nothing, and routes only on proven ones (REQ-PRV-7)', async () => {
    const { ctx, fake } = await boot({ fake: { answer: 'Found it', features: ['web-search'] } })
    expect(await ctx.turns.probe('chatgpt-main')).toEqual(['web-search'])
    expect(fake.sent).toEqual([])
    expect((await ctx.accounts.get('chatgpt-main')).features).toMatchObject({ names: ['web-search'] })
    const worker = (await ctx.workers.list()).find((w) => w.worker === 'worker:chatgpt-main/standard')!
    expect(worker.capabilities.map((c) => [c.capability, c.evidence.kind])).toEqual([['reason', 'conformance'], ['persistent-conversation', 'conformance'], ['web-search', 'probe']])
    // A feature the account does not offer fails closed; one it offers is used for the turn.
    await expect(ask(ctx, { prompt: 'Research it', research: true })).rejects.toThrow(/deep-research/)
    const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'Latest news?', search: true })).turnId, 30_000)
    expect(turn).toMatchObject({ status: 'completed', answer: 'Found it' })
    expect(fake.sent).toEqual([expect.objectContaining({ prompt: 'Latest news?', webSearch: true, deepResearch: false })])
  }, 90_000)

  it('cools an account the site answers with its usage limit, keeps its status ready, and ends the limit by a used feature or the operator (ADR-0034)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    // The operator's overlay recognizes the site's limit answers, with no release.
    writeFileSync(join(dir, 'none.yaml'), [
      'elements:',
      '  answer.limit:',
      "    candidates: [{ text: { en: '^You have reached your usage limit' } }]",
      '  answer.search-limit:',
      "    candidates: [{ text: { en: '^You have reached your search limit' } }]",
      'errors:',
      '  - { when: { visible: answer.limit }, kind: quota_exhausted, on: answer }',
      '  - { when: { visible: answer.search-limit }, kind: quota_exhausted, feature: web-search, on: answer }',
    ].join('\n'))
    const { ctx, fake } = await boot({ dir, fake: { answer: 'You have reached your usage limit until 18:40.', features: ['web-search'] } })
    const stateOf = async () => (await ctx.workers.list()).find((w) => w.worker === 'worker:chatgpt-main/standard')!
    // The whole account: sent, so it fails and is never resent; its Workers are out of quota for a while.
    const limited = await ctx.turns.wait((await ask(ctx, { prompt: 'one' })).turnId, 30_000)
    expect(limited).toMatchObject({ status: 'failed', error: { kind: 'quota_exhausted' } })
    expect(fake.sent).toHaveLength(1)
    expect(ctx.turns.cooldowns()).toEqual([expect.objectContaining({ account: 'chatgpt-main', feature: '*', source: expect.stringMatching(/quota_exhausted/) })])
    expect((await stateOf()).state).toBe('quota-exhausted')
    // Its account, assigned by default, says when it is back, so work only it could take waits for it (ADR-0052).
    expect((await stateOf()).account).toEqual({ id: 'chatgpt-main', group: 'chatgpt-web', mode: 'assigned', limitUntil: ctx.turns.cooldowns()[0]!.until })
    expect((await ctx.accounts.get('chatgpt-main')).status).toBe('ready')
    expect(ctx.turns.clearCooldown('chatgpt-main')).toBe(1)
    expect((await stateOf()).state).toBe('ready')
    expect((await stateOf()).account).toEqual({ id: 'chatgpt-main', group: 'chatgpt-web', mode: 'assigned' })
    // One feature: only work that needs it is kept away; a turn that used it and succeeded ends it.
    await ctx.turns.probe('chatgpt-main')
    fake.options.answer = 'You have reached your search limit for today.'
    await ctx.turns.wait((await ask(ctx, { prompt: 'news?', search: true })).turnId, 30_000)
    expect((await stateOf()).cooldowns).toEqual([{ capability: 'web-search', until: expect.any(String) }])
    await expect(ask(ctx, { prompt: 'more news?', search: true })).rejects.toThrow(/web-search limit until/)
    fake.options.answer = 'Plain answer'
    expect(await ctx.turns.wait((await ask(ctx, { prompt: 'plain' })).turnId, 30_000)).toMatchObject({ status: 'completed' })
    const requirement: WorkRequirement = { schema: 'work-requirement@1.0', objective: 'test', egressPolicy: 'egress.classification-and-secrets', capabilities: ['reason', 'web-search'],
      data: { classification: 'operator-shared', refs: [] }, tier: { min: 'standard', source: 'default' }, acceptance: { contract: 'acceptance.answer' } }
    const used = ctx.turns.ask({ key: 'used-search', worker: 'worker:chatgpt-main/standard', prompt: 'news now', requirement, decisions: limited.routeDecision ? { route: limited.routeDecision, tier: limited.tierDecision! } : (undefined as never) })
    expect(await ctx.turns.wait(used.turnId, 30_000)).toMatchObject({ status: 'completed' })
    expect(ctx.turns.cooldowns()).toEqual([])
  }, 120_000)

  it('never takes a limit an earlier answer of the conversation gave for the next answer\'s (ADR-0034)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(join(dir, 'none.yaml'), [
      'elements:',
      '  answer.limit:',
      "    candidates: [{ text: { en: '^You have reached your usage limit' } }]",
      'errors:',
      '  - { when: { visible: answer.limit }, kind: quota_exhausted, on: answer }',
    ].join('\n'))
    const { ctx, fake } = await boot({ dir, fake: { answer: 'You have reached your usage limit until 18:40.' } })
    const first = await ctx.turns.wait((await ask(ctx, { prompt: 'one', persist: true })).turnId, 30_000)
    expect(first).toMatchObject({ status: 'failed', error: { kind: 'quota_exhausted' } })
    ctx.turns.clearCooldown('chatgpt-main')
    // The limit answer stays in the conversation; the next answer is read on its own.
    fake.options.answer = 'A plain answer'
    const second = await ctx.turns.wait((await ask(ctx, { prompt: 'two', sessionId: first.sessionId! })).turnId, 30_000)
    expect(second).toMatchObject({ status: 'completed', answer: 'A plain answer' })
    expect(ctx.turns.cooldowns()).toEqual([])
  }, 120_000)
})
