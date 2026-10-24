import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { browserStack, settledOp, until, waitingPlan } from './stack.ts'
import { TEST_TEMPLATES } from './templates.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: plans that wait for the operator\'s approval', () => {
  it('approves only the plan the operator names when two plans wait, never whichever came first (INV-5)', async () => {
    const [planner, synthesis] = TEST_TEMPLATES.investigate!
    const gated = { ...planner!, grows: { maxNodes: 2, approvalRequired: ['reason'] } }
    const twoPlans = [{ ...gated, nodeId: 'plan:a' }, { ...gated, nodeId: 'plan:b' }, { ...synthesis!, dependsOn: ['plan:a', 'plan:b'] }]
    const answer = (prompt: string): string => (prompt.includes('Plan how to answer')
      ? '```json\n{"confidence":"high","nodes":[{"id":"only","objective":"o","prompt":"the step","capabilities":["reason"],"tier":"economy"}]}\n```'
      : prompt.includes('<findings>') ? 'final' : 'step done')
    const { ctx } = await boot({ fake: { answer }, workflow: { templates: { twoPlans } } })
    const run = ctx.workflow.start({ template: 'twoPlans', input: 'q' })
    const plans = () => ctx.artifacts.list({ kind: 'plan', runId: run.runId })
    await until(() => plans().length === 2, 90_000)
    await until(() => ctx.workflow.records(run.runId).filter((r) => r.state === 'BLOCKED').length === 2, 30_000)
    expect(() => ctx.workflow.approve(run.runId, { verdict: 'approved' })).toThrow(/2 plans wait/)
    const [first, second] = plans()
    ctx.workflow.approve(run.runId, { verdict: 'approved', plan: first!.id })
    const approvals = () => ctx.artifacts.list({ kind: 'approval', runId: run.runId })
    expect(approvals().map((a) => (a.body as { subject: { ref: string } }).subject.ref)).toEqual([first!.id])
    // The run advances after a verdict (its lease is busy meanwhile); once it waits again, the
    // decided plan is no longer waiting and the other one is approved by its own id.
    await expect(settledOp(() => ctx.workflow.approve(run.runId, { verdict: 'approved', plan: first!.id }))).rejects.toThrow(/not waiting/)
    await settledOp(() => ctx.workflow.approve(run.runId, { verdict: 'approved', plan: second!.id }))
    expect((await ctx.workflow.wait(run.runId, 90_000)).status).toBe('completed')
  }, 240_000)

  it('holds steps that need approval until the operator approves the exact plan (REQ-WF-11)', async () => {
    const gated = TEST_TEMPLATES.investigate!.map((n) => (n.grows ? { ...n, grows: { maxNodes: 2, approvalRequired: ['reason'] } } : n))
    const answer = (prompt: string): string => (prompt.includes('Plan how to answer')
      ? '```json\n{"confidence":"high","nodes":[{"id":"only","objective":"o","prompt":"the step","capabilities":["reason"],"tier":"economy"}]}\n```'
      : prompt.includes('<findings>') ? 'final' : 'step done')
    const { ctx, fake } = await boot({ fake: { answer }, workflow: { templates: { gated, rejectable: gated } } })
    const run = ctx.workflow.start({ template: 'gated', input: 'q' })
    await until(() => ctx.workflow.get(run.runId)?.blocked !== undefined, 60_000)
    const blocked = ctx.workflow.get(run.runId)!
    expect(blocked).toMatchObject({ status: 'running', blocked: { nodeId: 'plan:1:gate' } })
    expect(blocked.updatedAt > blocked.createdAt).toBe(true) // the plan's progress shows while the run is still running
    expect(fake.sent).toHaveLength(1)
    ctx.workflow.approve(run.runId, { verdict: 'approved', note: 'fine' })
    const done = await ctx.workflow.wait(run.runId, 60_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'final' })
    const approval = ctx.artifacts.list({ kind: 'approval', runId: run.runId })[0]!
    expect(approval.body).toMatchObject({ verdict: 'approved', by: 'operator', subject: { type: 'artifact', ref: waitingPlan(blocked) } })
    // A rejection fails the run, and the steps never run.
    const second = ctx.workflow.start({ template: 'rejectable', input: 'q2' })
    await until(() => ctx.workflow.get(second.runId)?.blocked !== undefined, 60_000)
    ctx.workflow.approve(second.runId, { verdict: 'rejected' })
    expect(await ctx.workflow.wait(second.runId, 30_000)).toMatchObject({ status: 'failed', error: { kind: 'plan_rejected' } })
    expect(() => ctx.workflow.approve(second.runId, { verdict: 'approved' })).toThrow(/waiting for approval/)
  }, 150_000)
})
