/**
 * One engine process for the dispatch crash cases (plain JavaScript on the built packages, ADR-0063):
 * boots the store, routing, sessions, the store-backed approval queue (`dispatch` takes its default,
 * ask), board, and resource ledger, and the workflow engine with its dispatch pass, over one scripted
 * Worker of the account the ledger has a pool for. The source keeps its executions in
 * `<dir>/source.json`, so they outlive the process as a Worker runtime does; each one holds (runs on).
 * Reports on stdout as `@@ {json}` lines.
 * Usage: dispatch-harness.mjs <dir> ask-crash | adopt | approve-crash | finish
 * - ask-crash: an active project, a ready task, the pool read; a pass, killed right after the queue
 *   took its request and before its row records it.
 * - adopt: a pass; reports the live asks and the queue's dispatch requests.
 * - approve-crash: approves the open dispatch request, then a pass, killed right after the board
 *   recorded the dispatched run and before its row records it started.
 * - finish: a pass; waits until the run's step started; reports the asks, the requests, and the starts.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import StoreResources from '@tsuuanmi/system-resources'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import Workflow from '@tsuuanmi/system-workflow'

const [dir, mode] = process.argv.slice(2)
const report = (value) => void process.stdout.write(`@@ ${JSON.stringify(value)}\n`)
const AT = '2026-10-25T00:00:00Z'
const WORKER = {
  schema: 'capability-descriptor@1.5', worker: 'w:max', provider: 'crash', tier: 'standard', quotaClass: 'agent-plan', locality: 'local',
  capabilities: [{ capability: 'reason', evidence: { kind: 'conformance', at: AT } }], account: { id: 'max', group: 'g', mode: 'assigned' },
  load: { running: 0, queued: 0, pending: 0, slots: 1 }, state: 'ready', observedAt: AT,
}

/** The source's durable state: executions by key and id, and every start. */
const FILE = join(dir, 'source.json')
const state = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { executions: {}, keys: {}, started: [] }
const save = () => {
  writeFileSync(`${FILE}.tmp`, JSON.stringify(state))
  renameSync(`${FILE}.tmp`, FILE)
}
const source = {
  name: 'scripted',
  describe: async () => [WORKER],
  start: (request) => {
    const known = state.keys[request.key]
    if (known) return state.executions[known]
    const id = `x-${state.started.length + 1}`
    state.started.push({ id, key: request.key, worker: request.worker, runId: request.runId })
    state.keys[request.key] = id
    state.executions[id] = { id, status: 'running', submitted: true, decisions: [] }
    save()
    return state.executions[id]
  },
  get: (id) => state.executions[id],
  wait: (id) => new Promise((resolve) => setTimeout(() => resolve(state.executions[id]), 1000)),
}

// The asks as a killed process left them, read before this process's engine starts (its start's
// own pass settles them: a restart is a pass, INV-4).
if (existsSync(join(dir, 'system.db'))) {
  const db = new DatabaseSync(join(dir, 'system.db'), { readOnly: true })
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workflow_dispatch'").get()
  report({ before: table ? db.prepare('SELECT ask_id, state, request_id, run_id, worker FROM workflow_dispatch ORDER BY created_at').all().map((row) => ({ ...row })) : [] })
  db.close()
}

