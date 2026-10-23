/**
 * Briefs (docs/design/workflow-engine.md#briefs). Every Worker execution the engine starts is given
 * a `brief@1.1`, recorded as an `objective` artifact before the start and named by the execution
 * (`workflow-node@1.2` `execution.brief`). The engine composes the record: the node's instructions
 * (composed at promotion: the template's text, the caller's input, and every dependency's result
 * by content id), the board task it serves, how its result is accepted, and the Worker's
 * confinement as the Worker's source declares it. The Worker source renders it into its own prompt
 * at start, resolving the pointers there (INV-12).
 */
import { type Brief, BRIEF_LIMITS, type BriefBudgetLine, type BriefPointer, NO_LOCAL_SANDBOX, renderBrief } from '@tsuuanmi/system-libs'
import type { ArtifactRef, WorkerSandbox, WorkRequirement } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import { clampText, type Instructions, literal, type ResolvedNode } from './spec.ts'
import { type NodeRow, type RunRow, WorkflowFailure } from './types.ts'

/**
 * What a run for a board task adds to every brief it writes, fixed when the run is admitted: the
 * task, its attempt, its goal and acceptance criteria, what it points at (the results of the tasks
 * it depends on, its previous attempt's result, and the decision behind this attempt), and the
 * budget it may still draw.
 */
export interface TaskFrame {
  projectId: string
  taskId: string
  attempt: number
  goal: string
  acceptance: Array<{ id: string; statement: string }>
  pointers: BriefPointer[]
  budget: BriefBudgetLine[]
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
 * states the task's goal and criteria, and points at what the task points at after its own
 * instructions' pointers; any other node's goal is its objective, and its criteria are its
 * acceptance contract and result schema. A node on a session the Worker keeps natively names that
 * session (`resume`): its brief is the session's next message.
 */
export function draftOf(e: Engine, run: RunRow, node: NodeRow, spec: ResolvedNode, requirement: WorkRequirement): Draft {
  const parts = instructionsOf(node)
  const task = e.tasks.frame(run.run_id)
  const own = new Set(parts.pointers.map((p) => p.ref))
  const extra = (task?.pointers ?? []).filter((p) => !own.has(p.ref)).slice(0, BRIEF_LIMITS.pointers - parts.pointers.length)
  const bound = node.subject ? (JSON.parse(node.subject) as { subject?: { type: 'git-head'; ref: string; version: string } }).subject : undefined
  const handle = spec.session.sessionId ? e.ctx.workers.handle(spec.session.sessionId) : undefined
  return {
    schema: 'brief@1.1',
    ...(task ? { projectId: task.projectId, taskId: task.taskId, attempt: task.attempt } : {}),
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

/** The length of what a Worker source renders from the draft, in characters (code points), for admission (ADR-0032). */
export function renderedChars(e: Engine, draft: Draft): number {
  return [...renderBrief({ ...draft, sandbox: NO_LOCAL_SANDBOX }, (ref) => e.ctx.artifacts.get(ref))].length
}

/**
 * Record the brief for an execution, before it starts: an `objective` artifact whose inputs are
 * every artifact it points at (so an unknown pointer is refused and the classification floor
 * applies, INV-12), with the sandbox the routed Worker's source declares (none: a Worker that runs
 * nothing on this machine).
 */
export function recordBrief(e: Engine, run: RunRow, node: NodeRow, draft: Draft, sandbox: WorkerSandbox | undefined): ArtifactRef {
  // At least as strict as what it points at, in its body as in its envelope (INV-12).
  let classification = draft.classification
  for (const pointer of draft.artifacts) {
    const stricter = e.ctx.artifacts.get(pointer.ref)?.classification
    if (stricter && RANK[stricter] > RANK[classification]) classification = stricter
  }
  const body: Brief = { ...draft, sandbox: sandbox ?? NO_LOCAL_SANDBOX, classification }
  return e.ctx.artifacts.put({
    kind: 'objective', bodySchema: body.schema, body, inputs: body.artifacts.map((p) => p.ref),
    classification: body.classification, producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id,
  }).id as ArtifactRef
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
