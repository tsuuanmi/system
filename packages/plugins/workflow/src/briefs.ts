/**
 * Briefs (docs/design/workflow-engine.md#briefs). Every Worker execution the engine starts is given
 * a `brief@1.1`, recorded as an `objective` artifact before the start and named by the execution
 * (`workflow-node@1.2` `execution.brief`). The engine composes the record: the node's instructions
 * (composed at promotion: the template's text, the caller's input, and every dependency's result
 * by content id), the board task it serves, how its result is accepted, and the Worker's
 * confinement as the Worker's source declares it. The Worker source renders it into its own prompt
 * at start, resolving the pointers there (INV-12). No execution starts on instructions that leave a
 * template's placeholder unfilled (`instructionsProblem`, INV-2).
 */
import type { Lease } from '@tsuuanmi/system-leases'
import { type Brief, type BriefBudgetLine, type BriefCheck, type BriefFile, BRIEF_LIMITS, type BriefPointer, NO_LOCAL_SANDBOX, QUESTION_LIMITS, renderBrief } from '@tsuuanmi/system-libs'
import { dispositionOf } from '@tsuuanmi/system-provider-core'
import type { ArtifactRef, Tier, WorkerSandbox, WorkRequirement } from '@tsuuanmi/system-workers-core'
import { landingTargets } from './checks.ts'
import { roleOf } from './dossiers.ts'
import type { Engine } from './engine.ts'
import { type Wording, wordingOf } from './review.ts'
import { changePaths } from './risk.ts'
import { guidesTouching, loadGuides, renderGuides } from './review-guides.ts'
import { clampText, type Instructions, literal, type PlaceholderScope, type ResolvedNode, unfilledPlaceholders } from './spec.ts'
import { type NodeRecord, type NodeRow, type RunRow, type WorkflowError, WorkflowFailure } from './types.ts'

/**
 * What a run for a board task adds to every brief it writes, fixed when the run is admitted: the
 * task, its attempt, its goal and acceptance criteria, what it points at (the results of the tasks
 * it depends on, its previous attempt's result, and the decision behind this attempt), and the
 * budget it could still draw then. A step's brief states the budget left when the step starts
 * (`TaskRuns.budgetAt`); the admitted one stands in only when the ledger cannot count it.
 */
export interface TaskFrame {
  projectId: string
  taskId: string
  attempt: number
  goal: string
  /** The task's criteria, each with what checks it (`check`) when the task names it (brief@1.3). */
  acceptance: Array<{ id: string; statement: string; check?: BriefCheck }>
  pointers: BriefPointer[]
  budget: BriefBudgetLine[]
  /** Files a source with a worktree of the run's own writes there: the board's `TASKS.md` projection (docs/design/workflow-engine.md#tasksmd-in-a-runs-workspace). */
  files?: BriefFile[]
}

const RANK: Record<Brief['classification'], number> = { public: 0, 'operator-shared': 1, 'local-private': 2 }

/** A brief before its sandbox is known (the sandbox is the routed Worker's). */
export type Draft = Omit<Brief, 'sandbox'>

/**
 * A node's instructions: the ones composed when it was promoted, or, for a node promoted before
 * briefs, its rendered prompt as text (it then points at nothing).
 */
export function instructionsOf(node: NodeRow): Instructions {
  if (node.brief_parts) return JSON.parse(node.brief_parts) as Instructions
  // Cleared by retention (`retainDays`): the node has nothing left to say, and nothing is sent.
  if (!node.prompt) throw new WorkflowFailure('invalid_input', `node ${node.node_id} has no instructions left (a finished run's prompts are cleared after retainDays); nothing was sent`)
  return literal(node.prompt)
}

/**
 * The brief a node's next execution is given, but for its sandbox. A node of a board task's run
 * states the task's goal and criteria, offers the Worker to ask questions instead of answering
 * (`ask`), and points at what the task points at after its own
 * instructions' pointers; any other node's goal is its objective, and its criteria are its
 * acceptance contract and result schema. A node on a session the Worker keeps natively names that
 * session (`resume`): its brief is the session's next message.
 */
