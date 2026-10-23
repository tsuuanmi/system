/**
 * Recovery after a failed attempt (REQ-WF-6, INV-4) and tier escalation after a rejected result
 * (REQ-WRK-9). Each choice is a decision artifact (INV-13).
 */
import type { Lease } from '@tsuuanmi/system-leases'
import type { ProviderErrorKind } from '@tsuuanmi/system-provider-core'
import { type AdmissionFailure, type ArtifactRef, type CapabilityDescriptor, type RouteOptions, TIERS, type WorkerAccount, type WorkerExecution } from '@tsuuanmi/system-workers-core'
import { noteDeferral } from './continuations.ts'
import type { Engine } from './engine.ts'
import { MATERIAL, type SourceSnapshot } from './sources.ts'
import type { ResolvedNode } from './spec.ts'
import type { NodeRecord, NodeRow, RunRow, WorkflowError } from './types.ts'

const RETRYABLE = new Set(['IMMEDIATE', 'BACKOFF', 'RECREATE_SESSION'])

/** The Workers a node's session holds it to (Model A: a team member keeps one logical Worker), as listed now. */
export interface Held {
  session: string
  workers: CapabilityDescriptor[]
}

/**
 * The Workers a node's session holds it to, as listed now, read before a rejected result's
 * escalation is decided (that runs in a transaction, which cannot wait for the listing).
 * Undefined when its session holds it to none, or none of them is listed now: routing then decides.
 */
export async function heldWorkers(e: Engine, spec: ResolvedNode): Promise<Held | undefined> {
  const session = spec.session.sessionId
  const own = session ? e.ctx.workers.affinity(session) : undefined
  if (!session || !own?.length) return undefined
  const workers = (await e.ctx.workers.list()).filter((w) => own.includes(w.worker))
  return workers.length ? { session, workers } : undefined
}

/**
 * A rejected result may run again at the next tier above the one that served it, at most
 * `maxEscalations` times (REQ-WRK-9, routing.md#intelligence-tiers), and only onto a Worker it
 * may take: a node its session holds to its Workers (`held`) escalates only when one of them
 * serves that tier or above, since routing would refuse every other one. The rejected result
 * stays as evidence; the choice is an `escalation` decision either way. `why` says why it
 * escalated, or why not.
 */
export function escalate(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, result: ArtifactRef, acceptance: ArtifactRef, reasons: string[], decisions: { decisions: string }, lease: () => Lease, held?: Held): { escalated: boolean; why: string } {
  const max = spec.maxEscalations ?? 1
  const served = node.served_tier ?? spec.tier
  const next = TIERS[TIERS.indexOf(served) + 1]
  const reachable = next === undefined || !held || held.workers.some((w) => TIERS.indexOf(w.tier) >= TIERS.indexOf(next))
  const escalate = node.escalations < max && next !== undefined && reachable
  const why = escalate
    ? `escalation ${node.escalations + 1} of ${max} to ${next}: ${spec.acceptance} rejected the ${served} result (${reasons.join('; ')})`
    : next === undefined ? `no tier above ${served}`
    : node.escalations >= max ? `escalation bound reached (${max})`
    : `session ${held!.session} stays on its Worker${held!.workers.length > 1 ? 's' : ''} ${held!.workers.map((w) => `${w.worker} (${w.tier})`).join(', ')}, none at tier ${next} or above, so no Worker could take it there`
  const decision = e.ctx.artifacts.recordDecision({
    decisionType: 'escalation',
    question: `Does node ${node.node_id} of run ${run.run_id} run again at a higher tier after its result was rejected?`,
    inputs: [acceptance, result],
    candidates: [
      { option: 'escalate', selected: escalate, reasons: [escalate ? why : `not escalate: ${why}`] },
      {
        option: 'fail', selected: !escalate,
        reasons: escalate ? [`not fail: ${max - node.escalations} escalation(s) of ${max} remain and ${next} is above ${served}${held ? `, which ${held.session}'s Workers serve` : ''}`] : [why],
      },
    ],
    // Version 2: an escalation the node's session cannot take is not chosen.
    decider: { type: 'policy', id: 'workflow.escalation', version: '2' },
    outcome: { option: escalate ? 'escalate' : 'fail', ...(escalate ? { detail: { from: served, to: next } } : {}) },
    deterministic: true,
  }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id })
  if (!escalate) return { escalated: false, why }
  // The node routes again, so its old Worker no longer speaks for it (a peer's diversity reads it, ADR-0027).
  e.writeNode(node, { state: 'READY', execution_id: null, worker: null, escalations: node.escalations + 1, error: null, ...decisions }, (r) => {
    const next_: NodeRecord = {
      ...r, requirement: { ...r.requirement, tier: { min: next!, source: 'decision', decision: decision.id as ArtifactRef } }, lastDecision: decision.id as ArtifactRef,
    }
    delete next_.execution
    return next_
  }, lease)
  e.ctx.eventLog.append({ type: 'workflow.node.escalated', runId: run.run_id, nodeId: node.node_id, decision: decision.id, data: { from: served, to: next, escalation: node.escalations + 1 } })
  return { escalated: true, why }
}

