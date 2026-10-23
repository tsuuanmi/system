// The web UI over the store-backed board, approval queue, and engine, under the bundle's own
// default studio policy, with the operator's and a client's tokens. Only Worker execution is
// scripted. Shared by the reviews, policy, and projects suites.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import StoreApprovals, { type Config as ApprovalsConfig } from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import type { BoardTask } from '@tsuuanmi/system-board-core'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import Workflow, { type RunView } from '@tsuuanmi/system-workflow'
import { expect } from 'vitest'
import { parse } from 'yaml'
import { CONFIG, readyTask, ScriptedWorkers, TEMPLATES } from '../../workflow/conformance/workflow.ts'
import * as WebUi from '../src/index.ts'

/** The `approvals` row's policies, as the bundle ships them (`cordis.patch.yml`). */
export function bundlePolicies(): AutonomyPolicy[] {
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

export const OPERATOR = Buffer.alloc(32, 7).toString('base64url')
export const CLIENT = Buffer.alloc(32, 8).toString('base64url')

export interface Booted {
  ctx: Context
  workers: ScriptedWorkers
  dir: string
  /** Why the approval queue refused to start, if it did (then no board runs either). */
  refused?: Error
  call: (path: string, body?: unknown, token?: string) => Promise<{ status: number; value: Record<string, unknown> }>
  client: string
  stop: () => Promise<void>
}

/**
 * Boot the UI over a fresh store, or the store in `dir` (a restart). `approvals` overrides the
 * queue's configuration (the bundle's policies by default). A queue that refuses to start leaves
 * the board unstarted, as in the bundle, and the UI serving without them.
 */
export async function boot(cleanups: Array<() => unknown>, options: { dir?: string; approvals?: Partial<ApprovalsConfig> } = {}): Promise<Booted> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'system-ui-store-'))
  if (!options.dir) {
    writeFileSync(join(dir, 'operator.token'), Buffer.from(OPERATOR, 'base64url'), { mode: 0o600 })
    writeFileSync(join(dir, 'client.token'), Buffer.from(CLIENT, 'base64url'), { mode: 0o600 })
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  }
  const workers = new ScriptedWorkers()
  const ctx = new Context()
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
    ctx.plugin({ name: 'scripted-workers', inject: ['workers', 'artifacts'], apply: (c: Context) => void c.workers.register(workers.source(c)) }),
    ctx.plugin(Workflow, { ...CONFIG, templates: TEMPLATES }),
    ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }), ctx.plugin(WebUi, { tokenDir: dir }),
  ]
  await Promise.all(fibers)
  const approvals = ctx.plugin(StoreApprovals, { policies: bundlePolicies(), sweepSeconds: 3600, ...options.approvals })
  fibers.push(approvals)
  const refused = await Promise.resolve(approvals).then(() => undefined, (error: unknown) => error as Error)
  if (!refused) {
    const board = ctx.plugin(StoreBoard, { sweepSeconds: 0 })
    fibers.push(board)
    await board
  }
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  }
  cleanups.push(stop)
  const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
  const call = async (path: string, body?: unknown, token = OPERATOR): Promise<{ status: number; value: Record<string, unknown> }> => {
    const response = await fetch(`${origin}/ui/api/${path}`, body === undefined
      ? { headers: { authorization: `Bearer ${token}` } }
      : { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, value: await response.json() as Record<string, unknown> }
  }
  return { ctx, workers, dir, ...(refused ? { refused } : {}), call, client: CLIENT, stop }
}

/** A workspace-write task of project p1 run to completion: under the bundle's policy, its run reports neither tests nor lint, so it waits in review for the operator. */
export async function reviewed(ctx: Context, title: string): Promise<{ task: BoardTask; run: RunView }> {
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
