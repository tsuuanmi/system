/**
 * Landing an accepted result (docs/design/workflow-engine.md#landing-an-accepted-result, ADR-0060,
 * PROP-0013 W5): a board task whose run's result is on a working tree a Worker source holds as the
 * run's own worktree is not done with by its acceptance. Once the board has the task `done` on that
 * run's result, the engine has the source commit the tree on the worktree's branch, then asks the
 * operator, as a `merge` request on the approval queue, to merge that branch into the repository's
 * checked-out branch; on the approval, the source merges it.
 *
 * - **Exact** (INV-5): the commit is made only while the worktree is still the accepted tree, and the
 *   request binds the merge to the base branch's head and the branch's head
 *   (`landing:merge:<base>:<head>`); a moved base asks again on the new one, a moved head refuses.
 * - **Recorded** (INV-13): the commit, the merge, and every refusal is a `gate` decision of rule
 *   `workflow.landing` under the run's final step, so `explain` shows it; the request has the
 *   policy's `autonomy` decision and the operator's `approval` decision.
 * - **Fails closed** (INV-2): nothing merges without the operator's approval: a merge always asks
 *   (D56; `merge` is in `ALWAYS_ASK`, so no policy gives it `auto` or `notify`), and `forbid`
 *   refuses; with no queue, it waits; a conflict, a dirty base, or a source that cannot answer
 *   changes nothing.
 * - **Restart is reconciliation** (INV-4): the landing's state is durable on the run's
 *   `workflow_tasks` row, a request asked before a crash is adopted, and each step of the source
 *   finds its own work done instead of doing it twice. Never a force, a reset, or a push.
 *
 * The workers seam's `land` is optional: with no source that holds the tree, nothing lands, and the
 * task is done as before.
 *
 * **One landing seam** (PROP-0017 L0): what happens after the commit and a rebase, the subject the
 * merge request binds and what an approval does (`prepare`), and the landing itself on that approval
 * (`land`, on the subject the approved request names), go through the landing seam `ctx.landing`,
 * which the composition provides (the `landing-local` row: today's local merge, ADR-0060, unchanged).
 * The engine depends on the definition only: with no provider registered, the landing waits as it
 * is, never landing some other way (INV-2). The commit, the rebase, and the checks run again stay
 * here, the same for every provider.
 *
 * **A target that moved** (ADR-0068, D82): when the base branch moved since the result's work started
 * (the commit's `fork` is not the base's head), the result is rebased onto it before the merge is
 * asked, in the run's worktree, by the source that holds it: replayed, the declared generated files made
 * again; a conflict goes to a writing step on the result's own author's Worker, whose prompt says what
 * moved and that the base's behaviour is kept; then the required checks run again on the rebased tree.
 * Each move is a `gate` decision. A conflict the Worker cannot resolve, or a check that fails on the
 * rebased tree, sends the result back to the board as another attempt (`Board.reopen`), with why; a
 * target that only moved spends no attempt.
 */
import { execFileSync } from 'node:child_process'
import type { ApprovalRequest, Approvals } from '@tsuuanmi/system-approvals-core'
import { type ArtifactRef, type Board, BoardError, type BoardTask, REOPEN_REASON_MAX, type Subject } from '@tsuuanmi/system-board-core'
import { type Landed as LandedOn, type LandingProvider, type LandingTarget, sameSubject } from '@tsuuanmi/system-landing-core'
import { BRIEF_LIMITS, subjectId } from '@tsuuanmi/system-libs'
import { AdmissionFailure, type Landed, type LandStep, type RebasePhase, RUN_CHECKS, type RunCheck, type WorkerSource, type WorkRequirement } from '@tsuuanmi/system-workers-core'
import { type Draft, recordBrief, renderedChars } from './briefs.ts'
import type { Engine } from './engine.ts'
import { queueOf } from './queue.ts'
import { writes } from './review.ts'
import { clampText, literal, type ResolvedNode } from './spec.ts'
import { type NodeRecord, now, type TaskLanding, type TaskRebase, type TaskRow } from './types.ts'

/** The outcomes after which the board may hold the task `done` on this run's result. */
const SUBMITTED = new Set(['accepted', 'review', 'reconciled'])
/** The landing states still in progress: the sweep looks at them. */
const OPEN = ['watch', 'commit', 'rebase', 'resolving', 'returning', 'recheck', 'committed', 'asked', 'merging'] as const
/** The landing states the task's dossier records as evidence (ADR-0070): committed, asked to merge, and every end. */
const DOSSIER_STATES: ReadonlySet<TaskLanding['state']> = new Set(['committed', 'asked', 'merged', 'returned', 'refused', 'rejected', 'none'])
/** Rebases one landing makes at most: a target that keeps moving past them is the operator's to merge (INV-9). */
export const MAX_REBASES = 3
/** How long a rebase's conflict waits for its author's Worker to be admitted before the landing gives it up (INV-9). */
export const RESOLVE_ADMISSION_MS = 6 * 3600_000
/** How much of the resolving Worker's answer a reason quotes, at most. */
const ANSWER_CHARS = 600
/** Landings one sweep looks at, the longest unlooked-at first (INV-9). */
const PAGE = 32
const RULE = { type: 'rule', id: 'workflow.landing', version: '1' } as const
const PRODUCER = { producer: { type: 'system' as const, ref: 'workflow' } }

type Result = { artifacts: ArtifactRef[]; subject: Subject }

/** What a merge request says of a landing rebased onto its target (ADR-0068); empty when its head is not a rebase. */
const rebasedNote = (landing: TaskLanding): string => {
  const r = landing.rebase
  if (!r?.head || r.head !== landing.head) return ''
  return `${landing.base!.branch} moved since the result's work started (from ${r.fork}): the result was rebased onto it from ${r.from}${r.executionId ? `, its conflicts resolved by ${r.worker}` : ''}${r.checks?.length ? `, and its required checks (${r.checks.join(', ')}) passed again on the rebased tree` : '; no check ran on the rebased tree, as no command check ran on the result at its acceptance'}.`
}

/** Commits a landing records as reverted at most (INV-9). */
const REVERTS_MAX = 8

/**
 * The commits a landed change reverts, from its commit messages (`git revert` writes `This reverts
 * commit <sha>.`): the messages of the commits the branch holds over the base, read in the run's
 * working tree, bounded in time and size. Nothing found, or the tree unreadable, gives none: a revert
 * not seen here is simply not recorded (the metric says it counts only what was recorded).
 */
export function revertsOf(workspace: string | undefined, base: string | undefined, head: string | undefined): string[] {
  if (!workspace || !base || !head || !/^[0-9a-f]{7,64}$/.test(base) || !/^[0-9a-f]{7,64}$/.test(head)) return []
  try {
    const log = execFileSync('git', ['-C', workspace, 'log', '--format=%B', `${base}..${head}`], { encoding: 'utf8', timeout: 5000, maxBuffer: 262_144, stdio: ['ignore', 'pipe', 'ignore'] })
    return [...new Set([...log.matchAll(/This reverts commit ([0-9a-f]{7,64})/g)].map((m) => m[1]!))].slice(0, REVERTS_MAX)
  } catch {
    return []
  }
}

