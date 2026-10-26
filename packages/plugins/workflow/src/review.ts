/**
 * Exact-subject review (REQ-WF-5, REQ-TEAM-5) and remediation cycles: a review of an agent's
 * change binds to the working tree's subject, passes only while the tree is still that subject,
 * and blocking findings grow a fix and a re-review, bounded by `maxReviewCycles`. A re-review is
 * worded as the review it re-runs (`wordingOf`).
 *
 * Severity and verification (ADR-0075): a finding is `important`, `nit`, or `pre-existing`, with its
 * evidence. A review with important findings grows a verification step, a second reviewer that votes
 * on each against the code; only a confirmed important finding blocks and grows a fix. Nits never
 * start a fix round (they reach the author once, as optional notes of a fix that runs anyway, else in
 * the dossier); a pre-existing finding proposes a follow-up board task, linked and never blocking.
 */
import type { Lease } from '@tsuuanmi/system-leases'
import { captureGitSubject, changeBetween, changeSince, CLEAN_VERSION, type GitSubject, subjectId } from '@tsuuanmi/system-libs'
import type { ArtifactRef } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import { fixCommits } from './fix-sessions.ts'
import { append } from './growth.ts'
import {
  type Assessment, blocks, clampText, type Finding, findingKey, growthPrefix, parseAssessment, parseVotes, pendingImportant, type PriorFinding, remediationPrompt,
  type ResolvedNode, type ReviewCycle, subjectBlock, summaryOf, verificationBlock,
} from './spec.ts'
import type { NodeRecord, NodeRow, RunRow } from './types.ts'

export type SubjectGate = { passed: true; decision: ArtifactRef; assessment: Assessment; ref: ArtifactRef; subject: string } | { passed: false; decision: ArtifactRef; reason: string }

/** The rule of a verification step's votes, and of a pre-existing finding's follow-up task. */
export const VERIFICATION_RULE = 'workflow.verification'
export const FOLLOW_UP_RULE = 'workflow.follow-up'

const PRODUCER = { producer: { type: 'system' as const, ref: 'workflow' } }

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
 * shown the change since the subject the last review read, with the open and answered findings.
 * When the run that wrote the change reported tests its own test runs did not run (`agent-result@1.5`
 * `notRun`, its browser tests, T265), the review is told so: its author's word that the tests pass
 * says nothing of those; and when what they reported is not known (`reportUnread`), it is told that.
 */
export function reviewSubject(e: Engine, results: ArtifactRef[], request: string, cycle?: (workspace: string, subject: GitSubject) => ReviewCycle | undefined): { workspace: string; subject: GitSubject; block: string } | { missing: string } | undefined {
  const producer = results
    .map((r) => e.ctx.artifacts.get(r)?.body as { schema?: string; workspace?: string; subject?: unknown; notRun?: unknown; reportUnread?: unknown } | undefined)
    .filter((b) => b?.schema?.startsWith('agent-result@') && b.workspace && b.subject)
    .at(-1)
  const workspace = producer?.workspace
  if (!workspace) return undefined
  const captured = captureGitSubject(workspace)
  if (!captured) return { missing: workspace }
  const id = subjectId(captured.subject)
  const block = subjectBlock(id, workspace, captured.subject.ref, captured.diff, request, cycle?.(workspace, captured.subject))
  const notes = [
    ...(typeof producer.notRun === 'string' ? [notRunNote(producer.notRun)] : []),
    ...(typeof producer.reportUnread === 'string' ? [reportUnreadNote(producer.reportUnread)] : []),
  ]
  return { workspace, subject: captured.subject, block: [...notes, block].join('\n') }
}

/** What a review is told of tests the run that wrote its change did not run (T265). */
export const notRunNote = (notRun: string): string =>
  `Note: the run that wrote this change ran its tests without running ${notRun.slice(0, 300)}; whatever it says of its tests says nothing of those. Judge what they cover from the change itself, and say so in a finding when it matters.`

/** What a review is told when what the run that wrote its change reported of its tests is not known (T265). */
export const reportUnreadNote = (why: string): string =>
  `Note: what the run that wrote this change reported of its own test runs is not known (${why.slice(0, 300)}): whether its browser tests ran is not known, so whatever it says of its tests may not cover them. Judge what they cover from the change itself, and say so in a finding when it matters.`

