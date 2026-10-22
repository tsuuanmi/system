import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import type { BoardTask } from '@tsuuanmi/system-board-core'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import Workflow, { type RunView } from '@tsuuanmi/system-workflow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { activeProject, CONFIG, readyTask, ScriptedWorkers, TEMPLATES } from '../../workflow/conformance/workflow.ts'
import * as WebUi from '../src/index.ts'

// End to end over the store-backed board, approval queue, and engine, under the bundle's own
// default studio policy, with the operator's verdicts through the web UI's API. Only Worker
// execution is scripted.
vi.setConfig({ testTimeout: 120_000 })

const schemas = new SchemaRegistry()

/** The `approvals` row's policies, as the bundle ships them (`cordis.patch.yml`). */
function bundlePolicies(): AutonomyPolicy[] {
  const file = fileURLToPath(new URL('../../../system-bundle/cordis.patch.yml', import.meta.url))
  const rows: Array<{ id?: string; config?: { policies?: AutonomyPolicy[] } }> = []
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') {
      const row = value as { id?: string; config?: { policies?: AutonomyPolicy[] } }
      if (row.id === 'approvals' && row.config?.policies) rows.push(row)
      Object.values(value).forEach(walk)
    }
  }
  walk(parse(readFileSync(file, 'utf8')))
  expect(rows, 'the bundle has one approvals row with policies').toHaveLength(1)
  return rows[0]!.config!.policies!
}

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'system-ui-reviews-'))
  writeFileSync(join(dir, 'operator.token'), Buffer.alloc(32, 7), { mode: 0o600 })
  writeFileSync(join(dir, 'client.token'), Buffer.alloc(32, 8), { mode: 0o600 })
  const workers = new ScriptedWorkers()
  const ctx = new Context()
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => void c.workers.register(workers.source(c)) }),
    ctx.plugin(StoreApprovals, { policies: bundlePolicies(), sweepSeconds: 3600 }), ctx.plugin(StoreBoard, { sweepSeconds: 0 }),
    ctx.plugin(Workflow, { ...CONFIG, templates: TEMPLATES }),
    ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }), ctx.plugin(WebUi, { tokenDir: dir }),
  ]
  await Promise.all(fibers)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
  const call = async (path: string, body?: unknown, token = Buffer.alloc(32, 7).toString('base64url')): Promise<{ status: number; value: Record<string, unknown> }> => {
    const response = await fetch(`${origin}/ui/api/${path}`, body === undefined
      ? { headers: { authorization: `Bearer ${token}` } }
      : { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, value: await response.json() as Record<string, unknown> }
  }
  return { ctx, workers, call, client: Buffer.alloc(32, 8).toString('base64url') }
}

/** A workspace-write task run to completion: under the bundle's policy, its run reports neither tests nor lint, so it waits in review for the operator. */
async function reviewed(ctx: Context, title: string): Promise<{ task: BoardTask; run: RunView }> {
  const task = await readyTask(ctx, title, { actionClass: 'workspace-write', maxAttempts: 2 })
  const run = await ctx.workflow.start({ template: 'solo', input: `change ${title}`, classification: 'public', task: { taskId: task.taskId } })
  const deadline = Date.now() + 60_000
  while (ctx.workflow.get(run.runId)?.task?.phase !== 'reported') {
    if (Date.now() > deadline) throw new Error(`run ${run.runId} was not reported`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const view = ctx.workflow.get(run.runId)!
  expect(view).toMatchObject({ status: 'completed', task: { outcome: { status: 'review', state: 'review' } } })
  return { task: (await ctx.board.task(task.taskId))!, run: view }
}

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
