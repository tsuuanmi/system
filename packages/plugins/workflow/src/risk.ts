/**
 * Process tiered by risk (PROP-0016 §4, D83, ADR-0071; docs/design/workflow-engine.md#process-tiered-by-risk):
 * a board task's change gets a tier from the path map in its project's autonomy policy, by what it
 * touches, never by a model's opinion. The tier is the highest of its changed paths', and a path no
 * rule matches, or a change that cannot be read, is heavy (INV-2). With no applying policy carrying a
 * map, tiering is off and the process is as before.
 *
 * - When a review approves the change, the engine decides its tier (`workflow.risk-tier`, under that
 *   review). A **heavy** change then needs an approving review of its exact tree by a Worker of
 *   another provider family before anything after the review runs: the engine grows that second
 *   review, which never runs on the same family for want of another. A **light** change skips a step
 *   the template marks `riskSkip` once every check the policy requires passed on its exact tree.
 * - At acceptance the engine decides the tier again, on the run's final change (run-level), and a
 *   heavy result without approving reviews of its exact tree by two provider families is rejected.
 *   The board never applies an acceptance of a heavy result unattended (ADR-0067's rule and the
 *   policy's alike): the operator decides it.
 *
 * Seams for the parts still to come: the second review is worded as the review it follows
 * ({@link SECOND_REVIEW}), where the adversarial review prompt goes; and the board's hold of a heavy
 * result names the decision a decision brief will summarize.
 */
import type { Lease } from '@tsuuanmi/system-leases'
import { type ChangePaths, changeTier, type ChangeTier, RISK_TIERS, type RiskTier, riskTierMaps, type MapOf, tierReasons } from '@tsuuanmi/system-approvals-core'
import type { ArtifactRef } from '@tsuuanmi/system-workers-core'
import { checksFor } from './checks.ts'
import type { Engine } from './engine.ts'
import { append } from './growth.ts'
import { queueOf } from './queue.ts'
import type { ResolvedNode } from './spec.ts'
import type { NodeRecord, NodeRow, RunRow } from './types.ts'

const PRODUCER = { producer: { type: 'system' as const, ref: 'workflow' } }

/** The rule that decides a change's tier, and the one that skips a step of a light change. */
export const RISK_RULE = 'workflow.risk-tier'
export const SKIP_RULE = 'workflow.risk-skip'

/** The paths a tier decision lists at most (INV-9); the rest are counted. */
const MAX_LISTED = 50

/**
 * The second review's objective. Its wording is the review's own (a template's prompt, composed
 * again); the adversarial review prompt of PROP-0016 I2's later part replaces it here.
 */
export const SECOND_REVIEW = 'Second review of a heavy-tier change, by a Worker of another provider family: review the exact change, independently of its developer and of the first review'

/** What a run's tier read: the maps, or why the policy could not be read; undefined when tiering is off. */
type Maps = { maps: MapOf[]; projectId: string; taskId: string } | { problem: string; projectId?: string; taskId: string }

/** Runs and steps whose tier was found off (no map applies), so the policy is not read again for them by this engine. */
const off = new WeakMap<Engine, Set<string>>()
const offOf = (e: Engine): Set<string> => {
  let set = off.get(e)
  if (!set) off.set(e, set = new Set())
  return set
}

/** The maps that apply to a board task's run: its project's policies, studio first. */
async function mapsOf(e: Engine, runId: string): Promise<Maps | undefined> {
  const row = e.tasks.row(runId)
  const approvals = queueOf(e)
  if (!row || !approvals || !e.board) return undefined
  let projectId: string | undefined
  try {
    projectId = (await e.board.task(row.task_id))?.projectId
    if (projectId === undefined) return { problem: `board task ${row.task_id} could not be read`, taskId: row.task_id }
    const maps = riskTierMaps((await approvals.policy(projectId)).policies)
    return maps.length ? { maps, projectId, taskId: row.task_id } : undefined
  } catch (error) {
    return { problem: `the autonomy policy could not be read (${(error as Error).message.slice(0, 200)})`, ...(projectId ? { projectId } : {}), taskId: row.task_id }
  }
}

