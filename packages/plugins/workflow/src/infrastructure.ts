/**
 * Whether a board task's failed run failed only on the infrastructure (ADR-0069,
 * docs/design/workflow-engine.md#an-attempt-not-spent-on-the-infrastructure), so its report asks the
 * board not to count it as an attempt:
 *
 * - **host-stopped**: the host stopped it (a drain or restart). A step whose execution its source
 *   ended marked `host-stopped` (its holder stopped with it in flight, and that alone ended it, as an
 *   agent run or a website turn reconciled after a restart is), or a run whose board holder lapsed
 *   while the host was down, found at its first renewal after the start. A restart alone is no
 *   proof: an execution that outlived one and then failed for its own reason (a sandbox or worktree
 *   violation, a result not captured) is not marked, whatever its kind.
 * - **worker-unavailable**: a step failed only because a Worker it needed became unavailable while
 *   the run ran: routing refused it with an otherwise fitting Worker `unavailable`, its Worker's
 *   source is no longer loaded, its execution ended unsent while its Worker reads `unavailable`, or
 *   its source ended it marked `worker-unavailable`, sent or not (its Worker went away mid-run).
 * - **unsent**: nothing of the run was ever sent to any Worker, and every step that failed failed
 *   for a Worker's own reason before the send ({@link UNSENT_INFRASTRUCTURE}: its network,
 *   overload, stalled or broken session, its account's limit, sign-out, or challenge, in routing or
 *   in its execution): every execution the run started, as its source tells it, was never
 *   submitted. One its source no longer knows counts as sent (INV-2).
 *
 * Always the attempt's, fail closed, whatever was sent: a run the operator stopped (the
 * operator's call); a run that failed for its own reason rather than a failed step's (the task's
 * budget spent or not reservable, `budget_spent` or `quota_exhausted` from the ledger; a result off
 * the subject it writes; no step able to run); and a step that failed for the task's own input,
 * policy, configuration, or code (`invalid_input`, `egress_denied`, `config_error`, `internal`, a
 * timeout, a rejection, ...), which sending again would not change. Only a kind named in
 * {@link UNSENT_INFRASTRUCTURE}, or a mark the engine or a source set, is the infrastructure's.
 *
 * Steps are marked when they fail, on `workflow_nodes.infrastructure`; a failure that is not marked
 * is a failure the task's attempt pays for. The board keeps the bound on free retries (INV-9).
 */
import type { InfrastructureFailure } from '@tsuuanmi/system-board-core'
import type { AdmissionFailure, WorkerExecution } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import type { NodeRow, RunRow, WorkflowError } from './types.ts'

export type { InfrastructureFailure }

/** The most characters a reason holds (the board's bound, `INFRASTRUCTURE_REASON_MAX`). */
const REASON_MAX = 500
/** Execution starts of one run read, at most; a run with more counts as one that sent something. */
const STARTS_MAX = 1000

/** A reason within the board's bound, on one line. */
export const reasonOf = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  const chars = [...line]
  return chars.length <= REASON_MAX ? line || 'an infrastructure failure' : `${chars.slice(0, REASON_MAX - 1).join('')}…`
}

/**
 * A failed execution's mark: what its source marked it (`host-stopped`, `worker-unavailable`), the
 * source's own word that the infrastructure alone ended it, sent or not; `worker-unavailable` when
 * nothing of it was sent and its Worker reads `unavailable` now; none otherwise. Never inferred from
 * its kind or a restart: an execution that failed for its own reason is the attempt's.
 */