export function draftOf(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, requirement: WorkRequirement, guides?: BriefPointer): Draft {
  const parts = instructionsOf(node)
  const task = e.tasks.frame(run.run_id)
  const own = new Set(parts.pointers.map((p) => p.ref))
  // An author's self-review (T267) is given the goal, the diff (its instructions' subject block), and
  // the review guides only: none of the task's pointers (earlier results, decisions, the carried work),
  // no dossier, and no files, so nothing its author planned, did, or was told reaches it.
  const fresh = spec.selfReview !== undefined
  // A run whose worktree starts from the previous attempt's work says so first (ADR-0061).
  const carried = task && !fresh ? e.tasks.carries.pointer(run.run_id) : undefined
  // The task's dossier as it stands now (ADR-0070): its slice for every step, the whole of it as a file.
  const dossier = task && !fresh ? e.tasks.dossiers.forBrief(run, node) : {}
  const extra = [...(carried ? [carried] : []), ...(fresh ? [] : task?.pointers ?? []), ...(dossier.pointer ? [dossier.pointer] : []), ...(guides ? [guides] : [])].filter((p) => !own.has(p.ref)).slice(0, BRIEF_LIMITS.pointers - parts.pointers.length)
  const files = [...(fresh ? [] : task?.files ?? []), ...(dossier.file ? [dossier.file] : [])].slice(0, BRIEF_LIMITS.files)
  const bound = node.subject ? (JSON.parse(node.subject) as { subject?: { type: 'git-head'; ref: string; version: string } }).subject : undefined
  const handle = spec.session.sessionId ? e.ctx.workers.handle(spec.session.sessionId) : undefined
  return {
    // A board task's brief offers the Worker a bounded way to ask instead of answering (@1.2 `ask`): its questions block the task.
    // A criterion that names what checks it carries that (@1.3 `check`), so a step that measures the change knows its own.
    schema: !task ? 'brief@1.1' : task.acceptance.some((a) => a.check !== undefined) ? 'brief@1.3' : 'brief@1.2',
    ...(task ? { projectId: task.projectId, taskId: task.taskId, attempt: task.attempt, ask: { maxQuestions: QUESTION_LIMITS.count } } : {}),
    ...(files.length ? { files } : {}),
    goal: clampText(task?.goal ?? spec.objective, BRIEF_LIMITS.goal),
    acceptance: task?.acceptance ?? [
      { id: 'contract', statement: clampText(`The result passes the acceptance contract ${spec.acceptance}`, BRIEF_LIMITS.statement) },
      ...(spec.resultSchema ? [{ id: 'result-schema', statement: `The answer ends with a JSON object valid against ${spec.resultSchema}` }] : []),
      ...(bound ? [{ id: 'exact-subject', statement: 'The review names the exact subject it was given, and the working tree is still that subject' }] : []),
    ],
    artifacts: [...parts.pointers, ...extra],
    ...(parts.segments.length ? { instructions: parts.segments } : {}),
    ...(bound ? { subject: { type: bound.type, ref: bound.ref, version: bound.version } } : {}),
    budget: { remaining: task?.budget ?? [] },
    ...(handle ? { resume: { nativeHandle: clampText(handle, 256) } } : {}),
    classification: requirement.data.classification,
  }
}

/**
 * The review guides a review step's brief points at (T267): the REVIEW.md of the areas the run's
 * change touches, read from the repository the run's worktree was cut from, and only those; every
 * guide when the change's paths could not all be read (INV-2). Undefined for a step that does not
 * review, a run no Worker source holds a worktree of, or a repository with no guides. A guide that
 * cannot be used is named in the text, never left out in silence.
 */
