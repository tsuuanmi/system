/**
 * Keeping an attempt's change, and starting a board task's next attempt from it
 * (docs/design/workflow-engine.md#starting-from-the-previous-attempts-work, ADR-0061, T112, T271).
 *
 * - **Kept when the attempt ends** (T271): an attempt whose result is not accepted (a failed step, a
 *   failed acceptance, a cut, the review bound reached, a rejected fix, a question, the operator's
 *   rejection) leaves its writing step's change as its result: the Worker source that holds the
 *   worktree commits it on the run's own branch (the `commit` landing step), and the attempt's dossier
 *   records the sha. Durable (INV-4): the report marks it `pending` in its own transaction, and it is
 *   asked again at start and before the next attempt decides; every end is said, never skipped.
 * - **Decided at admission** (INV-13), from the engine's own records, before the task is taken: an
 *   `admission` decision (`workflow.task-worktree`) chooses `carry` or `fresh`, with why, whenever the
 *   previous attempt left a writing step's result in a worktree. However that attempt ended, its change
 *   is carried, unless the task opts out (`task.fresh`, a fresh start).
 * - **Bounded**: only the immediately previous attempt; only on the subject the task writes, which no
 *   other open task holds (INV-15), and only a tree on the commit that attempt was admitted to write.
 * - **Carried before any step**, at the run's first turn: the Worker source that holds the tree commits
 *   it on its branch (or finds it kept), then cuts the run's worktree at the commit the task writes now,
 *   the repository's HEAD, holding the change replayed there; when the replay conflicts, at the
 *   change's own base, the conflict named (INV-5). A `gate` decision records what it did, every brief of
 *   the run points at it, and the dossier says which attempt the tree came from.
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

/** Earlier runs of a task looked at for its previous attempt (runs the board never recorded are skipped), at most. */
const LOOK_BACK = 8
const RULE = { type: 'rule', id: 'workflow.task-worktree', version: '1' } as const
const PRODUCER = { producer: { type: 'system' as const, ref: 'workflow' } }

/** A run's writing step that completed in a worktree: its node, its result, and the tree it left. */
interface Writer { nodeId: string; result: ArtifactRef; workspace: string; subject: { ref: string; version: string } }

type Rebase = NonNullable<Extract<Carried, { outcome: 'carried' }>['rebase']>

const describe = (s: Subject): string => `${s.type} ${s.ref}`
const kindOf = (error: string | null): string | undefined => (error ? (JSON.parse(error) as WorkflowError).kind : undefined)

/** Whether a reported outcome leaves the attempt's change to keep: its result was not accepted, nor waits for the operator's acceptance. */
export const keepable = (outcome: TaskOutcome): boolean => outcome.status !== 'not-started' && outcome.state !== 'done' && outcome.state !== 'review'

export class TaskCarries {
  /** The keeps in flight, by run: one at a time per run, so the dossier says each end once. */
  private readonly keeping = new Map<string, Promise<void>>()
  /** The runs whose first turn here already saw the previous attempt's change kept ({@link settle}). */
  private readonly keptBefore = new Set<string>()

  constructor(private readonly e: Engine) {}

  view(row: TaskRow): TaskCarry | undefined {
    const stored = this.stored(row)
    if (!stored) return undefined
    const { noted: _noted, ...carry } = stored
    return carry
  }

