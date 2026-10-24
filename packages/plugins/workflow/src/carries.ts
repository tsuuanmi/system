/**
 * Starting a board task's next attempt from the work its previous attempt left
 * (docs/design/workflow-engine.md#starting-from-the-previous-attempts-work, ADR-0061, T112): when
 * that attempt's writing step completed its change and the attempt failed only after it, for a
 * reason that says nothing about the change (a later step's Worker or session, a limit, a timeout),
 * the next attempt's worktree starts from that tree instead of the work being done again.
 *
 * - **Decided at admission** (INV-13), from the engine's own records, before the task is taken: an
 *   `admission` decision (`workflow.task-worktree`) chooses `carry` or `fresh`, with why, whenever the
 *   previous attempt left a writing step's result in a worktree.
 * - **Bounded**: only the immediately previous attempt; only a run that failed as a later step fails;
 *   only when no review of it judged the change other than approved and no step asked questions; and
 *   only on the subject the task writes, which no other open task holds (INV-15).
 * - **Carried before any step**, at the run's first turn: the Worker source that holds the tree commits
 *   it on its branch and cuts the run's worktree at its base holding it, only while the tree is still
 *   exactly what the writing step left and the base is still the repository's HEAD (INV-5). A `gate`
 *   decision records what it did, naming the earlier run and the commit, and every brief of the run
 *   points at it.
 * - **Fails closed** (INV-2): any doubt, a refusal, or no source that carries, and the run's worktree is
 *   cut from HEAD as for any attempt.
 * - **Restart** (INV-4): where it stands is on the run's row, and the source finds a carry it made.
 *
 * The run's writing step still runs: its brief says the worktree holds the earlier work, and it
 * continues from it; the review then reviews the whole change on that tree.
 */
import type { BoardTask, Subject } from '@tsuuanmi/system-board-core'
import { BRIEF_LIMITS, type BriefPointer, subjectId } from '@tsuuanmi/system-libs'
import type { ArtifactRef, Carried, CarryStep } from '@tsuuanmi/system-workers-core'
import type { TaskFrame } from './briefs.ts'
import type { Engine } from './engine.ts'
import { clampText, type ResolvedNode } from './spec.ts'
import { type NodeRecord, type NodeRow, now, type TaskCarry, type TaskOutcome, type TaskQuestion, type TaskRow, type WorkflowError } from './types.ts'

/**
 * Failures that say nothing about the change a run's writing step made: a later step's Worker,
 * session, or sign-in failed or was misconfigured, a limit or the task's budget stopped the run, it
 * timed out, its holder was lost, or an agent run of it was found gone after a restart. Anything else
 * (a review's rejection, a person's decision or stop, a stale subject, a question, a denied egress)
 * leaves the next attempt to start from HEAD.
 */
export const LATER_FAILURES: ReadonlySet<string> = new Set([
  'session_broken', 'provider_stalled', 'timeout', 'network', 'overloaded', 'quota_exhausted', 'reauth_required', 'challenge',
  'reconciliation_failed', 'config_error', 'internal', 'budget_spent', 'holder_lost',
])

/** Earlier runs of a task looked at for its previous attempt (runs the board never recorded are skipped), at most. */
const LOOK_BACK = 8
const RULE = { type: 'rule', id: 'workflow.task-worktree', version: '1' } as const
const PRODUCER = { producer: { type: 'system' as const, ref: 'workflow' } }

/** A run's writing step that completed in a worktree: its node, its result, and the tree it left. */
interface Writer { nodeId: string; result: ArtifactRef; workspace: string; subject: { ref: string; version: string } }

const describe = (s: Subject): string => `${s.type} ${s.ref}`
const kindOf = (error: string | null): string | undefined => (error ? (JSON.parse(error) as WorkflowError).kind : undefined)

export class TaskCarries {
  constructor(private readonly e: Engine) {}

  view(row: TaskRow): TaskCarry | undefined {
    return row.carry ? JSON.parse(row.carry) as TaskCarry : undefined
  }