/**
 * A verification step's subject: the exact tree the review it verifies was bound to, captured again
 * now, with the findings to vote on. `missing` when that tree can no longer be captured or is no
 * longer the subject the review read: the findings are then never verified against another tree.
 */
export function verificationSubject(e: Engine, spec: ResolvedNode, nodes: readonly NodeRow[], request: string): { workspace: string; subject: GitSubject; block: string } | { missing: string } {
  const review = nodes.find((n) => n.node_id === spec.verifies!.review)
  const bound = review?.subject ? JSON.parse(review.subject) as { workspace: string; subject: GitSubject } : undefined
  if (!bound) return { missing: `review ${spec.verifies!.review} is bound to no tree` }
  const captured = captureGitSubject(bound.workspace)
  if (!captured || subjectId(captured.subject) !== subjectId(bound.subject)) return { missing: bound.workspace }
  const body = e.ctx.artifacts.get(spec.verifies!.assessment)?.body as { findings?: Finding[] } | undefined
  const findings = (body?.findings ?? []).filter(pendingImportant)
  const id = subjectId(captured.subject)
  return { workspace: bound.workspace, subject: captured.subject, block: verificationBlock(id, bound.workspace, captured.subject.ref, captured.diff, request, spec.verifies!.review, findings) }
}

/** A step's latest assessment: the one its latest passed exact-subject gate names (a review's verification writes one too). */
export function latestAssessment(e: Engine, node: Pick<NodeRow, 'decisions'>): { ref: ArtifactRef; body: { verdict?: string; findings?: Finding[]; subject?: GitSubject; summary?: string; approach?: Assessment['approach'] } } | undefined {
  let found: ReturnType<typeof latestAssessment>
  for (const ref of node.decisions ? JSON.parse(node.decisions) as ArtifactRef[] : []) {
    const body = e.ctx.artifacts.get(ref)?.body as { decisionType?: string; decider?: { id?: string }; outcome?: { option?: string; detail?: { assessment?: ArtifactRef } } } | undefined
    if (body?.decisionType !== 'gate' || body.decider?.id !== 'workflow.exact-subject' || body.outcome?.option !== 'pass' || !body.outcome.detail?.assessment) continue
    const assessment = e.ctx.artifacts.get(body.outcome.detail.assessment)?.body as NonNullable<typeof found>['body'] | undefined
    if (assessment) found = { ref: body.outcome.detail.assessment, body: assessment }
  }
  return found
}

/**
 * The findings of the earlier reviews of a re-review's change (its cycles' reviews, completed), each
 * by its review's latest assessment: `open` when the last review's verifier confirmed it (it was sent
 * to the fix this re-review follows), else `answered` (rejected, unverified, a nit, pre-existing, or
 * fixed and re-reviewed already). A repeated finding is left out: the one it repeats is there.
 */
export function priorFindings(e: Engine, spec: ResolvedNode, nodes: readonly NodeRow[]): PriorFinding[] {
  if (spec.reviewOf === undefined) return []
  const base = spec.reviewOf
  const last = spec.grownBy?.node ?? base
  const prior: PriorFinding[] = []
  for (const row of nodes) {
    if (row.node_id === spec.nodeId || row.state !== 'COMPLETED') continue
    const rspec = JSON.parse(row.spec) as ResolvedNode
    if (row.node_id !== base && (rspec.reviewOf !== base || rspec.secondReview)) continue
    for (const finding of latestAssessment(e, row)?.body.findings ?? []) {
      if (finding.repeated) continue
      prior.push({ review: row.node_id, finding, state: row.node_id === last && blocks(finding) ? 'open' : 'answered' })
    }
  }
  // A finding still open (confirmed last round, sent to the fix) is raised again if the fix did not
  // hold: it is no answered one, even when an earlier round answered the same finding.
  const open = new Set(prior.filter((p) => p.state === 'open').map((p) => findingKey(p.finding)))
  return prior.filter((p) => p.state === 'open' || !open.has(findingKey(p.finding)))
}

