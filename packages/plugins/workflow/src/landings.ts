/**
 * Landing an accepted result (docs/design/workflow-engine.md#landing-an-accepted-result, ADR-0059,
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
 * - **Fails closed** (INV-2): nothing merges without the policy's word (`ask`: the operator's
 *   approval; `forbid`: refused); with no queue, it waits; a conflict, a dirty base, or a source that
 *   cannot answer changes nothing.
 * - **Restart is reconciliation** (INV-4): the landing's state is durable on the run's
 *   `workflow_tasks` row, a request asked before a crash is adopted, and each step of the source
 *   finds its own work done instead of doing it twice. Never a force, a reset, or a push.
 *
 * The workers seam's `land` is optional: with no source that holds the tree, nothing lands, and the
 * task is done as before.
 */
import type { ApprovalRequest, Approvals } from '@tsuuanmi/system-approvals-core'
import type { ArtifactRef, Board, BoardTask, Subject } from '@tsuuanmi/system-board-core'
import { subjectId } from '@tsuuanmi/system-libs'
import type { Landed, LandStep } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import { queueOf } from './queue.ts'
import { now, type TaskLanding, type TaskRow } from './types.ts'

/** The outcomes after which the board may hold the task `done` on this run's result. */
const SUBMITTED = new Set(['accepted', 'review', 'reconciled'])
/** The landing states still in progress: the sweep looks at them. */
const OPEN = ['watch', 'commit', 'committed', 'asked', 'merging'] as const
/** Landings one sweep looks at, the longest unlooked-at first (INV-9). */
const PAGE = 32
const RULE = { type: 'rule', id: 'workflow.landing', version: '1' } as const
const PRODUCER = { producer: { type: 'system' as const, ref: 'workflow' } }

type Result = { artifacts: ArtifactRef[]; subject: Subject }

/** The landing version a `merge` request binds to: the base branch's head and the run branch's head. */
export const landingVersion = (base: string, head: string): string => `landing:merge:${base}:${head}`