  /**
   * At admission, once the run took the task and before it is admitted: whether run `runId`, the
   * task's next attempt, starts from the work its previous attempt left. Undefined when that attempt
   * left no writing step's result in a worktree: there is nothing to carry, and nothing is decided.
   * Otherwise an `admission` decision, `carry` when every bound holds (the carry is then `due` for the
   * run's first turn), else `fresh` with why; `fresh` too when the start asked for it (the task opts
   * out). Never throws on the engine's own records: one it cannot read is a reason to start from HEAD,
   * recorded, never a reason to refuse the start (INV-2).
   */
  plan(task: BoardTask, runId: string, fresh = false, thisAttempt: number = task.attempts.count + 1): TaskCarry | undefined {
    // The previous run is found by its own record, never by the attempts counted: a run the board
    // did not count (it failed only on the infrastructure, ADR-0069) leaves the count where it was
    // before it, and is still the previous run, whose work this one may carry.
    let attempt = task.attempts.count
    let previous: TaskRow | undefined
    let writer: Writer | undefined
    let why: string | undefined
    let ended = ''
    try {
      previous = this.previous(task.taskId)
      writer = previous ? this.writerOf(previous.run_id) : undefined
      if (!previous || !writer) return undefined
      attempt = this.served(previous) ?? attempt
      why = this.refusal(task, previous, writer, fresh, thisAttempt)
      ended = this.ended(previous, this.e.nodeRows(previous.run_id))
    } catch (error) {
      if (attempt < 1 && !previous) return undefined
      return this.unread(task, runId, thisAttempt, `the engine's record of attempt ${attempt}${previous ? ` (run ${previous.run_id})` : ''} could not be read (${(error as Error).message.slice(0, 300)})`)
    }
    const tree = subjectId({ type: 'git-head', ...writer.subject })
    // A writing step that asked questions left its tree before it finished: its change is what it made before it asked (T291).
    const asked = (previous.question ? JSON.parse(previous.question) as TaskQuestion : undefined)?.nodeId === writer.nodeId
    const decision = this.e.ctx.artifacts.recordDecision({
      decisionType: 'admission',
      question: `Does run ${runId}, attempt ${thisAttempt} of board task ${task.taskId}, start from the work ${attempt === thisAttempt ? `run ${previous.run_id}, ${thisAttempt === task.attempts.count ? 'whose answered question continues it,' : 'not counted,'} left of the same attempt` : `attempt ${attempt} left`} in its worktree?`,
      inputs: [writer.result],
      candidates: [
        { option: 'carry', selected: !why, reasons: why ? [`not carry: ${why}`] : [
          asked
            ? `step ${writer.nodeId} of run ${previous.run_id} (attempt ${attempt}) changed the tree, ${tree}, then asked questions before it finished`
            : `step ${writer.nodeId} of run ${previous.run_id} (attempt ${attempt}) completed its change, ${tree}`,
          asked
            ? `the answers continue the attempt (${ended}): what the step changed before it asked is kept on its run's branch, and the run builds on it rather than making it again`
            : `the attempt ended after it without being accepted (${ended}): its change is the attempt's result, kept on its run's branch, and the next attempt builds on it rather than making it again`,
          'the Worker source that holds the tree carries it before the run\'s first step, only while it is still that tree: replayed on the commit the task writes now, the repository\'s HEAD, or on its own base when the replay conflicts',
        ] },
        { option: 'fresh', selected: !!why, reasons: why ? [why, 'the run\'s worktree is cut from the repository\'s HEAD, as for any attempt'] : ['not fresh: the earlier work is the task\'s own, intact as its writing step left it, and the task did not opt out'] },
      ],
      decider: RULE,
      outcome: { option: why ? 'fresh' : 'carry', detail: { taskId: task.taskId, attempt: thisAttempt, from: previous.run_id, fromAttempt: attempt, nodeId: writer.nodeId, result: writer.result, workspace: writer.workspace, subject: writer.subject, ...(fresh ? { optedOut: true } : {}) } },
      deterministic: true,
    }, { ...PRODUCER, runId }).id as ArtifactRef
    return {
      state: why ? 'fresh' : 'due', from: { runId: previous.run_id, attempt, ...writer }, decisions: [decision],
      ...(why ? { reason: why } : {}), at: now(),
    }
  }

  /** {@link plan} when the previous attempt's record cannot be read: `fresh`, decided and recorded with why, with no tree named. */
  private unread(task: BoardTask, runId: string, thisAttempt: number, what: string): TaskCarry {
    const why = `${what}, so its work is not carried`
    const decision = this.e.ctx.artifacts.recordDecision({
      decisionType: 'admission',
      question: `Does run ${runId}, attempt ${thisAttempt} of board task ${task.taskId}, start from the work attempt ${task.attempts.count} left in its worktree?`,
      inputs: [],
      candidates: [
        { option: 'carry', selected: false, reasons: [`not carry: ${why}`] },
        { option: 'fresh', selected: true, reasons: [why, 'the run\'s worktree is cut from the repository\'s HEAD, as for any attempt'] },
      ],
      decider: RULE,
      outcome: { option: 'fresh', detail: { taskId: task.taskId, attempt: thisAttempt, fromAttempt: task.attempts.count } },
      deterministic: true,
    }, { ...PRODUCER, runId }).id as ArtifactRef
    this.e.ctx.logger.warn(`workflow: run ${runId} of board task ${task.taskId} starts from HEAD: ${why}`)
    return { state: 'fresh', decisions: [decision], reason: why, at: now() }
  }

