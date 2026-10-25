/**
 * A deferred tool call (docs/design/workflow-engine.md#a-deferred-tool-call). A Worker whose tool
 * gate deferred a call on an approval request stops there, and its execution fails (`config_error`,
 * naming the request): the workers seam has no waiting status. The engine then waits for the
 * operator's verdict on that request, and continues the session by itself, once, when it is
 * approved: the node that served the run, reopened as a new attempt on the same session, with a
 * brief that says the call was approved, so the Worker makes exactly that call (its gate lets the
 * approved call run once). Bounded: at most once per approval, recorded as a `recovery` decision.
 *
 * - **A run that serves no board task** fails on that node, and the request it waits on is noted
 *   (`workflow_deferrals`); the queue is read every `approvalPollSeconds`, and an approved request
 *   reopens the node and the run. A rejected, expired, or withdrawn request continues nothing, and
 *   nor does a run that moved on.
 * - **A board task's run** does not fail: the step waits on the request (`BLOCKED`, the request on
 *   its row, until the request's expiry, or for a `command` call at most `deferredCommandMinutes`),
 *   its run live, holding the task and renewing its lease. An approved request continues the session
 *   as above. A rejected, expired, or withdrawn one, one unanswered past the step's deadline (a
 *   command call's bound, or the request's own expiry, the request then withdrawn), or one approved
 *   only after that deadline, is a denied call: the session continues once, told so, and the Worker
 *   goes on without it (its gate denies that exact call again in the session, in any workflow,
 *   reading the engine's denial kept on its own row of the request). The
 *   step fails for the operator (`USER_ACTION`), and the attempt ends, only when the policy now
 *   forbids the call's class or cannot be read, on an approval that is not the operator's for
 *   exactly that call, or with no queue to read at the deadline. When the attempt ends any other
 *   way, the requests its Workers' gates left open are withdrawn ({@link withdrawCalls}).
 *
 * Which request an execution deferred on is read from the Worker gate's own record of it (the
 * `agent-workers.tool.deferred` event: the agent run and the request id), and the request itself
 * is checked in full through `ctx.approvals` before anything runs (INV-5): requester `worker`,
 * that execution as its run, that session.
 */
import type { Approvals, ApprovalRequest, AutonomyVerdict } from '@tsuuanmi/system-approvals-core'
import { type Lease, LeaseLost, StaleGeneration } from '@tsuuanmi/system-leases'
import { canonicalJson, sha256 } from '@tsuuanmi/system-libs'
import type { ArtifactRef, WorkerExecution } from '@tsuuanmi/system-workers-core'
import { instructionsText } from './briefs.ts'
import type { Engine } from './engine.ts'
import { gateDeadline } from './growth.ts'
import { queueOf } from './queue.ts'
import { routedDecisions } from './recovery.ts'
import { appended, type Instructions, literal, recordExecutor, type ResolvedNode } from './spec.ts'
import { LEASE_TTL_MS, type NodeRecord, type NodeRow, now, type RunRow, type WorkflowError } from './types.ts'

/** The event a Worker's tool gate appends when it defers a call (docs/design/approvals.md#what-each-verdict-does). */
const DEFERRED = 'agent-workers.tool.deferred'
const RULE = { type: 'rule', id: 'workflow.approved-call', version: '1' } as const
/** The rule a board task's step waits by on its deferred call, and fails by when the call is not approved. */
const WAIT_RULE = { type: 'rule', id: 'workflow.deferred-call', version: '1' } as const
const PRODUCER = { type: 'system', ref: 'workflow' } as const
/** Deferrals settled per sweep, oldest first (INV-9). */
const PAGE = 100

interface DeferralRow { request_id: string; run_id: string; node_id: string; execution_id: string; session_id: string; created_at: string }
type Outcome = 'continued' | 'rejected' | 'unbound' | 'moved-on'

const specOf = (node: NodeRow): ResolvedNode => JSON.parse(node.spec) as ResolvedNode

/** The approval request an execution's Worker gate deferred a call on, from the gate's `agent-workers.tool.deferred` event of it. */
function deferredOn(e: Engine, runId: string, executionId: string): string | undefined {
  const event = e.ctx.eventLog.query({ type: DEFERRED, runId, limit: 1000 })
    .filter((entry) => entry.data?.agentRun === executionId && typeof entry.data.requestId === 'string').at(-1)
  return event ? String(event.data!.requestId) : undefined
}

/**
 * When a node fails for good on an execution its Worker's gate deferred (sent, `config_error`, on
 * a session a later execution can continue), note the request it waits on, in the transaction
 * that fails the node. A board task's run is not noted: its step waits instead ({@link awaitCall}).
 */