/**
 * Why a rejected answer may have failed for want of room, not of intelligence: it stopped at its
 * Worker's output bound (a model answer's `finish: max-tokens`). Undefined for any other result.
 */
export function cutShort(e: Engine, result: ArtifactRef): string | undefined {
  const body = e.ctx.artifacts.get(result)?.body as { finish?: unknown; maxTokens?: unknown } | undefined
  if (body?.finish !== 'max-tokens') return undefined
  return `the answer stopped at its Worker's output bound${typeof body.maxTokens === 'number' ? ` (${body.maxTokens} tokens)` : ''}: a longer answer needs a higher bound in that Worker's configuration`
}

/** Whether a decision is the opt-in same-family admission of ADR-0029. */
export function isSameFamily(e: Engine, decision: ArtifactRef | undefined): boolean {
  return sameFamilyOf(e, decision) !== undefined
}

/**
 * The outcome of a same-family admission: `same-family` (only the family rule lifted; a team
 * member keeps an account of its own, ADR-0035) or `same-family-shared-account`; undefined for
 * any other decision.
 */
export function sameFamilyOf(e: Engine, decision: ArtifactRef | undefined): string | undefined {
  if (!decision) return undefined
  const body = e.ctx.artifacts.get(decision)?.body as { decider?: { id?: string }; outcome?: { option?: string } } | undefined
  return body?.decider?.id === 'workflow.same-family' ? body.outcome?.option ?? 'same-family' : undefined
}

/** The decisions recorded when the node's current attempt was routed: tier and route, after a same-family admission if there was one. */
export function routedDecisions(node: NodeRow, e?: Engine): ArtifactRef[] {
  const stored = node.decisions ? (JSON.parse(node.decisions) as ArtifactRef[]) : []
  const before = stored.at(-3)
  return e && isSameFamily(e, before) ? stored.slice(-3) : stored.slice(-2)
}

/** Failures an unsent attempt fails over from, to another Worker (ADR-0034). */
const FAILOVER = new Set(['quota_exhausted', 'challenge', 'reauth_required', 'overloaded'])

/** The account an attempt's Worker ran on, as routing saw it, when it declared one (ADR-0052). */
export function accountOf(node: NodeRow): WorkerAccount | undefined {
  return node.account ? (JSON.parse(node.account) as WorkerAccount) : undefined
}

/** The account a node stays on within its group after an unsent failure on an assigned account (ADR-0052), as route options. */
export function assignmentOf(node: NodeRow): RouteOptions['assignment'] {
  if (!node.assignment) return undefined
  const { group, account } = JSON.parse(node.assignment) as { group: string; account: string }
  return { group, account, reason: `an earlier attempt of ${node.node_id} failed on its assigned account ${account} before anything was sent; another account of its provider does not take its work` }
}

/** The group and account an attempt ran on, when its account is assigned: where the node then stays (ADR-0052). */
function assignedOf(node: NodeRow): { group: string; account: string } | undefined {
  const account = accountOf(node)
  return account?.mode === 'assigned' ? { group: account.group, account: account.id } : undefined
}

/** Until when a node waits for an assigned account's limit (ADR-0052), while it does. */
export function waitingUntil(node: NodeRow): string | undefined {
  if (node.state !== 'READY' || !node.limit_wait_since || !node.not_before || Date.parse(node.not_before) <= Date.now()) return undefined
  return (node.error ? (JSON.parse(node.error) as WorkflowError).kind : undefined) === 'quota_exhausted' ? node.not_before : undefined
}

/**
 * A node refused only because the assigned accounts that could take it are at their limit waits
 * for the earliest reset (ADR-0052), as a `recovery` decision with outcome `wait` (`decision@1.8`):
 * it stays `READY` with `not_before` the reset, kept on its row so a restart waits on (INV-4), sends
 * nothing, and spends no attempt. Bounded (INV-9): from its first wait, at most `maxLimitWaitHours`
 * in all. `node` is the row as it stands, its attempt not yet counted. Returns why it does not wait
 * when it cannot, so the caller fails it as before.
 */