export async function executionInfrastructure(e: Engine, node: NodeRow, execution: WorkerExecution, error: WorkflowError): Promise<InfrastructureFailure | undefined> {
  const marked = execution.error?.infrastructure
  if (marked === 'host-stopped') {
    return { kind: 'host-stopped', reason: reasonOf(`step ${node.node_id}'s execution ${execution.id} was in flight when the host stopped (a drain or restart), and its source ended it for that alone (${error.kind}): ${error.message}`) }
  }
  if (marked === 'worker-unavailable') {
    return { kind: 'worker-unavailable', reason: reasonOf(`step ${node.node_id}'s Worker ${node.worker ?? '(none)'} became unavailable while its execution ${execution.id} ran${execution.submitted ? ', after it was sent,' : ''} and its source ended it for that alone (${error.kind}): ${error.message}`) }
  }
  if (execution.submitted || !node.worker) return undefined
  const state = await workerState(e, node.worker)
  if (state?.state !== 'unavailable') return undefined
  return { kind: 'worker-unavailable', reason: reasonOf(`step ${node.node_id}'s Worker ${node.worker} became unavailable${state.why ? ` (${state.why})` : ''} before anything of it was sent: ${error.message}`) }
}

/** A routing refusal's mark: `worker-unavailable` when a Worker that would otherwise take the step is `unavailable`. */
export function admissionInfrastructure(node: NodeRow, failure: AdmissionFailure): InfrastructureFailure | undefined {
  const down = failure.rejections.filter((r) => r.state === 'unavailable' && r.failed.length > 0 && r.failed.every((f) => f.check === 'state'))
  if (!down.length) return undefined
  const named = down.slice(0, 4).map((r) => r.worker).join(', ')
  return { kind: 'worker-unavailable', reason: reasonOf(`no Worker took step ${node.node_id}, and ${named}${down.length > 4 ? ` and ${down.length - 4} more` : ''}, which would otherwise take it, ${down.length === 1 ? 'is' : 'are'} unavailable; nothing of it was sent`) }
}

/** A step whose Worker's source is no longer loaded: its Worker is gone while the run ran. */
export function sourceGone(node: NodeRow): InfrastructureFailure {
  return { kind: 'worker-unavailable', reason: reasonOf(`step ${node.node_id}'s Worker source ${node.source ?? '(none)'} is no longer loaded, so its Worker ${node.worker ?? '(none)'} became unavailable while the run ran`) }
}

/** The run's board holder lapsed while the host was down: found at its first renewal after the start. */
export function holderLapsedAtStart(taskId: string, generation: number, reason: string): InfrastructureFailure {
  return { kind: 'host-stopped', reason: reasonOf(`the board no longer held generation ${generation} of task ${taskId} when the host started again (${reason}): its lease lapsed while the host was stopped`) }
}

/** A node's mark, as stored. */
export function markOf(node: NodeRow): InfrastructureFailure | undefined {
  if (!node.infrastructure) return undefined
  try {
    const mark = JSON.parse(node.infrastructure) as InfrastructureFailure
    return mark.kind && mark.reason ? mark : undefined
  } catch {
    return undefined
  }
}

/**
 * Failures of a step that, with nothing of the run sent, are a Worker's and not the attempt's: its
 * network, overload, stalled or broken session, its account's usage limit, sign-out, or challenge
 * (routing refusing the step for one of these, or its execution failing on one before the send).
 * Every other kind is the attempt's (fail closed): the task's input, policy, configuration, or code
 * (`invalid_input`, `input_dropped`, `egress_denied`, `config_error`, `ui_drift`, `internal`), a
 * timeout, a rejection, a stop, or a reconciliation its source did not mark.
 */
export const UNSENT_INFRASTRUCTURE: ReadonlySet<string> = new Set([
  'network', 'overloaded', 'provider_stalled', 'session_broken', 'quota_exhausted', 'reauth_required', 'challenge',
])

/** How a failed run's report reads: it failed only on the infrastructure, or its attempt counts, and why. */
export type RunVerdict = { infrastructure: InfrastructureFailure } | { counted: string }

/**
 * Whether a failed run failed only on the infrastructure, and how, from its own records, or why its
 * attempt counts. `holderLost` is the run's lost holder's infrastructure, when the loss was found
 * at the start.
 */