/**
 * The run's change as its tier reads it, from the Worker sources that hold its worktrees
 * (`ctx.workers.changes`): every path it touches (a rename's both), and each part that could not be
 * read, which counts as heavy: a source that could not read its own, files past the bound, or no
 * source that holds a worktree of the run at all.
 */
export async function changePaths(e: Engine, runId: string): Promise<ChangePaths> {
  if (typeof e.ctx.workers.changes !== 'function') return { paths: [], unreadable: ['no Worker source can tell a run\'s change (ctx.workers.changes)'] }
  try {
    const { changes, unread } = await e.ctx.workers.changes(runId)
    const paths = changes.flatMap((c) => c.files.flatMap((f) => [f.path, ...(f.from !== undefined ? [f.from] : [])]))
    const unreadable = [
      ...unread.map((u) => `source ${u.source} could not read its worktree of the run: ${u.detail.slice(0, 200)}`),
      ...changes.filter((c) => c.more > 0).map((c) => `${c.more} file(s) of ${c.workspace} past the bound of the change's files`),
      ...(!changes.length && !unread.length ? ['no Worker source holds a worktree of the run'] : []),
    ]
    return { paths, unreadable }
  } catch (error) {
    return { paths: [], unreadable: [`the run's change could not be read (${(error as Error).message.slice(0, 200)})`] }
  }
}

/** A decided tier: its decision, and what it read. */
export interface Tiered { tier: RiskTier; decision: ArtifactRef; result?: ChangeTier }

/** Record a `workflow.risk-tier` decision: the tier, the maps and paths that gave it, and why. */
function recordTier(e: Engine, run: RunRow, maps: Maps, change: ChangePaths, where: { nodeId?: string; subject?: string }): Tiered {
  const result = 'maps' in maps ? changeTier(maps.maps, change) : undefined
  const tier: RiskTier = result?.tier ?? 'heavy'
  const why = result ? tierReasons(result) : [`${'problem' in maps ? maps.problem : 'no map'}: the tier cannot be read from the policy, so the change is heavy (INV-2)`]
  const listed = result?.paths.slice(0, MAX_LISTED).map((p) => ({ ...(p.path ? { path: p.path } : {}), tier: p.tier, why: p.why, ...(p.rules ? { rules: p.rules.map((r) => r.pattern) } : {}), ...(p.detail ? { detail: p.detail.slice(0, 300) } : {}) }))
  const decision = e.ctx.artifacts.recordDecision({
    decisionType: 'gate',
    question: `What risk tier is the change of run ${run.run_id}${where.subject ? ` on ${where.subject}` : ''}, by the paths it touches?`,
    inputs: [],
    candidates: RISK_TIERS.map((t) => ({
      option: t, selected: t === tier,
      reasons: t === tier ? why : [`not ${t}: ${RISK_TIERS.indexOf(t) < RISK_TIERS.indexOf(tier) ? `a path of the change is ${tier}, and the highest tier of its paths wins` : `no path of the change is ${t}`}`],
    })),
    decider: { type: 'rule', id: RISK_RULE, version: '1' },
    outcome: {
      option: tier,
      detail: {
        taskId: maps.taskId, ...(maps.projectId ? { projectId: maps.projectId } : {}), ...(where.subject ? { subject: where.subject } : {}),
        ...(result ? { maps: result.maps, counts: result.counts, paths: listed, ...(result.paths.length > MAX_LISTED ? { more: result.paths.length - MAX_LISTED } : {}) } : { problem: (maps as { problem: string }).problem }),
      },
    },
    deterministic: true,
  }, { ...PRODUCER, runId: run.run_id, ...(where.nodeId ? { nodeId: where.nodeId } : {}) }).id as ArtifactRef
  return { tier, decision, ...(result ? { result } : {}) }
}

/** An approving review of the run: its step, its Worker, the exact tree it approved, and no blocking finding left. */
export interface Approval { node: string; worker?: string; subject: string }