export function noteDeferral(e: Engine, run: RunRow, node: NodeRow, error: WorkflowError, execution: WorkerExecution | undefined): void {
  if (!execution || !execution.submitted || error.kind !== 'config_error' || e.tasks.bound(run.run_id)) return
  const sessionId = specOf(node).session.sessionId
  if (!sessionId) return
  const requestId = deferredOn(e, run.run_id, execution.id)
  if (!requestId) return
  e.ctx.store.db.prepare('INSERT OR IGNORE INTO workflow_deferrals (request_id, run_id, node_id, execution_id, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(requestId, run.run_id, node.node_id, execution.id, sessionId, now())
}

/**
 * Read the queue for the requests deferred executions of runs that serve no board task wait on
 * (every `approvalPollSeconds`, and once at start): an approved one continues its session, once;
 * a rejected one, or one whose run moved on, is settled with nothing run. With no queue loaded,
 * they wait.
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
function binds(request: ApprovalRequest, call: { execution_id: string; session_id: string }): boolean {
  return request.requester.component === 'worker' && request.requester.runId === call.execution_id && request.requester.sessionId === call.session_id
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
    const decision = reopen(e, e.nodeRow(row.run_id, row.node_id)!, request, { execution: row.execution_id, sessionId: row.session_id }, lease)
    db.prepare("UPDATE workflow_deferrals SET settled_at = ?, outcome = 'continued', decision = ? WHERE request_id = ?").run(now(), decision, row.request_id)
    db.prepare("UPDATE workflow_runs SET status = 'running', result = NULL, error = NULL, updated_at = ? WHERE run_id = ?").run(now(), row.run_id)
    e.ctx.eventLog.append({ type: 'workflow.run.continued', runId: row.run_id, nodeId: row.node_id, decision, data: { nodes: [row.node_id], approvalRequest: request.requestId, by: 'rule' } })
    return true
  })
}

/**
 * The node that stopped at an approved call, reopened as a new attempt on its session (in the
 * caller's transaction, under the run's lease): a `recovery` decision `continue` naming the request
 * and the approval, then the node `READY` with instructions that end with the approval, so its input
 * hash, its execution key, and its brief are new (pointers, never content). Its next execution
 * resumes the native session, and its Worker's gate lets the approved call run once.
 */
function reopen(e: Engine, node: NodeRow, request: ApprovalRequest, call: { execution: string; sessionId: string }, lease: () => Lease): ArtifactRef {
  const approval = request.resolution!.approval!
  const decision = e.ctx.artifacts.recordDecision({
    decisionType: 'recovery',
    question: `Does node ${node.node_id} of run ${node.run_id} continue session ${call.sessionId} now that the operator approved the call its Worker stopped at?`,
    inputs: [approval, request.resolution!.decision],
    candidates: [
      { option: 'continue', selected: true, reasons: [`the operator approved request ${request.requestId} (${request.action.summary.slice(0, 300)}), the exact call execution ${call.execution} deferred on; the session continues once, as a new attempt, to make that call`] },
      { option: 'leave', selected: false, reasons: ['not leave: an approved call is continued by the engine, once per approval, so the operator need not start it'] },
    ],
    decider: RULE,
    outcome: { option: 'continue', detail: { approvalRequest: request.requestId, approval, execution: call.execution, sessionId: call.sessionId } },
    deterministic: true,
  }, { producer: PRODUCER, runId: node.run_id, nodeId: node.node_id }).id as ArtifactRef
  // The brief says the call was approved: the next message of the session (pointers, never content).
  reopenNode(e, node, decision, `\n\nThe operator approved the tool call you stopped at (approval request ${request.requestId}). Make exactly that call again now; it runs once. Then finish the work above.`, lease)
  return decision
}

/**
 * The node reopened as a new attempt on its session, under `decision` (in the caller's transaction,
 * under the run's lease): `READY` with instructions that end with `text`, so its input hash, its
 * execution key, and its brief are new. Its next execution resumes the native session.
 */
function reopenNode(e: Engine, node: NodeRow, decision: ArtifactRef, text: string, lease: () => Lease): void {
  const spec = specOf(node)
  const record = JSON.parse(node.record) as NodeRecord
  const parts = appended(node.brief_parts ? JSON.parse(node.brief_parts) as Instructions : literal(node.prompt!), text)
  const prompt = instructionsText(e, parts)
  const inputHash = sha256(canonicalJson({ node: spec, prompt, dependencies: record.inputReceipt?.bundle ?? [] }))
  e.writeNode(node, { state: 'READY', execution_id: null, worker: null, not_before: null, error: null, excluded: null, approval_request: null, prompt, brief_parts: JSON.stringify(parts) }, (r) => {
    const next: NodeRecord = { ...r, inputReceipt: { inputHash, bundle: r.inputReceipt?.bundle ?? [] }, lastDecision: decision }
    delete next.execution
    return next
  }, lease)
}

// --- a board task's run: the step waits on the request ---

/** Whether a node is a board task's step waiting on its Worker's deferred tool call: a Worker step, `BLOCKED` on an approval request. */
export const waitsOnCall = (node: NodeRow): boolean => node.state === 'BLOCKED' && !!node.approval_request && recordExecutor(specOf(node)) === 'worker'

/**
 * A board task's step whose execution its Worker's tool gate deferred (sent, failed as
 * `config_error`, on a session, its `agent-workers.tool.deferred` event naming the request) waits on
 * that request instead of failing: the node becomes `BLOCKED` with the request on its row, until the
 * request's expiry (read now; a queue that cannot be read bounds it by `gateTimeoutHours`), after a
 * `recovery` decision `wait` (`decision@1.8`, rule `workflow.deferred-call`) in the same transaction.
 * The run stays live: it holds its task, renews the task's lease, and counts as a run that waits on
 * someone (`maxWaitingRuns`). False when this is no such step, and the caller fails it as before: a
 * run that serves no board task (noted for its continuation, {@link noteDeferral}), one that lost its
 * holder or whose budget refused a step (it starts nothing new, so nothing could continue it), or an
 * execution no gate deferred.
 */
export async function awaitCall(e: Engine, run: RunRow, node: NodeRow, execution: WorkerExecution, lease: () => Lease): Promise<boolean> {
  if (!execution.submitted || execution.error?.kind !== 'config_error' || !e.tasks.bound(run.run_id) || e.tasks.lost(run.run_id) || e.tasks.budgetStopped(run.run_id)) return false
  const sessionId = specOf(node).session.sessionId
  if (!sessionId) return false
  const requestId = deferredOn(e, run.run_id, execution.id)
  if (!requestId) return false
  // Bounded (INV-9): by the request's own expiry; with no queue to read it from now, by gateTimeoutHours.
  let until = gateDeadline(e)
  let unread: string | undefined
  // A call of class command waits at most deferredCommandMinutes from its request's creation (0: until it expires).
  let bound: number | undefined
  try {
    const request = await queueOf(e)?.get(requestId)
    if (request) {
      const command = commandBound(e, request)
      until = command?.until ?? request.expiresAt
      bound = command?.minutes
    } else unread = queueOf(e) ? 'the approval queue does not know it yet' : 'no approval queue is loaded'
  } catch (error) {
    if (isLeaseError(error)) throw error
    unread = `the approval queue could not be read: ${(error as Error).message.slice(0, 200)}`
  }
  const kept = [...execution.decisions, ...routedDecisions(node, e)]
  e.ctx.store.transaction(() => {
    const decision = e.ctx.artifacts.recordDecision({
      schema: 'decision@1.8',
      decisionType: 'recovery',
      question: `How does node ${node.node_id} of run ${run.run_id} go on from the tool call its Worker stopped at?`,
      inputs: kept,
      candidates: [
        { option: 'wait', selected: true, reasons: [`its Worker's tool gate deferred a call to the operator on approval request ${requestId} and stopped there; the step waits for the verdict until ${until}${unread ? ` (${unread}, so gateTimeoutHours bounds the wait)` : bound !== undefined ? ` (deferredCommandMinutes ${bound} for a command call; unanswered then, the call is denied and its request withdrawn)` : ''}, its session held for that call: approved, the session continues once to make it; rejected or expired, it continues once told the call was denied, unless the policy now forbids the call's class`] },
        { option: 'fail', selected: false, reasons: ['not fail: the step waits on a person, not on a fault; failing it would end the attempt and leave the request open on a session no later attempt resumes'] },
      ],
      decider: WAIT_RULE,
      outcome: { option: 'wait', detail: { approvalRequest: requestId, execution: execution.id, sessionId, until, attempt: node.attempt, ...(bound !== undefined ? { boundMinutes: bound } : {}) } },
      deterministic: true,
    }, { producer: PRODUCER, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
    e.writeNode(node, { state: 'BLOCKED', approval_request: requestId, not_before: until, error: null, decisions: JSON.stringify(kept) }, (r) => ({ ...r, lastDecision: decision }), lease)
    e.ctx.eventLog.append({ type: 'workflow.node.blocked', runId: run.run_id, nodeId: node.node_id, decision, data: { approvalRequest: requestId, executionId: execution.id, until } })
  })
  return true
}

/**
 * Settle the board task's steps that wait on a deferred call, against the approval queue (read
 * every `approvalPollSeconds` while the run waits, under its lease):
 * - approved by the operator for exactly that call by the step's deadline (its recorded wait: a
 *   `command` call's bound, or the request's expiry): the step continues its session once, to make
 *   it; approved after that deadline (the engine was down across it): the call is denied as below,
 *   cause `late`; approved for anything else (INV-5): the step fails for the operator;
 * - rejected (a verdict or a withdrawal) or expired: the call is denied, and the step continues its
 *   session once, told so, so its Worker goes on without it ({@link denyCall}); the attempt ends
 *   only when the policy now forbids the call's class (or cannot be read);
 * - open past the step's deadline, whether or not the queue's sweep recorded an expiry yet: the
 *   request is withdrawn, and the call is denied as above, for it alone (cause `bound` past a
 *   command call's bound, `deferredCommandMinutes`, recorded on its wait decision; else `expired`);
 *   a request whose withdrawal fails is denied all the same, the engine's denial on record;
 * - open, or a queue that cannot be read, waits until the deadline; past it with no queue to read,
 *   the step fails for the operator (`USER_ACTION`).
 * A step that fails ends the attempt, which the board counts. Restart-safe (INV-4): what the step
 * does is read from the queue and the node's row each time; a withdrawal is idempotent, and the
 * Worker's gate reads the engine's denial from its own row of the request. True when a step changed, so the run
 * looks at its nodes again.
 */
export async function settleCalls(e: Engine, run: RunRow, nodes: readonly NodeRow[], lease: () => Lease): Promise<boolean> {
  const approvals = queueOf(e)
  let changed = false
  for (const waiting of nodes) {
    let node = waiting
    const requestId = node.approval_request!
    let request: ApprovalRequest | undefined
    let unread: string | undefined
    try {
      request = approvals ? await approvals.get(requestId) : undefined
      if (!request) unread = approvals ? 'the approval queue does not know it' : 'no approval queue is loaded'
    } catch (error) {
      if (isLeaseError(error)) throw error
      unread = `the approval queue could not be read: ${(error as Error).message.slice(0, 200)}`
    }
    // Read now, after a wait that started unread: a command call's bound, if its row has none yet
    // and it ends sooner than the deadline on the row, is reconciled and kept (INV-4, INV-9).
    if (request && boundOf(e, node) === undefined) {
      const command = commandBound(e, request)
      if (command && Date.parse(command.until) < (Date.parse(node.not_before ?? '') || Infinity)) node = reconcileBound(e, run, node, request, command, lease)
    }
    const call = { execution: node.execution_id ?? '', sessionId: specOf(node).session.sessionId ?? '' }
    const due = !(Date.parse(node.not_before ?? '') > Date.now())
    const bound = boundOf(e, node)
    // The step's deadline: its recorded wait (a command call's bound, or the request's expiry), and
    // never later than the request's own expiry.
    const deadline = request ? Math.min(Date.parse(node.not_before ?? '') || Infinity, Date.parse(request.expiresAt)) : Date.parse(node.not_before ?? '')
    const unanswered = request?.state === 'open' || request?.state === 'batched'
    // Past its deadline and still unanswered (a command call's bound, or the request's own expiry,
    // before the queue's sweep recorded it): withdrawn, then settled on what the queue says now.
    let expiredHere = false
    if (due && approvals && unanswered) {
      try {
        request = await approvals.withdraw(requestId)
        expiredHere = true
      } catch (error) {
        if (isLeaseError(error)) throw error
        warnOnce(e, `workflow: could not withdraw approval request ${requestId} of run ${run.run_id} past its deadline; the call is denied all the same: ${(error as Error).message}`)
      }
    }
    if (request?.state === 'approved') {
      const unbound = approvalProblem(request, call)
      if (unbound) failCall(e, run, node, { kind: unbound.kind, message: unbound.message }, request.resolution ? [request.resolution.decision] : [], lease)
      // Approved after the step's deadline (the engine was down across it, so nothing withdrew the
      // request in time): the approval came too late, and the call is denied, for it alone.
      else if (approvals && Date.parse(request.resolution!.at) > deadline) await denyCall(e, approvals, run, node, request, call, lateDenial(request, bound, deadline), lease)
      else continueCall(e, run, node, request, call, lease)
      changed = true
      continue
    }
    if (request?.state === 'rejected' && request.resolution && approvals) {
      // Withdrawn here at the step's deadline: the call's expiry (by its bound, or the request's own).
      const denial = expiredHere && request.resolution.cause === 'withdrawn' && bound === undefined
        ? { cause: 'expired' as const, how: `no verdict came by ${new Date(deadline).toISOString()}`, inputs: [request.resolution.decision] }
        : rejectedDenial(request, due ? bound : undefined)
      await denyCall(e, approvals, run, node, request, call, denial, lease)
      changed = true
      continue
    }
    if (!due) {
      if (unread) warnOnce(e, `workflow: step ${node.node_id} of run ${run.run_id} waits on approval request ${requestId} until ${node.not_before}: ${unread}`)
      continue
    }
    // Past its deadline, still open (its withdrawal failed): denied all the same, the engine's own
    // denial recorded, which the Worker's gate reads whatever the queue says later.
    if (request && approvals && (request.state === 'open' || request.state === 'batched')) {
      await denyCall(e, approvals, run, node, request, call, bound !== undefined
        ? { cause: 'bound', how: `no verdict came within ${bound} minutes, so the call is denied`, inputs: [request.policy.decision], bound }
        : { cause: 'expired', how: `no verdict came by ${node.not_before}`, inputs: [request.policy.decision] }, lease)
      changed = true
      continue
    }
    // Past its deadline with no queue to read: the policy cannot be read either, so the step ends.
    failCall(e, run, node, { kind: 'call_expired', message: `approval request ${requestId} for the tool call step ${node.node_id}'s Worker stopped at had no verdict by ${node.not_before}${unread ? ` (${unread})` : ''}; the call does not run, and this attempt ends` }, request ? [request.policy.decision] : [], lease)
    if (approvals && (!request || request.state === 'open' || request.state === 'batched')) await withdraw(e, approvals, requestId, run.run_id)
    changed = true
  }
  return changed
}

/** How long a command call waits by default (`deferredCommandMinutes`). */
const DEFAULT_COMMAND_MINUTES = 10

/**
 * A command call's bound, from its request: `deferredCommandMinutes` from the request's creation,
 * when that is inside the request's own expiry (0: no bound, the request's expiry). Derived from the
 * request alone, so it is the same whenever the request is first read (INV-4).
 */
function commandBound(e: Engine, request: ApprovalRequest): { until: string; minutes: number } | undefined {
  const minutes = e.config.deferredCommandMinutes ?? DEFAULT_COMMAND_MINUTES
  const by = Date.parse(request.createdAt) + minutes * 60_000
  return request.action.class === 'command' && minutes > 0 && by < Date.parse(request.expiresAt) ? { until: new Date(by).toISOString(), minutes } : undefined
}

/**
 * A waiting step whose request could not be read when it started to wait (its deadline then
 * `gateTimeoutHours`, its wait decision without the bound): once the request is read, a command
 * call's bound applies after all. A second `wait` decision records it, and the node's deadline
 * becomes the bound, in one transaction under the run's lease, so a restart reads it from the row
 * ({@link boundOf}) and it is reconciled once. Returns the node as it is now.
 */
function reconcileBound(e: Engine, run: RunRow, node: NodeRow, request: ApprovalRequest, command: { until: string; minutes: number }, lease: () => Lease): NodeRow {
  e.ctx.store.transaction(() => {
    const decision = e.ctx.artifacts.recordDecision({
      schema: 'decision@1.8',
      decisionType: 'recovery',
      question: `How long does node ${node.node_id} of run ${run.run_id} wait on the command call its Worker stopped at, now that its request can be read?`,
      inputs: [request.policy.decision],
      candidates: [
        { option: 'wait', selected: true, reasons: [`approval request ${request.requestId} could not be read when the step started to wait, so gateTimeoutHours bounded it (until ${node.not_before}); read now, it is a command call, which waits at most deferredCommandMinutes ${command.minutes} from the request's creation: until ${command.until}; unanswered then, the call is denied and its request withdrawn`] },
        { option: 'fail', selected: false, reasons: ['not fail: the step waits on a person, not on a fault'] },
      ],
      decider: WAIT_RULE,
      outcome: { option: 'wait', detail: { approvalRequest: request.requestId, execution: node.execution_id ?? '', sessionId: specOf(node).session.sessionId ?? '', until: command.until, attempt: node.attempt, boundMinutes: command.minutes } },
      deterministic: true,
    }, { producer: PRODUCER, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
    e.writeNode(node, { state: 'BLOCKED', not_before: command.until }, (r) => ({ ...r, lastDecision: decision }), lease)
    e.ctx.eventLog.append({ type: 'workflow.node.blocked', runId: run.run_id, nodeId: node.node_id, decision, data: { approvalRequest: request.requestId, executionId: node.execution_id, until: command.until, reconciled: true } })
  })
  return e.nodeRow(run.run_id, node.node_id) ?? node
}

/** Why a call is denied, and on what: the cause recorded on the `deny` decision and the inputs it cites. */
interface Denial { cause: 'rejected' | 'expired' | 'withdrawn' | 'bound' | 'late'; how: string; inputs: ArtifactRef[]; bound?: number }

/** A request the queue rejected (a verdict, an expiry, a withdrawal; `bound` when the step's own bound withdrew it). */
function rejectedDenial(request: ApprovalRequest, bound: number | undefined): Denial {
  const resolution = request.resolution!
  if (bound !== undefined && resolution.cause === 'withdrawn') return { cause: 'bound', how: `no verdict came within ${bound} minutes, so the call is denied`, inputs: [resolution.decision], bound }
  if (resolution.cause === 'verdict') return { cause: 'rejected', how: 'the operator rejected it', inputs: [resolution.decision] }
  if (resolution.cause === 'expired') return { cause: 'expired', how: `no verdict came by ${request.expiresAt}`, inputs: [resolution.decision] }
  return { cause: 'withdrawn', how: 'it was withdrawn (a policy change, or its work ended)', inputs: [resolution.decision] }
}

/** An approval given after the step's deadline: too late, so the call is denied (cause `late`), the approval among its inputs. */
function lateDenial(request: ApprovalRequest, bound: number | undefined, deadline: number): Denial {
  const by = new Date(deadline).toISOString()
  return {
    cause: 'late',
    how: `the approval came at ${request.resolution!.at}, after the call's deadline ${by}${bound !== undefined ? ` (${bound} minutes, deferredCommandMinutes)` : ''}, so the call is denied`,
    inputs: [request.resolution!.decision, ...(request.resolution!.approval ? [request.resolution!.approval] : [])],
    ...(bound !== undefined ? { bound } : {}),
  }
}

/** The bound (minutes) a waiting step's wait decision recorded for its command call, if it had one: read from the node's own record, so a restart keeps it (INV-4). */
function boundOf(e: Engine, node: NodeRow): number | undefined {
  const last = (JSON.parse(node.record) as NodeRecord).lastDecision
  const body = last ? e.ctx.artifacts.get(last)?.body as { decider?: { id?: string }; outcome?: { option?: string; detail?: { approvalRequest?: unknown; boundMinutes?: unknown } } } | undefined : undefined
  if (body?.decider?.id !== WAIT_RULE.id || body.outcome?.option !== 'wait' || body.outcome.detail?.approvalRequest !== node.approval_request) return undefined
  const minutes = body.outcome.detail?.boundMinutes
  return typeof minutes === 'number' && minutes > 0 ? minutes : undefined
}

/**
 * A denied call: its request rejected, expired, or withdrawn; unanswered past the step's deadline
 * (a `command` call's bound, or the request's own expiry, whether or not the queue's sweep recorded
 * it yet); or approved only after that deadline. The call never runs. Unless the policy now forbids
 * the call's class (judged again: an `autonomy` decision), the step continues its session once as a
 * new attempt, its brief saying the call was denied and why: the Worker's gate denies that exact
 * call again in the session (the agent's tool result is the denial), and the Worker goes on without
 * it. Recorded as a `recovery` decision `deny` (rule `workflow.deferred-call`) with its cause
 * (`bound` is the call's expiry by the step's own bound, `late` an approval after the deadline),
 * and, in the same transaction, on the gate's own row of the request (`ctx.agentWorkers.denyToolCall`),
 * which the gate reads by session: the call stays denied in any later run of the session, in any
 * workflow, whatever the queue, the policy, or the event log's retention says later. When the
 * policy forbids the class, or cannot be read, or nothing can keep the denial, the step fails for
 * the operator.
 */
async function denyCall(e: Engine, approvals: Approvals, run: RunRow, node: NodeRow, request: ApprovalRequest, call: { execution: string; sessionId: string }, denial: Denial, lease: () => Lease): Promise<void> {
  const { cause, how } = denial
  const ends =(message: string, inputs: ArtifactRef[]): void => failCall(e, run, node, { kind: cause === 'rejected' || cause === 'withdrawn' ? 'call_rejected' : 'call_expired', message }, inputs, lease)
  let verdict: AutonomyVerdict
  try {
    verdict = await approvals.check({ class: request.action.class })
  } catch (error) {
    if (isLeaseError(error)) throw error
    return ends(`approval request ${request.requestId} for the tool call step ${node.node_id}'s Worker stopped at is denied: ${how}; the call does not run, and the policy cannot be read to tell whether its class is still allowed to ask (${(error as Error).message.slice(0, 200)}), so this attempt ends`, denial.inputs)
  }
  if (verdict.mode === 'forbid') {
    return ends(`approval request ${request.requestId} for the tool call step ${node.node_id}'s Worker stopped at is denied: ${how}; the call does not run, and the autonomy policy now forbids its class ${request.action.class} (decision ${verdict.decision}), so this attempt ends`, [...denial.inputs, verdict.decision])
  }
  // The denial is kept where the Worker's gate reads it, by session: with nothing to keep it, the
  // session cannot go on safely (a later run could make the call), so the attempt ends.
  const gates = gatesOf(e)
  const unkept = (why: string): void => ends(`approval request ${request.requestId} for the tool call step ${node.node_id}'s Worker stopped at is denied: ${how}; the call does not run, and ${why}, so the session does not go on and this attempt ends`, [...denial.inputs, verdict.decision])
  if (!gates) return unkept('no agent Workers (ctx.agentWorkers) are loaded to keep the denial its gate enforces')
  try {
    denyAndContinue(e, gates, run, node, request, call, denial, verdict, lease)
  } catch (error) {
    if (!(error instanceof Unkept)) throw error
    unkept('no Worker gate holds that request, so nothing would keep its denial')
  }
}

/** The agent Workers' record of a call's denial, which their gates read by session (`ctx.agentWorkers`, optional). */
interface CallDenials { denyToolCall(requestId: string, denial: { decision: string; cause: string }): boolean }
const gatesOf = (e: Engine): CallDenials | undefined => {
  const service = e.ctx.get('agentWorkers' as never) as Partial<CallDenials> | undefined
  return typeof service?.denyToolCall === 'function' ? service as CallDenials : undefined
}
/** The denial could not be kept on the gate's row: the transaction rolls back. */
class Unkept extends Error {}

function denyAndContinue(e: Engine, gates: CallDenials, run: RunRow, node: NodeRow, request: ApprovalRequest, call: { execution: string; sessionId: string }, denial: Denial, verdict: AutonomyVerdict, lease: () => Lease): void {
  const { cause, how, bound } = denial
  const byBound = cause === 'bound'
  e.ctx.store.transaction(() => {
    e.ctx.leases.fence(lease())
    const now_ = e.nodeRow(run.run_id, node.node_id)
    // Settled already: it continues nothing again.
    if (!now_ || !waitsOnCall(now_) || now_.approval_request !== request.requestId) return
    const decision = e.ctx.artifacts.recordDecision({
      decisionType: 'recovery',
      question: byBound
        ? `Does the tool call step ${node.node_id} of run ${run.run_id} stopped at expire unanswered, ${bound} minutes after it was asked?`
        : `How does node ${node.node_id} of run ${run.run_id} go on from the tool call its Worker stopped at, now that it is denied?`,
      inputs: [...new Set([...denial.inputs, verdict.decision])],
      candidates: [
        { option: 'deny', selected: true, reasons: [`approval request ${request.requestId} (${request.action.summary.slice(0, 300)}): ${how}; the call does not run, and the session continues once, as a new attempt of the step told it was denied, so its Worker goes on without it`] },
        ...(byBound ? [{ option: 'wait', selected: false, reasons: [`not wait: a command call waits at most ${bound} minutes (deferredCommandMinutes); the request is withdrawn, and only this call is denied`] }] : []),
        { option: 'fail', selected: false, reasons: [`not fail: the autonomy policy does not forbid the ${request.action.class} class (decision ${verdict.decision}) and the session can continue; a denied call ends only that call`] },
      ],
      decider: WAIT_RULE,
      outcome: { option: 'deny', detail: { approvalRequest: request.requestId, cause, execution: call.execution, sessionId: call.sessionId, ...(byBound ? { boundMinutes: bound } : {}) } },
      deterministic: true,
    }, { producer: PRODUCER, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
    // Kept for good on the request's row, by session: the Worker's gate denies that exact call in
    // any later run of the session, whatever the queue says later and whatever the event log keeps.
    if (!gates.denyToolCall(request.requestId, { decision, cause })) throw new Unkept()
    // The brief says the call was denied and why: the next message of the session (pointers, never content).
    reopenNode(e, now_, decision, `\n\nThe tool call you stopped at was denied (approval request ${request.requestId}): ${how}. It did not run, and it will not run in this session; its result is that denial. Do not make it again: go on without it, and finish the work above.`, lease)
    e.ctx.eventLog.append({ type: 'workflow.run.continued', runId: run.run_id, nodeId: node.node_id, decision, data: { nodes: [node.node_id], approvalRequest: request.requestId, by: 'rule', denied: true, cause } })
  })
}

/**
 * Why an approved request does not continue the step, or undefined when it does: the operator's
 * verdict (`cause: verdict`, with its approval) on the exact call the execution deferred: requester
 * `worker`, that execution as its run, that session (INV-5). One given after the step's deadline (a
 * command call's bound, or the request's expiry) is denied by {@link settleCalls}, not used.
 */
function approvalProblem(request: ApprovalRequest, call: { execution: string; sessionId: string }): { kind: string; message: string } | undefined {
  if (!binds(request, { execution_id: call.execution, session_id: call.sessionId })) {
    return { kind: 'call_rejected', message: `approval request ${request.requestId} is approved, but it is not the operator's approval of the call execution ${call.execution} deferred in session ${call.sessionId} (INV-5), so it is not used; this attempt ends` }
  }
  return undefined
}

/** The approved call's step continues its session once, as a new attempt (under the run's lease, in one transaction). */
function continueCall(e: Engine, run: RunRow, node: NodeRow, request: ApprovalRequest, call: { execution: string; sessionId: string }, lease: () => Lease): void {
  e.ctx.store.transaction(() => {
    e.ctx.leases.fence(lease())
    const now_ = e.nodeRow(run.run_id, node.node_id)
    // Settled already: it continues nothing again.
    if (!now_ || !waitsOnCall(now_) || now_.approval_request !== request.requestId) return
    const decision = reopen(e, now_, request, call, lease)
    e.ctx.eventLog.append({ type: 'workflow.run.continued', runId: run.run_id, nodeId: node.node_id, decision, data: { nodes: [node.node_id], approvalRequest: request.requestId, by: 'rule' } })
  })
}

/**
 * The step ends for the operator: a `recovery` decision `fail` (rule `workflow.deferred-call`), then
 * the node `FAILED` as `call_rejected` or `call_expired` with disposition `USER_ACTION`, nothing of
 * the call run. The run then ends the attempt, and its report is a failed run the board counts.
 */
function failCall(e: Engine, run: RunRow, node: NodeRow, failure: { kind: string; message: string }, inputs: ArtifactRef[], lease: () => Lease): void {
  const error: WorkflowError = { kind: failure.kind, disposition: 'USER_ACTION', message: failure.message }
  e.ctx.store.transaction(() => {
    const now_ = e.nodeRow(run.run_id, node.node_id)
    if (!now_ || !waitsOnCall(now_) || now_.approval_request !== node.approval_request) return
    const decision = e.ctx.artifacts.recordDecision({
      decisionType: 'recovery',
      question: `How does node ${node.node_id} of run ${run.run_id} go on from the tool call its Worker stopped at?`,
      inputs: [...new Set(inputs)],
      candidates: [
        { option: 'continue', selected: false, reasons: [`not continue: approval request ${node.approval_request} gives no approval of exactly that call in time`] },
        { option: 'fail', selected: true, reasons: [failure.message] },
      ],
      decider: WAIT_RULE,
      outcome: { option: 'fail', detail: { approvalRequest: node.approval_request!, kind: failure.kind, disposition: 'USER_ACTION' } },
      deterministic: true,
    }, { producer: PRODUCER, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
    e.writeNode(now_, { state: 'FAILED', error: JSON.stringify(error) }, (r) => ({ ...r, lastDecision: decision }), lease)
    e.ctx.eventLog.append({ type: 'workflow.node.failed', runId: run.run_id, nodeId: node.node_id, decision, data: { attempt: node.attempt, kind: error.kind, disposition: error.disposition, approvalRequest: node.approval_request! } })
  })
}

/**
 * When a board task's run has ended (completed, failed, stopped, or wound down), the approval
 * requests left open on its account are withdrawn, so an approval given later starts nothing
 * unseen: those its Workers' tool gates opened (requester `worker`, one of the run's executions as
 * its run; found from the gates' `agent-workers.tool.deferred` events and its steps' rows) and those
 * its remediation gates opened (requester `workflow`, this run). The task's next attempt is a new
 * run, given its brief. One that cannot be read or withdrawn is logged and expires on its own
 * (INV-9). Idempotent: a resolved request is left as it is.
 */
export async function withdrawCalls(e: Engine, runId: string): Promise<void> {
  const approvals = queueOf(e)
  if (!approvals) return
  const nodes = e.nodeRows(runId)
  const executions = new Set(nodes.flatMap((n) => (n.execution_id ? [n.execution_id] : [])))
  let afterSeq: number | undefined
  for (;;) {
    const page = e.ctx.eventLog.query({ runId, type: 'workflow.node.started', limit: 1000, ...(afterSeq !== undefined ? { afterSeq } : {}) })
    for (const event of page) if (typeof event.data?.['executionId'] === 'string') executions.add(event.data['executionId'])
    if (page.length < 1000) break
    afterSeq = page.at(-1)!.seq
  }
  const requests = new Set(nodes.flatMap((n) => (n.approval_request ? [n.approval_request] : [])))
  for (const event of e.ctx.eventLog.query({ type: DEFERRED, runId, limit: 1000 })) {
    if (typeof event.data?.requestId === 'string' && executions.has(String(event.data.agentRun))) requests.add(event.data.requestId)
  }
  for (const requestId of requests) {
    let request: ApprovalRequest | undefined
    try {
      request = await approvals.get(requestId)
    } catch (error) {
      warnOnce(e, `workflow: could not read approval request ${requestId} of run ${runId} to withdraw it; it expires on its own: ${(error as Error).message}`)
      continue
    }
    if (!request || (request.state !== 'open' && request.state !== 'batched')) continue
    const ours = (request.requester.component === 'worker' && executions.has(request.requester.runId ?? ''))
      || (request.requester.component === 'workflow' && request.requester.runId === runId)
    if (ours) await withdraw(e, approvals, requestId, runId)
  }
}

async function withdraw(e: Engine, approvals: Approvals, requestId: string, runId: string): Promise<void> {
  try {
    await approvals.withdraw(requestId)
  } catch (error) {
    warnOnce(e, `workflow: could not withdraw approval request ${requestId} of run ${runId}; it expires on its own: ${(error as Error).message}`)
  }
}

const isLeaseError = (error: unknown): boolean => error instanceof LeaseLost || error instanceof StaleGeneration

const warned = new WeakMap<Engine, Set<string>>()
/** A standing problem is logged once per engine, not on every poll. */
function warnOnce(e: Engine, message: string): void {
  const seen = warned.get(e) ?? warned.set(e, new Set()).get(e)!
  if (seen.has(message)) return
  seen.add(message)
  e.ctx.logger.warn(message)
}