export async function guidesFor(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode): Promise<BriefPointer | undefined> {
  if (roleOf(spec, node) !== 'review') return undefined
  const targets = await landingTargets(e, run.run_id)
  const root = targets[0]?.repository
  if (!root) return undefined
  const { guides, problems } = loadGuides(root)
  if (!guides.length && !problems.length) return undefined
  const picked = guidesTouching(guides, await changePaths(e, run.run_id))
  const rendered = renderGuides(picked.selected, picked.left, picked.all, problems)
  if (!rendered) return undefined
  const ref = e.ctx.artifacts.put({
    kind: 'report', bodySchema: 'review-guides@1.0', body: rendered.body, classification: run.classification ?? e.ctx.egress.defaultClassification,
    producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id,
  }).id as ArtifactRef
  return { ref, role: 'context', note: `the review guides of the areas this change touches (${picked.selected.length}): what failure looks like there, and how to report it` }
}

/** The length of what a Worker source renders from the draft, in characters (code points), for admission (ADR-0032). */
export function renderedChars(e: Engine, draft: Draft): number {
  // Rendered as a source that writes the brief's files renders it, the longest any source sends.
  return [...renderBrief({ ...draft, sandbox: NO_LOCAL_SANDBOX }, (ref) => e.ctx.artifacts.get(ref), { placesFiles: true })].length
}

/**
 * Record the brief for an execution, before it starts: an `objective` artifact whose inputs are
 * every artifact it points at, its files' included (so an unknown pointer is refused and the classification floor
 * applies, INV-12), with the sandbox the routed Worker's source declares (none: a Worker that runs
 * nothing on this machine).
 */
export function recordBrief(e: Engine, run: RunRow, node: NodeRow, draft: Draft, sandbox: WorkerSandbox | undefined, tier?: Tier, model?: string): ArtifactRef {
  // At least as strict as what it points at, in its body as in its envelope (INV-12).
  let classification = draft.classification
  const refs = [...new Set([...draft.artifacts.map((p) => p.ref), ...(draft.files ?? []).map((f) => f.ref)])]
  for (const ref of refs) {
    const stricter = e.ctx.artifacts.get(ref)?.classification
    if (stricter && RANK[stricter] > RANK[classification]) classification = stricter
  }
  // The tier the run was routed at, when its Worker offers several, and the model its source's
  // configuration runs there (ADR-0073): `brief@1.4` with the tier, `@1.5` with its model too.
  const named = model !== undefined && model.length && model.length <= 200 ? model : undefined
  // A brief that records its handbook slice is `brief@1.6`, which holds the tier and the model too.
  const versioned = draft.handbook ? { schema: 'brief@1.6' as const } : undefined
  const tiered = tier ? (named ? { ...(versioned ?? { schema: 'brief@1.5' as const }), tier, model: named } : { ...(versioned ?? { schema: 'brief@1.4' as const }), tier }) : (versioned ?? {})
  const body: Brief = { ...draft, ...tiered, sandbox: sandbox ?? NO_LOCAL_SANDBOX, classification }
  return e.ctx.artifacts.put({
    kind: 'objective', bodySchema: body.schema, body, inputs: refs,
    classification: body.classification, producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id,
  }).id as ArtifactRef
}

/** What a node's template text may be filled from: its wording's results, a planner's steps, and a team step's prompt (spec.ts `compose`). */
export function placeholderScope(spec: ResolvedNode, wording: Wording, nodes: readonly NodeRow[]): PlaceholderScope {
  const planner = (id: string): boolean => {
    const row = nodes.find((n) => n.node_id === id)
    return !!row && !!(JSON.parse(row.spec) as ResolvedNode).grows
  }
  return { refs: wording.refs, grown: wording.grownOf.dependsOn.some(planner), team: spec.team?.role === 'ballot' || spec.team?.role === 'debate' }
}

/** Why a node's instructions are not sent. */
export interface InstructionsProblem {
  message: string
  /** The placeholders the engine could not fill, as written. */
  placeholders: string[]
}

