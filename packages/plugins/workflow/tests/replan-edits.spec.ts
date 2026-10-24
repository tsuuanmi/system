import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { planOf, replanAnswer, replanTemplate, states } from './replan.ts'
import { browserStack, settledOp, until, waitingPlan } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: re-planning by superseding a rejected plan', () => {
  it('edits a rejected plan by superseding the planner\'s result: a new plan and gate, never the old approval, and the planner is not asked again', async () => {
    const { ctx, fake } = await boot({ fake: { answer: replanAnswer }, workflow: { templates: { replan: replanTemplate() } } })
    const run = ctx.workflow.start({ template: 'replan', input: 'q' })
    await until(() => ctx.workflow.get(run.runId)?.blocked !== undefined, 60_000)
    const oldPlan = waitingPlan(ctx.workflow.get(run.runId)!)
    await settledOp(() => ctx.workflow.approve(run.runId, { verdict: 'rejected', note: 'wrong step' }))
    expect(await ctx.workflow.wait(run.runId, 30_000)).toMatchObject({ status: 'failed', error: { kind: 'plan_rejected' } })
    const asked = fake.sent.length
    await ctx.workflow.supersede(run.runId, 'plan:1', { text: planOf('edited-step'), note: 'the operator edited the plan' })
    await until(() => ctx.workflow.get(run.runId)?.blocked !== undefined, 20_000)
    const view = ctx.workflow.get(run.runId)!
    expect(states(view)).toMatchObject({ 'plan:1:gate': 'RETIRED', 'plan:1:old-step': 'RETIRED', 'plan:1:g2:gate': 'BLOCKED', 'plan:1:g2:edited-step': 'WAITING' })
    expect(ctx.artifacts.get(waitingPlan(view))).toMatchObject({ lineage: { supersedes: [oldPlan] } })
    await expect(settledOp(() => ctx.workflow.approve(run.runId, { verdict: 'approved', plan: oldPlan }))).rejects.toThrow(/not waiting/)
    await settledOp(() => ctx.workflow.approve(run.runId, { verdict: 'approved', plan: waitingPlan(view) }))
    expect((await ctx.workflow.wait(run.runId, 60_000)).status).toBe('completed')
    expect(fake.sent.slice(asked).map((s) => s.prompt.includes('Plan how to answer'))).not.toContain(true)
    // A gate is decided by a verdict, never replaced.
    await expect(ctx.workflow.supersede(run.runId, 'plan:1:g2:gate', { text: 'approved' })).rejects.toThrow(/approve or reject the plan/)
  }, 240_000)

  it('refuses a superseding plan that fails validation, and changes nothing', async () => {
    const { ctx } = await boot({ fake: { answer: replanAnswer }, workflow: { templates: { replan: replanTemplate() } } })
    const run = ctx.workflow.start({ template: 'replan', input: 'q' })
    await until(() => ctx.workflow.get(run.runId)?.blocked !== undefined, 60_000)
    await settledOp(() => ctx.workflow.approve(run.runId, { verdict: 'rejected' }))
    await ctx.workflow.wait(run.runId, 30_000)
    const before = ctx.workflow.get(run.runId)!
    await expect(ctx.workflow.supersede(run.runId, 'plan:1', { text: 'not a plan at all' })).rejects.toThrow(/replacement plan is refused/)
    expect(ctx.workflow.get(run.runId)).toEqual(before)
  }, 120_000)
})