/**
 * What a re-review reads of its cycle (docs/design/workflow-engine.md#review-cycles): the subject the
 * review that grew it read, the change since then, and the findings still open and already answered;
 * the whole change against the commit the first review's tree started from only stands in for the
 * change since when that cannot be shown apart. The change since is the one between the commits of
 * the run's review history that hold the tree that review read and its fix's result
 * (`workflow.fix-commit`), while the tree the re-review reads (`now`) is still that result; else,
 * against the HEAD, when that tree was the HEAD with nothing on top. Undefined for a first review, or
 * when the reviews it builds on were bound to no tree.
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
  const prior = priorFindings(e, spec, nodes)
  return {
    cycle: spec.cycle ?? 2, previous: { review: previous, subject: subjectId(last) },
    ...(holds && since ? { since: { commit: holds, diff: since.diff } } : {}), whole: { commit: first.ref, diff: whole.diff },
    ...(prior.length ? { prior } : {}),
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
  }, { ...PRODUCER, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
}

/** Store an `assessment@1.1`: the findings as the engine reads them, the verdict, and the summary that opens with the count. */
function putAssessment(e: Engine, run: RunRow, node: NodeRow, subject: GitSubject, assessment: Assessment, inputs: ArtifactRef[], reviewer: string | null): ArtifactRef {
  return e.ctx.artifacts.put({
    kind: 'assessment', bodySchema: 'assessment@1.1', subject, inputs,
    body: {
      schema: 'assessment@1.1', subject, verdict: assessment.verdict, findings: assessment.findings, summary: summaryOf(assessment),
      ...(assessment.said ? { said: assessment.said } : {}), ...(assessment.approach ? { approach: assessment.approach } : {}), ...(reviewer ? { reviewer } : {}),
    },
    classification: run.classification ?? e.ctx.egress.defaultClassification, ...PRODUCER, runId: run.run_id, nodeId: node.node_id,
  }).id as ArtifactRef
}

