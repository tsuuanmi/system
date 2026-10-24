import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { browserStack } from './stack.ts'
import { TEST_TEMPLATES } from './templates.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: a result its acceptance contract rejects', () => {
  it('fails the run when a result is rejected by its acceptance contract, and never runs the next node (REQ-WRK-3, INV-3)', async () => {
    // A deployment that requires cited reports.
    const cited = TEST_TEMPLATES['deep-research']!.map((node) => ({ ...node, acceptance: 'acceptance.cited' }))
    const { ctx, fake } = await boot({ fake: { report: 'A report without any source.' }, workflow: { templates: { 'deep-research': cited } } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'deep-research', input: 'q' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'acceptance_rejected', disposition: 'NONE' } })
    expect(done.nodes.map((n) => n.state)).toEqual(['FAILED', 'WAITING'])
    expect(fake.sent).toHaveLength(1)
  }, 90_000)

  it('escalates a rejected result to the next tier once, keeping the rejected result as evidence (REQ-WRK-9)', async () => {
    const cited = [{ nodeId: 'ask:1', objective: 'x', prompt: '{{input}}', capabilities: ['reason'], tier: 'economy', conversation: 'temporary', acceptance: 'acceptance.cited' }]
    const { ctx, fake } = await boot({
      fake: { answer: (_prompt, sent) => (sent.power === 'Instant' ? 'No sources here.' : 'See https://src.example/a') },
      workflow: { templates: { cited } },
    })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'cited', input: 'q' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'See https://src.example/a', nodes: [{ tier: 'standard' }] })
    expect(fake.sent.map((s) => s.power)).toEqual(['Instant', 'Medium'])
    const record = ctx.workflow.records(done.runId)[0]!
    expect(record.requirement.tier).toMatchObject({ min: 'standard', source: 'decision' })
    const escalation = ctx.artifacts.get(record.requirement.tier.decision!)?.body as { decisionType: string; outcome: { option: string }; inputs: string[] }
    expect(escalation).toMatchObject({ decisionType: 'escalation', outcome: { option: 'escalate' } })
    expect(escalation.inputs).toHaveLength(2)
    expect(ctx.eventLog.query({ type: 'workflow.node.escalated', runId: done.runId })).toHaveLength(1)
  }, 90_000)

  it('keeps a completed step when a later one fails: the operator\'s continue re-runs only the failed step, on the same input, as a new attempt recorded as their decision (QA-2, REQ-WF-3, REQ-WF-7)', async () => {
    const chain = [
      { nodeId: 'first:1', objective: 'x', prompt: 'first: {{input}}', capabilities: ['reason'], tier: 'economy', conversation: 'temporary', acceptance: 'acceptance.answer' },
      { nodeId: 'second:1', objective: 'y', dependsOn: ['first:1'], prompt: 'second: {{node:first:1}}', capabilities: ['reason'], tier: 'economy', conversation: 'temporary', acceptance: 'acceptance.cited', maxEscalations: 0 },
    ]
    let cite = false
    const { ctx, fake } = await boot({ fake: { answer: (p: string) => (p.startsWith('first') ? 'the first result' : cite ? 'See https://src.example/a' : 'no source') }, workflow: { templates: { chain } } })
    const failed = await ctx.workflow.wait(ctx.workflow.start({ template: 'chain', input: 'q' }).runId, 60_000)
    expect(failed).toMatchObject({ status: 'failed', error: { kind: 'acceptance_rejected' } })
    expect(failed.nodes.map((n) => n.state)).toEqual(['COMPLETED', 'FAILED'])
    const before = ctx.workflow.records(failed.runId)
    cite = true
    expect(ctx.workflow.continue(failed.runId)).toMatchObject({ status: 'running' })
    const done = await ctx.workflow.wait(failed.runId, 60_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'See https://src.example/a' })
    // The first step was sent once; the second twice, both times on the same input hash.
    expect(fake.sent.map((s) => s.prompt.split(':')[0])).toEqual(['first', 'second', 'second'])
    const after = ctx.workflow.records(done.runId)
    expect(after[0]!.outputReceipt).toEqual(before[0]!.outputReceipt)
    expect(after[1]!.inputReceipt!.inputHash).toBe(before[1]!.inputReceipt!.inputHash)
    const recovery = ctx.artifacts.list({ kind: 'decision', decisionType: 'recovery', runId: failed.runId }).map((a) => a.body as { decider: { type: string }; outcome: { option: string } })
    expect(recovery).toContainEqual(expect.objectContaining({ decider: expect.objectContaining({ type: 'operator' }), outcome: expect.objectContaining({ option: 'continue' }) }))
    expect(() => ctx.workflow.continue(failed.runId)).toThrow(/not failed/)
  }, 120_000)
})