  /**
   * At admission, before the task is taken: whether run `runId`, the task's next attempt, starts from
   * the work its previous attempt left. Undefined when that attempt left no writing step's result in a
   * worktree: there is nothing to carry, and nothing is decided. Otherwise an `admission` decision,
   * `carry` when every bound holds (the carry is then `due` for the run's first turn), else `fresh`
   * with why.
   */
  plan(task: BoardTask, runId: string): TaskCarry | undefined {
    const attempt = task.attempts.count
    if (attempt < 1) return undefined
    const previous = this.previous(task.taskId)
    const writer = previous ? this.writerOf(previous.run_id) : undefined
    if (!previous || !writer) return undefined
    const why = this.refusal(task, previous, writer)
    const tree = subjectId({ type: 'git-head', ...writer.subject })
    const decision = this.e.ctx.artifacts.recordDecision({
      decisionType: 'admission',
      question: `Does run ${runId}, attempt ${attempt + 1} of board task ${task.taskId}, start from the work attempt ${attempt} left in its worktree?`,
      inputs: [writer.result],
      candidates: [
        { option: 'carry', selected: !why, reasons: why ? [`not carry: ${why}`] : [
          `step ${writer.nodeId} of run ${previous.run_id} (attempt ${attempt}) completed its change, ${tree}`,
          `the attempt failed only after it (${this.failures(previous).join(', ')}); no review judged the change, and it is on ${writer.subject.ref}, the commit the task writes`,
          'the run\'s worktree is to start from that tree so the work is not done again: the Worker source that holds it carries it before the run\'s first step, only while it is still that tree and the repository\'s HEAD is still its base',
        ] },
        { option: 'fresh', selected: !!why, reasons: why ? [why, 'the run\'s worktree is cut from the repository\'s HEAD, as for any attempt'] : ['not fresh: the earlier work is the task\'s own, intact as its writing step left it, and only a later step failed'] },
      ],
      decider: RULE,
      outcome: { option: why ? 'fresh' : 'carry', detail: { taskId: task.taskId, attempt: attempt + 1, from: previous.run_id, fromAttempt: attempt, nodeId: writer.nodeId, result: writer.result, workspace: writer.workspace, subject: writer.subject } },
      deterministic: true,
    }, { ...PRODUCER, runId }).id as ArtifactRef
    return {
      state: why ? 'fresh' : 'due', from: { runId: previous.run_id, attempt, ...writer }, decisions: [decision],
      ...(why ? { reason: why } : {}), at: now(),
    }
  }

  /**
   * At the run's first turn, before any step: a carry that is `due` is asked of the Worker source that
   * holds the earlier tree, and what it did is a `gate` decision naming the earlier run and the commit
   * (`carried`), or why the run's worktree is cut from HEAD instead (`fresh`). A source that cannot
   * answer is a refusal (the workers seam's own rule), never a wait: the run then starts as any attempt.
   */
  async settle(runId: string): Promise<void> {
    const row = this.e.tasks.row(runId)
    const carry = row ? this.view(row) : undefined
    if (!row || carry?.state !== 'due') return
    const carryOf = this.e.ctx.workers.carry
    const step: CarryStep = { runId, from: { runId: carry.from.runId, workspace: carry.from.workspace, subject: carry.from.subject }, message: this.message(row, carry) }
    const answer: (Carried & { source: string }) | undefined = !row.lost && carryOf ? await carryOf.call(this.e.ctx.workers, step) : undefined
    const tree = subjectId({ type: 'git-head', ...carry.from.subject })
    const carried = answer?.outcome === 'carried' ? answer : undefined
    const fresh = carried ? undefined
      : row.lost ? 'the run lost its holder before its first step, and starts nothing'
        : !carryOf ? 'the workers seam cannot carry a worktree (no carry)'
          : !answer ? `no Worker source holds ${carry.from.workspace} as the worktree of run ${carry.from.runId}`
            : answer.outcome === 'refused' ? `source ${answer.source} did not carry it: ${answer.reason}` : `source ${answer.source} answered ${String((answer as { outcome?: unknown }).outcome)}`
    const decision = this.e.ctx.artifacts.recordDecision({
      decisionType: 'gate',
      question: `Does run ${runId}'s worktree start from the work run ${carry.from.runId} left (attempt ${carry.from.attempt} of board task ${row.task_id})?`,
      inputs: [...carry.decisions.slice(0, 1), carry.from.result],
      candidates: [
        { option: 'carry', selected: !!carried, reasons: carried ? [
          `source ${carried.source} ${carried.carried ? 'committed' : 'had committed'} the tree step ${carry.from.nodeId} of run ${carry.from.runId} left, ${tree}, on ${carried.from.branch} as ${carried.from.commit}`,
          `run ${runId}'s worktree on ${carried.branch} starts at ${carried.base}, holding that change: ${carried.worktree}`,
          'every brief of the run says so: its writing step continues from that work, and its review reviews the whole change',
        ] : [`not carry: ${fresh}`] },
        { option: 'fresh', selected: !carried, reasons: carried ? ['not fresh: the earlier tree was still what its writing step left, and the repository\'s HEAD was still its base'] : [fresh!, 'the run\'s worktree is cut from the repository\'s HEAD, as for any attempt'] },
      ],
      decider: RULE,
      outcome: {
        option: carried ? 'carry' : 'fresh',
        detail: {
          taskId: row.task_id, from: carry.from.runId, subject: carry.from.subject,
          ...(carried ? { source: carried.source, repository: carried.repository, commit: carried.from.commit, fromBranch: carried.from.branch, base: carried.base, branch: carried.branch, worktree: carried.worktree, carried: carried.carried } : {}),
          ...(answer?.outcome === 'refused' ? { source: answer.source, cause: answer.cause } : {}),
        },
      },
      deterministic: true,
    }, { ...PRODUCER, runId }).id as ArtifactRef
    const next: TaskCarry = carried
      ? { ...carry, state: 'carried', repository: carried.repository, worktree: carried.worktree, branch: carried.from.branch, commit: carried.from.commit, decisions: [...carry.decisions, decision], at: now() }
      : { ...carry, state: 'fresh', ...(answer?.outcome === 'refused' ? { cause: answer.cause } : {}), reason: fresh!, decisions: [...carry.decisions, decision], at: now() }
    this.e.ctx.store.transaction((db) => {
      db.prepare('UPDATE workflow_tasks SET carry = ? WHERE run_id = ?').run(JSON.stringify(next), runId)
      this.e.ctx.eventLog.append({
        type: 'workflow.task.carry', runId, decision,
        data: { taskId: row.task_id, state: next.state, from: carry.from.runId, ...(next.commit ? { commit: next.commit } : {}), ...(next.reason ? { reason: next.reason.slice(0, 500) } : {}) },
      })
    })
    if (carried) this.e.ctx.logger.info(`workflow: run ${runId} of board task ${row.task_id} starts from the work of run ${carry.from.runId} (${carried.from.commit} on ${carried.from.branch})`)
    else this.e.ctx.logger.info(`workflow: run ${runId} of board task ${row.task_id} starts from HEAD, not from the work of run ${carry.from.runId}: ${fresh}`)
  }

