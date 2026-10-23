/**
 * A deferred tool call's continuation (docs/design/workflow-engine.md#a-deferred-tool-call). A
 * Worker whose tool gate deferred a call on an approval request stops there, and its execution
 * fails (`config_error`, naming the request): the workers seam has no waiting status. When the
 * operator approves that request in the queue, the engine continues the session by itself, once:
 * the node that served the run, reopened as a new attempt on the same session, with a brief that
 * says the call was approved, so the Worker makes exactly that call (its gate lets the approved
 * call run once). Bounded: at most once per approval, recorded as a `recovery` decision; a
 * rejected, expired, or withdrawn request continues nothing, and nor does a run that moved on.
 *
 * Which request an execution deferred on is read from the Worker gate's own record of it (the
 * `agent-workers.tool.deferred` event: the agent run and the request id), and the request itself
 * is checked in full through `ctx.approvals` before anything runs (INV-5): requester `worker`,
 * that execution as its run, that session.
 */
import type { Approvals, ApprovalRequest } from '@tsuuanmi/system-approvals-core'
import type { Lease } from '@tsuuanmi/system-leases'
import { canonicalJson, sha256 } from '@tsuuanmi/system-libs'
import type { ArtifactRef, WorkerExecution } from '@tsuuanmi/system-workers-core'
import { instructionsText } from './briefs.ts'
import type { Engine } from './engine.ts'
import { queueOf } from './queue.ts'
import { appended, type Instructions, literal, type ResolvedNode } from './spec.ts'
import { LEASE_TTL_MS, type NodeRecord, type NodeRow, now, type RunRow, type WorkflowError } from './types.ts'

/** The event a Worker's tool gate appends when it defers a call (docs/design/approvals.md#what-each-verdict-does). */
const DEFERRED = 'agent-workers.tool.deferred'
const RULE = { type: 'rule', id: 'workflow.approved-call', version: '1' } as const
/** Deferrals settled per sweep, oldest first (INV-9). */
const PAGE = 100

interface DeferralRow { request_id: string; run_id: string; node_id: string; execution_id: string; session_id: string; created_at: string }
type Outcome = 'continued' | 'rejected' | 'unbound' | 'moved-on'

/**
 * When a node fails for good on an execution its Worker's gate deferred (sent, `config_error`, on
 * a session a later execution can continue), note the request it waits on, in the transaction
 * that fails the node. A board task's run is not noted: the board decides its next attempt.
 */
