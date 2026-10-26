/**
 * A step that prefers another provider family (`diversity: 'preferred'`, docs/reference/workflow-templates.md):
 * when no Worker of another family than its `differentFrom` steps' can take it (none admitted: unavailable,
 * over its input bound; or the one that took it failed: stalled after the prompt, failed on the
 * infrastructure), it runs once on their family's provider, in a conversation of its own that never
 * sees theirs, rather than failing or waiting (operator decision D89). It never happens silently: the
 * choice is a `workflow.diversity` decision with outcome `single-family` naming why, every later step
 * built on it is told in its brief, and the run's answer says so first. A step that requires another
 * family (the default) keeps ADR-0027 and ADR-0029 unchanged.
 */
import type { Lease } from '@tsuuanmi/system-leases'
import type { AdmissionFailure, AdmittedWorker, ArtifactRef, WorkerExecution } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import { clampText, type ResolvedNode } from './spec.ts'
import { newId, type NodeRecord, type NodeRow, type RunRow, type WorkflowError } from './types.ts'

/** The decider of a single-family choice, at admission or in recovery. */
export const DIVERSITY = { id: 'workflow.diversity', version: '1' } as const

/** A decision's reason, within the decision schema's bound. */
const reason = (text: string): string => clampText(text.replace(/\s+/g, ' ').trim(), 300)

/** The outcome of a decision, when `workflow.diversity` made it. */
function diversityOutcome(e: Engine, decision: ArtifactRef | undefined): { option: string; detail?: { why?: string; differsFrom?: string[] } } | undefined {
  if (!decision) return undefined
  const body = e.ctx.artifacts.get(decision)?.body as { decider?: { id?: string }; outcome?: { option: string; detail?: { why?: string; differsFrom?: string[] } } } | undefined
  return body?.decider?.id === DIVERSITY.id ? body.outcome : undefined
}

/** Whether a decision is a single-family admission: the step ran on the family it should differ from. */
export function isSingleFamily(e: Engine, decision: ArtifactRef | undefined): boolean {
  return diversityOutcome(e, decision)?.option === 'single-family'
}

/** The single-family admission among a node's routed decisions, when its current attempt ran on one family. */
export function singleFamilyOf(e: Engine, node: NodeRow): { node: string; differsFrom: string[]; why: string } | undefined {
  for (const id of node.decisions ? (JSON.parse(node.decisions) as ArtifactRef[]) : []) {
    const outcome = diversityOutcome(e, id)
    if (outcome?.option === 'single-family') return { node: node.node_id, differsFrom: outcome.detail?.differsFrom ?? [], why: outcome.detail?.why ?? '' }
  }
  return undefined
}

/** The step's fallback, when it already took it: its recovery (after the other family failed) or its admission. Once per step. */
function fellBack(e: Engine, runId: string, nodeId: string, decisionType: 'recovery' | 'admission'): ArtifactRef | undefined {
  const found = e.ctx.artifacts.list({ kind: 'decision', decisionType, runId, nodeId, outcome: 'single-family', limit: 4 })
    .find((a) => (a.body as { decider?: { id?: string } } | undefined)?.decider?.id === DIVERSITY.id)
  return found?.id as ArtifactRef | undefined
}

/**
 * Whether the step's one fallback was already admitted (once per step): any single-family admission
 * of it, at any escalation. Then the family rule is never lifted again: a fallback whose result was
 * rejected escalates only onto another family, if one is admitted, or the step fails.
 */
export function fallbackSpent(e: Engine, runId: string, node: NodeRow): boolean {
  return fellBack(e, runId, node.node_id, 'admission') !== undefined
}

/** The recovery that sent the step to one family after the other family's Worker failed it, if one did. */
export function singleFamilyRecovery(e: Engine, runId: string, nodeId: string): ArtifactRef | undefined {
  return fellBack(e, runId, nodeId, 'recovery')
}

/**
 * Record that a step that prefers another family runs on the family of the steps it differs from:
 * no Worker of another family was admitted (`refused`), after the other family's Worker failed it
 * (`recovery`) or not. Its outcome names the Worker, the steps, and why.
 */
