/**
 * Remediation on the approval queue (docs/design/workflow-engine.md#remediation-on-the-approval-queue,
 * docs/design/approvals.md). A remediation fix writes, so its gate waits for a person's approval of
 * exactly its plan (ADR-0028, INV-15). With `ctx.approvals` loaded, the gate puts that plan to the
 * one queue as a `remediation` action (always `ask`, `ALWAYS_ASK`): one request on the exact
 * subject, the plan's content id and the reviewed subject. The fix starts only once that request is
 * approved by the operator, before it expired, and the working tree is still the subject the review
 * read; rejected, expired, or withdrawn, the cycle ends and the run fails. With no queue loaded,
 * the gate is the operator's plan gate (`approve`), as before: never approved by policy (INV-2).
 * Everything the gate waits on is durable (its request id on the node, and the `wait` decision
 * naming it), so a restart reads the request again and never asks twice (INV-4).
 */
import { type ApprovalRequest, type Approvals, ApprovalsError, type AutonomyVerdict, type Subject } from '@tsuuanmi/system-approvals-core'
import { type Lease, LeaseLost, StaleGeneration } from '@tsuuanmi/system-board-core'
import { captureGitSubject, type GitSubject, sha256, subjectId } from '@tsuuanmi/system-libs'
import type { ArtifactRef } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import type { ResolvedNode } from './spec.ts'
import type { NodeRow, RunRow, WorkflowError } from './types.ts'

const RULE = { type: 'rule', id: 'workflow.remediation-approval', version: '1' } as const
/** The exact-subject rule the review's gates decide by (./review.ts): the approved subject is still the working tree. */
const EXACT = { type: 'rule', id: 'workflow.exact-subject', version: '1' } as const
const PRODUCER = { type: 'system', ref: 'workflow' } as const
/** The longest subject version a request carries (`common` subject `version`). */
const VERSION_MAX = 128

const specOf = (node: NodeRow): ResolvedNode => JSON.parse(node.spec) as ResolvedNode

/** A gate that puts its plan to the approval queue when one is loaded: a remediation fix's. */
export const isRemediationGate = (spec: ResolvedNode): boolean => spec.executor === 'gate' && spec.remediation !== undefined

/** How often a run waiting on the queue reads it again (`approvalPollSeconds`, INV-9). */
export const pollMs = (e: Engine): number => (e.config.approvalPollSeconds ?? 15) * 1000

/** The approval queue, when one is loaded (optional: with none, remediation waits for the operator's plan gate). */
export const queueOf = (e: Engine): Approvals | undefined => e.ctx.get('approvals') ?? undefined

/**
 * The exact subject a remediation request binds to (INV-5): the plan by its content id, at the
 * version of the subject the review was bound to (`git:<HEAD>:<hash>`), or that subject's content
 * id when it is longer than a subject version may be (a repository with SHA-256 object names).
 */
export function remediationSubject(spec: ResolvedNode): Subject {
  const reviewed = spec.remediation!.subject
  return { type: 'artifact', ref: String(spec.plan), version: reviewed.length <= VERSION_MAX ? reviewed : sha256(reviewed) }
}

const sameSubject = (a: Subject, b: Subject): boolean => a.type === b.type && a.ref === b.ref && a.version === b.version

/** Whether `request` is this gate's own: a remediation request by the workflow, for this run's gate, on its exact subject. */
function isOwn(request: ApprovalRequest, run: RunRow, gate: NodeRow, subject: Subject): boolean {
  return request.action.class === 'remediation' && request.requester.component === 'workflow' && request.requester.runId === run.run_id
    && request.requester.nodeId === gate.node_id && sameSubject(request.subject, subject)
}

/**
 * Why the operator's `approve` does not decide this gate, or undefined when it does: a remediation
 * gate whose plan is on the approval queue, or will be put there now that a queue is loaded, is
 * decided there, the one channel for the operator's verdicts on it.
 */