export function waitForLimit(e: Engine, run: RunRow, node: NodeRow, failure: AdmissionFailure, message: string, lease: () => Lease): { waited: true } | { why: string } {
  const until = failure.limitUntil
  if (!until) return { why: 'no reset of the limit is known' }
  const max = e.config.maxLimitWaitHours ?? 24
  const since = node.limit_wait_since ?? new Date().toISOString()
  const hours = (Date.parse(until) - Date.parse(since)) / 3_600_000
  if (!(max > 0) || hours > max) return { why: `waiting until ${until} would pass maxLimitWaitHours (${max}) from its first wait at ${since}` }
  const waited = Math.max(0, (Date.now() - Date.parse(since)) / 3_600_000)
  const decision = e.ctx.artifacts.recordDecision({
    schema: 'decision@1.8',
    decisionType: 'recovery',
    question: `How does node ${node.node_id} of run ${run.run_id} recover from quota_exhausted?`,
    inputs: [failure.decision],
    candidates: [
      { option: 'retry', selected: false, reasons: ['not retry: no Worker is admitted now; the assigned accounts that could take it are at their limit'] },
      { option: 'failover', selected: false, reasons: ['not failover: assigned accounts do not take another account\'s work at its limit'] },
      { option: 'wait', selected: true, reasons: [`the assigned accounts that could take it are at their limit, the first back at ${until}; it waits for that reset (${round(waited)} h of the ${max} h it may wait in all), sends nothing, and spends no attempt`] },
      { option: 'fail', selected: false, reasons: [`not fail: the reset is known and within maxLimitWaitHours (${max}) of its first wait`] },
    ],
    decider: { type: 'rule', id: 'workflow.recovery', version: '1' },
    outcome: { option: 'wait', detail: { kind: 'quota_exhausted', attempt: node.attempt, until, since, maxLimitWaitHours: max } },
    deterministic: true,
  }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id })
  const error: WorkflowError = { kind: 'quota_exhausted', disposition: 'BACKOFF', message: `${message}; waiting until ${until}` }
  e.ctx.store.transaction(() => {
    e.writeNode(node, { state: 'READY', execution_id: null, worker: null, not_before: until, limit_wait_since: since, error: JSON.stringify(error), decisions: JSON.stringify([failure.decision]) }, (r) => {
      const next: NodeRecord = { ...r, lastDecision: decision.id as ArtifactRef }
      delete next.execution
      return next
    }, lease)
    e.ctx.eventLog.append({ type: 'workflow.node.waiting', runId: run.run_id, nodeId: node.node_id, decision: decision.id, data: { until, since, attempt: node.attempt } })
  })
  return { waited: true }
}

const round = (hours: number): string => (Math.round(hours * 100) / 100).toString()

/**
 * Retry, fail over, or fail a node after a failed attempt (REQ-WF-6), recorded as a
 * `recovery` decision (INV-13). A retry needs a retryable disposition, attempts left, and a
 * prompt that never reached the provider: once sent, only the turn runtime may resubmit, within
 * its own bound, so the engine never causes a duplicate provider turn (INV-4). An unsent
 * usage limit, challenge, sign-out, or overload fails over instead: the next attempt leaves the
 * failed Worker out (ADR-0034), unless the node's session is held to it.
 */