/** Lead or Worker text in a commit message: one line, bounded. */
const line = (text: string, max = 120): string => Array.from(text, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').replace(/ {2,}/g, ' ').trim().slice(0, max)

export class TaskLandings {
  private sweeping: Promise<void> | undefined

  constructor(private readonly e: Engine) {}

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
    if (task.run?.runId !== row.run_id) return { ...landing, state: 'none', reason: `task ${task.taskId} moved on to another attempt`, at: now() }
    if (task.state === 'review' || task.state === 'running' || task.state === 'waiting-for-approval') return this.touch(row, landing)
    if (task.state !== 'done' || !task.result?.acceptance) return { ...landing, state: 'none', reason: `task ${task.taskId} is ${task.state}: its result was not accepted`, at: now() }
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
    if (landed.contained) return this.merged(row, committed, { ...landed, outcome: 'merged', commit: landed.base.sha, already: true, source: landed.source }, [decision], `${landed.base.branch} at ${landed.base.sha} already holds ${landed.head}: nothing is left to merge`)
    return committed
  }

  /** Put the merge to the autonomy policy: `ask` opens one request on its exact version (an earlier one adopted), `forbid` refuses, `auto` and `notify` merge. */
  private async ask(row: TaskRow, board: Board, landing: TaskLanding): Promise<TaskLanding | undefined> {
    const approvals = queueOf(this.e)
    if (!approvals) return landing.reason ? this.touch(row, landing) : { ...landing, reason: 'no approval queue (ctx.approvals) is loaded: the merge waits for one', at: now() }
    const task = await board.task(row.task_id)
    const project = task ? { projectId: task.projectId } : {}
    const verdict = await approvals.check({ class: 'merge', ...project })
    if (verdict.mode === 'forbid') return this.refuse(row, landing, 'merge', 'forbidden', `the autonomy policy ${verdict.policy.id} forbids merge, so ${landing.branch} is not merged; it keeps the commit ${landing.head}`, [verdict.decision])
    // A rule's required checks bind where a result is applied, and a landing runs none (docs/design/approvals.md#a-verdict-is-not-yet-a-permission).
    if (verdict.failedChecks?.length) return this.refuse(row, landing, 'merge', 'checks', `the autonomy policy ${verdict.policy.id} requires ${verdict.failedChecks.join(', ')} before a merge, and no landing runs them: merge ${landing.branch} by hand once they pass`, [verdict.decision])
    if (verdict.mode !== 'ask') return { ...landing, state: 'merging', approval: verdict.decision, at: now() }
    const subject: Subject = { type: 'git-head', ref: landing.branch!, version: landingVersion(landing.base!.sha, landing.head!) }
    if (subject.version!.length > 128) return this.refuse(row, landing, 'merge', 'failed', `a landing version of this repository's object ids is longer than a request's subject holds (${subject.version!.length} > 128): merge ${landing.branch} by hand`, [verdict.decision])
    const request = await this.adopt(approvals, row, subject, project) ?? await approvals.request({
      subject,
      action: {
        class: 'merge',
        summary: line(`Merge the accepted result of task ${task ? `"${line(task.title, 80)}"` : row.task_id} into ${landing.base!.branch}`, 300),
        consequences: [
          `Approved: system merges ${landing.branch} (at ${landing.head}) into ${landing.base!.branch} (at ${landing.base!.sha}) in ${landing.repository}, as one merge commit. Never a force or a push; a conflict or a moved branch changes nothing.`,
          `Denied or unanswered: nothing is merged; ${landing.branch} keeps the commit.`,
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
    const bound = request.subject.ref === landing.branch && request.subject.version === landingVersion(landing.base!.sha, landing.head!)
    if (request.state === 'approved' && bound && request.resolution?.cause === 'verdict' && request.resolution.approval) {
      return { ...landing, state: 'merging', approval: request.resolution.decision, at: now() }
    }
    if (request.resolution?.cause === 'withdrawn' && this.byPolicy(request)) return { ...landing, state: 'commit', reason: `request ${request.requestId} was withdrawn on a policy change: the merge is put to the policy in force again`, at: now() }
    const why = !bound ? 'it is not on this landing\'s exact subject' : request.resolution?.cause === 'expired' ? 'it expired unanswered' : request.resolution?.cause === 'withdrawn' ? 'it was withdrawn' : 'the operator denied it'
    return { ...landing, state: 'rejected', reason: `request ${request.requestId} was not approved (${why}): nothing is merged; ${landing.branch} keeps the commit ${landing.head}`, ...(request.resolution ? { decisions: [...(landing.decisions ?? []), request.resolution.decision] } : {}), at: now() }
  }

  /** Have the source merge the branch, on the policy's or the operator's word. */
  private async merge(row: TaskRow, board: Board, landing: TaskLanding): Promise<TaskLanding | undefined> {
    const land = this.e.ctx.workers.land
    if (!land) return this.refuse(row, landing, 'merge', 'failed', 'the workers seam cannot land a result (no land)', [landing.approval!])
    const task = await board.task(row.task_id)
    const message = this.mergeMessage(row, task, landing)
    const landed = await land.call(this.e.ctx.workers, { step: 'merge', runId: row.run_id, workspace: landing.workspace!, head: landing.head!, base: landing.base!, message } satisfies LandStep)
    if (!landed) return this.refuse(row, landing, 'merge', 'gone', `no Worker source holds the worktree of run ${row.run_id} any more`, [landing.approval!])
    if (landed.outcome === 'refused') {
      // The base moved or was not clean when the approval came: the merge is asked again on the base as it is then.
      if (landed.cause === 'base-moved' || landed.cause === 'dirty') {
        const refused = this.refuse(row, landing, 'merge', landed.cause, `${landed.reason}; it is asked again on ${landing.base!.branch} as it is now`, [landing.approval!])
        return { ...refused, state: 'commit', reason: refused.reason!, at: now() }
      }
      return this.refuse(row, landing, 'merge', landed.cause, landed.reason, [landing.approval!])
    }
    if (landed.outcome !== 'merged') return this.refuse(row, landing, 'merge', 'failed', `source ${landed.source} answered ${landed.outcome} to a merge`, [landing.approval!])
    return this.merged(row, landing, landed, [landing.approval!], landed.already ? `${landing.base!.branch} already held ${landing.head} (merged before a restart)` : `${landing.branch} at ${landing.head} is merged into ${landing.base!.branch} as ${landed.commit}`)
  }

  private merged(row: TaskRow, landing: TaskLanding, landed: Extract<Landed, { outcome: 'merged' }> & { source: string }, inputs: ArtifactRef[], why: string): TaskLanding {
    const decision = this.decide(row, 'merge', `Is board task ${row.task_id}'s accepted result merged into ${landing.base!.branch}?`, [...(landing.decisions ?? []).slice(-1), ...inputs], [
      { option: 'merge', selected: true, reasons: [why, landing.approval ? `on ${landing.requestId ? `the operator's approval of request ${landing.requestId}` : 'the autonomy policy'} (decision ${landing.approval})` : 'no merge was needed'] },
      { option: 'refuse', selected: false, reasons: ['not refuse: the branch and the base were where the approval saw them, and the merge met no conflict'] },
    ], { step: 'merge', source: landed.source, branch: landing.branch, head: landing.head, base: landing.base, commit: landed.commit, already: landed.already, ...(landing.requestId ? { requestId: landing.requestId } : {}) })
    const done: TaskLanding = { ...landing, state: 'merged', commit: landed.commit, decisions: [...(landing.decisions ?? []), decision], at: now() }
    delete done.reason
    this.e.ctx.logger.info(`workflow: board task ${row.task_id}'s accepted result (run ${row.run_id}) is in ${landing.base!.branch} of ${landing.repository} at ${landed.commit}; nothing is pushed`)
    return done
  }

  /** A landing step that changes nothing: a `gate` decision saying why, and the landing ends refused. */
  private refuse(row: TaskRow, landing: TaskLanding, step: 'commit' | 'merge', cause: string, reason: string, inputs: ArtifactRef[]): TaskLanding {
    const decision = this.decide(row, 'refuse', `Is board task ${row.task_id}'s accepted result ${step === 'commit' ? 'committed on its branch' : 'merged'}?`, inputs.filter(Boolean), [
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
    this.e.ctx.store.transaction((db) => {
      // The landing keeps its own time (`at`): the row's updated_at stays the report's.
      db.prepare('UPDATE workflow_tasks SET landing = ? WHERE run_id = ?').run(JSON.stringify(landing), row.run_id)
      if (landing.state !== this.view(row)?.state) {
        this.e.ctx.eventLog.append({ type: 'workflow.task.landing', runId: row.run_id, ...(landing.decisions?.length ? { decision: landing.decisions.at(-1)! } : {}), data: { taskId: row.task_id, state: landing.state, ...(landing.requestId ? { requestId: landing.requestId } : {}), ...(landing.commit ? { commit: landing.commit } : {}), ...(landing.reason ? { reason: landing.reason.slice(0, 500) } : {}) } })
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
        reviews.push(`${node.node_id} by ${workers.get(node.node_id) ?? 'an unknown Worker'}: ${verdict ?? 'no verdict'}`)
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

  private mergeMessage(row: TaskRow, task: BoardTask | undefined, landing: TaskLanding): string {
    const on = landing.requestId ? `the operator's approval of request ${landing.requestId}` : 'the autonomy policy'
    return [
      `system: merge task ${row.task_id}${task ? `: ${line(task.title)}` : ''}`, '',
      `Lands ${landing.branch} at ${landing.head}, the accepted result of run ${row.run_id}, into ${landing.base!.branch} at ${landing.base!.sha}, on ${on} (decision ${landing.approval}).`, '',
      `System-Task: ${row.task_id}`, `System-Run: ${row.run_id}`, `System-Landing: ${landingVersion(landing.base!.sha, landing.head!)}`,
    ].join('\n')
  }

  /** A request the queue withdrew on a policy change, not its requester (docs/design/approvals.md#a-request). */
  private byPolicy(request: ApprovalRequest): boolean {
    const decision = request.resolution ? this.e.ctx.artifacts.get(request.resolution.decision)?.body as { decider?: { id?: string } } | undefined : undefined
    return decision?.decider?.id === 'approvals.policy'
  }
}

