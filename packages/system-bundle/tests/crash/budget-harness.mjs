/**
 * One engine process for the spent-budget crash cases (plain JavaScript on the built packages):
 * boots the store, routing, the store-backed approval queue, board, and resource ledger, and the
 * workflow engine. `start <point>` founds a project with one task of one attempt whose `runs` line
 * the ledger already counts as reached, starts the task's run, and kills itself with SIGKILL at
 * `<point>`: `decision`, once the engine recorded its last-attempt decision, inside the transaction
 * that fails the run, before it commits; `report`, once that committed, as the run's report reaches
 * the board. `steps <point>` founds one task of one attempt with one `runs` line nothing has drawn
 * yet, and starts a two-step run of it on a scripted Worker whose every run draws one run (ADR-0047,
 * step 1): the first step reserves the line, runs, and spends it, so the second is refused. It is
 * killed at `hold`, once the first step's reservation is on the run's row, as its execution starts
 * (before the start commits), or at `end`, once the second step's refusal committed, as the engine
 * records its last-attempt decision. `resume` (`resume steps` for those) prints the run's row as the
 * dead process left it, boots the same stack on the same state, waits for the run's report, and
 * prints what the run, the board, the queue, the decisions, and the ledger show. Output: `@@ {json}`
 * lines; each start of the scripted Worker appends its key to `<dir>/started`.
 * Usage: budget-harness.mjs <dir> start <decision|report> | steps <hold|end> | resume [steps]
 */
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
const steps = mode === 'steps' || point === 'steps'
const report = (value) => void process.stdout.write(`@@ ${JSON.stringify(value)}\n`)
const die = () => {
  process.kill(process.pid, 'SIGKILL')
  // SIGKILL is not handled: nothing after it runs.
  const until = Date.now() + 10_000
  while (Date.now() < until);
}

if ((mode === 'start' && point === 'decision') || (mode === 'steps' && point === 'end')) {
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
  const row = db.prepare('SELECT r.status, t.phase, t.budget, t.run_id FROM workflow_tasks t JOIN workflow_runs r ON r.run_id = t.run_id').get()
  const nodes = db.prepare('SELECT node_id, state FROM workflow_nodes WHERE run_id = ? ORDER BY ordinal').all(row.run_id).map((n) => [n.node_id, n.state])
  db.close()
  report({ left: { status: row.status, phase: row.phase, budget: JSON.parse(row.budget), nodes } })
}

/** Two Worker steps, the second on the first's answer. */
const step = (nodeId, prompt, extra = {}) => ({ nodeId, objective: nodeId, prompt, capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer', ...extra })
const TEMPLATES = { pair: [step('a', 'A: {{input}}'), step('b', 'B: {{node:a}}', { dependsOn: ['a'] })] }
const AT = '2026-10-23T00:00:00Z'
const DESCRIPTOR = {
  schema: 'capability-descriptor@1.0', worker: 'w:crash', provider: 'crash', tier: 'standard', quotaClass: 'subscription-chat', locality: 'remote',
  capabilities: [{ capability: 'reason', evidence: { kind: 'conformance', at: AT } }], state: 'ready', observedAt: AT,
}
/**
 * A scripted Worker that lives in this process only: each start is idempotent by its key and
 * appended to `<dir>/started`; it answers once waited on, after recording that its run drew one run
 * of the pool for the workflow run (the ledger counts it for the task the run was reserved for).
 */
const scripted = (c) => {
  const executions = new Map()
  return {
    name: 'crash-workers',
    describe: async () => [DESCRIPTOR],
    start: (request) => {
      if (mode === 'steps' && point === 'hold') die()
      const id = `x-${createHash('sha256').update(request.key).digest('hex').slice(0, 16)}`
      if (!executions.has(id)) {
        appendFileSync(join(dir, 'started'), `${request.key}\n`)
        executions.set(id, { execution: { id, status: 'running', submitted: true, decisions: [] }, runId: request.runId })
      }
      return { ...executions.get(id).execution }
    },
    get: (id) => executions.get(id) && { ...executions.get(id).execution },
    wait: async (id) => {
      const held = executions.get(id)
      if (held?.execution.status === 'running') {
        await c.resources.record({ schema: 'usage-record@1.0', requestId: id, source: 'runtime-result', observedAt: new Date().toISOString(), account: 'max', pool: POOL.pool, runId: held.runId, turns: 1 })
        const text = 'half of it'
        held.execution.result = c.artifacts.put({
          kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'public', producer: { type: 'worker', ref: DESCRIPTOR.worker },
          body: { schema: 'provider-answer@1.0', provider: 'crash', account: 'crash', turnId: id, conversation: { mode: 'temporary' }, promptHash: `sha256:${createHash('sha256').update(id).digest('hex')}`, text },
        }).id
        held.execution.status = 'completed'
      }
      return held && { ...held.execution }
    },
  }
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
  // The leases keep their default cap, unlike the other harnesses' (LEASE_CAP_MS, leases.mjs): it
  // caps the run's lease on its board task too, which must outlive the run's own lease, as it does
  // on a real restart (600 s against 60 s). Capped together, the task's lease lapses as the restart
  // takes the run, and the run ends as holder_lost: another case than the one this harness injects.
  ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
  ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}), ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 }),
  ctx.plugin(StoreBoard, { sweepSeconds: 0 }), ctx.plugin(StoreResources, { pools: [POOL] }),
  ...(steps ? [ctx.plugin({ name: 'crash-workers', inject: ['workers', 'artifacts', 'resources'], apply: (c) => void c.workers.register(scripted(c)) })] : []),
  ctx.plugin(Workflow, { retryDelayMs: 300, templates: TEMPLATES }),
]
await Promise.all(fibers)
await new Promise((resolve) => ctx.inject(['workflow', 'board', 'approvals', 'resources'], () => resolve(undefined)))

if (mode === 'start' || mode === 'steps') {
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
  // Earlier work drew the task's one run: its line is reached. With two steps, the first step draws it.
  if (mode === 'start') await ctx.resources.record({ schema: 'usage-record@1.0', requestId: 'earlier', source: 'runtime-result', observedAt: at, account: 'max', pool: POOL.pool, taskId, turns: 1 })
  const { runId } = await ctx.workflow.start({ template: mode === 'steps' ? 'pair' : 'ask', input: 'q', classification: 'public', task: { taskId } })
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
// The ledger's own decisions on the run's reservations, and whether any of them is still held.
const budgets = ctx.artifacts.list({ kind: 'decision', decisionType: 'budget', limit: 1000 }).filter((a) => a.body.outcome.detail?.runId === runId)
  .map((a) => ({ option: a.body.outcome.option, reservationId: a.body.outcome.detail.reservationId }))
const held = []
for (const { reservationId } of budgets) {
  if (!reservationId) continue
  const live = await ctx.resources.release(reservationId).then(() => true, () => false)
  if (live) held.push(reservationId)
}
report({ settled: { run: ctx.workflow.get(runId), task: await ctx.board.task(task.taskId), decisions, requests, budgets: budgets.map((b) => b.option), held, nodes: ctx.workflow.records(runId).map((r) => [r.nodeId, r.state]) } })
for (const fiber of [...fibers].reverse()) await fiber.dispose()
process.exit(0)
