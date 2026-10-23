/**
 * One engine process for the spent-budget crash cases (plain JavaScript on the built packages):
 * boots the store, routing, the store-backed approval queue, board, and resource ledger, and the
 * workflow engine. `start <point>` founds a project with one task of one attempt whose `runs` line
 * the ledger already counts as reached, starts the task's run, and kills itself with SIGKILL at
 * `<point>`: `decision`, once the engine recorded its last-attempt decision, inside the transaction
 * that fails the run, before it commits; `report`, once that committed, as the run's report reaches
 * the board. `resume` prints the run's row as the dead process left it, boots the same stack on the
 * same state, waits for the run's report, and prints what the run, the board, the queue, and the
 * decisions show. Output: `@@ {json}` lines.
 * Usage: budget-harness.mjs <dir> start <decision|report> | resume
 */
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

const [dir, mode, point] = process.argv.slice(2)
const report = (value) => void process.stdout.write(`@@ ${JSON.stringify(value)}\n`)
const die = () => {
  process.kill(process.pid, 'SIGKILL')
  // SIGKILL is not handled: nothing after it runs.
  const until = Date.now() + 10_000
  while (Date.now() < until);
}

if (mode === 'start' && point === 'decision') {
  const record = Artifacts.prototype.recordDecision
  Artifacts.prototype.recordDecision = function (decision, ...rest) {
    const recorded = record.call(this, decision, ...rest)
    if (decision.decider?.id === 'workflow.task-funding') die()
    return recorded
  }
} else if (mode === 'start' && point === 'report') {
  StoreBoard.prototype.reconcileRun = die
} else if (mode === 'resume') {
  // What the dead process left, before anything reconciles it.
  const db = new DatabaseSync(join(dir, 'system.db'))
  const row = db.prepare('SELECT r.status, t.phase, t.budget FROM workflow_tasks t JOIN workflow_runs r ON r.run_id = t.run_id').get()
  db.close()
  report({ left: { status: row.status, phase: row.phase, budget: JSON.parse(row.budget) } })
}

const POLICY = {
  schema: 'autonomy-policy@1.0', id: 'studio', version: 1, scope: 'studio', rules: [{ actionClass: 'read', mode: 'auto' }],
  default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86400 },
}
const POOL = { pool: 'max.programmatic', account: 'max', kind: 'programmatic', windows: [{ id: 'monthly', kind: 'credit' }] }
const CHARTER = {
  version: 1, intent: 'A kernel at least 3x faster.', criteria: [{ id: 'speed', statement: 'Median speed-up at least 3x', measure: { kind: 'operator' } }],
  constraints: {}, stopRules: [{ id: 'no-gain', condition: 'Below 1.5x after two milestones', action: 'stop' }],
  budget: { pools: [{ pool: POOL.pool, unit: 'runs', amount: 10 }] },
}

const ctx = new Context()
const fibers = [
  ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
  ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}), ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 }),
  ctx.plugin(StoreBoard, { sweepSeconds: 0 }), ctx.plugin(StoreResources, { pools: [POOL] }), ctx.plugin(Workflow, { retryDelayMs: 300 }),
]
await Promise.all(fibers)
await new Promise((resolve) => ctx.inject(['workflow', 'board', 'approvals', 'resources'], () => resolve(undefined)))

if (mode === 'start') {
  const { approvalRequest } = await ctx.board.charter({ projectId: 'p1', title: 'project p1', charter: CHARTER })
  const charter = await ctx.approvals.get(approvalRequest)
  await ctx.approvals.decide([{ requestId: approvalRequest, subject: charter.subject, verdict: 'approved' }])
  await ctx.board.sweep(new Date())
  const { taskId } = await ctx.board.propose({
    projectId: 'p1', title: 'last', goal: 'do it', acceptance: [{ id: 'a1', statement: 'it answers' }], actionClass: 'read',
    maxAttempts: 1, budget: [{ pool: POOL.pool, unit: 'runs', amount: 1 }],
  })
  await ctx.board.sweep(new Date())
  const at = new Date().toISOString()
  await ctx.resources.observe({ schema: 'limit-state@1.0', pool: POOL.pool, account: 'max', window: { id: 'monthly', kind: 'credit' }, state: 'ok', source: 'runtime-result', observedAt: at })
  // Earlier work drew the task's one run: its line is reached.
  await ctx.resources.record({ schema: 'usage-record@1.0', requestId: 'earlier', source: 'runtime-result', observedAt: at, account: 'max', pool: POOL.pool, taskId, turns: 1 })
  const { runId } = await ctx.workflow.start({ template: 'ask', input: 'q', classification: 'public', task: { taskId } })
  report({ runId, taskId })
  // The process dies at the injected point; still alive after this, it never came.
  await new Promise((resolve) => setTimeout(resolve, 120_000))
  report({ survived: true })
  process.exit(1)
}

const [task] = await ctx.board.tasks({ projectId: 'p1' })
const runId = task.run.runId
const deadline = Date.now() + 180_000
while (ctx.workflow.get(runId)?.task?.phase !== 'reported' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
const decisions = ctx.artifacts.list({ kind: 'decision', decisionType: 'gate', limit: 1000 }).filter((a) => a.body.decider.id === 'workflow.task-funding').map((a) => a.id)
const requests = (await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })).filter((r) => r.requester.taskId === task.taskId)
report({ settled: { run: ctx.workflow.get(runId), task: await ctx.board.task(task.taskId), decisions, requests } })
for (const fiber of [...fibers].reverse()) await fiber.dispose()
process.exit(0)