export function queueOwns(e: Engine, gate: NodeRow): string | undefined {
  const spec = specOf(gate)
  if (!isRemediationGate(spec)) return undefined
  if (gate.approval_request) return `plan ${String(spec.plan)} of run ${gate.run_id} waits on approval request ${gate.approval_request} in the approval queue; decide it there (the queue on /ui, or MCP approvals_decide)`
  if (queueOf(e)) return `plan ${String(spec.plan)} of run ${gate.run_id} is being put to the approval queue; decide its request there (the queue on /ui, or MCP approvals_decide)`
  return undefined
}

/**
 * Settle the remediation gates a run waits on, against the approval queue: a gate not yet on it is
 * put there (one request on its exact subject, adopting one a crash left), and a gate whose request
 * was resolved opens or closes by it. True when a gate changed (its request was opened, or it opened
 * or closed), so the run looks at its nodes again. With no queue loaded nothing changes: the gate is
 * the operator's plan gate until its deadline. A gate the queue cannot be read for waits, logged,
 * until its deadline; then it closes as `gate_timeout` by this rule, naming its request, which it
 * withdraws if it can (INV-2, INV-9).
 */
export async function settleQueued(e: Engine, run: RunRow, gates: NodeRow[], lease: () => Lease): Promise<boolean> {
  const approvals = queueOf(e)
  if (!approvals) return false
  let changed = false
  for (const gate of gates) {
    try {
      changed = (gate.approval_request ? await applyVerdict(e, approvals, run, gate, lease) : await putToQueue(e, approvals, run, gate, lease)) || changed
    } catch (error) {
      if (isLeaseError(error)) throw error
      if (Date.parse(gate.not_before ?? '') > Date.now()) {
        warnOnce(e, `workflow: the approval queue could not settle gate ${gate.node_id} of run ${run.run_id}; it waits until ${gate.not_before ?? 'its deadline'}: ${(error as Error).message}`)
        continue
      }
      // Past its deadline the gate closes, read or not: no verdict that opens it was read in time.
      const plan = specOf(gate).plan as ArtifactRef
      const requestId = gate.approval_request ?? undefined
      close(e, run, gate, { kind: 'gate_timeout', message: `no verdict on plan ${plan} could be read from the approval queue by ${gate.not_before}${requestId ? ` (approval request ${requestId})` : ''}: ${(error as Error).message.slice(0, 300)}; the fix does not run (continue the run to ask again)` }, [plan], requestId, lease)
      if (requestId) await withdraw(e, approvals, requestId, run.run_id)
      changed = true
    }
  }
  return changed
}

/**
 * Put a remediation gate's plan to the queue: the policy is asked about `remediation` (which always
 * asks), then one request is opened on the exact subject, or one a crash left before its id was
 * stored is adopted, whatever its state: the gate's own most recent request that it never stored.
 * The gate then waits until the request expires, or applies the outcome the adopted one already
 * has. Any mode but `ask` closes the gate: `forbid` forbids the fix, and a policy that would run it
 * without a person is not followed.
 */