/**
 * The guard before a node's Worker execution starts (INV-2): its instructions must be what its
 * wording composes to, every placeholder of a template filled. Refused when the node cannot be
 * worded, when its template holds a placeholder the engine cannot fill for it, or when it was
 * promoted by an earlier engine as text its wording composes (a re-review that engine marked
 * literal): its stored instructions would carry the template's placeholders as they are. Text the
 * engine never expands (the caller's input, a dependency's result, a plan step's model text, a
 * fix's quoted findings, a diff) is data, and may hold `{{…}}`.
 */
export function instructionsProblem(spec: ResolvedNode, nodes: readonly NodeRow[]): InstructionsProblem | undefined {
  const wording = wordingOf(spec, nodes)
  if ('problem' in wording) return { message: `${wording.problem}; nothing was sent`, placeholders: [] }
  if (!!spec.literal !== wording.literal) {
    return { message: `node ${spec.nodeId}'s instructions were stored by an earlier engine as ${spec.literal ? 'its template\'s text as it is, never composed' : 'a composed template'}; nothing was sent: continue the run to compose them again`, placeholders: [] }
  }
  if (wording.literal) return undefined
  const placeholders = unfilledPlaceholders(wording.prompt, placeholderScope(spec, wording, nodes))
  return placeholders.length ? unfilledProblem(spec, placeholders) : undefined
}

/** The problem of a template whose placeholders the engine cannot fill (at most 16 named, INV-9). */
export function unfilledProblem(spec: ResolvedNode, placeholders: string[]): InstructionsProblem {
  const named = placeholders.slice(0, 16)
  const more = placeholders.length > named.length ? ` and ${placeholders.length - named.length} more` : ''
  return { message: `node ${spec.nodeId}'s template holds ${named.join(', ')}${more}, which the engine does not fill for it; nothing was sent: fix the template, then start the run again`, placeholders: named }
}

/**
 * Fail a node whose instructions may not be sent, before anything is routed or sent: a `gate`
 * decision (`workflow.instructions`) says why, first (INV-13), and the node fails as `config_error`
 * without an input receipt, so `continue` composes its instructions again.
 */
export function refuseInstructions(e: Engine, run: RunRow, node: NodeRow, problem: InstructionsProblem, lease: () => Lease): void {
  e.ctx.store.transaction(() => {
    const decision = e.ctx.artifacts.recordDecision({
      decisionType: 'gate',
      question: `May node ${node.node_id} of run ${run.run_id} start a Worker with its instructions?`,
      inputs: [],
      candidates: [
        { option: 'fail', selected: true, reasons: [clampText(problem.message, 300)] },
        { option: 'start', selected: false, reasons: ['not start: a Worker never reads a placeholder the engine did not fill, nor instructions that are not what the node\'s template composes to (INV-2)'] },
      ],
      decider: { type: 'rule', id: 'workflow.instructions', version: '1' },
      outcome: { option: 'fail', detail: { placeholders: problem.placeholders } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
    const error: WorkflowError = { kind: 'config_error', disposition: dispositionOf('config_error'), message: problem.message }
    e.writeNode(node, { state: 'FAILED', error: JSON.stringify(error) }, (r) => {
      const next: NodeRecord = { ...r, lastDecision: decision }
      delete next.inputReceipt
      delete next.execution
      return next
    }, lease)
    e.ctx.eventLog.append({ type: 'workflow.node.failed', runId: run.run_id, nodeId: node.node_id, decision, data: { kind: error.kind, disposition: error.disposition, placeholders: problem.placeholders } })
  })
}

/**
 * The text a node's instructions render to, as a Worker source renders them (the brief's one
 * rendering, `renderBrief`): what its input hash covers, and what `explain` keeps as its prompt.
 */
export function instructionsText(e: Engine, parts: Instructions): string {
  if (!parts.segments.length) return ''
  const bare: Brief = {
    schema: 'brief@1.1', goal: '-', acceptance: [{ id: 'contract', statement: '-' }], artifacts: parts.pointers, instructions: parts.segments,
    budget: { remaining: [] }, sandbox: NO_LOCAL_SANDBOX, classification: 'public',
  }
  return renderBrief(bare, (ref) => e.ctx.artifacts.get(ref))
}