  /**
   * At the run's first turn, before any step: the previous attempt's change is kept first (if a stop
   * or the report's own timing left it pending); then a carry that is `due` is asked of the Worker
   * source that holds the earlier tree, and what it did is a `gate` decision naming the earlier run
   * and the commit (`carried`), or why the run's worktree is cut from HEAD instead (`fresh`). A source
   * that cannot answer is a refusal (the workers seam's own rule), never a wait: the run then starts
   * as any attempt.
   */
  async settle(runId: string): Promise<void> {
    const row = this.e.tasks.row(runId)
    const stored = row ? this.stored(row) : undefined
    if (!row || !stored) return
    const { noted, ...carry } = stored
    // The earlier attempt's change is its result, kept before this attempt decides what to do with it (T271), carried or not;
    // once per run in this engine (every advance passes here), and again after a restart.
    if (carry.from && !this.keptBefore.has(runId)) {
      await this.keepEnded(carry.from.runId)
      // Bounded (INV-9): forgetting only means one more cheap look at a keep already settled.
      if (this.keptBefore.size >= 4096) this.keptBefore.clear()
      this.keptBefore.add(runId)
    }
    // Settled already (or decided fresh at admission): its dossier note, unless a stop came before it was written (INV-4).
    if (carry.state !== 'due' || !carry.from) {
      if (!noted) this.note(runId)
      return
    }
    const from = carry.from
    const carryOf = this.e.ctx.workers.carry
    // The commit the task writes now: the carry goes onto it, replayed there when the repository moved since the earlier tree
    // (T271), and only while it is still the repository's HEAD, where a run's worktree is cut from.
    const writes = row.writes ? JSON.parse(row.writes) as Subject : undefined
    const step: CarryStep = {
      runId, from: { runId: from.runId, workspace: from.workspace, subject: from.subject }, message: this.message(row, from, carry.decisions[0]!),
      ...(writes?.type === 'git-head' ? { onto: writes.ref } : {}),
    }
    const answer: (Carried & { source: string }) | undefined = !row.lost && carryOf ? await carryOf.call(this.e.ctx.workers, step) : undefined
    const tree = subjectId({ type: 'git-head', ...from.subject })
    const carried = answer?.outcome === 'carried' ? answer : undefined
    const fresh = carried ? undefined
      : row.lost ? 'the run lost its holder before its first step, and starts nothing'
        : !carryOf ? 'the workers seam cannot carry a worktree (no carry)'
          : !answer ? `no Worker source holds ${from.workspace} as the worktree of run ${from.runId}`
            : answer.outcome === 'refused' ? `source ${answer.source} did not carry it: ${answer.reason}` : `source ${answer.source} answered ${String((answer as { outcome?: unknown }).outcome)}`
    const decision = this.e.ctx.artifacts.recordDecision({
      decisionType: 'gate',
      question: `Does run ${runId}'s worktree start from the work run ${from.runId} left (attempt ${from.attempt} of board task ${row.task_id})?`,
      inputs: [...carry.decisions.slice(0, 1), from.result],
      candidates: [
        { option: 'carry', selected: !!carried, reasons: carried ? [
          `source ${carried.source} ${carried.carried ? 'committed' : 'had committed'} the tree step ${from.nodeId} of run ${from.runId} left, ${tree}, on ${carried.from.branch} as ${carried.from.commit}`,
          `run ${runId}'s worktree on ${carried.branch} starts at ${carried.base}, holding that change: ${carried.worktree}`,
          ...(carried.rebase ? [this.moved(carried.rebase)] : []),
          'every brief of the run says so: its writing step continues from that work, and its review reviews the whole change',
        ] : [`not carry: ${fresh}`] },
        { option: 'fresh', selected: !carried, reasons: carried ? ['not fresh: the earlier tree was still what its writing step left, and the commit the task writes was the repository\'s HEAD'] : [fresh!, 'the run\'s worktree is cut from the repository\'s HEAD, as for any attempt'] },
      ],
      decider: RULE,
      outcome: {
        option: carried ? 'carry' : 'fresh',
        detail: {
          taskId: row.task_id, from: from.runId, subject: from.subject,
          ...(carried ? { source: carried.source, repository: carried.repository, commit: carried.from.commit, fromBranch: carried.from.branch, base: carried.base, branch: carried.branch, worktree: carried.worktree, carried: carried.carried, ...(carried.rebase ? { rebase: carried.rebase } : {}) } : {}),
          ...(answer?.outcome === 'refused' ? { source: answer.source, cause: answer.cause } : {}),
        },
      },
      deterministic: true,
    }, { ...PRODUCER, runId }).id as ArtifactRef
    const next: TaskCarry = carried
      ? { ...carry, state: 'carried', repository: carried.repository, worktree: carried.worktree, branch: carried.from.branch, commit: carried.from.commit, base: carried.base, ...(carried.rebase ? { rebase: carried.rebase } : {}), decisions: [...carry.decisions, decision], at: now() }
      : { ...carry, state: 'fresh', ...(answer?.outcome === 'refused' ? { cause: answer.cause } : {}), reason: fresh!, decisions: [...carry.decisions, decision], at: now() }
    this.e.ctx.store.transaction((db) => {
      db.prepare('UPDATE workflow_tasks SET carry = ? WHERE run_id = ?').run(JSON.stringify(next), runId)
      this.e.ctx.eventLog.append({
        type: 'workflow.task.carry', runId, decision,
        data: { taskId: row.task_id, state: next.state, from: from.runId, ...(next.commit ? { commit: next.commit } : {}), ...(next.reason ? { reason: next.reason.slice(0, 500) } : {}) },
      })
    })
    // The attempt the tree came from, in the task's dossier (T271), written from what the row now holds.
    this.note(runId)
    if (carried) this.e.ctx.logger.info(`workflow: run ${runId} of board task ${row.task_id} starts from the work of run ${from.runId} (${carried.from.commit} on ${carried.from.branch})`)
    else this.e.ctx.logger.info(`workflow: run ${runId} of board task ${row.task_id} starts from HEAD, not from the work of run ${from.runId}: ${fresh}`)
  }

