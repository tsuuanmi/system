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
 *   its row, until the request's expiry), its run live, holding the task and renewing its lease. An
 *   approved request continues the session as above; a rejected, expired, or withdrawn one, an
 *   approval that is not the operator's for exactly that call, or no verdict by the deadline fails
 *   the step for the operator (`USER_ACTION`), and the attempt ends. When the attempt ends any other
 *   way, the requests its Workers' gates left open are withdrawn ({@link withdrawCalls}).
 *
 * Which request an execution deferred on is read from the Worker gate's own record of it (the
 * `agent-workers.tool.deferred` event: the agent run and the request id), and the request itself
 * is checked in full through `ctx.approvals` before anything runs (INV-5): requester `worker`,
 * that execution as its run, that session.
 */
import type { Approvals, ApprovalRequest } from '@tsuuanmi/system-approvals-core'
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
  const spec = specOf(node)
  const record = JSON.parse(node.record) as NodeRecord
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
  const parts = appended(node.brief_parts ? JSON.parse(node.brief_parts) as Instructions : literal(node.prompt!),
    `\n\nThe operator approved the tool call you stopped at (approval request ${request.requestId}). Make exactly that call again now; it runs once. Then finish the work above.`)
  const prompt = instructionsText(e, parts)
  const inputHash = sha256(canonicalJson({ node: spec, prompt, dependencies: record.inputReceipt?.bundle ?? [] }))
  e.writeNode(node, { state: 'READY', execution_id: null, worker: null, not_before: null, error: null, excluded: null, approval_request: null, prompt, brief_parts: JSON.stringify(parts) }, (r) => {
    const next: NodeRecord = { ...r, inputReceipt: { inputHash, bundle: r.inputReceipt?.bundle ?? [] }, lastDecision: decision }
    delete next.execution
    return next
  }, lease)
  return decision
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
  try {
    const request = await queueOf(e)?.get(requestId)
    if (request) until = request.expiresAt
    else unread = queueOf(e) ? 'the approval queue does not know it yet' : 'no approval queue is loaded'
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
        { option: 'wait', selected: true, reasons: [`its Worker's tool gate deferred a call to the operator on approval request ${requestId} and stopped there; the step waits for the verdict until ${until}${unread ? ` (${unread}, so gateTimeoutHours bounds the wait)` : ''}, its session held for that call: approved, the session continues once to make it; rejected or expired, the attempt ends for the operator`] },
        { option: 'fail', selected: false, reasons: ['not fail: the step waits on a person, not on a fault; failing it would end the attempt and leave the request open on a session no later attempt resumes'] },
      ],
      decider: WAIT_RULE,
      outcome: { option: 'wait', detail: { approvalRequest: requestId, execution: execution.id, sessionId, until, attempt: node.attempt } },
      deterministic: true,
    }, { producer: PRODUCER, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
    e.writeNode(node, { state: 'BLOCKED', approval_request: requestId, not_before: until, error: null, decisions: JSON.stringify(kept) }, (r) => ({ ...r, lastDecision: decision }), lease)
    e.ctx.eventLog.append({ type: 'workflow.node.blocked', runId: run.run_id, nodeId: node.node_id, decision, data: { approvalRequest: requestId, executionId: execution.id, until } })
  })
  return true
}

/**
 * Settle the board task's steps that wait on a deferred call, against the approval queue (read
 * every `approvalPollSeconds` while the run waits, under its lease): approved by the operator for
 * exactly that call before it expired, the step continues its session once; rejected (a verdict or
 * a withdrawal), expired, approved for anything else (INV-5), or with no verdict read by its
 * deadline, the step fails for the operator (`USER_ACTION`), and the run ends the attempt, which the
 * board counts. An open request, or a queue that cannot be read, waits until the deadline; past it,
 * the request is withdrawn. True when a step changed, so the run looks at its nodes again.
 */
export async function settleCalls(e: Engine, run: RunRow, nodes: readonly NodeRow[], lease: () => Lease): Promise<boolean> {
  const approvals = queueOf(e)
  let changed = false
  for (const node of nodes) {
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
    const call = { execution: node.execution_id ?? '', sessionId: specOf(node).session.sessionId ?? '' }
    if (request?.state === 'approved') {
      const unbound = approvalProblem(request, call)
      if (unbound) failCall(e, run, node, { kind: unbound.kind, message: unbound.message }, request.resolution ? [request.resolution.decision] : [], lease)
      else continueCall(e, run, node, request, call, lease)
      changed = true
      continue
    }
    if (request?.state === 'rejected' && request.resolution) {
      const resolution = request.resolution
      const how = resolution.cause === 'verdict' ? 'the operator rejected it' : resolution.cause === 'expired' ? `no verdict came by ${request.expiresAt}` : 'it was withdrawn (a policy change, or its work ended)'
      failCall(e, run, node, { kind: resolution.cause === 'expired' ? 'call_expired' : 'call_rejected', message: `approval request ${requestId} for the tool call step ${node.node_id}'s Worker stopped at is rejected: ${how}; the call does not run, and this attempt ends` }, [resolution.decision], lease)
      changed = true
      continue
    }
    if (Date.parse(node.not_before ?? '') > Date.now()) {
      if (unread) warnOnce(e, `workflow: step ${node.node_id} of run ${run.run_id} waits on approval request ${requestId} until ${node.not_before}: ${unread}`)
      continue
    }
    // Past its deadline the step ends, read or not: no verdict that continues it was read in time.
    failCall(e, run, node, { kind: 'call_expired', message: `approval request ${requestId} for the tool call step ${node.node_id}'s Worker stopped at had no verdict by ${node.not_before}${unread ? ` (${unread})` : ''}; the call does not run, and this attempt ends` }, request ? [request.policy.decision] : [], lease)
    if (approvals && (!request || request.state === 'open' || request.state === 'batched')) await withdraw(e, approvals, requestId, run.run_id)
    changed = true
  }
  return changed
}

/**
 * Why an approved request does not continue the step, or undefined when it does: the operator's
 * verdict (`cause: verdict`, with its approval), given no later than the request's expiry (the queue
 * refuses a later one; checked again in defence), on the exact call the execution deferred: requester
 * `worker`, that execution as its run, that session (INV-5).
 */
function approvalProblem(request: ApprovalRequest, call: { execution: string; sessionId: string }): { kind: string; message: string } | undefined {
  if (!binds(request, { execution_id: call.execution, session_id: call.sessionId })) {
    return { kind: 'call_rejected', message: `approval request ${request.requestId} is approved, but it is not the operator's approval of the call execution ${call.execution} deferred in session ${call.sessionId} (INV-5), so it is not used; this attempt ends` }
  }
  if (!(Date.parse(request.resolution!.at) <= Date.parse(request.expiresAt))) {
    return { kind: 'call_expired', message: `approval request ${request.requestId} was approved at ${request.resolution!.at}, not by its expiry ${request.expiresAt}, so it is not used; this attempt ends` }
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