/** The approving reviews among `nodes`: each completed step whose exact-subject gate passed with an `approve` and no blocking finding, by its latest such gate. */
export function approvals(e: Engine, nodes: readonly NodeRow[]): Approval[] {
  const found: Approval[] = []
  for (const node of nodes) {
    if (node.state !== 'COMPLETED' || !node.subject) continue
    // The step's latest passed gate decides, as the board's last review does.
    let last: Approval | undefined
    for (const ref of node.decisions ? JSON.parse(node.decisions) as ArtifactRef[] : []) {
      const body = e.ctx.artifacts.get(ref)?.body as { decisionType?: string; decider?: { id?: string }; outcome?: { option?: string; detail?: { assessment?: ArtifactRef } } } | undefined
      if (body?.decisionType !== 'gate' || body.decider?.id !== 'workflow.exact-subject' || body.outcome?.option !== 'pass' || !body.outcome.detail?.assessment) continue
      const assessment = e.ctx.artifacts.get(body.outcome.detail.assessment)?.body as { verdict?: string; findings?: Array<{ severity?: string }>; subject?: { ref?: string; version?: string } } | undefined
      const approved = assessment?.verdict === 'approve' && !(assessment.findings ?? []).some((f) => f.severity === 'blocking') && !!assessment.subject?.ref
      last = approved ? { node: node.node_id, ...(node.worker ? { worker: node.worker } : {}), subject: `git:${assessment!.subject!.ref}:${assessment!.subject!.version ?? ''}` } : undefined
    }
    if (last) found.push(last)
  }
  return found
}

/** The provider family of each Worker, as the Worker sources describe them now (ADR-0027); none when they cannot be listed. */
async function familiesOf(e: Engine): Promise<Map<string, string>> {
  try {
    return new Map((await e.ctx.workers.list()).filter((w) => typeof w.family === 'string').map((w) => [w.worker, w.family!]))
  } catch (error) {
    e.ctx.logger.warn(`workflow: the Workers could not be listed for their provider families; no review counts as another family's: ${(error as Error).message}`)
    return new Map()
  }
}

/** Whether a step already holds a tier decision (it was settled, even across a restart). */
function settled(e: Engine, node: NodeRow): boolean {
  return (node.decisions ? JSON.parse(node.decisions) as ArtifactRef[] : []).some((ref) => (e.ctx.artifacts.get(ref)?.body as { decider?: { id?: string } } | undefined)?.decider?.id === RISK_RULE)
}

/**
 * Before anything after an approving review runs (the run's loop, before it promotes): decide the
 * tier of the change the review approved, once per review, and act on it. Heavy: grow the second
 * review by another family, unless the tree already has approving reviews by two families. Light
 * (or a tier a waiting step names in `riskSkip`): skip that step once the policy's required checks
 * passed on the exact tree, recorded either way. Returns whether the graph changed.
 */
export async function settleRisk(e: Engine, run: RunRow, nodes: readonly NodeRow[], lease: () => Lease, signal: AbortSignal): Promise<boolean> {
  if (!e.tasks.bound(run.run_id)) return false
  const done = offOf(e)
  const pending = approvals(e, nodes).filter((a) => !done.has(`${run.run_id}\0${a.node}`) && !settled(e, nodes.find((n) => n.node_id === a.node)!))
  if (!pending.length) return false
  const maps = await mapsOf(e, run.run_id)
  if (signal.aborted) return false
  if (!maps) {
    for (const a of pending) done.add(`${run.run_id}\0${a.node}`)
    return false
  }
  const review = pending.at(-1)!
  const change = await changePaths(e, run.run_id)
  if (signal.aborted) return false
  const families = await familiesOf(e)
  if (signal.aborted) return false
  // Every earlier approving review still pending is settled under the latest one: its decision covers the change as it is now.
  const tiered = recordTier(e, run, maps, change, { nodeId: review.node, subject: review.subject })
  let changed = false
  e.ctx.store.transaction(() => {
    for (const a of pending) {
      const row = e.nodeRow(run.run_id, a.node)!
      e.writeNode(row, { decisions: JSON.stringify([...(row.decisions ? JSON.parse(row.decisions) as string[] : []), tiered.decision]) }, (r) => r, lease)
    }
    if (tiered.tier === 'heavy') changed = growSecond(e, run, review, tiered.decision, families, lease)
  })
  if (tiered.tier !== 'heavy') changed = await skipAt(e, run, tiered, review, lease, signal) || changed
  return changed
}

/** The provider families whose Workers approved exactly `subject`, by the families listed now. */
function familiesOn(all: readonly Approval[], subject: string, families: ReadonlyMap<string, string>): Set<string> {
  return new Set(all.filter((a) => a.subject === subject && a.worker && families.has(a.worker)).map((a) => families.get(a.worker!)!))
}