async function putToQueue(e: Engine, approvals: Approvals, run: RunRow, gate: NodeRow, lease: () => Lease): Promise<boolean> {
  const spec = specOf(gate)
  const plan = spec.plan as ArtifactRef
  const subject = remediationSubject(spec)
  const frame = e.tasks.frame(run.run_id)
  const project = frame ? { projectId: frame.projectId } : {}
  const verdict = await approvals.check({ class: 'remediation', ...project })
  if (verdict.mode !== 'ask') {
    const why = verdict.mode === 'forbid' ? 'the autonomy policy forbids remediation, so the fix does not run'
      : `the autonomy policy gives remediation ${verdict.mode}, and a fix that writes never runs without a person's approval (ALWAYS_ASK); it does not run`
    close(e, run, gate, { kind: 'plan_rejected', message: `${why} (decision ${verdict.decision}); continue the run to put the plan to the policy again` }, [plan, verdict.decision], undefined, lease)
    return true
  }
  // A request this gate stored before (a `wait` decision names it) was spent: the gate was reopened since, so it asks anew.
  const spent = storedRequests(e, run, gate)
  const listed = await approvals.list({ states: ['open', 'batched', 'approved', 'rejected'], ...project })
  let request = listed.filter((r) => isOwn(r, run, gate, subject) && !spent.has(r.requestId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.requestId.localeCompare(a.requestId))[0]
  const adopted = request !== undefined
  try {
    request ??= await ask(e, approvals, run, gate, spec, subject, verdict, project, frame?.taskId)
  } catch (error) {
    // The queue refused the request itself (`not-asked`, `invalid`): asking again cannot help, and nothing runs.
    if (!(error instanceof ApprovalsError)) throw error
    close(e, run, gate, { kind: 'plan_rejected', message: `the approval queue refused the request for plan ${plan} (${error.failure}: ${error.message.slice(0, 300)}); the fix does not run (continue the run to ask again)` }, [plan, verdict.decision], undefined, lease)
    return true
  }
  return store(e, approvals, run, gate, spec, request, verdict.decision, adopted, lease)
}

/** The requests this gate stored, each named by the `wait` decision recorded with it (./queue.ts `store`). */
function storedRequests(e: Engine, run: RunRow, gate: NodeRow): Set<string> {
  const decisions = e.ctx.artifacts.list({ kind: 'decision', decisionType: 'gate', runId: run.run_id, nodeId: gate.node_id, limit: 1000 })
  return new Set(decisions.map((d) => d.body as { decider?: { id?: string }; outcome?: { option?: string; detail?: { approvalRequest?: unknown } } })
    .filter((b) => b.decider?.id === RULE.id && b.outcome?.option === 'wait' && typeof b.outcome.detail?.approvalRequest === 'string')
    .map((b) => b.outcome!.detail!.approvalRequest as string))
}

/** One request for the fix, on its exact subject, asked by the workflow for this run's gate. */
function ask(e: Engine, approvals: Approvals, run: RunRow, gate: NodeRow, spec: ResolvedNode, subject: Subject, verdict: AutonomyVerdict, project: { projectId?: string }, taskId: string | undefined): Promise<ApprovalRequest> {
  const plan = spec.plan as ArtifactRef
  return approvals.request({
    subject,
    action: {
      class: 'remediation',
      summary: `Run ${run.run_id}: let ${fixOf(e, run, gate)} write a fix of the blocking findings its review found on ${spec.remediation!.subject}`.slice(0, 500),
      consequences: `Approved: the fix runs once, as plan ${plan} says, then a review of the changed subject. Rejected, withdrawn, or unanswered when the request expires: nothing of the plan runs, and the run fails (continue it to ask again).`,
      refs: [plan],
    },
    requester: { component: 'workflow', runId: run.run_id, nodeId: gate.node_id, ...project, ...(taskId ? { taskId } : {}) },
    verdict, classification: run.classification ?? e.ctx.egress.defaultClassification,
  })
}

/**
 * Store the request's id on the gate, which then waits until the request expires (or applies the
 * outcome an adopted one already has, on the next pass); a gate that moved on meanwhile withdraws it.
 */
async function store(e: Engine, approvals: Approvals, run: RunRow, gate: NodeRow, spec: ResolvedNode, request: ApprovalRequest, autonomy: ArtifactRef, adopted: boolean, lease: () => Lease): Promise<boolean> {
  const plan = spec.plan as ArtifactRef
  const stored = e.ctx.store.transaction(() => {
    const now = e.nodeRow(run.run_id, gate.node_id)
    if (now?.state !== 'BLOCKED' || now.approval_request) return false
    const decision = e.ctx.artifacts.recordDecision({
      decisionType: 'gate',
      question: `Does gate ${gate.node_id} let the steps of plan ${plan} run now?`,
      inputs: [plan, autonomy],
      candidates: [
        { option: 'wait', selected: true, reasons: [`the fix writes, so it waits for the operator's verdict on approval request ${request.requestId}, on exactly plan ${plan} and subject ${spec.remediation!.subject}, until ${request.expiresAt}${adopted ? ` (adopted: the gate's own request, ${request.state}, whose id a crash left unstored)` : ''}`] },
        { option: 'open', selected: false, reasons: ['not open: no approval of this plan is recorded yet'] },
      ],
      decider: RULE,
      outcome: { option: 'wait', detail: { plan, approvalRequest: request.requestId, until: request.expiresAt } },
      deterministic: true,
    }, { producer: PRODUCER, runId: run.run_id, nodeId: gate.node_id }).id as ArtifactRef
    e.writeNode(now, { approval_request: request.requestId, not_before: request.expiresAt }, (r) => ({ ...r, lastDecision: decision }), lease)
    e.ctx.eventLog.append({ type: 'workflow.gate.requested', runId: run.run_id, nodeId: gate.node_id, decision, data: { plan, approvalRequest: request.requestId, until: request.expiresAt } })
    return true
  })
  if (!stored && !request.resolution) await withdraw(e, approvals, request.requestId, run.run_id)
  return stored
}

/**
 * A gate whose request the queue knows: approved by the operator's verdict before the request
 * expired, its approval bound to exactly this gate's plan and subject, and the working tree still
 * that subject, the gate opens with the operator's approval as its result. An approval that does
 * not bind closes it (`plan_rejected`), one given after the expiry as `gate_timeout`, and a working
 * tree that moved since the review as `stale_subject` (an exact-subject `gate` decision); the
 * approved request stays as it is. Rejected, it closes (`plan_rejected` for a verdict or a
 * withdrawal, `gate_timeout` for an expiry). Still open past the gate's deadline (the request's
 * expiry, which the queue's own sweep may not have applied yet), the gate closes as
 * `gate_timeout`, and the request is withdrawn.
 */
async function applyVerdict(e: Engine, approvals: Approvals, run: RunRow, gate: NodeRow, lease: () => Lease): Promise<boolean> {
  const spec = specOf(gate)
  const plan = spec.plan as ArtifactRef
  const requestId = gate.approval_request!
  const request = await approvals.get(requestId)
  if (!request) {
    warnOnce(e, `workflow: the approval queue does not know ${requestId}, which gate ${gate.node_id} of run ${run.run_id} waits on; it waits until ${gate.not_before}`)
    return false
  }
  const resolution = request.resolution
  if (request.state === 'approved' && resolution?.approval) {
    const subject = remediationSubject(spec)
    const unbound = !isOwn(request, run, gate, subject)
      ? { kind: 'plan_rejected', message: `approval request ${requestId} does not bind plan ${plan} of gate ${gate.node_id} on subject ${spec.remediation!.subject}, so its approval is not used (INV-5)` }
      : approvalProblem(e, request, subject)
    if (unbound) {
      close(e, run, gate, unbound, [plan, resolution.decision], requestId, lease)
      return true
    }
    // The fix acts on the working tree as it is now: it must still be the subject the operator approved (INV-5).
    const moved = subjectMoved(e, run, gate, spec)
    if (moved) {
      close(e, run, gate, { kind: 'stale_subject', message: `exact-subject gate: approval request ${requestId} approved plan ${plan} on subject ${spec.remediation!.subject}, but ${moved.reason}; the fix does not run on another tree (continue the run to ask again once the tree is that subject)` },
        [plan, resolution.approval, resolution.decision], requestId, lease, { subject: spec.remediation!.subject, ...(moved.now ? { now: moved.now } : {}) })
      return true
    }
    open(e, run, gate, request, lease)
    return true
  }
  if (request.state === 'rejected' && resolution) {
    const how = resolution.cause === 'verdict' ? 'the operator rejected it' : resolution.cause === 'expired' ? `no verdict came by ${request.expiresAt}` : 'it was withdrawn (a policy change, or its work ended)'
    const kind = resolution.cause === 'expired' ? 'gate_timeout' : 'plan_rejected'
    close(e, run, gate, { kind, message: `approval request ${requestId} on plan ${plan} is rejected: ${how}; the fix does not run (continue the run to ask again)` }, [plan, resolution.decision], requestId, lease)
    return true
  }
  if (Date.parse(gate.not_before ?? '') > Date.now()) return false
  close(e, run, gate, { kind: 'gate_timeout', message: `approval request ${requestId} on plan ${plan} had no verdict by ${gate.not_before}; the fix does not run (continue the run to ask again)` }, [plan, request.policy.decision], requestId, lease)
  await withdraw(e, approvals, requestId, run.run_id)
  return true
}

/**
 * Why an approved request's approval does not open the gate, or undefined when it does: it was the
 * operator's verdict, given no later than the request's expiry (the queue refuses a later one; this
 * is defence in depth), recorded as an `approval@1.0` by the operator approving exactly the gate's
 * subject, and resolved by an `approval` decision `approved` (docs/design/approvals.md).
 */
function approvalProblem(e: Engine, request: ApprovalRequest, subject: Subject): { kind: string; message: string } | undefined {
  const resolution = request.resolution!
  const unbound = (why: string) => ({ kind: 'plan_rejected', message: `approval request ${request.requestId} is approved, but ${why}, so its approval is not used (INV-5)` })
  if (resolution.cause !== 'verdict') return unbound(`by ${resolution.cause}, not by the operator's verdict`)
  const at = Date.parse(resolution.at)
  if (!(at <= Date.parse(request.expiresAt))) {
    return { kind: 'gate_timeout', message: `approval request ${request.requestId} was approved at ${resolution.at}, not by its expiry ${request.expiresAt}, so its approval is not used; the fix does not run (continue the run to ask again)` }
  }
  const approval = e.ctx.artifacts.get(resolution.approval!)
  const body = approval?.body as { schema?: string; subject?: Subject; verdict?: string; by?: string } | undefined
  if (approval?.kind !== 'approval' || body?.schema !== 'approval@1.0' || body.verdict !== 'approved' || body.by !== 'operator' || !body.subject || !sameSubject(body.subject, subject)) {
    return unbound(`its approval ${resolution.approval} is not the operator's approval of exactly plan ${subject.ref} at ${subject.version}`)
  }
  const decision = e.ctx.artifacts.get(resolution.decision)?.body as { decisionType?: string; outcome?: { option?: string } } | undefined
  if (decision?.decisionType !== 'approval' || decision.outcome?.option !== 'approved') return unbound(`its resolution's decision ${resolution.decision} is not an approval decision \`approved\``)
  return undefined
}

/**
 * Whether the working tree the review read moved since: captured again as the exact-subject review
 * captures it (./review.ts), it must still be the subject the review was bound to, which the
 * request's subject carries. Undefined when it is; a reason (and the subject now) when it is not, or
 * when the tree, or the review's binding to it, can no longer be read.
 */
function subjectMoved(e: Engine, run: RunRow, gate: NodeRow, spec: ResolvedNode): { reason: string; now?: string } | undefined {
  const reviewed = spec.remediation!.subject
  // The review this gate waits behind recorded the tree it was bound to (its `subject` column).
  const review = spec.dependsOn.map((id) => e.nodeRow(run.run_id, id)).find((n) => n?.subject)
  const bound = review?.subject ? JSON.parse(review.subject) as { workspace?: string; subject?: GitSubject } : undefined
  if (!bound?.workspace || !bound.subject || subjectId(bound.subject) !== reviewed) return { reason: `the working tree review ${spec.dependsOn.join(', ')} was bound to at ${reviewed} is not recorded` }
  const captured = captureGitSubject(bound.workspace)
  if (!captured) return { reason: `${bound.workspace} is no longer a git working tree` }
  const now = subjectId(captured.subject)
  return now === reviewed ? undefined : { reason: `the working tree ${bound.workspace} changed since the review (now ${now})`, now }
}

/** The gate opens on the operator's approval of exactly its plan: the approval is its result (INV-5, INV-13). */
function open(e: Engine, run: RunRow, gate: NodeRow, request: ApprovalRequest, lease: () => Lease): void {
  const plan = specOf(gate).plan as ArtifactRef
  const { approval, decision: verdict } = request.resolution as { approval: ArtifactRef; decision: ArtifactRef }
  e.ctx.store.transaction(() => {
    const now = e.nodeRow(run.run_id, gate.node_id)
    if (now?.state !== 'BLOCKED' || now.approval_request !== request.requestId) return
    const decision = e.ctx.artifacts.recordDecision({
      decisionType: 'gate',
      question: `May the steps of plan ${plan} run in run ${run.run_id}?`,
      inputs: [approval, verdict, plan],
      candidates: [
        { option: 'open', selected: true, reasons: [`the operator approved request ${request.requestId}, bound to exactly plan ${plan} at ${request.subject.version}`] },
        { option: 'closed', selected: false, reasons: [`not closed: request ${request.requestId} is approved, and binds this gate's plan and subject`] },
      ],
      decider: RULE,
      outcome: { option: 'open', detail: { plan, approvalRequest: request.requestId, approval } },
      deterministic: true,
    }, { producer: PRODUCER, runId: run.run_id, nodeId: gate.node_id }).id as ArtifactRef
    e.writeNode(now, { state: 'COMPLETED' }, (r) => ({ ...r, outputReceipt: { result: approval, acceptance: decision }, lastDecision: decision }), lease)
    e.ctx.eventLog.append({ type: 'workflow.gate.opened', runId: run.run_id, nodeId: gate.node_id, decision, data: { plan, by: 'queue', approvalRequest: request.requestId } })
  })
}

/**
 * The gate closes by rule, and the run fails on it: nothing of its plan ran. With `exact`, it closes
 * by the exact-subject rule: the working tree is no longer the approved subject.
 */
function close(e: Engine, run: RunRow, gate: NodeRow, error: WorkflowError | { kind: string; message: string }, inputs: ArtifactRef[], requestId: string | undefined, lease: () => Lease, exact?: { subject: string; now?: string }): void {
  const plan = specOf(gate).plan as ArtifactRef
  const failure: WorkflowError = { kind: error.kind, disposition: 'NONE', message: error.message }
  e.ctx.store.transaction(() => {
    const now = e.nodeRow(run.run_id, gate.node_id)
    if (now?.state !== 'BLOCKED') return
    const decision = e.ctx.artifacts.recordDecision({
      decisionType: 'gate',
      question: `May the steps of plan ${plan} run in run ${run.run_id}?`,
      inputs: [...new Set(inputs)],
      candidates: [
        { option: 'open', selected: false, reasons: [exact ? `not open: the working tree is no longer ${exact.subject}, the subject the operator approved` : `not open: plan ${plan} has no approval it binds to`] },
        { option: 'closed', selected: true, reasons: [failure.message] },
      ],
      decider: exact ? EXACT : RULE,
      outcome: { option: 'closed', detail: { plan, kind: failure.kind, ...(requestId ? { approvalRequest: requestId } : {}), ...exact } },
      deterministic: true,
    }, { producer: PRODUCER, runId: run.run_id, nodeId: gate.node_id }).id as ArtifactRef
    e.writeNode(now, { state: 'FAILED', error: JSON.stringify(failure) }, (r) => ({ ...r, lastDecision: decision }), lease)
    e.ctx.eventLog.append({ type: 'workflow.gate.closed', runId: run.run_id, nodeId: gate.node_id, decision, data: { plan, by: 'queue', kind: failure.kind, ...(requestId ? { approvalRequest: requestId } : {}) } })
  })
}

/**
 * Withdraw the requests of a run's remediation gates that no longer wait on them (after a stop, say):
 * an approval given later would open nothing. One that fails expires on its own.
 */
export async function withdrawUnheld(e: Engine, runId: string): Promise<void> {
  const approvals = queueOf(e)
  if (!approvals) return
  const rows = e.ctx.store.db.prepare("SELECT approval_request FROM workflow_nodes WHERE run_id = ? AND approval_request IS NOT NULL AND state IN ('FAILED', 'RETIRED')").all(runId) as Array<{ approval_request: string }>
  for (const { approval_request } of rows) await withdraw(e, approvals, approval_request, runId)
}

async function withdraw(e: Engine, approvals: Approvals, requestId: string, runId: string): Promise<void> {
  try {
    await approvals.withdraw(requestId)
  } catch (error) {
    warnOnce(e, `workflow: could not withdraw approval request ${requestId} of run ${runId}; it expires on its own: ${(error as Error).message}`)
  }
}

/** The fix step a remediation gate guards: the step that depends on it. */
function fixOf(e: Engine, run: RunRow, gate: NodeRow): string {
  return e.nodeRows(run.run_id).find((n) => specOf(n).dependsOn.includes(gate.node_id))?.node_id ?? 'its fix step'
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
