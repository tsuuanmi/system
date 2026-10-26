/**
 * Exact-subject review (REQ-WF-5, REQ-TEAM-5) and remediation cycles: a review of an agent's
 * change binds to the working tree's subject, passes only while the tree is still that subject,
 * and blocking findings grow a fix and a re-review, bounded by `maxReviewCycles`. A re-review is
 * worded as the review it re-runs (`wordingOf`).
 */
import type { Lease } from '@tsuuanmi/system-leases'
import { captureGitSubject, changeBetween, changeSince, CLEAN_VERSION, type GitSubject, subjectId } from '@tsuuanmi/system-libs'
import type { ArtifactRef } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import { fixCommits } from './fix-sessions.ts'
import { append } from './growth.ts'
import { type Assessment, growthPrefix, parseAssessment, remediationPrompt, type ResolvedNode, type ReviewCycle, subjectBlock } from './spec.ts'
import type { NodeRecord, NodeRow, RunRow } from './types.ts'

export type SubjectGate = { passed: true; decision: ArtifactRef; assessment: Assessment; subject: string } | { passed: false; decision: ArtifactRef; reason: string }

/**
 * What a node's instructions are composed from (docs/design/workflow-engine.md#briefs): a
 * template's prompt, its `{{node:<id>}}` placeholders bound to results, or text used as it is
 * (`literal`: a plan step's model text, a fix's engine-composed prompt), never expanded.
 */
export interface Wording {
  prompt: string
  literal: boolean
  /** The result each `{{node:<id>}}` points at, by the id the prompt names. */
  refs: Record<string, ArtifactRef>
  /** Those results in dependency order: what the input hash binds, and where an exact subject is read. */
  results: ArtifactRef[]
  /** The node whose result an id the prompt names reads instead (a re-review's fix, in place of the step that wrote the change). */
  readFrom: Record<string, string>
  /** The node whose planners `{{grown}}` lists the steps of. */
  grownOf: ResolvedNode
}

/** Whether a step writes the change (it needs `develop`): a template's writing step, and a fix grown from it. */
export const writes = (spec: ResolvedNode | undefined): boolean => !!spec?.capabilities.includes('develop')

/**
 * A node's wording: its own prompt over its dependencies' results. A re-review is worded as the
 * review its cycles started from (`reviewOf`, docs/design/workflow-engine.md#graph-growth): that
 * review's prompt, composed again, so it reads the caller's input and every result that review read,
 * but the step that wrote the change, whose place the fix that wrote the new subject takes; a plan
 * step's review stays model text. This holds for a re-review an earlier engine grew too, whatever its
 * own spec says. A problem when a result it is bound to is missing: nothing is composed on a guess.
 */
export function wordingOf(spec: ResolvedNode, nodes: readonly NodeRow[]): Wording | { problem: string } {
  const specOf = (id: string): ResolvedNode | undefined => {
    const row = nodes.find((n) => n.node_id === id)
    return row ? JSON.parse(row.spec) as ResolvedNode : undefined
  }
  let source = spec
  let bound: { from: string; to: string } | undefined
  if (spec.reviewOf !== undefined) {
    const reviewed = specOf(spec.reviewOf)
    const producer = reviewed?.dependsOn.find((id) => writes(specOf(id)))
    const fix = spec.dependsOn.find((id) => writes(specOf(id)))
    if (!reviewed || !producer || !fix) {
      return { problem: `re-review ${spec.nodeId} cannot be worded as review ${spec.reviewOf}: ${!reviewed ? 'that review is not in the run' : !producer ? 'no step that review depends on wrote the change' : 'no fix precedes it'}` }
    }
    source = reviewed
    bound = { from: producer, to: fix }
  }
  const refs: Record<string, ArtifactRef> = {}
  const results: ArtifactRef[] = []
  for (const id of source.dependsOn) {
    const read = id === bound?.from ? bound.to : id
    const row = nodes.find((n) => n.node_id === read)
    const result = row ? (JSON.parse(row.record) as NodeRecord).outputReceipt?.result : undefined
    if (!result) return { problem: `node ${spec.nodeId} reads the result of ${read}, which has none` }
    refs[id] = result
    results.push(result)
  }
  return { prompt: source.prompt, literal: !!source.literal, refs, results, readFrom: bound ? { [bound.from]: bound.to } : {}, grownOf: source }
}