/**
 * A heavy change's second review: after the approving review, bound to the same change, routed only
 * to a Worker of another provider family than that review's (`differentFrom`), never lifted; whatever
 * waited for the review waits for it too. None when approving reviews of the tree by two families
 * already exist, or this review already grew one. Inside a store transaction.
 */
function growSecond(e: Engine, run: RunRow, review: Approval, decision: ArtifactRef, families: ReadonlyMap<string, string>, lease: () => Lease): boolean {
  const nodes = e.nodeRows(run.run_id)
  if (familiesOn(approvals(e, nodes), review.subject, families).size >= 2) return false
  const id = `${review.node}:second`
  if (nodes.some((n) => n.node_id === id)) return false
  const row = nodes.find((n) => n.node_id === review.node)!
  const spec = JSON.parse(row.spec) as ResolvedNode
  const second: ResolvedNode = {
    nodeId: id, objective: SECOND_REVIEW, prompt: spec.prompt, ...(spec.literal ? { literal: true } : {}),
    capabilities: spec.capabilities, tier: spec.tier, tierSource: 'decision', tierDecision: decision, acceptance: spec.acceptance,
    ...(spec.kind !== undefined ? { kind: spec.kind } : {}), ...(spec.resultSchema ? { resultSchema: spec.resultSchema } : {}),
    // Worded as the review it follows: the same dependencies, or, for a re-review, the same cycle of the same review.
    dependsOn: spec.dependsOn, ...(spec.reviewOf !== undefined ? { reviewOf: spec.reviewOf } : {}), ...(spec.cycle !== undefined ? { cycle: spec.cycle } : {}),
    differentFrom: [review.node], secondReview: { of: review.node, decision }, session: {}, grownBy: { node: review.node, generation: spec.generation ?? 1 },
  }
  append(e, run, row, [second], [id], lease)
  e.ctx.eventLog.append({ type: 'workflow.graph.grown', runId: run.run_id, nodeId: review.node, decision, data: { steps: [id], secondReview: true } })
  return true
}

/**
 * Skip the waiting steps a light (or `riskSkip`-named) change does not need: only once every check
 * the policy requires of the result is a command that ran and passed on the exact tree the review
 * approved. Recorded either way (`workflow.risk-skip`, under the step); with no such step, nothing.
 */
