import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { browserStack } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: a graph grown from a planner\'s plan', () => {
  it('grows the graph from a planner\'s validated plan, and feeds the steps\' findings to its dependent (REQ-WF-8, REQ-WF-10)', async () => {
    const answer = (prompt: string): string => {
      if (prompt.includes('Plan how to answer')) {
        return '```json\n' + JSON.stringify({ confidence: 'high', nodes: [
          { id: 'step-1', objective: 'Look up one', prompt: 'step one: look it up', capabilities: ['reason'], tier: 'economy' },
          { id: 'step-2', objective: 'Analyse two', prompt: 'step two: analyse {{input}}', capabilities: ['reason'], tier: 'standard', dependsOn: ['step-1'] },
        ] }) + '\n```'
      }
      if (prompt.includes('<findings>')) return `Synthesis of ${['finding A', 'finding B'].filter((f) => prompt.includes(f)).join(' and ')}`
      return prompt.includes('step one') ? 'finding A' : 'finding B'
    }
    const { ctx, fake } = await boot({ fake: { answer } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'investigate', input: 'why?' }).runId, 90_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'Synthesis of finding A and finding B' })
    expect(done.nodes.map((n) => [n.nodeId, n.state, n.tier])).toEqual([
      ['plan:1', 'COMPLETED', 'standard'], ['plan:1:step-1', 'COMPLETED', 'economy'], ['plan:1:step-2', 'COMPLETED', 'standard'], ['synthesis:1', 'COMPLETED', 'standard'],
    ])
    // A plan's text is used literally: its prompts are never expanded as templates.
    expect(fake.sent.map((s) => s.prompt)).toContain('step two: analyse {{input}}')
    const schemas = new SchemaRegistry()
    for (const record of ctx.workflow.records(done.runId)) schemas.assertRecord(record)
    const growth = ctx.artifacts.list({ kind: 'decision', decisionType: 'graph-growth', runId: done.runId })
    expect(growth.map((g) => (g.body as { outcome: { option: string } }).outcome.option)).toEqual(['append'])
    expect(ctx.artifacts.get(growth[0]!.inputs[0]!)).toMatchObject({ kind: 'plan', bodySchema: 'plan@1.0' })
  }, 120_000)

  it('refuses a plan whose step id is absurdly long as plan_rejected, never as an internal failure', async () => {
    const id = 'x'.repeat(400)
    const { ctx } = await boot({ fake: { answer: () => '```json\n' + JSON.stringify({ confidence: 'high', nodes: [{ id, objective: 'o', prompt: 'p', capabilities: ['reason'], tier: 'economy' }] }) + '\n```' } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'investigate', input: 'q' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'plan_rejected', disposition: 'NONE' } })
  }, 60_000)
})