  /** What a move of the repository's HEAD since the earlier tree did to the carry, in words. */
  private moved(r: Rebase): string {
    return r.outcome === 'rebased'
      ? `the repository moved from ${r.from} to ${r.onto}: the change was replayed on ${r.onto} without conflict, and the worktree starts there`
      : `the repository moved from ${r.from} to ${r.onto} and the change conflicts with it${r.files?.length ? ` (${r.files.slice(0, 8).join(', ')})` : ''}: the worktree stays at the change's own base ${r.from}, and the Worker resolves the move (rebase onto ${r.onto}, keeping its behaviour)`
  }

  /**
   * The pointer every brief of a carried run adds (role `prior`): the decision that records the carry,
   * with a note saying the run's worktree already holds the earlier change, and what a move of the base
   * did to it. Undefined for any other run.
   */
  pointer(runId: string): BriefPointer | undefined {
    const row = this.e.tasks.row(runId)
    const carry = row ? this.view(row) : undefined
    if (carry?.state !== 'carried' || !carry.from) return undefined
    const from = carry.from
    const ref = carry.decisions.at(-1)!
    if (!this.e.ctx.artifacts.get(ref)) return undefined
    // Within the note's bound: what a move of the base did, else where to read why the attempt ended (the dossier says both in full).
    const tail = carry.rebase ? `. Dev moved to ${carry.rebase.onto.slice(0, 8)}: ${carry.rebase.outcome === 'rebased' ? 'replayed' : 'conflicts'}` : '. The dossier says why it ended'
    return {
      ref, role: 'prior',
      note: clampText(`This run's worktree already holds the change step ${from.nodeId} of attempt ${from.attempt} made (committed as ${carry.commit} on ${carry.branch}, on top of ${from.subject.ref}): build on it, do not make it again${tail}`, BRIEF_LIMITS.note),
    }
  }

  /** The carry as the row stores it: the view, and whether its dossier note was written. */
  private stored(row: TaskRow): (TaskCarry & { noted?: boolean }) | undefined {
    return row.carry ? JSON.parse(row.carry) as TaskCarry & { noted?: boolean } : undefined
  }