/** The exact-subject `gate` decision on a review step: whether its assessment binds to the current subject. */
function recordGate(e: Engine, run: RunRow, node: NodeRow, expected: string, inputs: ArtifactRef[], reason: string | undefined, assessment: ArtifactRef | undefined, verdict: string): ArtifactRef {
  return e.ctx.artifacts.recordDecision({
    decisionType: 'gate',
    question: `Does the review at node ${node.node_id} of run ${run.run_id} bind to the current subject ${expected}?`,
    inputs: [...inputs, ...(assessment ? [assessment] : [])],
    candidates: [
      { option: 'pass', selected: !reason, reasons: reason ? [`not pass: ${reason}`] : [`the assessment names ${expected}, and the working tree is still it (${verdict})`] },
      { option: 'fail', selected: !!reason, reasons: reason ? [reason] : [`not fail: the review parses, names ${expected}, and the working tree has not changed since`] },
    ],
    decider: { type: 'policy', id: 'workflow.exact-subject', version: '1' },
    outcome: { option: reason ? 'fail' : 'pass', detail: { subject: expected, ...(assessment ? { assessment } : {}) } },
    deterministic: true,
  }, { ...PRODUCER, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
}

/**
 * The exact-subject gate of a bound review: its assessment names the subject it was given, and
 * the working tree is still that subject now. A pass stores the `assessment` artifact, bound to
 * the subject, its findings read by severity (a re-review's repeats of answered findings marked);
 * either way the outcome is a `gate` decision.
 */
export function subjectGate(e: Engine, run: RunRow, node: NodeRow, result: ArtifactRef): SubjectGate {
  const bound = JSON.parse(node.subject!) as { workspace: string; subject: GitSubject }
  const expected = subjectId(bound.subject)
  const spec = JSON.parse(node.spec) as ResolvedNode
  const answered = priorFindings(e, spec, e.nodeRows(run.run_id)).filter((p) => p.state === 'answered')
  const parsed = parseAssessment(e.resultText(result), answered)
  const now = captureGitSubject(bound.workspace)
  const reason = !parsed.ok ? parsed.reason
    : parsed.assessment.subject !== expected ? `the review names ${parsed.assessment.subject}, not the subject it was given (${expected})`
      : !now ? `${bound.workspace} is no longer a git working tree`
        : subjectId(now.subject) !== expected ? `the working tree changed during the review (now ${subjectId(now.subject)})` : undefined
  const assessment = parsed.ok && !reason ? putAssessment(e, run, node, bound.subject, parsed.assessment, [result], node.worker) : undefined
  const decision = recordGate(e, run, node, expected, [result], reason, assessment, parsed.ok ? parsed.assessment.verdict : '')
  return reason || !parsed.ok ? { passed: false, decision, reason: reason ?? '' } : { passed: true, decision, assessment: parsed.assessment, ref: assessment!, subject: expected }
}

/**
 * A verification step's gate (ADR-0075): the tree is still the one the review read, and the votes
 * are read for each important finding it was given (one it did not vote on stays unverified). A
 * `workflow.verification` decision on the step records every vote and its reason; the review's
 * assessment is stored again with the votes and its verdict read anew (changes-requested only for a
 * confirmed important finding), and a new exact-subject gate on the review names it: the review's
 * latest assessment is what every reader takes (risk tier, acceptance, auto-accept). The tree having
 * moved fails the step as a stale subject, as it fails a review.
 */
export function verificationGate(e: Engine, run: RunRow, node: NodeRow, result: ArtifactRef, lease: () => Lease): SubjectGate & { review?: NodeRow } {
  const spec = JSON.parse(node.spec) as ResolvedNode
  const bound = JSON.parse(node.subject!) as { workspace: string; subject: GitSubject }
  const expected = subjectId(bound.subject)
  const reviewRow = e.nodeRow(run.run_id, spec.verifies!.review)
  const reviewed = e.ctx.artifacts.get(spec.verifies!.assessment)?.body as (Assessment & { schema?: string }) | undefined
  const now = captureGitSubject(bound.workspace)
  const reason = !reviewRow || !reviewed ? `the review ${spec.verifies!.review} or its assessment ${spec.verifies!.assessment} is not stored`
    : !now ? `${bound.workspace} is no longer a git working tree`
      : subjectId(now.subject) !== expected ? `the working tree changed during the verification (now ${subjectId(now.subject)})` : undefined
  if (reason) {
    const decision = recordGate(e, run, node, expected, [result], reason, undefined, '')
    return { passed: false, decision, reason }
  }
  const ids = reviewed!.findings.filter(pendingImportant).map((f) => f.id!)
  const { votes, problem } = parseVotes(e.resultText(result), expected, ids)
  const findings = reviewed!.findings.map((f): Finding => (votes[f.id ?? ''] ? { ...f, verification: { ...votes[f.id!]!, node: node.node_id, ...(node.worker ? { worker: node.worker } : {}) } } : f))
  const verdict = findings.some(blocks) ? 'changes-requested' : 'approve'
  const assessment: Assessment = { subject: expected, verdict, findings, ...(reviewed!.said ? { said: reviewed!.said } : {}), ...(reviewed!.approach ? { approach: reviewed!.approach } : {}) }
  const confirmed = ids.filter((id) => votes[id]!.vote === 'confirm')
  const rejected = ids.filter((id) => votes[id]!.vote === 'reject')
  const unvoted = ids.filter((id) => votes[id]!.vote === 'none')
  const ref = putAssessment(e, run, node, bound.subject, assessment, [spec.verifies!.assessment as ArtifactRef, result], reviewRow!.worker)
  const said = (list: string[]): string => list.map((id) => `${id} (${votes[id]!.reason || 'no reason given'})`).join('; ')
  const passReasons = [
    ...(confirmed.length ? [`not pass: ${confirmed.length} important finding(s) confirmed`] : []),
    ...(rejected.length ? [clampText(`rejected, recorded and never sent as work: ${said(rejected)}`, 300)] : []),
    ...(unvoted.length ? [clampText(`unverified, so not blocking: ${unvoted.join(', ')}${problem ? ` (${problem})` : ''}`, 300)] : []),
  ]
  const decision = e.ctx.artifacts.recordDecision({
    decisionType: 'gate',
    question: `Which important findings of review ${spec.verifies!.review} of run ${run.run_id} does the second reviewer confirm on ${expected}?`,
    inputs: [spec.verifies!.assessment as ArtifactRef, result, ref],
    candidates: [
      { option: 'block', selected: confirmed.length > 0, reasons: confirmed.length ? [clampText(`confirmed: ${said(confirmed)}`, 300)] : ['not block: no important finding was confirmed'] },
      { option: 'pass', selected: !confirmed.length, reasons: passReasons.length ? passReasons : ['no important finding to verify'] },
    ],
    decider: { type: 'rule', id: VERIFICATION_RULE, version: '1' },
    outcome: { option: confirmed.length ? 'block' : 'pass', detail: { review: spec.verifies!.review, subject: expected, assessment: ref, confirmed, rejected, unverified: unvoted } },
    deterministic: true,
  }, { ...PRODUCER, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
  // The review's latest exact-subject gate names the assessment with the votes: what its readers take.
  const gate = recordGate(e, run, reviewRow!, expected, [decision], undefined, ref, verdict)
  // With no confirmed finding, no fix carries the nits: the author gets them here, once.
  if (!confirmed.length) noteNits(e, run, reviewRow!, assessment, ref)
  e.writeNode(reviewRow!, { decisions: JSON.stringify([...(reviewRow!.decisions ? JSON.parse(reviewRow!.decisions) as string[] : []), gate]) }, (r) => r, lease)
  return { passed: true, decision, assessment, ref, subject: expected, review: e.nodeRow(run.run_id, reviewRow!.node_id)! }
}

/**
 * A review's assessment, settled (ADR-0075): its pre-existing findings each propose a follow-up task
 * (after the transaction, never blocking); its important findings, when any is not yet verified, grow
 * the verification step that votes on them; a review with none grows nothing, so a nit never starts a
 * fix round, and its nits go to the author once. A legacy `assessment@1.0`-style `blocking` finding is
 * read as important, verified too.
 */
export function settleReview(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, assessment: Assessment, ref: ArtifactRef, lease: () => Lease): void {
  const pre = assessment.findings.filter((f) => f.severity === 'pre-existing' && !f.repeated)
  if (pre.length) e.ctx.store.afterCommit(() => void proposeFollowUps(e, run.run_id, node.node_id, ref, pre).catch((error: unknown) => e.ctx.logger.warn(`workflow: the follow-up of a pre-existing finding of ${node.node_id} was not proposed: ${(error as Error)?.message ?? String(error)}`)))
  const pending = assessment.findings.filter(pendingImportant)
  if (!pending.length) {
    // No fix round will carry the nits (a nit never starts one): the author gets them once, here.
    noteNits(e, run, node, assessment, ref)
    return
  }
  // A review that ran again after a re-plan grows under its new generation, as its remediation does.
  const generation = spec.generation ?? 1
  const verifyId = `${node.node_id}${generation > 1 ? `:r${generation}` : ''}:verify`
  if (e.nodeRow(run.run_id, verifyId)) return
  const verify: ResolvedNode = {
    nodeId: verifyId, objective: `Verify the important findings of review ${node.node_id} against the code: a second reviewer's vote on each`,
    prompt: '', literal: true, capabilities: spec.capabilities, tier: spec.tier, tierSource: 'profile', acceptance: 'acceptance.answer',
    ...(spec.kind !== undefined ? { kind: spec.kind } : {}),
    dependsOn: [node.node_id], differentFrom: [node.node_id], diversity: 'preferred', session: {},
    grownBy: { node: node.node_id, generation }, verifies: { review: node.node_id, assessment: ref },
  }
  append(e, run, node, [verify], [verifyId], lease)
  e.ctx.eventLog.append({ type: 'workflow.graph.grown', runId: run.run_id, nodeId: node.node_id, data: { steps: [verifyId], verification: true, findings: pending.map((f) => f.id) } })
}

/**
 * A review's nits, once, to the author (ADR-0075), when no fix round carries them as the optional notes
 * of its prompt (a fix does, for a review with a confirmed important finding): the dossier, which
 * every step's brief points at and the author reads, gets an entry naming each nit and asking one
 * response line each (taken, or left and why). Never a fix round, never a hold of the result. Nothing
 * for a run that serves no board task, or a review with no nit.
 */
function noteNits(e: Engine, run: RunRow, node: NodeRow, assessment: Assessment, ref: ArtifactRef): void {
  const nits = assessment.findings.filter((f) => f.severity === 'nit' && !f.repeated)
  if (!nits.length) return
  e.tasks.dossiers.safely('the nits of a review', () => e.tasks.dossiers.evidence(run.run_id, [
    `Optional notes for the author from review ${node.node_id} (${nits.length} nit${nits.length === 1 ? '' : 's'}; they never start a fix round or hold the result): take or leave each, and answer each with one response line in the dossier naming it (taken, or left and why).`,
    ...nits.map((f) => `- ${f.id ? `${f.id}: ` : ''}${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}`),
  ].join('\n'), [ref]))
}

/**
 * Each pre-existing finding of a board task's review proposes a follow-up task on the board, in the
 * task's project, naming the finding, the review, and the task it was found in: proposed, so the lead
 * or the operator decides it, and linked, never a dependency of the task. Once per finding: a
 * `workflow.follow-up` decision records the task proposed (or why none was), and a finding that has
 * one is never proposed again. The dossier's evidence entry links it.
 */
export async function proposeFollowUps(e: Engine, runId: string, nodeId: string, assessment: ArtifactRef, findings: readonly Finding[]): Promise<void> {
  const row = e.tasks.row(runId)
  const board = e.board
  if (!row || !board) return
  const done = new Set(e.ctx.artifacts.list({ kind: 'decision', decisionType: 'graph-growth', runId, nodeId, limit: 1000 })
    .map((a) => a.body as { decider?: { id?: string }; outcome?: { detail?: { key?: string } } })
    .filter((b) => b.decider?.id === FOLLOW_UP_RULE).map((b) => b.outcome?.detail?.key))
  const source = await board.task(row.task_id)
  for (const f of findings) {
    const key = findingKey(f)
    if (done.has(key)) continue
    const place = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'no place named'
    let proposed: string | undefined
    let why: string
    try {
      if (!source) throw new Error(`board task ${row.task_id} could not be read`)
      const task = await board.propose({
        projectId: source.projectId, title: clampText(`Pre-existing: ${f.title}`, 200), actionClass: source.actionClass, ...(source.template ? { template: source.template } : {}),
        goal: clampText(`A pre-existing defect a review found while reviewing task ${source.taskId} (${source.title}), in review ${nodeId} of run ${runId}; that change did not introduce it, so it is not fixed there. ${f.title} (${place}). Evidence: ${f.evidence ?? 'none given'}.${f.detail ? ` ${f.detail}` : ''} The assessment is ${assessment}.`, 4000),
        acceptance: [{ id: 'fixed', statement: clampText(`The defect no longer holds: ${f.title} (${place})`, 500) }],
      })
      proposed = task.taskId
      why = `proposed ${task.taskId} in project ${source.projectId}, linked to task ${source.taskId}; it never blocks that task`
    } catch (error) {
      why = `not proposed: ${clampText((error as Error)?.message ?? String(error), 300)}`
    }
    e.ctx.store.transaction(() => {
      const decision = e.ctx.artifacts.recordDecision({
        decisionType: 'graph-growth',
        question: `Does pre-existing finding ${f.id ?? '?'} of review ${nodeId} of run ${runId} become a follow-up task?`,
        inputs: [assessment],
        candidates: [
          { option: 'propose', selected: !!proposed, reasons: [clampText(proposed ? why : `not propose: ${why}`, 300)] },
          { option: 'none', selected: !proposed, reasons: [proposed ? 'not none: the board took the proposal' : clampText(why, 300)] },
        ],
        decider: { type: 'rule', id: FOLLOW_UP_RULE, version: '1' },
        outcome: { option: proposed ? 'propose' : 'none', detail: { key, finding: f.id ?? '', ...(proposed ? { taskId: proposed } : {}) } },
        deterministic: true,
      }, { ...PRODUCER, runId, nodeId }).id as ArtifactRef
      if (proposed) e.tasks.dossiers.safely('a follow-up task', () => e.tasks.dossiers.evidence(runId, `Pre-existing finding ${f.id ?? '?'} of review ${nodeId} (${f.title}, ${place}) is proposed as follow-up task ${proposed}: linked, not blocking this task.`, [decision, assessment]))
    })
  }
}

/**
 * A review whose verified assessment has blocking findings (important ones a second reviewer
 * confirmed) grows a remediation cycle (an engine rule for any node offering `review`,
 * docs/design/workflow-engine.md): a fix on the producer's capabilities, then a re-review bound to the
 * new subject, after `after` (the verification step); whatever waited for it waits for both. The fix
 * carries the review's nits once, as optional notes. Bounded by `maxReviewCycles`; either way a
 * `graph-growth` decision records why.
 */
export function remediate(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, assessment: Assessment, subject: string, lease: () => Lease, after: NodeRow = node): void {
  const blocking = assessment.findings.filter(blocks)
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
      { option: 'append', selected: !why, reasons: why ? [`not append: ${why}`] : [`${blocking.length} confirmed important finding(s) on ${subject}; review cycle ${cycle + 1} of ${max}`] },
      { option: 'refuse', selected: !!why, reasons: why ? [why] : [`not refuse: a writing step produced the change, and review cycle ${cycle} is below the bound ${max}`] },
    ],
    decider: { type: 'policy', id: 'workflow.remediation', version: '1' },
    outcome: { option: why ? 'refuse' : 'append' },
    deterministic: true,
  }, { ...PRODUCER, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
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
  // The review's nits reach the author once, as optional notes of this fix; never a fix of their own.
  const notes = assessment.findings.filter((f) => f.severity === 'nit' && !f.repeated)
  // The review's findings as the author session's next message: the findings, the subject the reviewer read, what to change.
  const prompt = remediationPrompt(run.input, subject, blocking, node.node_id, !!author, notes, producer?.showsEvidence === true)
  // The fix writes, so it waits for a person's approval of exactly this plan (ADR-0028, INV-15), never
  // for a policy's: the gate puts it to the approval queue as a `remediation` action, which always
  // asks (./queue.ts), or, with no queue loaded, waits for the operator's `approve`.
  // The author's own review (T267) has no gate: its fix is the author answering its own findings in
  // its own session, before the independent review starts, and that review keeps every gate.
  const own = spec.selfReview !== undefined
  const plan = own ? undefined : e.ctx.artifacts.put({
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
  const steps: ResolvedNode[] = [
    ...(plan ? [{ ...step, literal: true, nodeId: gateId, objective: `Approve the fix of review cycle ${cycle}`, executor: 'gate' as const, plan, prompt: '', capabilities: ['review'],
      tier: 'economy' as const, tierSource: 'profile' as const, acceptance: 'acceptance.answer', dependsOn: [after.node_id], operatorApproval: true as const, remediation: { subject } }] : []),
    // The fix is the same kind of work as the change it fixes, and the re-review as the review (ADR-0057).
    // It continues its author's session, on that session's Worker; the re-review keeps a session of
    // its own (`step`'s), never the author's: the reviewer stays independent.
    { ...step, literal: true, nodeId: fixId, objective: `Fix the blocking findings of review cycle ${cycle}`, prompt,
      capabilities: producer!.capabilities, tier: producer!.tier, ...(producer!.kind !== undefined ? { kind: producer!.kind } : {}), acceptance: 'acceptance.answer', dependsOn: [plan ? gateId : after.node_id],
      fixOf: node.node_id, ...(author ? { session: { sessionId: author.sessionId }, author } : {}),
      // A fix of a step that must show its checks' output must too, for the tree it leaves (T267).
      ...(producer!.showsEvidence ? { showsEvidence: true as const } : {}) },
    { ...step, ...(reviewed.literal ? { literal: true } : {}), nodeId: recheckId, objective: `Review cycle ${cycle + 1}: review the fixed change`, prompt: reviewed.prompt,
      ...(reviewed.resultSchema ? { resultSchema: reviewed.resultSchema } : {}), ...(spec.kind !== undefined ? { kind: spec.kind } : {}),
      ...(spec.selfReview !== undefined ? { selfReview: spec.selfReview } : {}),
      capabilities: spec.capabilities, tier: spec.tier, acceptance: spec.acceptance, dependsOn: [fixId], cycle: cycle + 1, reviewOf: base },
  ]
  const ids = steps.map((s) => s.nodeId)
  append(e, run, after, steps, ids, lease)
  e.ctx.eventLog.append({ type: 'workflow.graph.grown', runId: run.run_id, nodeId: node.node_id, decision, data: { steps: ids, ...(plan ? { plan } : {}), cycle: cycle + 1 } })
}