  /**
   * The pointer every brief of a carried run adds (role `prior`): the decision that records the carry,
   * with a note saying the run's worktree already holds the earlier change. Undefined for any other run.
   */
  pointer(runId: string): BriefPointer | undefined {
    const row = this.e.tasks.row(runId)
    const carry = row ? this.view(row) : undefined
    if (carry?.state !== 'carried') return undefined
    const ref = carry.decisions.at(-1)!
    if (!this.e.ctx.artifacts.get(ref)) return undefined
    return {
      ref, role: 'prior',
      note: clampText(`This run's worktree already holds the change step ${carry.from.nodeId} of attempt ${carry.from.attempt} made (committed as ${carry.commit} on ${carry.branch}, on top of ${carry.from.subject.ref}): build on it, do not make it again`, BRIEF_LIMITS.note),
    }
  }

  /** The latest run of the task the board recorded (a run it never recorded made no attempt), among the last {@link LOOK_BACK}. */
  private previous(taskId: string): TaskRow | undefined {
    const rows = this.e.ctx.store.db.prepare("SELECT * FROM workflow_tasks WHERE task_id = ? AND phase = 'reported' ORDER BY created_at DESC, rowid DESC LIMIT ?").all(taskId, LOOK_BACK) as unknown as TaskRow[]
    return rows.find((r) => (r.outcome ? (JSON.parse(r.outcome) as TaskOutcome).status : undefined) !== 'not-started')
  }

  /** The run's latest writing step that completed with an agent's result on a git working tree, and that tree. */
  private writerOf(runId: string): Writer | undefined {
    const writers = this.e.nodeRows(runId).filter((n) => n.state === 'COMPLETED' && (JSON.parse(n.spec) as ResolvedNode).capabilities.includes('develop'))
    const last = writers.at(-1)
    const result = last ? (JSON.parse(last.record) as NodeRecord).outputReceipt?.result : undefined
    const body = result ? this.e.ctx.artifacts.get(result)?.body as { schema?: string; workspace?: unknown; subject?: Subject } | undefined : undefined
    if (!last || !result || !body?.schema?.startsWith('agent-result@') || typeof body.workspace !== 'string' || body.subject?.type !== 'git-head' || !body.subject.version) return undefined
    return { nodeId: last.node_id, result, workspace: body.workspace, subject: { ref: body.subject.ref, version: body.subject.version } }
  }

  /** The kinds the run and its failed steps failed as. */
  private failures(previous: TaskRow): string[] {
    const kinds = [kindOf(this.e.runRow(previous.run_id)?.error ?? null), ...this.e.nodeRows(previous.run_id).filter((n) => n.state === 'FAILED').map((n) => kindOf(n.error))]
    return [...new Set(kinds.filter((k): k is string => k !== undefined))]
  }

