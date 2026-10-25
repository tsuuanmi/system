import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { replanAnswer, replanTemplate } from './replan.ts'
import { browserStack, settledOp, until, waitingPlan } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: re-planning after a step that needed approval ran, with plans approved by policy', () => {
  it('asks the operator for a re-plan after a step that needed approval already ran, even when plans are approved by policy', async () => {
    const { ctx } = await boot({ fake: { answer: replanAnswer }, workflow: { templates: { replan: replanTemplate() }, autoApprovePlans: true } })
    const run = ctx.workflow.start({ template: 'replan', input: 'q' })
    expect(await ctx.workflow.wait(run.runId, 90_000)).toMatchObject({ status: 'completed', answer: 'final from old finding' })
    await ctx.workflow.supersede(run.runId, 'context:1', { text: 'Corrected context' })
    await until(() => ctx.workflow.get(run.runId)?.blocked !== undefined, 20_000)
    const view = ctx.workflow.get(run.runId)!
    await settledOp(() => ctx.workflow.approve(run.runId, { verdict: 'approved', plan: waitingPlan(view) }))
    expect(await ctx.workflow.wait(run.runId, 60_000)).toMatchObject({ status: 'completed', answer: 'final from new finding' })
  }, 240_000)
})