  /**
   * The task's dossier says where a settled carry left the run's tree (T271), from what the row
   * stores, then the row marks it noted: which attempt's tree it starts from, the commit that keeps
   * that change and what a move of the base did; or that it starts fresh, and why (the task opted out,
   * a bound, a refusal). Written at the run's turn that settles the carry, or the first turn after a
   * stop that came between the carry and its note (INV-4); a stop between the entry and the mark
   * writes it once more, never not at all.
   */
  private note(runId: string): void {
    const row = this.e.tasks.row(runId)
    const stored = row ? this.stored(row) : undefined
    if (!row || !stored || stored.state === 'due') return
    const { noted: _noted, ...carry } = stored
    const from = carry.from
    const attempt = this.served(row) ?? (from ? from.attempt + 1 : '?')
    const decision = carry.decisions.at(-1)
    this.e.tasks.dossiers.safely('the carry', () => this.e.tasks.dossiers.evidence(runId, carry.state === 'carried' && from
      ? `Attempt ${attempt} (run ${runId}) starts from the tree of attempt ${from.attempt} (run ${from.runId}): its change is kept as commit ${carry.commit} on ${carry.branch}, on top of ${from.subject.ref}${carry.rebase ? `; ${this.moved(carry.rebase)}` : ''}.`
      : `Attempt ${attempt} (run ${runId}) starts fresh${from ? `, not from the tree of attempt ${from.attempt} (run ${from.runId})` : ''}: ${carry.reason ?? 'no reason recorded'}.`,
    decision ? [decision] : [], undefined, carry.state === 'carried' && carry.commit ? [carry.commit] : []))
    this.e.ctx.store.transaction((db) => void db.prepare('UPDATE workflow_tasks SET carry = ? WHERE run_id = ?').run(JSON.stringify({ ...carry, noted: true }), runId))
  }

  /**
   * When an attempt ends without its result being accepted (T271): the change its writing step left
   * is kept as the attempt's own result, a commit on the run's branch made by the source that holds
   * the worktree (the `commit` landing step, only while the tree is still exactly what the step left
   * and nothing of the run can write it), and recorded in the attempt's dossier with its sha, whether
   * or not a next attempt ever carries it or opts out. A result that is done, or waits for the
   * operator's acceptance, is landed, never kept here (until the operator rejects it: {@link rejected}).
   *
   * Durable (INV-4): the report marks the outcome `kept: pending` in its own transaction, and this runs
   * from the report, again for every pending report when the engine starts ({@link recover}), and
   * before the next attempt's carry decides ({@link settle}), so a stop between the report and the
   * commit loses nothing. A busy tree (a run of it not known to be gone) stays pending. Every other end
   * is final and said: `kept` with the commit, or `not-kept` with why (no `land` on the workers seam,
   * no source that holds the tree, a refusal), in the outcome and as an `evidence` entry of the
   * attempt's dossier; nothing is skipped without being said. The worktree is then left as it is.
   */
  keep(runId: string, atStart = false): Promise<void> {
    const running = this.keeping.get(runId)
    if (running) return running
    const keeping = this.keepOnce(runId, atStart).finally(() => this.keeping.delete(runId))
    this.keeping.set(runId, keeping)
    return keeping
  }

  /** {@link keep}'s work; `atStart`, asked as the engine starts, when a source that holds the tree may not have registered yet: no answer then stays pending. */
  private async keepOnce(runId: string, atStart: boolean): Promise<void> {
    const row = this.e.tasks.row(runId)
    const outcome = row?.outcome ? JSON.parse(row.outcome) as TaskOutcome : undefined
    if (!row || row.phase !== 'reported' || !outcome?.kept) return
    let kept = outcome.kept
    if (kept.state === 'pending') {
      const settled = await this.commitKept(row, outcome, atStart)
      if (!settled) return
      kept = settled
      this.saveKept(runId, outcome, kept)
    }
    // Said apart from being settled, and marked once said: a stop between the two says it at the next keep (INV-4).
    if (!kept.said) this.sayKept(row, outcome, kept)
  }

