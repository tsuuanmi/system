import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { browserStack } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: static DAGs on the single engine', () => {
  it('runs research as two nodes: Deep research on frontier, then a cited compaction of the verbatim report on economy', async () => {
    const { ctx, fake } = await boot()
    const started = ctx.workflow.start({ template: 'deep-research', input: 'Survey the plugin catalog' })
    expect(started).toMatchObject({ template: 'deep-research', status: 'running' })
    expect(started.sessionId).toMatch(/^ses_/)
    // The file's first run also starts the browser: a loaded CI runner gets room for that.
    const done = await ctx.workflow.wait(started.runId, 120_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'Synthesis: plugins matter (https://src.example/catalog).' })
    expect(fake.sent).toHaveLength(2)
    expect(fake.sent[0]).toMatchObject({ prompt: 'Survey the plugin catalog', deepResearch: true, temporary: false, model: 'GPT-6', power: 'High' })
    expect(fake.sent[1]).toMatchObject({ deepResearch: false, temporary: true, model: 'Latest', power: 'Instant' })
    // Editors may change blank-line spacing; every line of the report arrives verbatim.
    expect(fake.sent[1]!.prompt.replace(/\n{2,}/g, '\n\n')).toContain('<report>\nResearch findings\nPlugins matter [1].\n\nSources:\n- [1] https://src.example/catalog\n</report>')
    expect(done.nodes.map((n) => [n.nodeId, n.state, n.worker, n.quotaClass])).toEqual([
      ['research:1', 'COMPLETED', 'worker:chatgpt-main/frontier', 'subscription-chat'],
      ['compact:1', 'COMPLETED', 'worker:chatgpt-main/economy', 'subscription-chat'],
    ])
    // Durable node records validate against workflow-node@1.0 and bind the result to its acceptance.
    const schemas = new SchemaRegistry()
    for (const record of ctx.workflow.records(started.runId)) {
      schemas.assertRecord(record)
      expect(record.outputReceipt).toBeDefined()
      expect(ctx.artifacts.get(record.outputReceipt!.acceptance)?.body).toMatchObject({ decisionType: 'acceptance', outcome: { option: 'accept' } })
    }
    // Template tiers are the profile's, and each requirement carries its node's objective.
    expect(ctx.workflow.records(started.runId).map((r) => [r.requirement.tier, r.requirement.objective])).toEqual([
      [{ min: 'frontier', source: 'profile' }, 'Write a cited Deep research report on the caller\'s question'],
      [{ min: 'economy', source: 'profile' }, 'Compact the report into a cited synthesis'],
    ])
    // Both tiers are visible in the event log (MVP exit criterion 4).
    const completed = ctx.eventLog.query({ type: 'workflow.node.completed', runId: started.runId })
    expect(completed.map((e) => [e.nodeId, e.data?.tier])).toEqual([['research:1', 'frontier'], ['compact:1', 'economy']])
  }, 180_000)

  it('answers ask as a one-node DAG with the caller\'s tier, and continues a session', async () => {
    const { ctx, fake } = await boot()
    const first = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'hello', tier: 'economy', persist: true }).runId, 30_000)
    expect(first).toMatchObject({ status: 'completed', answer: 'Plain answer.', nodes: [{ nodeId: 'ask:1', worker: 'worker:chatgpt-main/economy' }] })
    const second = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'again', sessionId: first.sessionId }).runId, 30_000)
    expect(second).toMatchObject({ status: 'completed', sessionId: first.sessionId, nodes: [{ worker: 'worker:chatgpt-main/standard' }] })
    expect(fake.sent[1]!.conversationId).toBe(fake.sent[0]!.conversationId ?? [...fake.conversations.keys()][0])
  }, 90_000)

  it('refuses a configured template that fails its check, alone: the engine and every other template keep working (INV-2)', async () => {
    const old = [{ nodeId: 'panel', objective: 'Answer as a panel', prompt: '{{input}}', capabilities: ['reason'], tier: 'standard', conversation: 'temporary',
      acceptance: 'acceptance.team-synthesis', team: { members: 2, rounds: 2, distinctAccounts: true, lead: {} } }]
    const { ctx } = await boot({ workflow: { templates: { 'panel-led': old } } })
    expect(ctx.workflow.refusedTemplates()).toEqual([{ name: 'panel-led', reason: expect.stringMatching(/^node panel: team must be \{kind: brainstorm \| review/) }])
    expect(ctx.workflow.templateNames()).toEqual(expect.arrayContaining(['ask', 'brainstorm', 'review']))
    expect(ctx.workflow.templateNames()).not.toContain('panel-led')
    // What a served template runs, step by step, for a person to read before a start; none for a refused one (T116).
    expect(ctx.workflow.templateSteps('panel-led')).toBeUndefined()
    expect(ctx.workflow.templateSteps('toString')).toBeUndefined()
    expect(ctx.workflow.templateSteps('ask')).toEqual([expect.objectContaining({ capabilities: expect.arrayContaining(['reason']), tier: expect.any(String) })])
    expect(ctx.workflow.templateSteps('brainstorm')!.find((s) => s.team)).toMatchObject({ team: { kind: 'brainstorm', members: expect.any(Number) } })
    expect(() => ctx.workflow.start({ template: 'panel-led', input: 'q' })).toThrow(/workflow template panel-led was refused at load: node panel: team must be/)
    expect((await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'hi' }).runId, 60_000)).status).toBe('completed')
  }, 90_000)
})