export function noteDeferral(e: Engine, run: RunRow, node: NodeRow, error: WorkflowError, execution: WorkerExecution | undefined): void {
  if (!execution || !execution.submitted || error.kind !== 'config_error' || e.tasks.bound(run.run_id)) return
  const sessionId = (JSON.parse(node.spec) as ResolvedNode).session.sessionId
  if (!sessionId) return
  const deferred = e.ctx.eventLog.query({ type: DEFERRED, runId: run.run_id, limit: 1000 })
    .filter((event) => event.data?.agentRun === execution.id && typeof event.data.requestId === 'string').at(-1)
  if (!deferred) return
  e.ctx.store.db.prepare('INSERT OR IGNORE INTO workflow_deferrals (request_id, run_id, node_id, execution_id, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(deferred.data!.requestId), run.run_id, node.node_id, execution.id, sessionId, now())
}

/**
 * Read the queue for the requests deferred executions wait on (every `approvalPollSeconds`, and
 * once at start): an approved one continues its session, once; a rejected one, or one whose run
 * moved on, is settled with nothing run. With no queue loaded, they wait.
 */
export function sweepDeferrals(e: Engine): Promise<void> {
  // One sweep at a time: a slow queue never stacks them up.
  const running = sweeps.get(e)
  if (running) return running
  const sweep = sweepOnce(e).finally(() => sweeps.delete(e))
  sweeps.set(e, sweep)
  return sweep
}

const sweeps = new WeakMap<Engine, Promise<void>>()

async function sweepOnce(e: Engine): Promise<void> {
  const approvals = queueOf(e)
  if (!approvals || e.stopped.signal.aborted) return
  const rows = e.ctx.store.db.prepare(`SELECT * FROM workflow_deferrals WHERE settled_at IS NULL ORDER BY created_at LIMIT ${PAGE}`).all() as unknown as DeferralRow[]
  for (const row of rows) {
    if (e.stopped.signal.aborted) return
    try {
      await settle(e, approvals, row)
    } catch (error) {
      e.ctx.logger.warn(`workflow: the deferred call of run ${row.run_id} (approval request ${row.request_id}) is left for the next sweep: ${(error as Error).message}`)
    }
  }
}

async function settle(e: Engine, approvals: Approvals, row: DeferralRow): Promise<void> {
  if (movedOn(e, row)) return mark(e, row, 'moved-on')
  const request = await approvals.get(row.request_id)
  if (!request || request.state === 'open' || request.state === 'batched') return
  if (request.state === 'rejected') return mark(e, row, 'rejected', request.resolution?.decision)
  if (!binds(request, row)) {
    e.ctx.logger.warn(`workflow: approval request ${row.request_id} is not the call execution ${row.execution_id} of run ${row.run_id} deferred (INV-5); nothing is continued`)
    return mark(e, row, 'unbound', request.resolution?.decision)
  }
  const lease = e.ctx.leases.acquire(`run:${row.run_id}`, LEASE_TTL_MS)
  // The run is busy elsewhere (an operator action): the next sweep looks again.
  if (!lease) return
  let continued = false
  try {
    continued = proceed(e, row, request, () => lease)
  } finally {
    e.ctx.leases.release(lease)
  }
  if (continued) e.schedule(row.run_id)
}

/** The request is for exactly the call this execution deferred: asked by its Worker's gate, for that run and session, and approved by the operator. */
function binds(request: ApprovalRequest, row: DeferralRow): boolean {
  return request.requester.component === 'worker' && request.requester.runId === row.execution_id && request.requester.sessionId === row.session_id
    && request.resolution?.cause === 'verdict' && request.resolution.approval !== undefined
}

/** The run no longer fails on that execution: continued, stopped and deleted, or another node failed beside it. */
function movedOn(e: Engine, row: DeferralRow): boolean {
  const run = e.runRow(row.run_id)
  const node = e.nodeRow(row.run_id, row.node_id)
  if (!run || run.status !== 'failed' || !node || node.state !== 'FAILED' || node.execution_id !== row.execution_id) return true
  if (!node.brief_parts && !node.prompt) return true
  return e.nodeRows(row.run_id).some((n) => n.state === 'FAILED' && n.node_id !== row.node_id)
}

function mark(e: Engine, row: DeferralRow, outcome: Outcome, decision?: ArtifactRef): void {
  e.ctx.store.db.prepare('UPDATE workflow_deferrals SET settled_at = ?, outcome = ?, decision = ? WHERE request_id = ? AND settled_at IS NULL').run(now(), outcome, decision ?? null, row.request_id)
}

/**
 * Continue the session, once: under the run's lease, in one transaction that settles the deferral
 * (so a second sweep, here or in another process, continues nothing), records the decision, and
 * reopens the node as a new attempt whose instructions end with the approval. False when the run
 * moved on meanwhile.
 */
function proceed(e: Engine, row: DeferralRow, request: ApprovalRequest, lease: () => Lease): boolean {
  return e.ctx.store.transaction((db) => {
    e.ctx.leases.fence(lease())
    if (movedOn(e, row)) {
      mark(e, row, 'moved-on')
      return false
    }
    // Settled already (by another sweep, here or in another process): it continues nothing again.
    if (!db.prepare('SELECT 1 FROM workflow_deferrals WHERE request_id = ? AND settled_at IS NULL').get(row.request_id)) return false
    const node = e.nodeRow(row.run_id, row.node_id)!
    const spec = JSON.parse(node.spec) as ResolvedNode
    const record = JSON.parse(node.record) as NodeRecord
    const approval = request.resolution!.approval!
    const decision = e.ctx.artifacts.recordDecision({
      decisionType: 'recovery',
      question: `Does node ${row.node_id} of run ${row.run_id} continue session ${row.session_id} now that the operator approved the call its Worker stopped at?`,
      inputs: [approval, request.resolution!.decision],
      candidates: [
        { option: 'continue', selected: true, reasons: [`the operator approved request ${request.requestId} (${request.action.summary.slice(0, 300)}), the exact call execution ${row.execution_id} deferred on; the session continues once, as a new attempt, to make that call`] },
        { option: 'leave', selected: false, reasons: ['not leave: an approved call is continued by the engine, once per approval, so the operator need not start it'] },
      ],
      decider: RULE,
      outcome: { option: 'continue', detail: { approvalRequest: request.requestId, approval, execution: row.execution_id, sessionId: row.session_id } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'workflow' }, runId: row.run_id, nodeId: row.node_id }).id as ArtifactRef
    db.prepare("UPDATE workflow_deferrals SET settled_at = ?, outcome = 'continued', decision = ? WHERE request_id = ?").run(now(), decision, row.request_id)
    // The brief says the call was approved: the next message of the session (pointers, never content).
    const parts = appended(node.brief_parts ? JSON.parse(node.brief_parts) as Instructions : literal(node.prompt!),
      `\n\nThe operator approved the tool call you stopped at (approval request ${request.requestId}). Make exactly that call again now; it runs once. Then finish the work above.`)
    const prompt = instructionsText(e, parts)
    const inputHash = sha256(canonicalJson({ node: spec, prompt, dependencies: record.inputReceipt?.bundle ?? [] }))
    e.writeNode(node, { state: 'READY', execution_id: null, worker: null, not_before: null, error: null, excluded: null, prompt, brief_parts: JSON.stringify(parts) }, (r) => {
      const next: NodeRecord = { ...r, inputReceipt: { inputHash, bundle: r.inputReceipt?.bundle ?? [] }, lastDecision: decision }
      delete next.execution
      return next
    }, lease)
    db.prepare("UPDATE workflow_runs SET status = 'running', result = NULL, error = NULL, updated_at = ? WHERE run_id = ?").run(now(), row.run_id)
    e.ctx.eventLog.append({ type: 'workflow.run.continued', runId: row.run_id, nodeId: row.node_id, decision, data: { nodes: [row.node_id], approvalRequest: request.requestId, by: 'rule' } })
    return true
  })
}