/** Lead or Worker text in a commit message: one line, bounded. */
const line = (text: string, max = 120): string => Array.from(text, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').replace(/ {2,}/g, ' ').trim().slice(0, max)

export class TaskLandings {
  private sweeping: Promise<void> | undefined

  constructor(private readonly e: Engine) {}

  /**
   * The provider a landing goes through after its commit (PROP-0017 L0): the provider of the seam
   * `ctx.landing` (the `landing-local` row, or another), or undefined while none is registered. The
   * engine never picks one itself: with none, a landing waits as it is (INV-2).
   */
  provider(): LandingProvider | undefined {
    return this.e.ctx.get('landing') ?? undefined
  }

  /** A landing that waits for a provider of `ctx.landing`: it stays as it is, saying why. */
  private noProvider(row: TaskRow, landing: TaskLanding, what: string): TaskLanding {
    const why = `no landing provider (ctx.landing) is registered: ${what} waits for one (the landing-local row provides it); nothing is merged meanwhile`
    return landing.reason === why ? this.touch(row, landing) : { ...landing, reason: why, at: now() }
  }

  /** What a committed landing would land: its run's branch at its head, on its base as it was read. */
  private targetOf(row: TaskRow, landing: TaskLanding): LandingTarget {
    return { runId: row.run_id, workspace: landing.workspace!, repository: landing.repository!, branch: landing.branch!, head: landing.head!, base: landing.base! }
  }

  /**
   * In the transaction that reports a run: a completed run whose result reached its task, on a git
   * working tree one of its result artifacts names, is watched for the task's acceptance.
   */
  due(row: TaskRow, status: string): void {
    if (!row.result || !SUBMITTED.has(status) || row.landing) return
    const tree = this.treeOf(JSON.parse(row.result) as Result)
    if (!tree) return
    this.e.ctx.store.db.prepare('UPDATE workflow_tasks SET landing = ? WHERE run_id = ? AND landing IS NULL')
      .run(JSON.stringify({ state: 'watch', ...tree, at: now() } satisfies TaskLanding), row.run_id)
  }

  /** The landing of a run's result as it stands, for the run's view. */
  view(row: TaskRow): TaskLanding | undefined {
    return row.landing ? JSON.parse(row.landing) as TaskLanding : undefined
  }

  /** Look at the landings in progress (every `approvalPollSeconds`, and once at start), one sweep at a time. */
  sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping
    const sweeping = this.sweepOnce().finally(() => {
      this.sweeping = undefined
    })
    this.sweeping = sweeping
    return sweeping
  }

  async close(): Promise<void> {
    await this.sweeping
  }

  private async sweepOnce(): Promise<void> {
    const board = this.e.board
    if (!board || this.e.stopped.signal.aborted) return
    const rows = this.e.ctx.store.db.prepare(`SELECT * FROM workflow_tasks WHERE json_extract(landing, '$.state') IN (${OPEN.map(() => '?').join(', ')})
      ORDER BY json_extract(landing, '$.at') LIMIT ${PAGE}`).all(...OPEN) as unknown as TaskRow[]
    for (const row of rows) {
      if (this.e.stopped.signal.aborted) return
      try {
        await this.step(row, board)
      } catch (error) {
        this.e.ctx.logger.warn(`workflow: the landing of run ${row.run_id}'s result is looked at again: ${(error as Error)?.message ?? String(error)}`)
      }
    }
  }

  /** Move one landing on as far as it goes now. */
  private async step(row: TaskRow, board: Board): Promise<void> {
    let landing = this.view(row)!
    for (let moves = 0; moves < OPEN.length + 1; moves++) {
      const next = await this.move(row, board, landing)
      if (!next) return
      this.save(row, next)
      if (!(OPEN as readonly string[]).includes(next.state) || next.state === landing.state) return
      landing = next
    }
  }

  /** The landing's next state, or undefined when it waits as it is. */
  private async move(row: TaskRow, board: Board, landing: TaskLanding): Promise<TaskLanding | undefined> {
    switch (landing.state) {
      case 'watch': return this.watch(row, board, landing)
      case 'commit': return this.commit(row, board, landing)
      case 'rebase': return this.rebase(row, board, landing)
      case 'resolving': return this.resolving(row, board, landing)
      case 'returning': return this.returning(row, board, landing)
      case 'recheck': return this.recheck(row, board, landing)
      case 'committed': return this.ask(row, board, landing)
      case 'asked': return this.answer(row, landing)
      case 'merging': return this.merge(row, board, landing)
      default: return undefined
    }
  }

  /** The task is `done` on this run's accepted result: commit it. Still in review: wait. Anything else: nothing lands. */
  private async watch(row: TaskRow, board: Board, landing: TaskLanding): Promise<TaskLanding | undefined> {
    const task = await board.task(row.task_id)
    if (!task) return { ...landing, state: 'none', reason: `task ${row.task_id} is unknown to the board`, at: now() }
    // A result held for the operator and not accepted ends its attempt unaccepted: its change is kept as the attempt's result (T271).
    const unaccepted = (reason: string): TaskLanding => {
      void this.e.tasks.carries.rejected(row.run_id).catch((error: unknown) => this.e.ctx.logger.warn(`workflow: the change of run ${row.run_id} was not kept yet: ${(error as Error)?.message ?? String(error)}`))
      return { ...landing, state: 'none', reason, at: now() }
    }
    if (task.run?.runId !== row.run_id) return unaccepted(`task ${task.taskId} moved on to another attempt`)
    if (task.state === 'review' || task.state === 'running' || task.state === 'waiting-for-approval') return this.touch(row, landing)
    if (task.state !== 'done' || !task.result?.acceptance) return unaccepted(`task ${task.taskId} is ${task.state}: its result was not accepted`)
    return { ...landing, state: 'commit', acceptance: task.result.acceptance, at: now() }
  }

  /** Have the source that holds the worktree commit the accepted tree on its branch. */
  private async commit(row: TaskRow, board: Board, landing: TaskLanding): Promise<TaskLanding | undefined> {
    const land = this.e.ctx.workers.land
    if (!land) return { ...landing, state: 'none', reason: 'the workers seam cannot land a result (no land)', at: now() }
    const task = await board.task(row.task_id)
    const message = this.commitMessage(row, task, landing)
    const landed = await land.call(this.e.ctx.workers, { step: 'commit', runId: row.run_id, workspace: landing.workspace!, subject: landing.subject!, message } satisfies LandStep)
    if (!landed) return { ...landing, state: 'none', reason: `no Worker source holds ${landing.workspace} as the worktree of run ${row.run_id}, so nothing lands`, at: now() }
    if (landed.outcome === 'refused') {
      // A run of the workflow run may still write the tree: looked at again, never committed under it (INV-15).
      if (landed.cause === 'busy') return landing.reason === landed.reason ? this.touch(row, landing) : { ...landing, reason: landed.reason, at: now() }
      return this.refuse(row, landing, 'commit', landed.cause, landed.reason, [landing.acceptance!])
    }
    if (landed.outcome !== 'committed') return this.refuse(row, landing, 'commit', 'failed', `source ${landed.source} answered ${landed.outcome} to a commit`, [landing.acceptance!])
    // The run changed nothing (a review, say): the base already is the accepted tree.
    if (!landed.committed && landed.contained && landed.head === landing.subject!.ref) return { ...landing, state: 'none', reason: `the accepted tree holds no change on ${landed.base.branch}: nothing to land`, at: now() }
    const decision = this.decide(row, 'commit', `Is board task ${row.task_id}'s accepted result committed on ${landed.branch}, to be landed in ${landed.base.branch}?`, [landing.acceptance!, ...this.resultOf(row).artifacts], [
      { option: 'commit', selected: true, reasons: [`the worktree ${landing.workspace} is still the accepted tree ${subjectId({ type: 'git-head', ...landing.subject! })}: ${landed.committed ? `its changes are committed on ${landed.branch} as ${landed.head}` : `${landed.branch} already holds them at ${landed.head}`}, by the system`] },
      { option: 'refuse', selected: false, reasons: ['not refuse: the tree did not move after the acceptance, and no run of it is left to write it'] },
    ], { step: 'commit', source: landed.source, branch: landed.branch, head: landed.head, committed: landed.committed, base: landed.base, contained: landed.contained, acceptance: landing.acceptance })
    const committed: TaskLanding = {
      ...landing, state: 'committed', repository: landed.repository, branch: landed.branch, head: landed.head, base: landed.base, stat: landed.stat,
      decisions: [...(landing.decisions ?? []), decision], at: now(),
    }
    // Asked again (a base that moved): what the earlier ask left is not this one's.
    for (const key of ['reason', 'cause', 'requestId', 'expiresAt', 'approval'] as const) delete committed[key]
    if (landed.contained) return this.merged(row, committed, { commit: landed.base.sha, already: true, source: landed.source }, [decision], `${landed.base.branch} at ${landed.base.sha} already holds ${landed.head}: nothing is left to merge`)
    if (landed.fork) committed.fork = landed.fork
    // The base moved since the result's work started: it is rebased there before the merge is asked (ADR-0068).
    if (landed.fork && landed.fork !== landed.base.sha) {
      const count = landing.rebase?.head ? landing.rebase.count + 1 : landing.rebase?.count ?? 0
      if (count >= MAX_REBASES) {
        return this.refuse(row, committed, 'rebase', 'moving', `${landed.base.branch} moved again after ${count} rebase(s) of this result (now at ${landed.base.sha}): a target that keeps moving is not followed further; merge ${landed.branch} by hand`, [decision])
      }
      return { ...committed, state: 'rebase', rebase: { from: landed.head, base: landed.base, fork: landed.fork, count } }
    }
    return committed
  }

  // --- a target that moved (ADR-0068) ---

  /** Have the source rebase the result onto the base: rebased, its checks run again; conflicted, a writing step resolves it. */
  private async rebase(row: TaskRow, board: Board, landing: TaskLanding): Promise<TaskLanding | undefined> {
    const landed = await this.landRebase(row, landing, 'start')
    if (!landed) return this.refuse(row, landing, 'rebase', 'gone', `no Worker source holds ${landing.workspace} as the worktree of run ${row.run_id} any more, so the result is not rebased`, [landing.acceptance!])
    if (landed.outcome === 'rebased') return this.rebased(row, landing, landed)
    if (landed.outcome === 'conflicted') return this.conflicted(row, board, landing, landed)
    if (landed.outcome !== 'refused') return this.refuse(row, landing, 'rebase', 'failed', `source ${landed.source} answered ${landed.outcome} to a rebase`, [landing.acceptance!])
    if (landed.cause === 'busy') return landing.reason === landed.reason ? this.touch(row, landing) : { ...landing, reason: landed.reason, at: now() }
    // The base moved again before the rebase began: the commit reads where it is now.
    if (landed.cause === 'base-moved') return { ...landing, state: 'commit', reason: `${landed.reason}; the base is read again`, at: now() }
    return this.refuse(row, landing, 'rebase', landed.cause, landed.reason, [landing.acceptance!])
  }

  /**
   * The rebase is committed on the branch: a `gate` decision records it (what moved, from which head
   * to which, how its conflicts were resolved, the generated files made again), then its required
   * checks run again on the rebased tree.
   */
  private rebased(row: TaskRow, landing: TaskLanding, landed: Extract<Landed, { outcome: 'rebased' }> & { source: string }): TaskLanding {
    const r = landing.rebase!
    const regenerated = landed.regenerated
    // Each reason within a decision's 300 characters (decision@1): the detail keeps every value whole.
    const resolved = r.executionId ? `its conflicts were resolved by ${r.worker}, the Worker of step ${r.nodeId} that wrote the result (execution ${r.executionId}), in ${this.filesOf(r)}` : 'it replayed with no conflict'
    const checks = this.requiredChecks(row, landing)
    const decision = this.decide(row, 'rebase', `Is board task ${row.task_id}'s accepted result rebased onto ${r.base.branch} at ${r.base.sha} before its merge is asked?`,
      [landing.acceptance!, ...(landing.decisions ?? []).slice(-1), ...((regenerated?.autonomy ?? []) as ArtifactRef[])], [
        {
          option: 'rebase', selected: true, reasons: [
            `${r.base.branch} moved from ${r.fork} to ${r.base.sha} since the result's work started`,
            `its change (${r.from}) is made again on top of it as ${landed.head}, in the run's worktree`,
            resolved,
            ...(regenerated ? [`the files the repository declares generated were made again by its commands (${regenerated.commands.join('; ')}): ${regenerated.files.join(', ') || 'none changed'}`] : []),
            checks.length ? `its required checks (${checks.join(', ')}) run again on the rebased tree ${subjectId({ type: 'git-head', ...landed.subject })} before the merge is asked` : 'no command check ran on the result at its acceptance, so none runs again; the merge request says so',
          ],
        },
        { option: 'merge-as-is', selected: false, reasons: [`not merge as it is: a result based on an older ${r.base.branch} conflicts with it, or merges a tree no check ran on (D82)`] },
      ], {
        step: 'rebase', source: landed.source, branch: landed.branch, from: r.from, head: landed.head, base: r.base, fork: r.fork, subject: landed.subject, already: landed.already,
        ...(r.executionId ? { resolvedBy: { nodeId: r.nodeId, worker: r.worker, executionId: r.executionId } } : {}),
        ...(regenerated ? { regenerated: { files: regenerated.files, commands: regenerated.commands } } : {}), checks,
      })
    const next: TaskLanding = { ...landing, state: 'recheck', rebase: { ...r, head: landed.head, subject: landed.subject, stat: landed.stat, checks }, decisions: [...(landing.decisions ?? []), decision], at: now() }
    delete next.reason
    return next
  }

  /** A conflict the source could not replay past: the result's own author's Worker gets a writing step to resolve it. */
  private async conflicted(row: TaskRow, board: Board, landing: TaskLanding, landed: Extract<Landed, { outcome: 'conflicted' }> & { source: string }): Promise<TaskLanding> {
    const r: TaskRebase = { ...landing.rebase!, fork: landed.fork || landing.rebase!.fork, files: landed.files, more: landed.more, moved: landed.moved }
    const author = this.authorOf(row, landing)
    if (!author) {
      const why = `the rebase of ${landing.branch} onto ${r.base.branch} at ${r.base.sha} conflicts in ${this.filesOf(r)}, and no writing step of run ${row.run_id} wrote the tree, so no Worker of the result's author resolves it`
      return this.giveUp({ ...landing, rebase: r }, why, [landing.acceptance!])
    }
    const task = await board.task(row.task_id)
    const prompt = this.resolvePrompt(row, task, landing, r)
    const written = this.resolution(row, r, author, prompt)
    if ('why' in written) return this.giveUp({ ...landing, rebase: r }, `the rebase of ${landing.branch} onto ${r.base.branch} at ${r.base.sha} conflicts in ${this.filesOf(r)}, and its resolving step cannot be briefed: ${written.why}`, [landing.acceptance!])
    const brief = await written.brief()
    const decision = this.decide(row, 'resolve', `Does a writing step resolve the conflicts of board task ${row.task_id}'s rebase onto ${r.base.branch} at ${r.base.sha}?`, [landing.acceptance!, ...(landing.decisions ?? []).slice(-1)], [
      {
        option: 'resolve', selected: true, reasons: [
          `the result's change conflicts with what ${r.base.branch} gained since ${r.fork}, in ${this.filesOf(r)}`,
          `${author.worker}, the Worker of step ${author.nodeId} that wrote the result, resolves it in the run's worktree, keeping ${r.base.branch}'s behaviour`,
        ],
      },
      { option: 'return', selected: false, reasons: ['not sent back yet: a conflict is first its author\'s to resolve; only one it cannot resolve goes back as another attempt'] },
    ], { step: 'resolve', source: landed.source, from: r.from, base: r.base, fork: r.fork, files: r.files, more: r.more, nodeId: author.nodeId, worker: author.worker })
    return { ...landing, state: 'resolving', rebase: { ...r, nodeId: author.nodeId, worker: author.worker, source: author.source, prompt, brief: brief.ref, chars: brief.chars, since: now() }, decisions: [...(landing.decisions ?? []), decision], at: now() }
  }

  /**
   * The writing step that resolves the rebase's conflict: started once (its key the run, the head, and
   * the base, so a restart finds it, INV-4) on the result's author's Worker only, in the run's worktree;
   * then read each sweep until it ends. Completed, the source commits the resolution once no marker is
   * left; one it cannot (markers left), a failed step, or a Worker not admitted within
   * {@link RESOLVE_ADMISSION_MS}, sends the result back as another attempt, the branch put back.
   */
  private async resolving(row: TaskRow, board: Board, landing: TaskLanding): Promise<TaskLanding | undefined> {
    const r = landing.rebase!
    const source = this.e.ctx.workers.source(r.source!)
    if (!source) return landing.reason ? this.touch(row, landing) : { ...landing, reason: `Worker source ${r.source} is not registered now: the rebase's conflict waits for it`, at: now() }
    if (!r.executionId) {
      const started = await this.startResolution(row, landing, source)
      if ('why' in started) {
        if (Date.now() - Date.parse(r.since ?? landing.at) < RESOLVE_ADMISSION_MS) return landing.reason === started.why ? this.touch(row, landing) : { ...landing, reason: started.why, at: now() }
        return this.giveUp(landing, `the rebase onto ${r.base.branch} at ${r.base.sha} conflicts in ${this.filesOf(r)}, and the result's author's Worker ${r.worker} was not admitted to resolve it within ${RESOLVE_ADMISSION_MS / 3600_000} hours: ${started.why}`, [landing.acceptance!])
      }
      const next: TaskLanding = { ...landing, rebase: { ...r, executionId: started.id }, at: now() }
      delete next.reason
      return next
    }
    const execution = source.get(r.executionId)
    if (!execution) return this.giveUp(landing,`the rebase's resolving step (execution ${r.executionId} on ${r.source}) is unknown to its source`, [landing.acceptance!])
    if (execution.status === 'queued' || execution.status === 'running') return this.touch(row, landing)
    if (execution.status === 'failed') {
      return this.giveUp(landing, `${r.worker} could not resolve the conflicts of the rebase onto ${r.base.branch} at ${r.base.sha} in ${this.filesOf(r)}: its step failed (${execution.error?.kind ?? 'unknown'}: ${(execution.error?.message ?? '').slice(0, 300)})`, [landing.acceptance!, ...execution.decisions as ArtifactRef[]])
    }
    const landed = await this.landRebase(row, landing, 'resolved')
    if (!landed) return this.refuse(row, landing, 'rebase', 'gone', `no Worker source holds the worktree of run ${row.run_id} any more`, [landing.acceptance!])
    if (landed.outcome === 'rebased') return this.rebased(row, landing, landed)
    if (landed.outcome === 'refused' && landed.cause === 'busy') return landing.reason === landed.reason ? this.touch(row, landing) : { ...landing, reason: landed.reason, at: now() }
    const said = execution.result ? this.answerOf(execution.result as ArtifactRef) : ''
    const why = landed.outcome === 'refused' ? landed.reason : `source ${landed.source} answered ${landed.outcome} to a resolved rebase`
    const inputs = [landing.acceptance!, ...(execution.result ? [execution.result as ArtifactRef] : [])]
    if (landed.outcome === 'refused' && landed.cause === 'conflict') return this.giveUp(landing,`${r.worker} did not resolve the rebase onto ${r.base.branch} at ${r.base.sha}: ${why}${said ? `. It said: ${said}` : ''}`, inputs)
    return this.refuse(row, landing, 'rebase', landed.outcome === 'refused' ? landed.cause : 'failed', why, inputs)
  }

  /**
   * The resolving step's requirement (the author's step's, its objective the resolution) and its brief,
   * recorded once when the conflict is found and kept on the landing, so a restart starts it on the same
   * brief (INV-4): a board task's brief, naming the task, its project, and its attempt as every step of
   * its run does, so the execution's reservations and usage are the task's and the project's (within
   * their caps), with the resolution's instructions and the budget the task has left; the sandbox the
   * author's source declares for the run.
   */
  private resolution(row: TaskRow, r: TaskRebase, author: { nodeId: string; worker: string; source: string }, prompt: string): { why: string } | { requirement: WorkRequirement; brief: () => Promise<{ ref: ArtifactRef; chars: number }> } {
    const node = this.e.nodeRows(row.run_id).find((n) => n.node_id === author.nodeId)
    const written = node ? (JSON.parse(node.record) as NodeRecord).requirement : undefined
    const run = this.e.runRow(row.run_id)
    if (!node || !written || !run) return { why: `step ${author.nodeId} of run ${row.run_id} is not known now` }
    const requirement: WorkRequirement = { ...written, objective: `Resolve the conflicts of board task ${row.task_id}'s rebase onto ${r.base.branch} (ADR-0068)` }
    return {
      requirement,
      brief: async () => {
        const frame = this.e.tasks.frame(row.run_id)
        const draft: Draft = {
          schema: frame ? 'brief@1.2' : 'brief@1.1',
          ...(frame ? { projectId: frame.projectId, taskId: frame.taskId, attempt: frame.attempt } : {}),
          goal: clampText(requirement.objective, BRIEF_LIMITS.goal),
          acceptance: [{ id: 'resolved', statement: clampText(`No conflict marker is left, ${r.base.branch}'s behaviour is kept, and the result's change is carried over it`, BRIEF_LIMITS.statement) }],
          artifacts: [],
          instructions: literal(prompt).segments,
          budget: { remaining: this.e.tasks.bound(row.run_id) ? await this.e.tasks.budgetAt(row.run_id) : [] },
          classification: requirement.data.classification,
        }
        const sandbox = this.e.ctx.workers.source(author.source)?.sandbox?.(author.worker, row.run_id)
        return { ref: recordBrief(this.e, run, node, draft, sandbox), chars: renderedChars(this.e, draft) }
      },
    }
  }

  /** Route the resolving step to the result's author's Worker only, and start it on its brief; its execution id, or why it was not started. */
  private async startResolution(row: TaskRow, landing: TaskLanding, source: WorkerSource): Promise<{ id: string } | { why: string }> {
    const r = landing.rebase!
    if (!r.brief) return { why: `the rebase's resolving step was never briefed` }
    const written = this.resolution(row, r, { nodeId: r.nodeId!, worker: r.worker!, source: r.source! }, r.prompt!)
    if ('why' in written) return written
    const { requirement } = written
    let admitted
    try {
      admitted = await this.e.ctx.workers.route(requirement, { restrict: { workers: [r.worker!], reason: `the rebase's conflict is resolved by the result's own author, ${r.worker} (ADR-0068)` }, input: { chars: r.chars ?? r.prompt!.length }, producer: 'workflow' })
    } catch (error) {
      if (error instanceof AdmissionFailure) return { why: `${r.worker} is not admitted now: ${error.message.slice(0, 300)}` }
      throw error
    }
    try {
      if (admitted.source !== r.source) return { why: `${r.worker} is described by ${admitted.source} now, not ${r.source}` }
      const started = source.start({
        key: `landing-rebase:${row.run_id}:${r.from}:${r.base.sha}`, worker: r.worker!, brief: r.brief, runId: row.run_id,
        requirement, decisions: admitted.decisions, ...(admitted.tier ? { tier: admitted.tier } : {}),
      })
      return { id: started.id }
    } finally {
      admitted.release()
    }
  }

  /** Run the required checks again on the rebased tree: all passed, the merge is asked on it; one failed, the result goes back; one that did not run, the landing stops for the operator. */
  private async recheck(row: TaskRow, board: Board, landing: TaskLanding): Promise<TaskLanding | undefined> {
    const r = landing.rebase!
    const checks = this.requiredChecks(row, landing)
    const verified = (inputs: ArtifactRef[]): TaskLanding => {
      const next: TaskLanding = { ...landing, state: 'committed', head: r.head!, stat: r.stat ?? '', base: r.base, decisions: [...(landing.decisions ?? []), ...inputs], at: now() }
      delete next.reason
      return next
    }
    if (!checks.length) return verified([])
    const check = this.e.ctx.workers.check
    if (typeof check !== 'function') return this.refuse(row, landing, 'rebase', 'checks', `the rebased tree's required checks (${checks.join(', ')}) cannot run: the workers seam runs no check; merge ${landing.branch} by hand once they pass`, [landing.acceptance!])
    const checked = await check.call(this.e.ctx.workers, {
      runId: row.run_id, workspace: landing.workspace!, subject: r.subject!, checks,
      classification: this.e.runRow(row.run_id)?.classification ?? this.e.ctx.egress.defaultClassification,
    }, this.e.stopped.signal)
    if (!checked) return this.refuse(row, landing, 'rebase', 'gone', `no Worker source holds the worktree ${landing.workspace} of run ${row.run_id} to check the rebased tree`, [landing.acceptance!])
    if (checked.outcome === 'refused') {
      if (checked.cause === 'busy') return landing.reason === checked.reason ? this.touch(row, landing) : { ...landing, reason: checked.reason, at: now() }
      return this.refuse(row, landing, 'rebase', 'checks', `the rebased tree's required checks did not run (${checked.cause}): ${checked.reason}`, [landing.acceptance!])
    }
    const failed = checked.results.filter((c) => checks.includes(c.check) && c.outcome === 'failed')
    const pending = checks.filter((c) => !checked.results.some((x) => x.check === c && x.outcome !== 'error'))
    const evidence = checked.evidence ? [checked.evidence as ArtifactRef] : []
    const tree = subjectId({ type: 'git-head', ...r.subject! })
    const said = checked.results.map((c) => `${c.check} ${c.outcome}${c.exitCode !== undefined ? ` (exit ${c.exitCode})` : ''}`).join(', ')
    const option = failed.length ? 'return' : pending.length ? 'hold' : 'pass'
    const decision = this.decide(row, option === 'pass' ? 'recheck' : option, `Do board task ${row.task_id}'s required checks pass on its rebased tree ${tree}?`, [...(landing.decisions ?? []).slice(-1), ...evidence], [
      { option: 'recheck', selected: option === 'pass', reasons: option === 'pass' ? [`each of ${checks.join(', ')} passed on the rebased tree: ${said}`, 'the merge is asked on it'] : ['not passed: a merge is asked only on a rebased tree whose required checks all passed (INV-2, INV-5)'] },
      { option: 'return', selected: option === 'return', reasons: option === 'return' ? [`${failed.map((c) => c.check).join(', ')} failed on the rebased tree: ${said}; the result does not hold on ${r.base.branch} as it is now, so it goes back as another attempt`] : ['not sent back: no check failed on the rebased tree'] },
      {
        option: 'hold', selected: option === 'hold', reasons: option === 'hold'
          ? [`${pending.join(', ')} did not run to an exit code on the rebased tree: neither passed nor failed, so nothing is merged and the operator decides`, line(checked.results.filter((c) => c.outcome === 'error').map((c) => c.reason).join('; '), 290)]
          : ['not held: every check ran to an exit code'],
      },
    ], { step: 'recheck', source: checked.source, subject: r.subject, checks, results: checked.results.map((c) => ({ check: c.check, outcome: c.outcome, ...(c.exitCode !== undefined ? { exitCode: c.exitCode } : {}) })), ...(checked.evidence ? { evidence: checked.evidence } : {}) })
    const recorded: TaskLanding = { ...landing, decisions: [...(landing.decisions ?? []), decision] }
    if (failed.length) return this.sendBack(row, board, recorded, `its required ${failed.map((c) => c.check).join(', ')} check(s) failed on the result rebased onto ${r.base.branch} at ${r.base.sha} (${said}): the change does not hold with what ${r.base.branch} gained since ${r.fork}`, decision)
    if (pending.length) return this.refuse(row, recorded, 'rebase', 'checks', `the rebased tree's ${pending.join(', ')} check(s) did not run to an exit code: nothing is merged; run them on ${landing.branch} at ${r.head} and merge it by hand once they pass`, [decision])
    return verified([decision])
  }

  /**
   * The checks that run again on the rebased tree: the command checks the run's own acceptance decision
   * required and asked of its exact result (ADR-0063; `workflow_tasks.acceptance`, kept whoever
   * accepted it on the board, the operator included), with any the board's final acceptance names:
   * those it reported (`checks`), and those its check run asked (`checkRun.asked`) that stayed pending,
   * which ADR-0063 leaves out of `checks`: one that timed out, was stopped, or was not let run. A
   * pending one is required on the rebased tree all the same: an operator's acceptance of a result whose
   * check did not run is no pass of the rebased tree. Left out are only those the repository has no
   * command for (the check run's `check-run` evidence names no `argv` for them, or none ran at all):
   * they cannot run on any tree. A check run refused or not run at all leaves every check it asked
   * required. Only a result of which no check was asked that the repository can run (one with no
   * checks configured) has none run again; the merge request says so.
   */
  private requiredChecks(row: TaskRow, landing: TaskLanding): RunCheck[] {
    if (landing.rebase?.checks) return landing.rebase.checks as RunCheck[]
    type Detail = { checks?: Record<string, boolean>; checkRun?: { asked?: unknown; outcome?: unknown; evidence?: unknown } }
    const names = (value: unknown): string[] => Array.isArray(value) ? value.filter((c): c is string => typeof c === 'string') : []
    const body = (ref: unknown): unknown => typeof ref === 'string' ? this.e.ctx.artifacts.get(ref as ArtifactRef)?.body : undefined
    const checksOf = (ref: string | null | undefined): string[] => {
      const detail = (body(ref) as { outcome?: { detail?: Detail } } | undefined)?.outcome?.detail
      const ran = detail?.checkRun
      let asked = names(ran?.asked)
      if (ran?.outcome === 'checked') {
        // A command the repository configures for the check: the source ran it, or meant to.
        const records = (body(ran.evidence) as { checks?: Array<{ check?: unknown; argv?: unknown }> } | undefined)?.checks ?? []
        asked = asked.filter((c) => records.some((r) => r.check === c && Array.isArray(r.argv) && r.argv.length > 0))
      }
      return [...Object.keys(detail?.checks ?? {}), ...asked]
    }
    const reported = new Set([...checksOf(row.acceptance), ...checksOf(landing.acceptance)])
    return RUN_CHECKS.filter((c) => reported.has(c))
  }

  /**
   * The rebase cannot go on through the result's author: `returning`, with why, saved before anything
   * is put back, so that a restart between the branch put back and the board's reopen finishes both
   * instead of reading the put-back branch as a moved head (INV-4). {@link returning} does the rest.
   */
  private giveUp(landing: TaskLanding, why: string, inputs: ArtifactRef[]): TaskLanding {
    return { ...landing, state: 'returning', rebase: { ...landing.rebase!, returning: { why, inputs } }, at: now() }
  }

  /**
   * A rebase given up: the branch put back at the head it was rebased from (the source's `abandon`
   * finds its own work done after a restart), the `return` decision recorded and saved once, then the
   * result sent back as another attempt ({@link sendBack} finds a task already sent back).
   */
  private async returning(row: TaskRow, board: Board, landing: TaskLanding): Promise<TaskLanding> {
    const r = landing.rebase!
    const { why, inputs } = r.returning!
    let decision = r.returning!.decision
    let current = landing
    if (!decision) {
      const back = await this.landRebase(row, landing, 'abandon').catch((error: unknown) => ({ outcome: 'refused' as const, cause: 'failed' as const, reason: (error as Error).message, source: 'workers' }))
      const put = back?.outcome === 'abandoned' ? `${landing.branch} is back at ${r.from}${back.left.length ? ` (${back.left.length} untracked file(s) the resolution made left there)` : ''}` : `${landing.branch} was not put back (${back ? back.outcome === 'refused' ? back.reason : back.outcome : 'no source holds the worktree'})`
      decision = this.decide(row, 'return', `Does board task ${row.task_id}'s accepted result go back as another attempt?`, [...inputs, ...(landing.decisions ?? []).slice(-1)], [
        { option: 'return', selected: true, reasons: [why, put] },
        { option: 'merge-as-is', selected: false, reasons: ['not merge as it is: it conflicts with the base as it is now, and no one resolved it'] },
      ], { step: 'return', from: r.from, base: r.base, files: r.files ?? [] })
      current = { ...landing, rebase: { ...r, returning: { why, inputs, decision } }, decisions: [...(landing.decisions ?? []), decision], at: now() }
      // Saved before the board is asked: a restart sends it back on this decision, never records another.
      this.save(row, current)
    }
    return this.sendBack(row, board, current, why, decision)
  }

  /**
   * Send the result back to the board as another attempt (`Board.reopen`), naming `decision` and why:
   * `returned`. A board that cannot (no `reopen`) or refuses leaves the landing refused, nothing merged.
   * A task that is no longer done on this result (sent back before a restart) is `returned` as it is.
   */
  private async sendBack(row: TaskRow, board: Board, landing: TaskLanding, reason: string, decision: ArtifactRef): Promise<TaskLanding> {
    const returned = (note: string): TaskLanding => {
      this.e.ctx.logger.warn(`workflow: board task ${row.task_id}'s accepted result (run ${row.run_id}) is not landed and goes back as another attempt: ${reason}`)
      return { ...landing, state: 'returned', reason: `${reason}${note}`, at: now() }
    }
    const task = await board.task(row.task_id)
    if (!task || task.state !== 'done' || task.run?.runId !== row.run_id || task.result?.acceptance !== landing.acceptance) return returned(`; task ${row.task_id} is ${task?.state ?? 'unknown'} now`)
    if (typeof board.reopen !== 'function') return this.refuse(row, landing, 'return', 'failed', `${reason}; the board cannot send a done task back (no reopen, board contract before 1.4): it stays done, and nothing is merged`, [decision])
    try {
      await board.reopen(row.task_id, { runId: row.run_id, acceptance: landing.acceptance!, decision, reason: reason.slice(0, REOPEN_REASON_MAX) })
    } catch (error) {
      if (!(error instanceof BoardError)) throw error
      return this.refuse(row, landing, 'return', error.failure, `${reason}; the board did not send it back: ${error.message}`, [decision])
    }
    return returned('')
  }

  private landRebase(row: TaskRow, landing: TaskLanding, phase: RebasePhase): Promise<(Landed & { source: string }) | undefined> {
    const land = this.e.ctx.workers.land
    if (!land) return Promise.resolve(undefined)
    const r = landing.rebase!
    const message = `Rebased onto ${r.base.branch} at ${r.base.sha} (it moved from ${r.fork}) by the landing of run ${row.run_id}, board task ${row.task_id}${r.executionId ? `; its conflicts resolved by ${r.worker} (execution ${r.executionId})` : ''}.`
    return land.call(this.e.ctx.workers, { step: 'rebase', runId: row.run_id, workspace: landing.workspace!, phase, head: r.from, base: r.base, message } satisfies LandStep)
  }

  /**
   * The step that wrote the result's tree, whose Worker resolves its rebase (the result's own author):
   * the latest completed writing step of the run (one that needs `develop`: the template's writing
   * step, or the last fix a review grew from it), whose result is an agent's, written in the result's
   * worktree with a writing sandbox, and not a review bound to a subject. A later step that only ran
   * in the worktree (a validation, even on a writing sandbox) wrote nothing of it, so it is never the author.
   */
  private authorOf(row: TaskRow, landing: TaskLanding): { nodeId: string; worker: string; source: string } | undefined {
    for (const node of this.e.nodeRows(row.run_id).filter((n) => n.state === 'COMPLETED').reverse()) {
      if (node.subject || !node.worker || !node.source || !writes(JSON.parse(node.spec) as ResolvedNode)) continue
      const result = (JSON.parse(node.record) as NodeRecord).outputReceipt?.result
      const body = result ? this.e.ctx.artifacts.get(result)?.body as { schema?: string; workspace?: string; sandbox?: string } | undefined : undefined
      if (body?.schema?.startsWith('agent-result@') && body.workspace === landing.workspace && body.sandbox === 'workspace-write') return { nodeId: node.node_id, worker: node.worker, source: node.source }
    }
    return undefined
  }

  /**
   * What the resolving step is told: the task, what moved on the base and where, the files in
   * conflict, and that the base's behaviour is kept while the result's change is carried over it; to
   * leave no marker, commit nothing, and say what it did, or leave the markers and say why.
   */
  private resolvePrompt(row: TaskRow, task: BoardTask | undefined, landing: TaskLanding, r: TaskRebase): string {
    return [
      `Board task ${row.task_id}${task ? ` ("${line(task.title, 160)}")` : ''} was accepted on run ${row.run_id}'s result, and its landing is rebasing it onto ${r.base.branch}, which moved since the result's work started.`,
      '',
      `What moved: ${r.base.branch} went from ${r.fork} to ${r.base.sha}${r.moved?.length ? `, with these commits (newest first${r.moved.length >= 20 ? ', the latest 20' : ''}):\n${r.moved.map((m) => `- ${line(m, 160)}`).join('\n')}` : '.'}`,
      '',
      `Your worktree ${landing.workspace} is on ${landing.branch} at ${r.base.sha}, holding the result's change (${r.from}) replayed on top, uncommitted. These files have conflicts, marked with <<<<<<< and >>>>>>> lines: ${this.filesOf(r)}.`,
      '',
      `Resolve every conflict so the result's change applies on top of ${r.base.branch} as it is now. ${r.base.branch}'s behaviour must be kept: never drop or undo a change that came from it; carry the result's own change over it. Where both sides added something under the same number (an ADR, a migration version, a schema version), keep ${r.base.branch}'s and give the result's the next free number, updating every reference to it.`,
      '',
      'Do not commit and do not run git: the landing commits your resolution, makes the generated files again, and runs the required checks on the rebased tree. Leave no conflict marker in any file. When you are done, answer with a short paragraph saying what you resolved and how. If a conflict cannot be resolved without changing what ' + r.base.branch + ' does, leave its markers in place and say why: the result then goes back to the board as another attempt.',
    ].join('\n')
  }

  /** The conflicted files in words, bounded. */
  private filesOf(r: TaskRebase): string {
    return `${(r.files ?? []).join(', ') || 'files git did not name'}${r.more ? ` and ${r.more} more` : ''}`
  }

  /** The start of a Worker's stored answer, on one line. */
  private answerOf(result: ArtifactRef): string {
    const text = (this.e.ctx.artifacts.get(result)?.body as { text?: unknown } | undefined)?.text
    return typeof text === 'string' ? line(text, ANSWER_CHARS) : ''
  }

  /**
   * Put the merge to the autonomy policy: `ask` opens one request on its exact version (an earlier
   * one adopted), `forbid` refuses. A merge always asks the operator (D56, ADR-0060): `merge` is in
   * `ALWAYS_ASK`, so the policy never gives it `auto` or `notify`, and a verdict that did would be
   * refused here, never merged on the policy's word alone.
   */
  private async ask(row: TaskRow, board: Board, landing: TaskLanding): Promise<TaskLanding | undefined> {
    const approvals = queueOf(this.e)
    if (!approvals) return landing.reason ? this.touch(row, landing) : { ...landing, reason: 'no approval queue (ctx.approvals) is loaded: the merge waits for one', at: now() }
    // What would land, and the subject the request binds it to, are the landing provider's (PROP-0017 L0): with none, nothing is asked.
    const provider = this.provider()
    if (!provider) return this.noProvider(row, landing, 'the merge request')
    const task = await board.task(row.task_id)
    const project = task ? { projectId: task.projectId } : {}
    const verdict = await approvals.check({ class: 'merge', ...project })
    if (verdict.mode === 'forbid') return this.refuse(row, landing, 'merge', 'forbidden', `the autonomy policy ${verdict.policy.id} forbids merge, so ${landing.branch} is not merged; it keeps the commit ${landing.head}`, [verdict.decision])
    // A rule's required checks bind where a result is applied, and a landing runs none (docs/design/approvals.md#a-verdict-is-not-yet-a-permission).
    if (verdict.failedChecks?.length) return this.refuse(row, landing, 'merge', 'checks', `the autonomy policy ${verdict.policy.id} requires ${verdict.failedChecks.join(', ')} before a merge, and no landing runs them: merge ${landing.branch} by hand once they pass`, [verdict.decision])
    // A merge always asks (D56): a queue whose policy gave it anything but ask is not one this landing merges on.
    if (verdict.mode !== 'ask') return this.refuse(row, landing, 'merge', 'failed', `a merge always asks the operator (D56), but the autonomy policy ${verdict.policy.id} gives merge ${verdict.mode}: nothing is merged; merge ${landing.branch} by hand`, [verdict.decision])
    const prepared = await provider.prepare(this.targetOf(row, landing))
    if (prepared.outcome === 'refused') return this.refuse(row, landing, 'merge', prepared.cause, prepared.reason, [verdict.decision])
    const subject: Subject = { ...prepared.subject }
    const request = await this.adopt(approvals, row, subject, project) ?? await approvals.request({
      subject,
      action: {
        class: 'merge',
        summary: line(`Merge the accepted result of task ${task ? `"${line(task.title, 80)}"` : row.task_id} into ${landing.base!.branch}`, 300),
        consequences: [
          ...prepared.consequences,
          'A merge always asks the operator (D56), whatever the policy\'s mode for merge.',
          // Rebased onto the base as it is now (ADR-0068): what the operator approves is that tree, checked again.
          rebasedNote(landing),
          landing.stat ? `\n${landing.stat}` : '',
        ].join(' ').slice(0, 2000),
        ...(landing.decisions?.length ? { refs: landing.decisions.slice(-1) } : {}),
      },
      requester: { component: 'workflow', runId: row.run_id, ...(this.finalNode(row) ? { nodeId: this.finalNode(row)! } : {}), taskId: row.task_id, ...project },
      verdict, classification: this.e.runRow(row.run_id)?.classification ?? this.e.ctx.egress.defaultClassification,
    })
    return { ...landing, state: 'asked', requestId: request.requestId, expiresAt: request.expiresAt, at: now() }
  }

  /** A request asked before a restart, on this exact subject, by this run's landing. */
  private async adopt(approvals: Approvals, row: TaskRow, subject: Subject, project: { projectId?: string }): Promise<ApprovalRequest | undefined> {
    const listed = await approvals.list({ states: ['open', 'batched'], ...project })
    return listed.find((r) => r.action.class === 'merge' && r.requester.component === 'workflow' && r.requester.runId === row.run_id
      && r.subject.type === subject.type && r.subject.ref === subject.ref && r.subject.version === subject.version)
  }

  /** Read the request: approved, merge; open, wait; withdrawn on a policy change, ask again; rejected or expired, nothing lands. */
  private async answer(row: TaskRow, landing: TaskLanding): Promise<TaskLanding | undefined> {
    const approvals = queueOf(this.e)
    if (!approvals) return undefined
    const request = await approvals.get(landing.requestId!)
    if (!request) return this.refuse(row, landing, 'merge', 'failed', `the approval queue no longer knows request ${landing.requestId}`, [])
    if (request.state === 'open' || request.state === 'batched') return this.touch(row, landing)
    // Bound to this landing's exact subject, as its provider gives it (PROP-0017 L0): with no provider, it cannot be told, and it waits.
    const provider = this.provider()
    if (!provider) return this.noProvider(row, landing, 'the answer to the merge request')
    const prepared = await provider.prepare(this.targetOf(row, landing))
    const bound = prepared.outcome === 'prepared' && sameSubject(prepared.subject, request.subject)
    if (request.state === 'approved' && bound && request.resolution?.cause === 'verdict' && request.resolution.approval) {
      return { ...landing, state: 'merging', approval: request.resolution.decision, at: now() }
    }
    if (request.resolution?.cause === 'withdrawn' && this.byPolicy(request)) return { ...landing, state: 'commit', reason: `request ${request.requestId} was withdrawn on a policy change: the merge is put to the policy in force again`, at: now() }
    const why = !bound ? 'it is not on this landing\'s exact subject' : request.resolution?.cause === 'expired' ? 'it expired unanswered' : request.resolution?.cause === 'withdrawn' ? 'it was withdrawn' : 'the operator denied it'
    return { ...landing, state: 'rejected', reason: `request ${request.requestId} was not approved (${why}): nothing is merged; ${landing.branch} keeps the commit ${landing.head}`, ...(request.resolution ? { decisions: [...(landing.decisions ?? []), request.resolution.decision] } : {}), at: now() }
  }

  /**
   * Have the landing provider land the branch on its target, on the operator's word (PROP-0017 L0; the
   * local provider merges it through the source that holds it). The subject `land` is given is the one
   * the approved request names, read from the queue, and only while the provider in force prepares that
   * same subject: a provider that changed since the approval (a restart in `merging` with another one)
   * lands nothing on it, and the merge is asked again on its own subject (INV-5). With no provider, or
   * no queue to read the request from, it waits.
   */
  private async merge(row: TaskRow, board: Board, landing: TaskLanding): Promise<TaskLanding | undefined> {
    const provider = this.provider()
    if (!provider) return this.noProvider(row, landing, 'the approved merge')
    const approvals = queueOf(this.e)
    if (!approvals) return landing.reason ? this.touch(row, landing) : { ...landing, reason: 'no approval queue (ctx.approvals) is loaded: the approved merge waits for one to read its request from', at: now() }
    const request = await approvals.get(landing.requestId!)
    if (!request || request.state !== 'approved' || request.resolution?.decision !== landing.approval) {
      return this.refuse(row, landing, 'merge', 'failed', `the approval queue does not hold request ${landing.requestId} approved by decision ${landing.approval}: nothing is merged`, [landing.approval!])
    }
    const target = this.targetOf(row, landing)
    const prepared = await provider.prepare(target)
    if (prepared.outcome === 'refused') return this.refuse(row, landing, 'merge', prepared.cause, prepared.reason, [landing.approval!])
    if (!sameSubject(prepared.subject, request.subject)) {
      const refused = this.refuse(row, landing, 'merge', 'unbound', `request ${request.requestId} approved ${request.subject.ref} at ${request.subject.version ?? 'no version'}, but the landing provider in force (${provider.id}) lands ${prepared.subject.ref} at ${prepared.subject.version}: nothing is merged on that approval; it is asked again on the provider's own subject`, [landing.approval!])
      return { ...refused, state: 'commit', reason: refused.reason!, at: now() }
    }
    const approved = { type: 'git-head' as const, ref: request.subject.ref, version: request.subject.version! }
    const task = await board.task(row.task_id)
    const message = this.mergeMessage(row, task, landing, approved.version)
    const landed = await provider.land({ ...target, subject: approved, approval: landing.approval!, message })
    if (landed.outcome === 'refused') {
      // The base moved or was not clean when the approval came: the merge is asked again on the base as it is then.
      if (landed.cause === 'base-moved' || landed.cause === 'dirty') {
        const refused = this.refuse(row, landing, 'merge', landed.cause, `${landed.reason}; it is asked again on ${landing.base!.branch} as it is now`, [landing.approval!])
        return { ...refused, state: 'commit', reason: refused.reason!, at: now() }
      }
      return this.refuse(row, landing, 'merge', landed.cause, landed.reason, [landing.approval!])
    }
    return this.merged(row, landing, { ...landed, source: landed.source ?? landed.provider }, [landing.approval!], landed.already ? `${landing.base!.branch} already held ${landing.head} (merged before a restart)` : `${landing.branch} at ${landing.head} is merged into ${landing.base!.branch} as ${landed.commit}`)
  }

  private merged(row: TaskRow, landing: TaskLanding, landed: Pick<LandedOn, 'commit' | 'already' | 'regenerated'> & { source: string }, inputs: ArtifactRef[], why: string): TaskLanding {
    const regenerated = landed.regenerated
    // A conflict only in files the repository declares generated, made again by its commands (T166): named, and their commands' autonomy decisions among the inputs (INV-13).
    const remade = regenerated ? [
      `it conflicted only in files the repository declares generated, regenerated: ${regenerated.files.join(', ')}`,
      `by the repository's commands (${regenerated.commands.join('; ')}), which exited 0, changed no other file, and changed nothing on a repeat`,
    ] : []
    const decision = this.decide(row, 'merge', `Is board task ${row.task_id}'s accepted result merged into ${landing.base!.branch}?`, [...(landing.decisions ?? []).slice(-1), ...inputs, ...((regenerated?.autonomy ?? []) as ArtifactRef[])], [
      { option: 'merge', selected: true, reasons: [why, ...remade, landing.approval ? `on ${landing.requestId ? `the operator's approval of request ${landing.requestId}` : 'the autonomy policy'} (decision ${landing.approval})` : 'no merge was needed'] },
      { option: 'refuse', selected: false, reasons: [regenerated ? 'not refuse: the branch and the base were where the approval saw them, and the merge met conflicts only in generated files, which were regenerated' : 'not refuse: the branch and the base were where the approval saw them, and the merge met no conflict'] },
    ], { step: 'merge', source: landed.source, branch: landing.branch, head: landing.head, base: landing.base, commit: landed.commit, already: landed.already, ...(regenerated ? { regenerated: { files: regenerated.files, commands: regenerated.commands } } : {}), ...(landing.requestId ? { requestId: landing.requestId } : {}) })
    const reverts = revertsOf(landing.workspace, landing.base?.sha, landing.head)
    const done: TaskLanding = { ...landing, state: 'merged', commit: landed.commit, ...(reverts.length ? { reverts } : {}), decisions: [...(landing.decisions ?? []), decision], at: now() }
    delete done.reason
    this.e.ctx.logger.info(`workflow: board task ${row.task_id}'s accepted result (run ${row.run_id}) is in ${landing.base!.branch} of ${landing.repository} at ${landed.commit}; nothing is pushed`)
    return done
  }

  /** A landing step that changes nothing: a `gate` decision saying why, and the landing ends refused. */
  private refuse(row: TaskRow, landing: TaskLanding, step: 'commit' | 'rebase' | 'return' | 'merge', cause: string, reason: string, inputs: ArtifactRef[]): TaskLanding {
    const what = { commit: 'committed on its branch', rebase: 'rebased onto its target as it is now', return: 'sent back as another attempt', merge: 'merged' }[step]
    const decision = this.decide(row, 'refuse', `Is board task ${row.task_id}'s accepted result ${what}?`, inputs.filter(Boolean), [
      { option: 'refuse', selected: true, reasons: [reason] },
      { option: step, selected: false, reasons: [`not ${step}: a landing goes on only on the exact tree and branches it was accepted and approved on, and changes nothing otherwise (INV-2, INV-5)`] },
    ], { step, cause, ...(landing.branch ? { branch: landing.branch } : {}), ...(landing.head ? { head: landing.head } : {}), ...(landing.base ? { base: landing.base } : {}) })
    this.e.ctx.logger.warn(`workflow: board task ${row.task_id}'s accepted result (run ${row.run_id}) is not landed: ${reason}`)
    return { ...landing, state: 'refused', cause, reason, decisions: [...(landing.decisions ?? []), decision], at: now() }
  }

  /** A `gate` decision of the landing, under the run's final step (INV-13). */
  private decide(row: TaskRow, option: string, question: string, inputs: ArtifactRef[], candidates: Array<{ option: string; selected: boolean; reasons: string[] }>, detail: Record<string, unknown>): ArtifactRef {
    const node = this.finalNode(row)
    return this.e.ctx.artifacts.recordDecision({
      decisionType: 'gate', question, inputs: [...new Set(inputs)], candidates,
      decider: RULE, outcome: { option, detail: { taskId: row.task_id, runId: row.run_id, ...detail } }, deterministic: true,
    }, { ...PRODUCER, runId: row.run_id, ...(node ? { nodeId: node } : {}) }).id as ArtifactRef
  }

  private save(row: TaskRow, landing: TaskLanding): void {
    // A landing that reached an outcome is the System's evidence in the task's dossier (ADR-0070), once
    // per state: committed, asked, and where it ended; never the steps between.
    if (landing.state !== this.view(row)?.state && DOSSIER_STATES.has(landing.state)) {
      this.e.tasks.dossiers.safely('the landing', () => this.e.tasks.dossiers.evidence(row.run_id,
        `Landing of run ${row.run_id}'s accepted result: ${landing.state}${landing.commit ? `, commit ${landing.commit}` : ''}${landing.requestId ? `, merge request ${landing.requestId}` : ''}${landing.reason ? `: ${landing.reason}` : ''}.`,
        landing.decisions?.length ? [landing.decisions.at(-1)!] : [], landing.subject ? { type: 'git-head', ref: landing.subject.ref, version: landing.subject.version } : undefined))
    }
    this.e.ctx.store.transaction((db) => {
      // The landing keeps its own time (`at`): the row's updated_at stays the report's.
      db.prepare('UPDATE workflow_tasks SET landing = ? WHERE run_id = ?').run(JSON.stringify(landing), row.run_id)
      if (landing.state !== this.view(row)?.state) {
        this.e.ctx.eventLog.append({ type: 'workflow.task.landing', runId: row.run_id, ...(landing.decisions?.length ? { decision: landing.decisions.at(-1)! } : {}), data: { taskId: row.task_id, state: landing.state, ...(landing.requestId ? { requestId: landing.requestId } : {}), ...(landing.commit ? { commit: landing.commit } : {}), ...(landing.reverts?.length ? { reverts: landing.reverts } : {}), ...(landing.reason ? { reason: landing.reason.slice(0, 500) } : {}) } })
      }
    })
    row.landing = JSON.stringify(landing)
  }

  /** Looked at, unchanged: it goes to the back of the sweep's order. */
  private touch(row: TaskRow, landing: TaskLanding): TaskLanding {
    return { ...landing, at: now() }
  }

  /** The working tree a result is on: the first result artifact of an agent run that names a git working tree, on the result's exact subject when that is a tree. */
  private treeOf(result: Result): Pick<TaskLanding, 'workspace' | 'subject'> | undefined {
    for (const ref of result.artifacts) {
      const body = this.e.ctx.artifacts.get(ref)?.body as { schema?: string; workspace?: unknown; subject?: Subject } | undefined
      if (!body?.schema?.startsWith('agent-result@') || typeof body.workspace !== 'string' || body.subject?.type !== 'git-head' || !body.subject.version) continue
      if (result.subject.type === 'git-head' && (result.subject.ref !== body.subject.ref || result.subject.version !== body.subject.version)) continue
      return { workspace: body.workspace, subject: { ref: body.subject.ref, version: body.subject.version } }
    }
    return undefined
  }

  private resultOf(row: TaskRow): Result {
    return JSON.parse(row.result!) as Result
  }

  /** The run's last completed step, where its landing's decisions are recorded. */
  private finalNode(row: TaskRow): string | undefined {
    return this.e.nodeRows(row.run_id).filter((n) => n.state === 'COMPLETED').at(-1)?.node_id
  }

  /** Who accepted the result, and the reviews of the accepted tree by the run's own review steps. */
  private provenance(row: TaskRow, landing: TaskLanding): string[] {
    const acceptance = this.e.ctx.artifacts.get(landing.acceptance!)?.body as { decider?: { type?: string; id?: string } } | undefined
    const by = acceptance?.decider?.type === 'operator' ? 'the operator' : `rule ${acceptance?.decider?.id ?? 'unknown'}`
    const id = subjectId({ type: 'git-head', ...landing.subject! })
    const done = this.e.nodeRows(row.run_id).filter((n) => n.state === 'COMPLETED')
    const workers = new Map((this.e.get(row.run_id)?.nodes ?? []).map((n) => [n.nodeId, n.worker]))
    const reviews: string[] = []
    for (const node of done) {
      const bound = node.subject ? (JSON.parse(node.subject) as { subject?: { ref: string; version: string } }).subject : undefined
      if (!bound || `git:${bound.ref}:${bound.version}` !== id) continue
      for (const ref of node.decisions ? JSON.parse(node.decisions) as ArtifactRef[] : []) {
        const body = this.e.ctx.artifacts.get(ref)?.body as { decisionType?: string; decider?: { id?: string }; outcome?: { option?: string; detail?: { assessment?: ArtifactRef } } } | undefined
        if (body?.decisionType !== 'gate' || body.decider?.id !== 'workflow.exact-subject' || body.outcome?.option !== 'pass' || !body.outcome.detail?.assessment) continue
        const verdict = (this.e.ctx.artifacts.get(body.outcome.detail.assessment)?.body as { verdict?: string } | undefined)?.verdict
        const own = (JSON.parse(node.spec) as { selfReview?: string }).selfReview !== undefined ? ', the author\'s own review' : ''
        reviews.push(`${node.node_id} by ${workers.get(node.node_id) ?? 'an unknown Worker'}${own}: ${verdict ?? 'no verdict'}`)
      }
    }
    return [
      `The result of run ${row.run_id} on ${id}, accepted by ${by} (acceptance decision ${landing.acceptance}).`,
      reviews.length ? `Reviewed on that tree: ${reviews.join('; ')}.` : 'No review step of the run reviewed that tree.',
    ]
  }

  private commitMessage(row: TaskRow, task: BoardTask | undefined, landing: TaskLanding): string {
    return [
      `system: land task ${row.task_id}${task ? `: ${line(task.title)}` : ''}`, '',
      ...this.provenance(row, landing), '',
      `System-Task: ${row.task_id}`, `System-Run: ${row.run_id}`, `System-Acceptance: ${landing.acceptance}`,
    ].join('\n')
  }

  private mergeMessage(row: TaskRow, task: BoardTask | undefined, landing: TaskLanding, version: string): string {
    const on = landing.requestId ? `the operator's approval of request ${landing.requestId}` : 'the autonomy policy'
    return [
      `system: merge task ${row.task_id}${task ? `: ${line(task.title)}` : ''}`, '',
      `Lands ${landing.branch} at ${landing.head}, the accepted result of run ${row.run_id}, into ${landing.base!.branch} at ${landing.base!.sha}, on ${on} (decision ${landing.approval}).`, '',
      `System-Task: ${row.task_id}`, `System-Run: ${row.run_id}`, `System-Landing: ${version}`,
    ].join('\n')
  }

  /** A request the queue withdrew on a policy change, not its requester (docs/design/approvals.md#a-request). */
  private byPolicy(request: ApprovalRequest): boolean {
    const decision = request.resolution ? this.e.ctx.artifacts.get(request.resolution.decision)?.body as { decider?: { id?: string } } | undefined : undefined
    return decision?.decider?.id === 'approvals.policy'
  }
}