export function failAttempt(e: Engine, run: RunRow, node: NodeRow, error: WorkflowError, attempt: { sent: boolean; execution?: WorkerExecution; decisions?: ArtifactRef[] }, lease: () => Lease): void {
  const max = e.config.maxAttempts ?? 3
  const reasons = {
    retry: [] as string[],
    failover: [] as string[],
    fail: [] as string[],
  }
  // A session that already holds its account (a turn of it was sent), or a team member, which joins
  // its team bound to the Worker of its first admission (Model A), never moves.
  const sessionId = (JSON.parse(node.spec) as ResolvedNode).session.sessionId
  const held = sessionId ? e.ctx.workers.affinity(sessionId) ?? e.ctx.workerSessions.session(sessionId) : undefined
  // An assigned account's unsent failure never moves inside its provider group (ADR-0052).
  const assigned = !attempt.sent && node.worker && FAILOVER.has(error.kind) ? assignedOf(node) : undefined
  // Why a failover is not possible: the first of its conditions that does not hold.
  const noFailover = attempt.sent ? 'the prompt was sent, so the turn stays with its Worker'
    : !node.worker ? 'no Worker served the attempt'
    : !FAILOVER.has(error.kind) ? `${error.kind} is not a failure of one Worker (usage limit, challenge, sign-out, or overload)`
    : node.attempt >= max ? `attempt ${node.attempt} of ${max} failed`
    : held ? `the node's session is held to ${node.worker}`
    : assigned && error.kind === 'overloaded' ? `${node.worker}'s account is assigned: an overload is retried on it with back-off, never moved to another account of its provider`
    : undefined
  // Why the node cannot run again at all: the first of a retry's conditions that does not hold.
  const noRetry = !RETRYABLE.has(error.disposition) ? `${error.kind} is ${error.disposition}, not retryable`
    : attempt.sent ? `${error.kind} came after the prompt was sent; resending could duplicate the provider turn`
    : node.attempt >= max ? `attempt ${node.attempt} of ${max} failed`
    : undefined
  if (!noFailover) {
    reasons.failover.push(assigned
      ? `${error.kind} on ${node.worker} before anything was sent, and attempt ${node.attempt} of ${max} failed: a Worker of another provider takes it, or else its own account again; its account is assigned, so no other account of its provider does`
      : `${error.kind} on ${node.worker} before anything was sent, and attempt ${node.attempt} of ${max} failed: another Worker takes it`)
    reasons.retry.push(`not retry: ${error.kind} is bound to ${node.worker}, so the next attempt leaves it out`)
    reasons.fail.push(`not fail: nothing was sent and ${max - node.attempt} attempt(s) of ${max} remain`)
  } else if (noRetry) {
    reasons.fail.push(noRetry)
    reasons.retry.push(`not retry: ${noRetry}`)
    reasons.failover.push(`not failover: ${noFailover}`)
  } else {
    reasons.retry.push(`${error.kind} is ${error.disposition}, the prompt was never sent, and attempt ${node.attempt} of ${max} failed`)
    reasons.failover.push(`not failover: ${noFailover}`)
    reasons.fail.push(`not fail: ${error.kind} is ${error.disposition}, the prompt was never sent, and ${max - node.attempt} attempt(s) of ${max} remain`)
  }
  const failover = !noFailover
  const retry = failover || !noRetry
  // What failed, in the decision `explain` shows, so the CLI alone tells why.
  const said = errorLine(error.message)
  if (said) (failover ? reasons.failover : retry ? reasons.retry : reasons.fail).push(`error: ${said}`)
  const kept = attempt.decisions ?? (attempt.execution ? [...attempt.execution.decisions, ...routedDecisions(node, e)] : node.decisions ? (JSON.parse(node.decisions) as ArtifactRef[]) : [])
  const decision = e.ctx.artifacts.recordDecision({
    decisionType: 'recovery',
    question: `How does node ${node.node_id} of run ${run.run_id} recover from ${error.kind}?`,
    inputs: kept,
    candidates: [
      { option: 'retry', selected: retry && !failover, reasons: reasons.retry },
      { option: 'failover', selected: failover, reasons: reasons.failover },
      { option: 'fail', selected: !retry, reasons: reasons.fail },
    ],
    decider: { type: 'rule', id: 'workflow.recovery', version: '1' },
    outcome: {
      option: failover ? 'failover' : retry ? 'retry' : 'fail',
      detail: { kind: error.kind, disposition: error.disposition, attempt: node.attempt, ...(failover ? { from: node.worker!, sent: false } : {}), ...(retry && assigned ? { assignment: assigned } : {}) },
    },
    deterministic: true,
  }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id })
  const decisions = kept.length ? { decisions: JSON.stringify(kept) } : {}
  if (retry) {
    // Moving to another Worker needs no wait; an overload waits its back-off, in case none is left but this one.
    const delay = error.disposition === 'IMMEDIATE' || (failover && error.disposition !== 'BACKOFF') ? 0 : (e.config.retryDelayMs ?? 5000) * 2 ** Math.max(0, node.attempt - 1)
    // The failed Worker and those that share its runtime (another tier of the same account).
    const excluded = failover ? { excluded: JSON.stringify([...new Set([...(node.excluded ? (JSON.parse(node.excluded) as string[]) : []), ...e.ctx.workers.siblings(node.worker!)])].sort()) } : {}
    // Kept on the row, so a restart keeps it: no other account of its group takes the node (ADR-0052).
    const pinned = assigned ? { assignment: JSON.stringify(assigned) } : {}
    e.ctx.store.transaction(() => {
      e.writeNode(node, { state: 'READY', execution_id: null, worker: null, attempt: node.attempt, not_before: new Date(Date.now() + delay).toISOString(), error: JSON.stringify(error), ...excluded, ...pinned, ...decisions },
        (r) => {
          // The next attempt gets its own execution; the failed one no longer explains the node.
          const next: NodeRecord = { ...r, lastDecision: decision.id as ArtifactRef }
          delete next.execution
          return next
        }, lease)
      e.ctx.eventLog.append({ type: 'workflow.node.retry', runId: run.run_id, nodeId: node.node_id, decision: decision.id, data: { attempt: node.attempt, kind: error.kind, disposition: error.disposition, delayMs: delay, ...(failover ? { failoverFrom: node.worker! } : {}) } })
    })
    return
  }
  // Sent and failed: nothing more is automatic; the operator decides (USER_ACTION).
  const final: WorkflowError = attempt.sent && RETRYABLE.has(error.disposition)
    ? { ...error, disposition: 'USER_ACTION', message: `${error.message} (the prompt was sent, so it is not resent automatically)` }
    : error
  e.ctx.store.transaction(() => {
    e.writeNode(node, { state: 'FAILED', attempt: node.attempt, error: JSON.stringify(final), ...decisions }, (r) => ({ ...r, lastDecision: decision.id as ArtifactRef }), lease)
    e.ctx.eventLog.append({ type: 'workflow.node.failed', runId: run.run_id, nodeId: node.node_id, decision: decision.id, data: { attempt: node.attempt, kind: final.kind, disposition: final.disposition } })
    // A Worker that stopped at a call waiting for the operator: its session continues once that is approved.
    noteDeferral(e, run, node, final, attempt.execution)
  })
}

