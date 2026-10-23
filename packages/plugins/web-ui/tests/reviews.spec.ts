import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeProject } from '../../workflow/conformance/workflow.ts'
import { boot as bootUi, reviewed } from './store-backed.ts'

// End to end over the store-backed board, approval queue, and engine, under the bundle's own
// default studio policy, with the operator's verdicts through the web UI's API. Only Worker
// execution is scripted.
vi.setConfig({ testTimeout: 120_000 })

const schemas = new SchemaRegistry()

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const boot = () => bootUi(cleanups)

describe('web UI: the operator accepts or rejects a board review held for the operator', () => {
  it('holds a workspace-write task\'s review past its run\'s lease, lists it with its pending checks, and takes only the operator\'s acceptance: done', async () => {
    const { ctx, call, client } = await boot()
    await activeProject(ctx)
    const { task, run } = await reviewed(ctx, 'kernel')
    schemas.assertRecord(task)
    expect(task).toMatchObject({ state: 'review', waiting: { reason: 'operator-review', pendingChecks: ['tests', 'lint'] } })
    expect(task.holder).toBeUndefined()
    // The bundle's policy: the operator has a day (expiry.defaultSeconds), not a lease's ten minutes.
    expect(Date.parse(task.waiting!.expiresAt) - Date.parse(task.waiting!.since)).toBe(86_400_000)
    await ctx.board.sweep(new Date(Date.now() + 11 * 60_000))
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'review', waiting: { reason: 'operator-review' } })

    const listed = await call('reviews')
    expect(listed.status).toBe(200)
    expect(listed.value.reviews).toEqual([expect.objectContaining({
      taskId: task.taskId, project: { projectId: 'p1', title: 'project p1' }, subject: task.result!.subject, artifacts: [run.result],
      pendingChecks: ['tests', 'lint'], run: expect.objectContaining({ runId: run.runId }), heldFor: 'operator', expiresAt: task.waiting!.expiresAt,
    })])

    // Only the operator's channel decides (INV-6): a client token is refused by the guard before any route.
    expect((await call(`reviews/${task.taskId}/decide`, { verdict: 'accept', subject: task.result!.subject }, client)).status).toBe(401)
    // The verdict binds to the result the page showed (INV-5).
    expect((await call(`reviews/${task.taskId}/decide`, { verdict: 'accept', subject: { ...task.result!.subject, ref: 'sha256:other' } })).status).toBe(409)
    expect((await call(`reviews/${task.taskId}/decide`, { verdict: 'maybe', subject: task.result!.subject })).status).toBe(400)
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'review' })

    const decided = await call(`reviews/${task.taskId}/decide`, { verdict: 'accept', subject: task.result!.subject, note: 'checked by hand' })
    expect(decided.status).toBe(200)
    expect(decided.value.task).toMatchObject({ state: 'done' })
    const done = (await ctx.board.task(task.taskId))!
    schemas.assertRecord(done)
    expect(done).toMatchObject({ state: 'done', result: { acceptance: decided.value.decision } })
    const envelope = ctx.artifacts.get(done.result!.acceptance!)!
    expect(envelope.producer).toMatchObject({ type: 'operator' })
    expect(envelope.body).toMatchObject({
      decisionType: 'acceptance', decider: { type: 'operator' }, rationale: 'checked by hand',
      outcome: { option: 'accept', detail: { taskId: task.taskId, subject: task.result!.subject } }, inputs: [run.result],
    })
    expect((await call('reviews')).value.reviews).toEqual([])
  })

  it('takes the operator\'s rejection as another attempt, through the gate', async () => {
    const { ctx, call } = await boot()
    await activeProject(ctx)
    const { task } = await reviewed(ctx, 'rejected')
    const decided = await call(`reviews/${task.taskId}/decide`, { verdict: 'reject', subject: task.result!.subject })
    expect(decided.status).toBe(200)
    const again = (await ctx.board.task(task.taskId))!
    expect(again).toMatchObject({ state: 'ready', attempts: { count: 1, max: 2 } })
    expect(again.waiting).toBeUndefined()
    // A task no longer in review takes no verdict.
    expect((await call(`reviews/${task.taskId}/decide`, { verdict: 'accept', subject: task.result!.subject })).status).toBe(409)
  })

  it('ends a review the operator did not decide by the policy\'s wait as review-expired', async () => {
    const { ctx, call } = await boot()
    await activeProject(ctx)
    const { task } = await reviewed(ctx, 'lapsed')
    await ctx.board.sweep(new Date(Date.parse(task.waiting!.expiresAt) - 1000))
    expect(await ctx.board.task(task.taskId)).toMatchObject({ state: 'review' })
    await ctx.board.sweep(new Date(Date.parse(task.waiting!.expiresAt) + 1000))
    const expired = (await ctx.board.task(task.taskId))!
    schemas.assertRecord(expired)
    expect(expired).toMatchObject({ state: 'waiting-for-input', waiting: { reason: 'review-expired' } })
    expect((await call(`reviews/${task.taskId}/decide`, { verdict: 'accept', subject: task.result!.subject })).status).toBe(409)
  })
})
