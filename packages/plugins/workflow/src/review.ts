/**
 * Exact-subject review (REQ-WF-5, REQ-TEAM-5) and remediation cycles: a review of an agent's
 * change binds to the working tree's subject, passes only while the tree is still that subject,
 * and blocking findings grow a fix and a re-review, bounded by `maxReviewCycles`.
 */
import type { Lease } from '@tsuuanmi/system-leases'
import { captureGitSubject, type GitSubject, subjectId } from '@tsuuanmi/system-libs'
import type { ArtifactRef } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import { append } from './growth.ts'
import { type Assessment, growthPrefix, parseAssessment, remediationPrompt, type ResolvedNode, subjectBlock } from './spec.ts'
import type { NodeRow, RunRow } from './types.ts'

export type SubjectGate = { passed: true; decision: ArtifactRef; assessment: Assessment; subject: string } | { passed: false; decision: ArtifactRef; reason: string }

/** The working tree a dependency's agent worked in, captured as it is now, with its verbatim change. */
export function reviewSubject(e: Engine, results: ArtifactRef[], request: string): { workspace: string; subject: GitSubject; block: string } | undefined {
  const workspace = results
    .map((r) => e.ctx.artifacts.get(r)?.body as { schema?: string; workspace?: string; subject?: unknown } | undefined)
    .filter((b) => b?.schema?.startsWith('agent-result@') && b.workspace && b.subject)
    .at(-1)?.workspace
  if (!workspace) return undefined
  const captured = captureGitSubject(workspace)
  if (!captured) return undefined
  const id = subjectId(captured.subject)
  return { workspace, subject: captured.subject, block: subjectBlock(id, workspace, captured.subject.ref, captured.diff, request) }
}

/**
 * The exact-subject gate of a bound review: its assessment names the subject it was given, and
 * the working tree is still that subject now. A pass stores the `assessment` artifact, bound to
 * the subject; either way the outcome is a `gate` decision.
 */
