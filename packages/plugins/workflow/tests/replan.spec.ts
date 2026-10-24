import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { browserStack, until, waitingPlan } from './stack.ts'
import { TEST_TEMPLATES } from './templates.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: re-planning after a superseded input or plan', () => {
  /**
   * A gated planner with an input upstream of it: what re-planning invalidates (REQ-ART-2,
   * REQ-WF-11). `plan:1:extra` is a template node that only shares the planner's id prefix.
   */
  const replanTemplate = (approvalRequired = ['reason']) => {
    const [planner, synthesis] = TEST_TEMPLATES.investigate!
    const step = (nodeId: string, prompt: string, dependsOn: string[] = []) => ({ nodeId, objective: nodeId, prompt, dependsOn, capabilities: ['reason'], tier: 'economy' as const, conversation: 'temporary' as const, acceptance: 'acceptance.answer' })
    return [
      step('context:1', 'context for: {{input}}'),
      step('plan:1:extra', 'extra for: {{input}}', ['context:1']),
      { ...planner!, dependsOn: ['context:1'], prompt: `${planner!.prompt}\n\nContext: {{node:context:1}}`, grows: { maxNodes: 2, approvalRequired } },
      { ...synthesis!, dependsOn: ['plan:1', 'plan:1:extra'] },
    ]
  }
  const planOf = (step: string) => '```json\n' + JSON.stringify({ confidence: 'high', nodes: [{ id: step, objective: `Do ${step}`, prompt: `the ${step}`, capabilities: ['reason'], tier: 'economy' }] }) + '\n```'
  const replanAnswer = (prompt: string): string => {
    if (prompt.includes('context for:')) return 'context v1'
    if (prompt.includes('extra for:')) return 'extra'
    if (prompt.includes('Plan how to answer')) return planOf(prompt.includes('Corrected context') ? 'new-step' : 'old-step')
    if (prompt.includes('<findings>')) return `final from ${['old finding', 'new finding'].filter((f) => prompt.includes(f)).join(' and ')}`
    return prompt.includes('the new-step') ? 'new finding' : 'old finding'
  }
  const settledOp = async <T,>(fn: () => T): Promise<T> => {
    for (let i = 0; ; i++) {
      try {
        return fn()
      } catch (error) {
        if (!/busy/.test((error as Error).message) || i > 100) throw error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
  const states = (view: { nodes: Array<{ nodeId: string; state: string }> }) => Object.fromEntries(view.nodes.map((n) => [n.nodeId, n.state]))

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

  it('counts a step that needed approval as having run once it started, even when it then failed', async () => {
    const answer = (prompt: string): string => (prompt.includes('the old-step') ? '' : replanAnswer(prompt))
    const { ctx } = await boot({ fake: { answer }, workflow: { templates: { replan: replanTemplate() }, autoApprovePlans: true } })
    const run = ctx.workflow.start({ template: 'replan', input: 'q' })
    const failed = await ctx.workflow.wait(run.runId, 120_000)
    expect(failed.status).toBe('failed')
    expect(states(failed)['plan:1:old-step']).toBe('FAILED')
    await ctx.workflow.supersede(run.runId, 'context:1', { text: 'Corrected context' })
    await until(() => ctx.workflow.get(run.runId)?.blocked !== undefined, 20_000)
    expect(ctx.workflow.get(run.runId)).toMatchObject({ status: 'running', blocked: { nodeId: 'plan:1:g2:gate' } })
  }, 240_000)
})