  /** {@link keepOnce}'s commit of a pending change: its end, `kept` or `not-kept`, or undefined while it stays pending. */
  private async commitKept(row: TaskRow, outcome: TaskOutcome, atStart: boolean): Promise<NonNullable<TaskOutcome['kept']> | undefined> {
    const runId = row.run_id
    const writer = this.writerOf(runId)
    if (!writer) return { state: 'not-kept', reason: 'no writing step of the run left a tree in a worktree', at: now() }
    const unkept = (reason: string): NonNullable<TaskOutcome['kept']> => ({ state: 'not-kept', reason: reason.slice(0, 500), at: now() })
    const writes = row.writes ? JSON.parse(row.writes) as Subject : undefined
    if (writes?.type !== 'git-head') return unkept(`the task writes ${writes ? describe(writes) : 'nothing'}, not a commit of a git repository`)
    const land = this.e.ctx.workers.land
    if (!land) return unkept('the workers seam cannot land a result (no land), so nothing commits the tree')
    const message = [
      `system: keep the change of attempt ${this.served(row) ?? '?'} of task ${row.task_id}`, '',
      `Step ${writer.nodeId} of run ${runId} made this change, and the attempt ended without being accepted (${outcome.status}${outcome.state ? `, task ${outcome.state}` : ''}).`, '',
      `System-Task: ${row.task_id}`, `System-Run: ${runId}`,
    ].join('\n')
    const landed = await land.call(this.e.ctx.workers, { step: 'commit', runId, workspace: writer.workspace, subject: writer.subject, message })
    // A tree a run of it may still write is asked again, never committed under it (INV-15).
    if (landed?.outcome === 'refused' && landed.cause === 'busy') return undefined
    if (!landed && atStart) return undefined
    if (landed?.outcome !== 'committed') return unkept(!landed ? `no Worker source holds ${writer.workspace} as the worktree of run ${runId}` : landed.outcome === 'refused' ? landed.reason : `source ${landed.source} answered ${landed.outcome}`)
    return { state: 'kept', commit: landed.head, branch: landed.branch, at: now() }
  }

  private saveKept(runId: string, outcome: TaskOutcome, kept: NonNullable<TaskOutcome['kept']>): void {
    this.e.ctx.store.transaction((db) => void db.prepare('UPDATE workflow_tasks SET outcome = ? WHERE run_id = ?').run(JSON.stringify({ ...outcome, kept }), runId))
  }

  /** The attempt's dossier entry for its settled change, from what the outcome stores, then the outcome marked `said`. */
  private sayKept(row: TaskRow, outcome: TaskOutcome, kept: NonNullable<TaskOutcome['kept']>): void {
    const runId = row.run_id
    const writer = this.writerOf(runId)
    const attempt = this.served(row) ?? '?'
    if (writer && kept.state === 'kept') {
      this.e.tasks.dossiers.safely('the kept change', () => this.e.tasks.dossiers.evidence(runId,
        `Attempt ${attempt} (run ${runId}) ended without being accepted; its change is kept as commit ${kept.commit} on ${kept.branch ?? `the branch of run ${runId}`}, on top of ${writer.subject.ref}, as the attempt's result.`, [writer.result], undefined, kept.commit ? [kept.commit] : []))
    } else if (writer && kept.state === 'not-kept') {
      this.e.tasks.dossiers.safely('the kept change', () => this.e.tasks.dossiers.evidence(runId,
        `Attempt ${attempt} (run ${runId}) ended without being accepted; its change is not kept as a commit (${kept.reason ?? 'no reason recorded'}): its worktree ${writer.workspace} is left as it is.`, [writer.result]))
    }
    this.saveKept(runId, outcome, { ...kept, said: true })
  }

  /**
   * A result that waited for the operator's acceptance and was not accepted (the landing's watch saw
   * the task move on, or the next attempt starts): its change is to be kept as the attempt's result now,
   * as for any attempt that ends unaccepted. Marks it `pending` once, then keeps it.
   */
  rejected(runId: string): Promise<void> {
    const row = this.e.tasks.row(runId)
    const outcome = row?.outcome ? JSON.parse(row.outcome) as TaskOutcome : undefined
    if (row?.phase === 'reported' && outcome && !outcome.kept && outcome.status !== 'not-started') {
      this.e.ctx.store.transaction((db) => void db.prepare("UPDATE workflow_tasks SET outcome = ? WHERE run_id = ? AND json_extract(outcome, '$.kept') IS NULL")
        .run(JSON.stringify({ ...outcome, kept: { state: 'pending', at: now() } }), runId))
    }
    return this.keep(runId)
  }

  /** {@link settle}'s keep of the attempt it may start from: that attempt ended, so a result of it not kept yet is kept now; never throws. */
  private async keepEnded(runId: string): Promise<void> {
    try {
      await this.rejected(runId)
    } catch (error) {
      this.e.ctx.logger.warn(`workflow: the change of run ${runId} was not kept yet: ${(error as Error)?.message ?? String(error)}`)
    }
  }