async function skipAt(e: Engine, run: RunRow, tiered: Tiered, review: Approval, lease: () => Lease, signal: AbortSignal): Promise<boolean> {
  const rows = e.nodeRows(run.run_id)
  const skippable = rows.filter((n) => n.state === 'WAITING' && ((JSON.parse(n.spec) as ResolvedNode).riskSkip ?? []).includes(tiered.tier)
    && !rows.some((d) => d.state !== 'RETIRED' && (JSON.parse(d.spec) as ResolvedNode).dependsOn.includes(n.node_id)))
  if (!skippable.length) return false
  const ran = await checksFor(e, run, rows, signal)
  if (signal.aborted) return false
  const checks = Object.entries(ran?.checks ?? {})
  const onTree = ran && `git:${ran.subject.ref}:${ran.subject.version}` === review.subject
  const why = !ran ? 'the policy requires no command check of the result here, or none could be asked: nothing shows the change passes'
    : !onTree ? `the checks ran on git:${ran.subject.ref}:${ran.subject.version}, not on the tree the review approved (${review.subject})`
      : !checks.length ? `no required check ran to an exit code (${ran.notes.join('; ').slice(0, 300) || 'none was asked'})`
        : checks.some(([, passed]) => !passed) ? `a required check failed: ${checks.filter(([, p]) => !p).map(([c]) => c).join(', ')}`
          : ran.notes.length ? `a required check is still pending: ${ran.notes.join('; ').slice(0, 300)}` : undefined
  const passed = checks.map(([c]) => c).join(', ')
  const skip = !why
  e.ctx.store.transaction(() => {
    for (const node of skippable) {
      const decision = e.ctx.artifacts.recordDecision({
        decisionType: 'graph-growth',
        question: `Does run ${run.run_id} skip step ${node.node_id} of its ${tiered.tier}-tier change on ${review.subject}?`,
        inputs: [tiered.decision, ...(ran?.evidence ? [ran.evidence] : [])],
        candidates: [
          { option: 'skip', selected: skip, reasons: skip ? [`the change is ${tiered.tier} (decision ${tiered.decision}), and the step skips at that tier`, `every check the policy requires passed on the exact tree the review approved: ${passed}`] : [`not skip: ${why}`] },
          { option: 'run', selected: !skip, reasons: skip ? ['not run: the change is light and its required checks passed on its exact tree'] : [why!] },
        ],
        decider: { type: 'rule', id: SKIP_RULE, version: '1' },
        outcome: { option: skip ? 'skip' : 'run', detail: { tier: tiered.tier, subject: review.subject, ...(ran ? { checkRun: ran.detail } : {}) } },
        deterministic: true,
      }, { ...PRODUCER, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
      if (!skip) continue
      const row = e.nodeRow(run.run_id, node.node_id)!
      e.writeNode(row, { state: 'RETIRED' }, (r: NodeRecord) => ({ ...r, schema: r.execution?.brief ? 'workflow-node@1.2' : 'workflow-node@1.1', lastDecision: decision }), lease)
      e.ctx.eventLog.append({ type: 'workflow.node.skipped', runId: run.run_id, nodeId: node.node_id, decision, data: { tier: tiered.tier } })
    }
  })
  return skip
}

/** What a task's acceptance reads of the tier: the run-level decision, and the approving reviews with their families. */
export interface AcceptanceRisk {
  tier: RiskTier
  decision: ArtifactRef
  /** Every approving review of the run, its tree, and its Worker's provider family when one is listed now. */
  reviews: Array<Approval & { family?: string }>
}

/**
 * Before a board task's acceptance is decided: the tier of the run's final change, recorded on the
 * run, and the approving reviews with their Workers' provider families, read now (ADR-0027: a family
 * is read from the live descriptors). Undefined when tiering is off for the run.
 */
export async function riskAtAcceptance(e: Engine, run: RunRow, nodes: readonly NodeRow[], signal: AbortSignal): Promise<AcceptanceRisk | undefined> {
  if (!e.tasks.bound(run.run_id)) return undefined
  const maps = await mapsOf(e, run.run_id)
  if (!maps || signal.aborted) return undefined
  const change = await changePaths(e, run.run_id)
  const families = await familiesOf(e)
  if (signal.aborted) return undefined
  const tiered = recordTier(e, run, maps, change, {})
  const reviews = approvals(e, nodes).map((a) => ({ ...a, ...(a.worker && families.has(a.worker) ? { family: families.get(a.worker)! } : {}) }))
  return { tier: tiered.tier, decision: tiered.decision, reviews }
}

/**
 * Whether a heavy result on exactly `subject` has approving reviews by Workers of two provider
 * families, and how many it has. Not heavy: always.
 */
export function secondFamily(risk: AcceptanceRisk | undefined, subject: string): { met: boolean; families: number; reviews: AcceptanceRisk['reviews'] } {
  if (risk?.tier !== 'heavy') return { met: true, families: 0, reviews: [] }
  const on = risk.reviews.filter((r) => r.subject === subject)
  const families = new Set(on.filter((r) => r.family !== undefined).map((r) => r.family)).size
  return { met: families >= 2, families, reviews: on }
}

/** The run's latest tier decision, and why, for `explain` and `/ui`: the acceptance's when there is one, else the latest review's. */
export function riskOf(e: Engine, runId: string): { tier: RiskTier; reasons: string[]; decision: ArtifactRef; at?: string } | undefined {
  const found = e.ctx.artifacts.list({ kind: 'decision', decisionType: 'gate', runId, limit: 1000 })
    .filter((a) => (a.body as { decider?: { id?: string } } | undefined)?.decider?.id === RISK_RULE)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const last = [...found].reverse().find((a) => a.nodeId === undefined) ?? found.at(-1)
  if (!last) return undefined
  const body = last.body as { outcome: { option: RiskTier }; candidates: Array<{ selected: boolean; reasons: string[] }> }
  return { tier: body.outcome.option, reasons: body.candidates.find((c) => c.selected)?.reasons ?? [], decision: last.id as ArtifactRef, ...(last.nodeId ? { at: last.nodeId } : {}) }
}