export function singleFamilyDecision(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, refused: AdmissionFailure, admitted: AdmittedWorker, recovery?: ArtifactRef): ArtifactRef {
  const others = spec.differentFrom ?? []
  const worker = admitted.worker.worker
  const before = recovery ? (e.ctx.artifacts.get(recovery)?.body as { outcome?: { detail?: { why?: string } } } | undefined)?.outcome?.detail?.why : undefined
  const why = reason(before ? `${before}; no Worker of another family is admitted now` : `no Worker of another provider family than ${others.join(', ')}'s is admitted: ${refused.message}`)
  return e.ctx.artifacts.recordDecision({
    decisionType: 'admission',
    question: `Does node ${node.node_id} of run ${run.run_id} run on the provider family of ${others.join(', ')}, for want of another?`,
    inputs: [...new Set([refused.decision, ...(recovery ? [recovery] : []), admitted.decisions.route])],
    candidates: [
      { option: 'single-family', selected: true, reasons: [
        why,
        'the template prefers another family and allows one fallback (diversity: preferred): the run neither fails nor waits for it',
        reason(`single family: it runs on ${worker} in a conversation of its own, which never sees ${others.join(', ')}'s; their results may share one blind spot`),
      ] },
      { option: 'wait', selected: false, reasons: ['not wait: the template prefers another family, it does not require one, so the step does not wait for it'] },
      { option: 'fail', selected: false, reasons: [reason(`not fail: ${worker} is admitted once the family rule is lifted`)] },
    ],
    decider: { type: 'policy', ...DIVERSITY },
    // The escalation it serves, for the record; no later admission lifts the family rule again, at any escalation (fallbackSpent).
    outcome: { option: 'single-family', detail: { worker, sameProviderFamily: true, differsFrom: others, why, escalations: node.escalations } },
    deterministic: true,
  }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
}

/**
 * After a failed execution, a step that prefers another family and ran on one (no single-family
 * choice of it yet) runs once more, on the family of the steps it differs from, at once, rather than
 * being retried, resent, or waited on there: the other family's Worker stalled after the prompt,
 * failed on the infrastructure, or answered with its own error. A `recovery` decision `single-family`
 * says why; the failed Worker and every Worker of its account are left out of the next attempt and
 * never taken back, so the prompt is never sent to it again; a conversation of its own starts afresh.
 * Returns whether it did; false leaves the failure to the usual recovery.
 */
export function recoverSingleFamily(e: Engine, run: RunRow, node: NodeRow, error: WorkflowError, attempt: { sent: boolean; execution?: WorkerExecution }, kept: ArtifactRef[], lease: () => Lease): boolean {
  const spec = JSON.parse(node.spec) as ResolvedNode
  if (spec.diversity !== 'preferred' || !spec.differentFrom?.length || spec.secondReview || !node.worker) return false
  if (singleFamilyOf(e, node) || fellBack(e, run.run_id, node.node_id, 'recovery') || fellBack(e, run.run_id, node.node_id, 'admission')) return false
  const worker = node.worker
  const how = attempt.sent ? 'after the prompt was sent' : 'before anything was sent'
  const why = reason(`${error.kind} on ${worker} ${how} (${error.message})`)
  const excluded = [...new Set([...(node.excluded ? (JSON.parse(node.excluded) as string[]) : []), ...e.ctx.workers.siblings(worker)])].sort()
  // A conversation of its own that the failed Worker held starts afresh: a new session, never theirs.
  const session = spec.session.sessionId && e.ctx.workers.affinity(spec.session.sessionId)?.length ? { spec: JSON.stringify({ ...spec, session: { ...spec.session, sessionId: newId('ses') } }) } : {}
  e.ctx.store.transaction(() => {
    const decision = e.ctx.artifacts.recordDecision({
      decisionType: 'recovery',
      question: `How does node ${node.node_id} of run ${run.run_id} recover from ${error.kind}?`,
      inputs: kept,
      candidates: [
        { option: 'single-family', selected: true, reasons: [
          why,
          'the template prefers another family and allows one fallback (diversity: preferred): the step runs once more on the family of the steps it differs from, in a fresh conversation',
          reason(`${worker} and the Workers of its account are left out: the prompt is never sent to them again`),
        ] },
        { option: 'retry', selected: false, reasons: [reason(attempt.sent ? 'not retry: the prompt was sent; it is never sent to the same Worker again' : `not retry: the step prefers another family, so ${worker} is not retried or waited on after ${error.kind}`)] },
        { option: 'fail', selected: false, reasons: ['not fail: a step that prefers another family does not fail the run for want of it'] },
      ],
      decider: { type: 'rule', ...DIVERSITY },
      outcome: { option: 'single-family', detail: { kind: error.kind, disposition: error.disposition, attempt: node.attempt, from: worker, sent: attempt.sent, why } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id })
    e.writeNode(node, { state: 'READY', execution_id: null, worker: null, attempt: node.attempt, not_before: null, error: JSON.stringify(error), excluded: JSON.stringify(excluded), ...session, ...(kept.length ? { decisions: JSON.stringify(kept) } : {}) },
      (r) => {
        const next: NodeRecord = { ...r, lastDecision: decision.id as ArtifactRef }
        delete next.execution
        return next
      }, lease)
    e.ctx.eventLog.append({ type: 'workflow.node.retry', runId: run.run_id, nodeId: node.node_id, decision: decision.id, data: { attempt: node.attempt, kind: error.kind, disposition: error.disposition, delayMs: 0, failoverFrom: worker, singleFamily: true } })
  })
  return true
}

/** The single-family steps a node builds on, directly or through others, in the run's order. */
function upstream(e: Engine, spec: ResolvedNode, nodes: readonly NodeRow[]): Array<{ node: string; differsFrom: string[]; why: string }> {
  const byId = new Map(nodes.map((n) => [n.node_id, n]))
  const seen = new Set<string>()
  const visit = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    const row = byId.get(id)
    for (const dep of row ? (JSON.parse(row.spec) as ResolvedNode).dependsOn : []) visit(dep)
  }
  for (const dep of spec.dependsOn) visit(dep)
  return nodes.filter((n) => seen.has(n.node_id) && !verifies(n)).map((n) => singleFamilyOf(e, n)).filter((s): s is NonNullable<typeof s> => !!s)
}

/**
 * Whether a step is a review's verification (ADR-0075): its fallback to the review's family, a fresh
 * session, is the verification's own record (its `workflow.diversity` decision and its votes), not a
 * result later steps build on as evidence, so it is left out of their briefs and the run's answer.
 */
const verifies = (n: NodeRow): boolean => !!(JSON.parse(n.spec) as ResolvedNode).verifies

/**
 * What a step is told when a step it builds on ran on a single family: which, beside which, and that
 * their results may share one blind spot. Undefined when none did, so a two-family run's briefs are
 * unchanged.
 */
export function singleFamilyBrief(e: Engine, spec: ResolvedNode, nodes: readonly NodeRow[]): string | undefined {
  const found = upstream(e, spec, nodes)
  if (!found.length) return undefined
  return [
    'Single family: the steps below ran on one provider family, not two, because no Worker of another family could take them.',
    ...found.map((s) => `- ${s.node} ran on the provider family of ${s.differsFrom.join(', ')}, in a conversation of its own (${s.why}).`),
    'Their results are not independent across providers and may share one blind spot: weigh their agreement as weaker evidence, and say so.',
  ].join('\n')
}

/** The run's answer's first lines when a step of it ran on a single family; empty otherwise. */
export function singleFamilyHeader(e: Engine, rows: readonly NodeRow[]): string {
  const found = rows.filter((n) => !verifies(n)).map((n) => singleFamilyOf(e, n)).filter((s): s is NonNullable<typeof s> => !!s)
  if (!found.length) return ''
  const steps = found.map((s) => `${s.node} on the family of ${s.differsFrom.join(', ')}`).join('; ')
  return `Single family: ${steps}, each in a conversation of its own, because no Worker of another provider family could take ${found.length > 1 ? 'them' : 'it'}; no other provider checked ${found.length > 1 ? 'them' : 'it'}.\n\n`
}