  /**
   * On start: every report whose kept change is still pending (a stop came between the report and the
   * commit), or settled and not yet said in the dossier (a stop came between the two), is asked again.
   */
  recover(): void {
    const rows = this.e.ctx.store.db.prepare(`SELECT run_id FROM workflow_tasks WHERE phase = 'reported' AND json_extract(outcome, '$.kept') IS NOT NULL
      AND (json_extract(outcome, '$.kept.state') = 'pending' OR IFNULL(json_extract(outcome, '$.kept.said'), 0) = 0) ORDER BY created_at`).all() as Array<{ run_id: string }>
    for (const { run_id } of rows) {
      void this.keep(run_id, true).catch((error: unknown) => this.e.ctx.logger.warn(`workflow: the change of run ${run_id} was not kept yet: ${(error as Error)?.message ?? String(error)}`))
    }
  }

  /** The latest run of the task the board recorded (a run it never recorded made no attempt), among the last {@link LOOK_BACK}. */
  private previous(taskId: string): TaskRow | undefined {
    const rows = this.e.ctx.store.db.prepare("SELECT * FROM workflow_tasks WHERE task_id = ? AND phase = 'reported' ORDER BY created_at DESC, rowid DESC LIMIT ?").all(taskId, LOOK_BACK) as unknown as TaskRow[]
    return rows.find((r) => (r.outcome ? (JSON.parse(r.outcome) as TaskOutcome).status : undefined) !== 'not-started')
  }

  /**
   * The run's latest writing step that left an agent's result on a git working tree, and that tree: a
   * writing step that asked questions instead of answering (T291), whose answer is that result and whose
   * edits made before it asked are in that tree, else the latest one that completed. The asking step is
   * the run's last turn, so its tree is the one the run left.
   */
  private writerOf(runId: string): Writer | undefined {
    const asked = this.askedWriter(runId)
    if (asked) return asked
    const writers = this.e.nodeRows(runId).filter((n) => n.state === 'COMPLETED' && (JSON.parse(n.spec) as ResolvedNode).capabilities.includes('develop'))
    const last = writers.at(-1)
    const result = last ? (JSON.parse(last.record) as NodeRecord).outputReceipt?.result : undefined
    return last && result ? this.treeOf(last.node_id, result) : undefined
  }

  /** The writing step of the run that asked the questions its board task waited on, with the tree its asking answer was made on (T291). */
  private askedWriter(runId: string): Writer | undefined {
    const row = this.e.tasks.row(runId)
    const question = row?.question ? JSON.parse(row.question) as TaskQuestion : undefined
    if (question?.state !== 'raised') return undefined
    const node = this.e.nodeRow(runId, question.nodeId)
    if (!node || !(JSON.parse(node.spec) as ResolvedNode).capabilities.includes('develop')) return undefined
    // The question's gate decision names the step's answer, its only input.
    const result = (this.e.ctx.artifacts.get(question.decision)?.body as { inputs?: ArtifactRef[] } | undefined)?.inputs?.[0]
    return result ? this.treeOf(node.node_id, result) : undefined
  }

  /** `result`'s working tree, when it is an agent's result on a git working tree at a known version. */
  private treeOf(nodeId: string, result: ArtifactRef): Writer | undefined {
    const body = this.e.ctx.artifacts.get(result)?.body as { schema?: string; workspace?: unknown; subject?: Subject } | undefined
    if (!body?.schema?.startsWith('agent-result@') || typeof body.workspace !== 'string' || body.subject?.type !== 'git-head' || !body.subject.version) return undefined
    return { nodeId, result, workspace: body.workspace, subject: { ref: body.subject.ref, version: body.subject.version } }
  }

  /** The kinds the run and its failed steps failed as. */
  private failures(previous: TaskRow): string[] {
    const kinds = [kindOf(this.e.runRow(previous.run_id)?.error ?? null), ...this.e.nodeRows(previous.run_id).filter((n) => n.state === 'FAILED').map((n) => kindOf(n.error))]
    return [...new Set(kinds.filter((k): k is string => k !== undefined))]
  }

