import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { replanAnswer, replanTemplate, settledOp, states } from './replan.ts'
import { browserStack, until, waitingPlan } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: re-planning after a superseded input or plan', () => {
  it('re-plans after an input upstream of a planner is superseded: the old plan is retired as history, and the new one waits for a new approval (REQ-ART-2, REQ-WF-11, INV-5)', async () => {
    const { ctx } = await boot({ fake: { answer: replanAnswer }, workflow: { templates: { replan: replanTemplate() } } })
    const run = ctx.workflow.start({ template: 'replan', input: 'q' })
    await until(() => ctx.workflow.get(run.runId)?.blocked !== undefined, 60_000)
    const oldPlan = waitingPlan(ctx.workflow.get(run.runId)!)
    await settledOp(() => ctx.workflow.approve(run.runId, { verdict: 'approved', plan: oldPlan }))
    expect(await ctx.workflow.wait(run.runId, 60_000)).toMatchObject({ status: 'completed', answer: 'final from old finding' })
    // Long after the run ended: the re-plan starts at once, not when a lease expires.
    await new Promise((resolve) => setTimeout(resolve, 1500))

    expect(await ctx.workflow.supersede(run.runId, 'context:1', { text: 'Corrected context' })).toMatchObject({ status: 'running' })
    await until(() => ctx.workflow.get(run.runId)?.blocked !== undefined, 20_000)
    const newPlan = waitingPlan(ctx.workflow.get(run.runId)!)
    expect(newPlan).not.toBe(oldPlan)
    expect(ctx.artifacts.get(newPlan)).toMatchObject({ kind: 'plan', lineage: { supersedes: [oldPlan] } })
    // The old plan's approval never opens the new gate, and a verdict on a replacement names it.
    await expect(settledOp(() => ctx.workflow.approve(run.runId, { verdict: 'approved', plan: oldPlan }))).rejects.toThrow(/not waiting/)
    await expect(settledOp(() => ctx.workflow.approve(run.runId, { verdict: 'approved' }))).rejects.toThrow(/replaces plan/)
    await settledOp(() => ctx.workflow.approve(run.runId, { verdict: 'approved', plan: newPlan }))
    const done = await ctx.workflow.wait(run.runId, 60_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'final from new finding' })
    // Retired nodes stay as history; a template node that shares the prefix is never retired.
    expect(states(done)).toEqual({
      'context:1': 'COMPLETED', 'plan:1:extra': 'COMPLETED', 'plan:1': 'COMPLETED', 'plan:1:gate': 'RETIRED', 'plan:1:old-step': 'RETIRED',
      'plan:1:g2:gate': 'COMPLETED', 'plan:1:g2:new-step': 'COMPLETED', 'synthesis:1': 'COMPLETED',
    })
    expect(ctx.artifacts.list({ kind: 'approval', runId: run.runId }).map((a) => (a.body as { subject: { ref: string } }).subject.ref)).toEqual([oldPlan, newPlan])
    const retire = ctx.artifacts.list({ kind: 'decision', decisionType: 'graph-growth', runId: run.runId })
      .find((a) => (a.body as { outcome: { option: string } }).outcome.option === 'retire')!
    expect((retire.body as { outcome: { detail: { retired: Array<{ nodeId: string; state: string }> } } }).outcome.detail.retired.map((r) => [r.nodeId, r.state]))
      .toEqual([['plan:1:gate', 'COMPLETED'], ['plan:1:old-step', 'COMPLETED']])
    expect(retire.inputs).toContain(oldPlan)
    const retiredRecord = ctx.workflow.records(run.runId).find((r) => r.nodeId === 'plan:1:old-step')!
    // Retired after it ran: its execution names its brief, so it is written as 1.2 (1.1 adds RETIRED, 1.2 the brief).
    expect(retiredRecord).toMatchObject({ schema: 'workflow-node@1.2', state: 'RETIRED', lastDecision: retire.id })
    const schemas = new SchemaRegistry()
    for (const record of ctx.workflow.records(run.runId)) schemas.assertRecord(record)
  }, 240_000)
})
