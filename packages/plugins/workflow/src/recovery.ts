/**
 * Recovery after a failed attempt (REQ-WF-6, INV-4) and tier escalation after a rejected result
 * (REQ-WRK-9). Each choice is a decision artifact (INV-13).
 */
import type { Lease } from '@tsuuanmi/system-leases'
import type { ProviderErrorKind } from '@tsuuanmi/system-provider-core'
import { type AdmissionFailure, type ArtifactRef, TIERS, type WorkerExecution } from '@tsuuanmi/system-workers-core'
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
    candidates: [{ option: 'escalate', selected: escalate, reasons: escalate ? why : [] }, { option: 'fail', selected: !escalate, reasons: escalate ? [] : why }],
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
  if (!decision) return false
  const body = e.ctx.artifacts.get(decision)?.body as { decider?: { id?: string } } | undefined
  return body?.decider?.id === 'workflow.same-family'
}

/** The decisions recorded when the node's current attempt was routed: tier and route, after a same-family admission if there was one. */
export function routedDecisions(node: NodeRow, e?: Engine): ArtifactRef[] {
  const stored = node.decisions ? (JSON.parse(node.decisions) as ArtifactRef[]) : []
  const before = stored.at(-3)
  return e && isSameFamily(e, before) ? stored.slice(-3) : stored.slice(-2)
}

/**
 * Retry or fail a node after a failed attempt (REQ-WF-6), recorded as a `recovery`
 * decision (INV-13). A retry needs a retryable disposition, attempts left, and a prompt
 * that never reached the provider: once sent, only the turn runtime may resubmit, within
 * its own bound, so the engine never causes a duplicate provider turn (INV-4).
 */
export function failAttempt(e: Engine, run: RunRow, node: NodeRow, error: WorkflowError, attempt: { sent: boolean; execution?: WorkerExecution; decisions?: ArtifactRef[] }, lease: () => Lease): void {
  const max = e.config.maxAttempts ?? 3
  const reasons = {
    retry: [] as string[],
    fail: [] as string[],
  }
  if (!RETRYABLE.has(error.disposition)) reasons.fail.push(`${error.kind} is ${error.disposition}, not retryable`)
  else if (attempt.sent) reasons.fail.push(`${error.kind} came after the prompt was sent; resending could duplicate the provider turn`)
  else if (node.attempt >= max) reasons.fail.push(`attempt ${node.attempt} of ${max} failed`)
  else reasons.retry.push(`${error.kind} is ${error.disposition}, the prompt was never sent, and attempt ${node.attempt} of ${max} failed`)
  const retry = reasons.retry.length > 0
  // What failed, in the decision `explain` shows, so the CLI alone tells why.
  const said = errorLine(error.message)
  if (said) (retry ? reasons.retry : reasons.fail).push(`error: ${said}`)
  const kept = attempt.decisions ?? (attempt.execution ? [...attempt.execution.decisions, ...routedDecisions(node, e)] : node.decisions ? (JSON.parse(node.decisions) as ArtifactRef[]) : [])
  const decision = e.ctx.artifacts.recordDecision({
    decisionType: 'recovery',
    question: `How does node ${node.node_id} of run ${run.run_id} recover from ${error.kind}?`,
    inputs: kept,
    candidates: [{ option: 'retry', selected: retry, reasons: reasons.retry }, { option: 'fail', selected: !retry, reasons: reasons.fail }],
    decider: { type: 'rule', id: 'workflow.recovery', version: '1' },
    outcome: { option: retry ? 'retry' : 'fail', detail: { kind: error.kind, disposition: error.disposition, attempt: node.attempt } },
    deterministic: true,
  }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id })
  const decisions = kept.length ? { decisions: JSON.stringify(kept) } : {}
  if (retry) {
    const delay = error.disposition === 'IMMEDIATE' ? 0 : (e.config.retryDelayMs ?? 5000) * 2 ** Math.max(0, node.attempt - 1)
    e.ctx.store.transaction(() => {
      e.writeNode(node, { state: 'READY', execution_id: null, worker: null, attempt: node.attempt, not_before: new Date(Date.now() + delay).toISOString(), error: JSON.stringify(error), ...decisions },
        (r) => {
          // The next attempt gets its own execution; the failed one no longer explains the node.
          const next: NodeRecord = { ...r, lastDecision: decision.id as ArtifactRef }
          delete next.execution
          return next
        }, lease)
      e.ctx.eventLog.append({ type: 'workflow.node.retry', runId: run.run_id, nodeId: node.node_id, decision: decision.id, data: { attempt: node.attempt, kind: error.kind, disposition: error.disposition, delayMs: delay } })
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
  if (onlyState.length) return 'overloaded'
  if (failure.rejections.some((r) => r.failed.every((f) => f.check === 'locality'))) return 'egress_denied'
  return 'config_error'
}