export function subjectGate(e: Engine, run: RunRow, node: NodeRow, result: ArtifactRef): SubjectGate {
  const bound = JSON.parse(node.subject!) as { workspace: string; subject: GitSubject }
  const expected = subjectId(bound.subject)
  const parsed = parseAssessment(e.resultText(result))
  const now = captureGitSubject(bound.workspace)
  const reason = !parsed.ok ? parsed.reason
    : parsed.assessment.subject !== expected ? `the review names ${parsed.assessment.subject}, not the subject it was given (${expected})`
      : !now ? `${bound.workspace} is no longer a git working tree`
        : subjectId(now.subject) !== expected ? `the working tree changed during the review (now ${subjectId(now.subject)})` : undefined
  const assessment = parsed.ok && !reason
    ? e.ctx.artifacts.put({
      kind: 'assessment', bodySchema: 'assessment@1.0', subject: bound.subject, inputs: [result],
      body: { schema: 'assessment@1.0', subject: bound.subject, verdict: parsed.assessment.verdict, findings: parsed.assessment.findings, ...(node.worker ? { reviewer: node.worker } : {}) },
      classification: run.classification ?? e.ctx.egress.defaultClassification, producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id,
    }).id as ArtifactRef
    : undefined
  const decision = e.ctx.artifacts.recordDecision({
    decisionType: 'gate',
    question: `Does the review at node ${node.node_id} of run ${run.run_id} bind to the current subject ${expected}?`,
    inputs: [result, ...(assessment ? [assessment] : [])],
    candidates: [
      { option: 'pass', selected: !reason, reasons: reason ? [`not pass: ${reason}`] : [`the assessment names ${expected}, and the working tree is still it (${parsed.ok ? parsed.assessment.verdict : ''})`] },
      { option: 'fail', selected: !!reason, reasons: reason ? [reason] : [`not fail: the review parses, names ${expected}, and the working tree has not changed since`] },
    ],
    decider: { type: 'policy', id: 'workflow.exact-subject', version: '1' },
    outcome: { option: reason ? 'fail' : 'pass', detail: { subject: expected, ...(assessment ? { assessment } : {}) } },
    deterministic: true,
  }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
  return reason || !parsed.ok ? { passed: false, decision, reason: reason ?? '' } : { passed: true, decision, assessment: parsed.assessment, subject: expected }
}

/**
 * A review that requested changes with blocking findings grows a remediation cycle (an engine
 * rule for any node offering `review`, docs/design/workflow-engine.md): a fix on the producer's capabilities, then a
 * re-review bound to the new subject; whatever waited for the review waits for both. Bounded
 * by `maxReviewCycles`; either way a `graph-growth` decision records why.
 */
export function remediate(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, assessment: Assessment, subject: string, lease: () => Lease): void {
  const blocking = assessment.findings.filter((f) => f.severity === 'blocking')
  if (assessment.verdict !== 'changes-requested' || !blocking.length) return
  const nodes = e.nodeRows(run.run_id)
  const producer = spec.dependsOn.map((id) => JSON.parse(nodes.find((n) => n.node_id === id)!.spec) as ResolvedNode).find((s) => s.capabilities.includes('develop'))
  const cycle = spec.cycle ?? 1
  const max = e.config.maxReviewCycles ?? 3
  const why = !producer ? 'no writing step produced the reviewed change'
    : cycle >= max ? `review cycle bound reached (${max})` : undefined
  const decision = e.ctx.artifacts.recordDecision({
    decisionType: 'graph-growth',
    question: `Does run ${run.run_id} remediate the blocking findings of review ${node.node_id}?`,
    inputs: [],
    candidates: [
      { option: 'append', selected: !why, reasons: why ? [`not append: ${why}`] : [`${blocking.length} blocking finding(s) on ${subject}; review cycle ${cycle + 1} of ${max}`] },
      { option: 'refuse', selected: !!why, reasons: why ? [why] : [`not refuse: a writing step produced the change, and review cycle ${cycle} is below the bound ${max}`] },
    ],
    decider: { type: 'policy', id: 'workflow.remediation', version: '1' },
    outcome: { option: why ? 'refuse' : 'append' },
    deterministic: true,
  }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
  if (why) return
  const base = spec.reviewOf ?? node.node_id
  // This cycle is grown by the review that found the blocking findings, never by the first review:
  // superseding an earlier fix then retires this cycle with the review it reran, and nothing it
  // grew stays live to collide with the next growth. After a re-plan, ids carry the new generation
  // (the base's for its own cycles, the reviewer's suffix for a later one).
  const baseGeneration = (JSON.parse(nodes.find((n) => n.node_id === base)?.spec ?? '{}') as ResolvedNode).generation ?? 1
  const generation = spec.generation ?? 1
  const prefix = `${growthPrefix(base, baseGeneration)}${node.node_id !== base && generation > 1 ? `:r${generation}` : ''}`
  const gateId = `${prefix}:approve:${cycle}`
  const fixId = `${prefix}:fix:${cycle}`
  const recheckId = `${prefix}:review:${cycle + 1}`
  const grownBy = { node: node.node_id, generation }
  const prompt = remediationPrompt(run.input, subject, blocking)
  // The fix writes, so it waits for the operator's approval of exactly this plan (ADR-0028, INV-15):
  // never approved by policy, until the approval queue (B5) decides by the autonomy policy.
  const plan = e.ctx.artifacts.put({
    kind: 'plan', bodySchema: 'plan@1.0',
    body: {
      schema: 'plan@1.0', runId: run.run_id, planner: node.node_id, confidence: 'medium',
      nodes: [{ nodeId: fixId, objective: `Fix the blocking findings of review cycle ${cycle}`, prompt, capabilities: producer!.capabilities, tier: producer!.tier, dependsOn: [gateId] }],
    },
    classification: run.classification ?? e.ctx.egress.defaultClassification, producer: { type: 'node', ref: node.node_id }, inputs: [decision], runId: run.run_id, nodeId: node.node_id,
  }).id as ArtifactRef
  const step = { literal: true, tierSource: 'decision' as const, tierDecision: decision, session: {}, grownBy }
  append(e, run, node, [
    { ...step, nodeId: gateId, objective: `Approve the fix of review cycle ${cycle}`, executor: 'gate' as const, plan, prompt: '', capabilities: ['review'],
      tier: 'economy' as const, tierSource: 'profile' as const, acceptance: 'acceptance.answer', dependsOn: [node.node_id], operatorApproval: true as const },
    { ...step, nodeId: fixId, objective: `Fix the blocking findings of review cycle ${cycle}`, prompt,
      capabilities: producer!.capabilities, tier: producer!.tier, acceptance: 'acceptance.answer', dependsOn: [gateId] },
    { ...step, nodeId: recheckId, objective: `Review cycle ${cycle + 1}: review the fixed change`, prompt: spec.prompt,
      capabilities: spec.capabilities, tier: spec.tier, acceptance: spec.acceptance, dependsOn: [fixId], cycle: cycle + 1, reviewOf: base },
  ], [gateId, fixId, recheckId], lease)
  e.ctx.eventLog.append({ type: 'workflow.graph.grown', runId: run.run_id, nodeId: node.node_id, decision, data: { steps: [gateId, fixId, recheckId], plan, cycle: cycle + 1 } })
}
