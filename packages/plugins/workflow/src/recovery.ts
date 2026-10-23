/**
 * Recovery after a failed attempt (REQ-WF-6, INV-4) and tier escalation after a rejected result
 * (REQ-WRK-9). Each choice is a decision artifact (INV-13).
 */
import type { Lease } from '@tsuuanmi/system-leases'
import type { ProviderErrorKind } from '@tsuuanmi/system-provider-core'
import { type AdmissionFailure, type ArtifactRef, TIERS, type WorkerExecution } from '@tsuuanmi/system-workers-core'
import { noteDeferral } from './continuations.ts'
import type { Engine } from './engine.ts'
import type { ResolvedNode } from './spec.ts'
import type { NodeRecord, NodeRow, RunRow, WorkflowError } from './types.ts'

const RETRYABLE = new Set(['IMMEDIATE', 'BACKOFF', 'RECREATE_SESSION'])

/**
 * A rejected result may run again at the next tier above the one that served it, at most
 * `maxEscalations` times (REQ-WRK-9, routing.md#intelligence-tiers). The rejected result stays
 * as evidence; the choice is an `escalation` decision either way. True when it escalated.
 */
export function escalate(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, result: ArtifactRef, acceptance: ArtifactRef, reasons: string[], decisions: { decisions: string }, lease: () => Lease): boolean {
  const max = spec.maxEscalations ?? 1
  const served = node.served_tier ?? spec.tier
  const next = TIERS[TIERS.indexOf(served) + 1]
  const escalate = node.escalations < max && next !== undefined
  const why = escalate
    ? [`escalation ${node.escalations + 1} of ${max} to ${next}: ${spec.acceptance} rejected the ${served} result (${reasons.join('; ')})`]
    : [next === undefined ? `no tier above ${served}` : `escalation bound reached (${max})`]
  const decision = e.ctx.artifacts.recordDecision({
    decisionType: 'escalation',
    question: `Does node ${node.node_id} of run ${run.run_id} run again at a higher tier after its result was rejected?`,
    inputs: [acceptance, result],
    candidates: [
      { option: 'escalate', selected: escalate, reasons: escalate ? why : why.map((w) => `not escalate: ${w}`) },
      { option: 'fail', selected: !escalate, reasons: escalate ? [`not fail: ${max - node.escalations} escalation(s) of ${max} remain and ${next} is above ${served}`] : why },
    ],
    decider: { type: 'policy', id: 'workflow.escalation', version: '1' },
    outcome: { option: escalate ? 'escalate' : 'fail', ...(escalate ? { detail: { from: served, to: next } } : {}) },
    deterministic: true,
  }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id })
  if (!escalate) return false
  // The node routes again, so its old Worker no longer speaks for it (a peer's diversity reads it, ADR-0027).
  e.writeNode(node, { state: 'READY', execution_id: null, worker: null, escalations: node.escalations + 1, error: null, ...decisions }, (r) => {
    const next_: NodeRecord = {
      ...r, requirement: { ...r.requirement, tier: { min: next!, source: 'decision', decision: decision.id as ArtifactRef } }, lastDecision: decision.id as ArtifactRef,
    }
    delete next_.execution
    return next_
  }, lease)
  e.ctx.eventLog.append({ type: 'workflow.node.escalated', runId: run.run_id, nodeId: node.node_id, decision: decision.id, data: { from: served, to: next, escalation: node.escalations + 1 } })
  return true
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
  // Why a failover is not possible: the first of its conditions that does not hold.
  const noFailover = attempt.sent ? 'the prompt was sent, so the turn stays with its Worker'
    : !node.worker ? 'no Worker served the attempt'
    : !FAILOVER.has(error.kind) ? `${error.kind} is not a failure of one Worker (usage limit, challenge, sign-out, or overload)`
    : node.attempt >= max ? `attempt ${node.attempt} of ${max} failed`
    : held ? `the node's session is held to ${node.worker}`
    : undefined
  // Why the node cannot run again at all: the first of a retry's conditions that does not hold.
  const noRetry = !RETRYABLE.has(error.disposition) ? `${error.kind} is ${error.disposition}, not retryable`
    : attempt.sent ? `${error.kind} came after the prompt was sent; resending could duplicate the provider turn`
    : node.attempt >= max ? `attempt ${node.attempt} of ${max} failed`
    : undefined
  if (!noFailover) {
    reasons.failover.push(`${error.kind} on ${node.worker} before anything was sent, and attempt ${node.attempt} of ${max} failed: another Worker takes it`)
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
    outcome: { option: failover ? 'failover' : retry ? 'retry' : 'fail', detail: { kind: error.kind, disposition: error.disposition, attempt: node.attempt, ...(failover ? { from: node.worker!, sent: false } : {}) } },
    deterministic: true,
  }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id })
  const decisions = kept.length ? { decisions: JSON.stringify(kept) } : {}
  if (retry) {
    // Moving to another Worker needs no wait; an overload waits its back-off, in case none is left but this one.
    const delay = error.disposition === 'IMMEDIATE' || (failover && error.disposition !== 'BACKOFF') ? 0 : (e.config.retryDelayMs ?? 5000) * 2 ** Math.max(0, node.attempt - 1)
    // The failed Worker and those that share its runtime (another tier of the same account).
    const excluded = failover ? { excluded: JSON.stringify([...new Set([...(node.excluded ? (JSON.parse(node.excluded) as string[]) : []), ...e.ctx.workers.siblings(node.worker!)])].sort()) } : {}
    e.ctx.store.transaction(() => {
      e.writeNode(node, { state: 'READY', execution_id: null, worker: null, attempt: node.attempt, not_before: new Date(Date.now() + delay).toISOString(), error: JSON.stringify(error), ...excluded, ...decisions },
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
 * (ADR-0032): a review member's input is sized by the source it is shown, so that bound is named;
 * any other input is the caller's to shorten, or a Worker's own bound to raise. Empty otherwise.
 */
export function inputHint(e: Engine, spec: ResolvedNode, failure: AdmissionFailure, chars: number): string {
  if (!failure.rejections.some((r) => r.failed.length && r.failed.every((f) => f.check === 'input'))) return ''
  if (spec.team?.kind === 'review') {
    return `. The input is ${chars} characters, most of it the source shown (repositories.maxSourceChars, ${e.config.repositories?.maxSourceChars ?? 24_000}): lower that bound or narrow the focus`
  }
  return `. The input is ${chars} characters: shorten it, or raise the Worker's own input bound in its configuration if its site or model takes more`
}