/**
 * A failure's message as one line for a decision: bounded, with terminal escapes and control
 * characters removed, and no text a browser's call log echoes from a typing call.
 */
export function errorLine(message: string): string {
  return [...message.split(`${String.fromCharCode(27)}[`).map((part, i) => (i ? part.replace(/^[0-9;]*m/, '') : part)).join('')]
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('')
    // A browser's call log echoes typed text (fill("…"), type("…")): never a prompt in a decision.
    .replace(/\b(fill|type|pressSequentially|insertText)\((["'`])(?:\\[\s\S]|(?!\2)[^\\])*\2/g, '$1(…')
    .replace(/\s+/g, ' ').trim().slice(0, 280)
}

/**
 * How a refused admission is handled: by the state that kept an otherwise fitting Worker
 * out. With no Worker at all, the operator still has to add and sign in an account.
 */
export function admissionKind(failure: AdmissionFailure): ProviderErrorKind {
  if (failure.rejections.length === 0) return 'reauth_required'
  const onlyState = failure.rejections.filter((r) => r.failed.every((f) => f.check === 'state'))
  if (onlyState.some((r) => r.state === 'reauth-required' || r.state === 'unavailable')) return 'reauth_required'
  if (onlyState.some((r) => r.state === 'quota-exhausted')) return 'quota_exhausted'
  // Refused only for a usage limit on what the work needs, or for that and being out of quota (ADR-0034).
  if (failure.rejections.some((r) => r.failed.every((f) => f.check === 'cooldown' || f.check === 'state') && r.failed.some((f) => f.check === 'cooldown'))) return 'quota_exhausted'
  if (failure.rejections.some((r) => r.failed.every((f) => f.check === 'locality'))) return 'egress_denied'
  // Too long for every Worker that could otherwise take it: sending it again cannot help (ADR-0032).
  if (failure.rejections.some((r) => r.failed.every((f) => f.check === 'input'))) return 'invalid_input'
  return 'config_error'
}

/**
 * When the input was too long for a Worker that could otherwise take it, the bound to change
 * (ADR-0032): a review member's input is sized by the source it is shown (`source`, its source
 * step's snapshot), so that bound is named, and for the caller's own text, the text; any other
 * input is the caller's to shorten, or a Worker's own bound to raise. Empty otherwise.
 */
export function inputHint(e: Engine, spec: ResolvedNode, failure: AdmissionFailure, chars: number, source?: SourceSnapshot): string {
  if (!failure.rejections.some((r) => r.failed.length && r.failed.every((f) => f.check === 'input'))) return ''
  const bound = `repositories.maxSourceChars, ${e.config.repositories?.maxSourceChars ?? 24_000}`
  if (spec.team?.kind === 'review' && source && !source.repository) {
    return `. The input is ${chars} characters, most of it the caller's text, shown once as the file ${MATERIAL} (at most ${bound}): review a smaller part of it, or lower that bound so a text this long is refused before any member is asked`
  }
  if (spec.team?.kind === 'review') {
    return `. The input is ${chars} characters, most of it the source shown (${bound}): lower that bound or narrow the focus`
  }
  return `. The input is ${chars} characters: shorten it, or raise the Worker's own input bound in its configuration if its site or model takes more`
}