const POLICY = { schema: 'autonomy-policy@1.0', id: 'studio', version: 1, scope: 'studio', rules: [{ actionClass: 'read', mode: 'auto' }], default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 } }
const POOL = { pool: 'plan/max', account: 'max', kind: 'interactive', windows: [{ id: 'five-hour', kind: 'rolling', seconds: 18000 }] }
const solo = { nodeId: 'solo', objective: 'Do it', prompt: '{{input}}', capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer' }
const ctx = new Context()
// The board task's lease outlives the killed run's (the default cap): the restarted engine still holds the task.
const fibers = [
  ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
  ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}),
  ctx.plugin({ name: 'scripted-workers', inject: ['workers'], apply: (c) => void c.workers.register(source) }),
  ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 }), ctx.plugin(StoreBoard, { sweepSeconds: 0 }), ctx.plugin(StoreResources, { pools: [POOL] }),
  ctx.plugin(Workflow, { templates: { solo: [solo] }, dispatch: { sweepSeconds: 3600 } }),
]
await Promise.all(fibers)
await new Promise((resolve) => ctx.inject(['workflow', 'board', 'approvals', 'resources'], () => resolve(undefined)))
// The pass the engine makes at its start.
await ctx.workflow.sweepDispatch()
const dispatchRequests = async () => (await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).filter((r) => r.action.class === 'dispatch')
const read = () => ctx.resources.observe({
  schema: 'limit-state@1.0', pool: 'plan/max', account: 'max', window: POOL.windows[0], state: 'ok', usedPercentage: 0, source: 'runtime-result', observedAt: new Date().toISOString(),
})
const kill = (what) => {
  report({ killed: what })
  process.kill(process.pid, 'SIGKILL')
}

if (mode === 'ask-crash') {
  const { approvalRequest } = await ctx.board.charter({ projectId: 'p1', title: 'project p1', charter: {
    version: 1, intent: 'crash', criteria: [{ id: 'c1', statement: 'it works', measure: { kind: 'operator' } }], constraints: {},
    stopRules: [{ id: 'never', condition: 'never', action: 'stop' }], budget: { pools: [{ pool: 'plan/max', unit: 'runs', amount: 10 }] },
  } })
  const charter = await ctx.approvals.get(approvalRequest)
  await ctx.approvals.decide([{ requestId: approvalRequest, subject: charter.subject, verdict: 'approved' }])
  await ctx.board.sweep(new Date())
  const task = await ctx.board.propose({ projectId: 'p1', title: 'dispatched', goal: 'do it', acceptance: [{ id: 'a1', statement: 'it answers' }], actionClass: 'read', template: 'solo' })
  await ctx.board.sweep(new Date())
  await read()
  report({ taskId: task.taskId })
  // Killed once the queue committed the dispatch request, before the engine records it on its row.
  const request = StoreApprovals.prototype.request
  StoreApprovals.prototype.request = async function (...args) {
    const made = await request.apply(this, args)
    if (made.action.class === 'dispatch') kill({ request: made.requestId })
    return made
  }
  await ctx.workflow.sweepDispatch()
  await new Promise(() => undefined)
}
if (mode === 'approve-crash') {
  await read()
  const [open] = (await dispatchRequests()).filter((r) => r.state === 'open' || r.state === 'batched')
  await ctx.approvals.decide([{ requestId: open.requestId, subject: open.subject, verdict: 'approved' }])
  // Killed once the board recorded the dispatched run (the engine admitted it), before the ask's row says so.
  const start = StoreBoard.prototype.start
  StoreBoard.prototype.start = async function (...args) {
    const task = await start.apply(this, args)
    kill({ run: task.run.runId })
    return task
  }
  await ctx.workflow.sweepDispatch()
  await new Promise(() => undefined)
}
const asks = () => ctx.store.db.prepare('SELECT ask_id, state, request_id, run_id, worker FROM workflow_dispatch ORDER BY created_at').all()
await read()
await ctx.workflow.sweepDispatch()
if (mode === 'finish') {
  for (let i = 0; i < 1200 && !state.started.length; i++) await new Promise((resolve) => setTimeout(resolve, 100))
  await ctx.workflow.sweepDispatch()
}
const status = ctx.workflow.dispatchStatus()
const rows = asks()
report({ status: { asks: status.asks, lastPass: status.lastPass }, rows, requests: (await dispatchRequests()).map((r) => ({ requestId: r.requestId, state: r.state, subject: r.subject })), started: state.started })
for (const fiber of [...fibers].reverse()) await fiber.dispose()
process.exit(0)