  /** Why the run's work is not carried, or undefined when every bound holds (fail closed: any doubt is a reason). */
  private refusal(task: BoardTask, previous: TaskRow, writer: Writer): string | undefined {
    const what = `run ${previous.run_id}`
    const served = previous.frame ? (JSON.parse(previous.frame) as TaskFrame).attempt : undefined
    if (served !== task.attempts.count) return `${what} served attempt ${served ?? '(unknown)'}, not attempt ${task.attempts.count}, the one before this: only the immediately previous attempt's work is carried`
    const run = this.e.runRow(previous.run_id)
    if (run?.status !== 'failed') return `${what} ${run ? run.status : 'is gone'}: ${run?.status === 'completed' ? 'its result went to the board, which judged it' : 'only a failed attempt\'s work is carried'}, so the next attempt starts from HEAD`
    const nodes = this.e.nodeRows(previous.run_id)
    const grown = nodes.filter((n) => (JSON.parse(n.spec) as ResolvedNode).grownBy !== undefined).map((n) => n.node_id)
    if (grown.length) return `a step of ${what} grew ${grown.slice(0, 4).join(', ')}${grown.length > 4 ? ` and ${grown.length - 4} more` : ''} (a review asked for changes, or a plan): the change was judged, so it is not carried`
    const judged = this.judged(nodes)
    if (judged) return `review ${judged.nodeId} of ${what} judged the change ${judged.verdict}: the change was judged, so it is not carried`
    const question = previous.question ? JSON.parse(previous.question) as TaskQuestion : undefined
    if (question) return `step ${question.nodeId} of ${what} asked questions instead of answering: their answers may change the work, so it is not carried`
    const failures = this.failures(previous)
    const about = failures.filter((k) => !LATER_FAILURES.has(k))
    if (!failures.length || about.length) return `${what} failed as ${about.join(', ') || 'nothing it recorded'}, which is not a later step's Worker, session, or limit failing, so its change is not carried`
    const writes = task.writes
    if (!writes) return `task ${task.taskId} names no subject it writes, so no earlier tree is held as its own (INV-15)`
    if (writes.type !== 'git-head') return `task ${task.taskId} writes ${describe(writes)}, not a commit of a git repository`
    const admitted = previous.writes ? JSON.parse(previous.writes) as Subject : undefined
    if (admitted?.type !== writes.type || admitted.ref !== writes.ref) return `${what} was admitted to write ${admitted ? describe(admitted) : 'nothing'}, not ${describe(writes)}, which task ${task.taskId} writes now`
    if (writer.subject.ref !== writes.ref) return `the tree step ${writer.nodeId} of ${what} left is on ${writer.subject.ref}, not on ${writes.ref}, the commit task ${task.taskId} writes: its subject moved, so it is not carried`
    if (!this.e.ctx.workers.carry) return 'the workers seam cannot carry a worktree (no carry)'
    return undefined
  }

  /** A review of the run that judged the change other than approved: an exact-subject gate's assessment, or a review step's own verdict. */
  private judged(nodes: NodeRow[]): { nodeId: string; verdict: string } | undefined {
    for (const node of nodes) {
      for (const ref of node.decisions ? JSON.parse(node.decisions) as ArtifactRef[] : []) {
        const body = this.e.ctx.artifacts.get(ref)?.body as { decisionType?: string; decider?: { id?: string }; outcome?: { detail?: { assessment?: ArtifactRef } } } | undefined
        if (body?.decisionType !== 'gate' || body.decider?.id !== 'workflow.exact-subject' || !body.outcome?.detail?.assessment) continue
        const verdict = (this.e.ctx.artifacts.get(body.outcome.detail.assessment)?.body as { verdict?: string } | undefined)?.verdict
        if (verdict !== 'approve') return { nodeId: node.node_id, verdict: verdict ?? 'with no verdict' }
      }
    }
    return undefined
  }

  /** The message of the earlier tree's commit on its branch, naming the task, both runs, and the step that made the change. */
  private message(row: TaskRow, carry: TaskCarry): string {
    return [
      `system: carry the work of attempt ${carry.from.attempt} of task ${row.task_id} into run ${row.run_id}`, '',
      `Step ${carry.from.nodeId} of run ${carry.from.runId} made this change, and the attempt failed only after it; attempt ${carry.from.attempt + 1}, run ${row.run_id}, starts from it (decision ${carry.decisions[0]}).`, '',
      `System-Task: ${row.task_id}`, `System-Run: ${carry.from.runId}`,
    ].join('\n')
  }
}