/**
 * The working tree a dependency's agent worked in, captured as it is now, with its verbatim change;
 * `missing` when an agent worked in a tree that can no longer be captured (its worktree was
 * cleaned up, say): the review is then never run unbound (INV-2, INV-5). A re-review (`cycle`) is
 * shown the change since the subject the last review read as well as the whole change.
 */
export function reviewSubject(e: Engine, results: ArtifactRef[], request: string, cycle?: (workspace: string, subject: GitSubject) => ReviewCycle | undefined): { workspace: string; subject: GitSubject; block: string } | { missing: string } | undefined {
  const workspace = results
    .map((r) => e.ctx.artifacts.get(r)?.body as { schema?: string; workspace?: string; subject?: unknown } | undefined)
    .filter((b) => b?.schema?.startsWith('agent-result@') && b.workspace && b.subject)
    .at(-1)?.workspace
  if (!workspace) return undefined
  const captured = captureGitSubject(workspace)
  if (!captured) return { missing: workspace }
  const id = subjectId(captured.subject)
  return { workspace, subject: captured.subject, block: subjectBlock(id, workspace, captured.subject.ref, captured.diff, request, cycle?.(workspace, captured.subject)) }
}

/**
 * What a re-review reads of its cycle (docs/design/workflow-engine.md#review-cycles): the subject the
 * review that grew it read, the change since then, and the whole change against the commit the first
 * review's tree started from. The change since is the one between the commits of the run's review
 * history that hold the tree that review read and its fix's result (`workflow.fix-commit`), while the
 * tree the re-review reads (`now`) is still that result; else, against the HEAD, when that tree was
 * the HEAD with nothing on top. Undefined for a first review, or when the reviews it builds on were
 * bound to no tree.
 */
export function cycleOf(e: Engine, runId: string, spec: ResolvedNode, nodes: readonly NodeRow[], workspace: string, now: GitSubject): ReviewCycle | undefined {
  if (spec.reviewOf === undefined) return undefined
  const subjectOf = (id: string): GitSubject | undefined => {
    const row = nodes.find((n) => n.node_id === id)
    return row?.subject ? (JSON.parse(row.subject) as { subject: GitSubject }).subject : undefined
  }
  const previous = spec.grownBy?.node ?? spec.reviewOf
  const first = subjectOf(spec.reviewOf)
  const last = subjectOf(previous)
  if (!first || !last) return undefined
  const fix = spec.dependsOn.find((id) => {
    const row = nodes.find((n) => n.node_id === id)
    return row && writes(JSON.parse(row.spec) as ResolvedNode)
  })
  const kept = fix ? fixCommits(e, runId, fix) : undefined
  const recorded = kept && kept.subject === subjectId(now) ? kept : undefined
  const holds = recorded?.reviewed ?? (last.version === CLEAN_VERSION ? last.ref : undefined)
  const whole = changeSince(workspace, first.ref)
  if (!whole) return undefined
  const since = recorded ? changeBetween(workspace, recorded.reviewed, recorded.fixed) : holds ? changeSince(workspace, holds) : undefined
  return {
    cycle: spec.cycle ?? 2, previous: { review: previous, subject: subjectId(last) },
    ...(holds && since ? { since: { commit: holds, diff: since.diff } } : {}), whole: { commit: first.ref, diff: whole.diff },
  }
}