  /** Why the run's work is not carried, or undefined when every bound holds (fail closed: any doubt is a reason). */
  private refusal(task: BoardTask, previous: TaskRow, writer: Writer, fresh: boolean, thisAttempt: number): string | undefined {
    const what = `run ${previous.run_id}`
    if (fresh) return `the start of attempt ${thisAttempt} asked for a fresh start: the task opts out of building on ${what}'s change (as when a review rejected its approach)`
    const served = this.served(previous)
    // The attempt before this one, or this same attempt when the board did not count the previous run
    // (it failed only on the infrastructure, ADR-0069, and gave its attempt back).
    const free = served === task.attempts.count + 1 && this.notCounted(previous)
    if (served !== task.attempts.count && !free) return `${what} served attempt ${served ?? '(unknown)'}, not attempt ${task.attempts.count}, the one before this, nor this attempt as a run the board did not count: only the immediately previous run's work is carried`
    // However the attempt ended (T271): a failed step, a failed acceptance, a cut, the review bound reached, a rejected fix, a
    // question. Its change is the attempt's result; the decision and the dossier say how it ended, and the Worker judges it again.
    if (!this.e.runRow(previous.run_id)) return `${what} is gone`
    const writes = task.writes
    if (!writes) return `task ${task.taskId} names no subject it writes, so no earlier tree is held as its own (INV-15)`
    if (writes.type !== 'git-head') return `task ${task.taskId} writes ${describe(writes)}, not a commit of a git repository`
    const admitted = previous.writes ? JSON.parse(previous.writes) as Subject : undefined
    if (admitted?.type !== writes.type) return `${what} was admitted to write ${admitted ? describe(admitted) : 'nothing'}, not ${describe(writes)}, which task ${task.taskId} writes now`
    // The commit the task writes may have moved since (dev moved: the source replays the change there), but the tree itself is
    // on the commit that attempt was admitted to write: a developer that committed moved its own subject (INV-5).
    if (writer.subject.ref !== admitted.ref) return `the tree step ${writer.nodeId} of ${what} left is on ${writer.subject.ref}, not on ${admitted.ref}, the commit task ${task.taskId} writes: its subject moved, so it is not carried`
    if (!this.e.ctx.workers.carry) return 'the workers seam cannot carry a worktree (no carry)'
    return undefined
  }

  /** How the previous attempt ended, in a few words, for the decision. */
  private ended(previous: TaskRow, nodes: NodeRow[]): string {
    const run = this.e.runRow(previous.run_id)
    const failures = this.failures(previous)
    const judged = this.judged(nodes)
    const question = previous.question ? JSON.parse(previous.question) as TaskQuestion : undefined
    return [
      run?.status === 'completed' ? 'its result went to the board, which did not accept it' : `it failed${failures.length ? ` (${failures.join(', ')})` : ''}`,
      ...(judged ? [`review ${judged.nodeId} judged the change ${judged.verdict}`] : []),
      ...(question ? [`step ${question.nodeId} asked questions`] : []),
    ].join('; ')
  }

  /** The attempt the run served, as its frame records it; undefined when it records none. */
  private served(row: TaskRow): number | undefined {
    return row.frame ? (JSON.parse(row.frame) as TaskFrame).attempt : undefined
  }

  /**
   * Whether the run was reported to its task as failed only on the infrastructure (ADR-0069): its
   * `reconciliation` decision says so. With the task's count back below the attempt it served, the
   * board did not count it (the count goes down on nothing else).
   */
  private notCounted(row: TaskRow): boolean {
    const outcome = row.outcome ? JSON.parse(row.outcome) as TaskOutcome : undefined
    if (outcome?.status !== 'reconciled' || !outcome.decision) return false
    const body = this.e.ctx.artifacts.get(outcome.decision)?.body as { decisionType?: string; outcome?: { detail?: { status?: unknown; infrastructure?: unknown } } } | undefined
    return body?.decisionType === 'reconciliation' && body.outcome?.detail?.status === 'failed' && body.outcome.detail.infrastructure !== undefined
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
  private message(row: TaskRow, from: NonNullable<TaskCarry['from']>, admission: ArtifactRef): string {
    return [
      `system: carry the work of attempt ${from.attempt} of task ${row.task_id} into run ${row.run_id}`, '',
      `Step ${from.nodeId} of run ${from.runId} made this change, and the attempt ended without being accepted; attempt ${this.served(row) ?? from.attempt + 1}, run ${row.run_id}, starts from it (decision ${admission}).`, '',
      `System-Task: ${row.task_id}`, `System-Run: ${from.runId}`,
    ].join('\n')
  }
}