export function infrastructureOf(e: Engine, run: RunRow, holderLost: InfrastructureFailure | undefined): RunVerdict {
  if (run.status !== 'failed') return { counted: `the run is ${run.status}, not failed` }
  const error = run.error ? (JSON.parse(run.error) as WorkflowError) : undefined
  if (error?.kind === 'holder_lost') return holderLost ? { infrastructure: holderLost } : { counted: 'its holder was lost while the host ran, not while it was stopped' }
  // The operator stopped it: the operator's call, counted as before, even with nothing sent.
  if (error?.kind === 'stopped') return { counted: 'the operator stopped it: the operator\'s call, never the infrastructure\'s, whatever was sent' }
  const failed = e.nodeRows(run.run_id).filter((n) => n.state === 'FAILED')
  // The run failed for its own reason, not a failed step's: the task's budget spent or not
  // reservable (the ledger refused a step's reservation), a result off its subject, no step able to
  // run. The task's own, so the attempt's, never a free retry, even with nothing sent.
  if (!failed.some((n) => n.error === run.error)) {
    return { counted: `it failed for its own reason, not a failed step's (${error?.kind ?? 'failed'}: the task's budget, its subject, or its steps), which is the attempt's, never the infrastructure's, even with nothing sent` }
  }
  // Every failed step was marked: the first mark says how.
  const marks = failed.map(markOf)
  if (marks.every((m) => m !== undefined)) return { infrastructure: marks[0]! }
  // A step that failed for the task's own input, policy, configuration, or code is the attempt's, sent or not.
  const own = failed.find((n, i) => marks[i] === undefined && !UNSENT_INFRASTRUCTURE.has(kindOf(n)))
  if (own) {
    return { counted: `step ${own.node_id} failed for a reason of its own (${kindOf(own)}), not because the host stopped it or a Worker failed or became unavailable: the attempt's, sent or not` }
  }
  if (sentAnything(e, run.run_id)) {
    return { counted: 'something of the run was sent, and not every failed step failed only because the host stopped it or a Worker became unavailable' }
  }
  // Nothing was ever sent, and every step failed on a Worker's own failure before the send.
  return { infrastructure: { kind: 'unsent', reason: reasonOf(`nothing of run ${run.run_id} was sent to any Worker before it failed (${error?.kind ?? 'failed'}: ${error?.message ?? 'no error recorded'})`) } }
}

/** A failed node's error kind; `internal` when it recorded none. */
const kindOf = (node: NodeRow): string => {
  try {
    return node.error ? (JSON.parse(node.error) as WorkflowError).kind : 'internal'
  } catch {
    return 'internal'
  }
}

/**
 * Whether anything of the run reached a Worker: an execution it started that its source reports
 * submitted, or one its source no longer knows (fail closed). Read from the run's own
 * `workflow.node.started` events, appended in the transaction that starts each execution.
 */
export function sentAnything(e: Engine, runId: string): boolean {
  const started = e.ctx.eventLog.query({ type: 'workflow.node.started', runId, limit: STARTS_MAX })
  if (started.length >= STARTS_MAX) return true
  for (const event of started) {
    const data = event.data as { executionId?: unknown; source?: unknown } | undefined
    if (typeof data?.executionId !== 'string' || typeof data.source !== 'string') return true
    const execution = e.ctx.workers.source(data.source)?.get(data.executionId)
    if (!execution || execution.submitted) return true
  }
  return false
}

/** A Worker's state as its source describes it now, with why when unavailable; undefined when no source lists it. */
async function workerState(e: Engine, worker: string): Promise<{ state: string; why?: string } | undefined> {
  try {
    const found = (await e.ctx.workers.list()).find((d) => d.worker === worker)
    return found ? { state: found.state, ...(found.unavailableReason ? { why: found.unavailableReason } : {}) } : undefined
  } catch {
    return undefined
  }
}