/** The `gate` decision that fails a review whose agent's working tree can no longer be captured. */
export function missingSubject(e: Engine, run: RunRow, node: NodeRow, workspace: string): ArtifactRef {
  return e.ctx.artifacts.recordDecision({
    decisionType: 'gate',
    question: `May review ${node.node_id} of run ${run.run_id} run on the change it is bound to?`,
    inputs: [],
    candidates: [
      { option: 'fail', selected: true, reasons: [`the agent's working tree ${workspace} can no longer be captured, so there is no exact subject to review`] },
      { option: 'pass', selected: false, reasons: ['not pass: a review is never run without the exact subject it binds to (REQ-WF-5)'] },
    ],
    decider: { type: 'rule', id: 'workflow.exact-subject', version: '1' },
    outcome: { option: 'fail', detail: { workspace } },
    deterministic: true,
  }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
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
  // One task, one author session (./fix-sessions.ts): the fix continues the session the change was
  // written in (a fix's, the session its own author's was), never a team member's (Model A).
  const authorSession = producer?.session.sessionId !== undefined && !producer.team?.member ? producer.session.sessionId : undefined
  const author = authorSession !== undefined ? { node: producer!.author?.node ?? producer!.nodeId, sessionId: authorSession } : undefined
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
  const baseRow = nodes.find((n) => n.node_id === base)
  const reviewed = baseRow ? JSON.parse(baseRow.spec) as ResolvedNode : spec
  const baseGeneration = reviewed.generation ?? 1
  const generation = spec.generation ?? 1
  const prefix = `${growthPrefix(base, baseGeneration)}${node.node_id !== base && generation > 1 ? `:r${generation}` : ''}`
  const gateId = `${prefix}:approve:${cycle}`
  const fixId = `${prefix}:fix:${cycle}`
  const recheckId = `${prefix}:review:${cycle + 1}`
  const grownBy = { node: node.node_id, generation }
  // The review's findings as the author session's next message: the findings, the subject the reviewer read, what to change.
  const prompt = remediationPrompt(run.input, subject, blocking, node.node_id, !!author)
  // The fix writes, so it waits for a person's approval of exactly this plan (ADR-0028, INV-15), never
  // for a policy's: the gate puts it to the approval queue as a `remediation` action, which always
  // asks (./queue.ts), or, with no queue loaded, waits for the operator's `approve`.
  const plan = e.ctx.artifacts.put({
    kind: 'plan', bodySchema: 'plan@1.0',
    body: {
      schema: 'plan@1.0', runId: run.run_id, planner: node.node_id, confidence: 'medium',
      nodes: [{ nodeId: fixId, objective: `Fix the blocking findings of review cycle ${cycle}`, prompt, capabilities: producer!.capabilities, tier: producer!.tier, dependsOn: [gateId] }],
    },
    classification: run.classification ?? e.ctx.egress.defaultClassification, producer: { type: 'node', ref: node.node_id }, inputs: [decision], runId: run.run_id, nodeId: node.node_id,
  }).id as ArtifactRef
  const step = { tierSource: 'decision' as const, tierDecision: decision, session: {}, grownBy }
  // The re-review is worded as the review the cycles started from (wordingOf): its template's
  // prompt, composed again at promotion, or a plan step's model text, used as it is.
  append(e, run, node, [
    { ...step, literal: true, nodeId: gateId, objective: `Approve the fix of review cycle ${cycle}`, executor: 'gate' as const, plan, prompt: '', capabilities: ['review'],
      tier: 'economy' as const, tierSource: 'profile' as const, acceptance: 'acceptance.answer', dependsOn: [node.node_id], operatorApproval: true as const, remediation: { subject } },
    // The fix is the same kind of work as the change it fixes, and the re-review as the review (ADR-0057).
    // It continues its author's session, on that session's Worker; the re-review keeps a session of
    // its own (`step`'s), never the author's: the reviewer stays independent.
    { ...step, literal: true, nodeId: fixId, objective: `Fix the blocking findings of review cycle ${cycle}`, prompt,
      capabilities: producer!.capabilities, tier: producer!.tier, ...(producer!.kind !== undefined ? { kind: producer!.kind } : {}), acceptance: 'acceptance.answer', dependsOn: [gateId],
      fixOf: node.node_id, ...(author ? { session: { sessionId: author.sessionId }, author } : {}) },
    { ...step, ...(reviewed.literal ? { literal: true } : {}), nodeId: recheckId, objective: `Review cycle ${cycle + 1}: review the fixed change`, prompt: reviewed.prompt,
      ...(reviewed.resultSchema ? { resultSchema: reviewed.resultSchema } : {}), ...(spec.kind !== undefined ? { kind: spec.kind } : {}),
      capabilities: spec.capabilities, tier: spec.tier, acceptance: spec.acceptance, dependsOn: [fixId], cycle: cycle + 1, reviewOf: base },
  ], [gateId, fixId, recheckId], lease)
  e.ctx.eventLog.append({ type: 'workflow.graph.grown', runId: run.run_id, nodeId: node.node_id, decision, data: { steps: [gateId, fixId, recheckId], plan, cycle: cycle + 1 } })
}
