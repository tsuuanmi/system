/**
 * Board tasks (docs/design/board.md): a run of the engine serves one attempt of one board task.
 *
 * - **Taking the task.** A run started for a task adopts the live claim its caller hands it (a
 *   lead's `board_claim`: holder and generation), or claims the ready task itself, as the run. A
 *   task that is not ready, or a stale claim, refuses the start before anything is written.
 * - **Run first, then work.** The run is written `starting`, the board records it (`start`, with
 *   the holder's generation), and only then is it opened and scheduled. A restart in between is
 *   reconciled against the board's record, never guessed at (INV-4).
 * - **While it lives** the engine renews the task's lease at a third of what is left
 *   (`leases.maxTtlMs` caps it). When the board no longer holds the run's generation, the run starts
 *   nothing new: it reconciles what is in flight and fails what is left (INV-4, INV-15).
 * - **Its outcome** goes through the board's own move: a completed run's result, on the exact
 *   subject the task writes, is submitted and the engine's `acceptance` decision applied; a failed
 *   run, and any run whose holder was lost, is reported with `reconcileRun`. When only the
 *   operator may accept the result (a required check not reported), the board holds the review
 *   for the operator.
 * - **After it**, a result that reached the board is digested, once, and the digest set on the
 *   task's result ({@link TaskDigests}); a digest never blocks the report.
 *
 * Every move goes through `ctx.board`: the engine never writes board state, and each of its own
 * choices is a decision with a reason for every candidate (INV-13). The board is optional: a run
 * for a task needs it, every other run does not.
 */
import { type ArtifactRef, BoardError, type BoardTask, type Board, type Classification, type RunOutcome, type Subject } from '@tsuuanmi/system-board-core'
import type { Lease } from '@tsuuanmi/system-leases'
import { BRIEF_LIMITS, type BriefBudgetLine, type BriefPointer, captureGitSubject } from '@tsuuanmi/system-libs'
import type { UsageRecord } from '@tsuuanmi/system-resources-core'
import type { TaskFrame } from './briefs.ts'
import { TaskDigests } from './digests.ts'
import type { Engine, Prepared } from './engine.ts'
import { clampText, type ResolvedNode } from './spec.ts'
import {
  newId, type NodeRecord, type NodeRow, now, type RunRow, type RunView, type StartInput, TASK_LEASE_TTL_MS, type TaskOutcome, type TaskRow, type TaskStartInput, type TaskView, type WorkflowError, WorkflowFailure,
} from './types.ts'
import { view } from './views.ts'

/** How long a report the board did not answer waits before it is tried again, doubling up to the cap. */
const REPORT_RETRY_MS = 5_000
const REPORT_RETRY_MAX_MS = 10 * 60_000
/** How soon a renewal the board did not answer is tried again; a lapse shows as a stale generation then. */
const RENEW_RETRY_MS = 5_000

const RANK: Record<Classification, number> = { public: 0, 'operator-shared': 1, 'local-private': 2 }
/** Pointers a task's run adds to every brief it writes, at most (the brief holds 64). */
const FRAME_POINTERS = 16
const PRODUCER = { producer: { type: 'system' as const, ref: 'workflow' } }

type Result = { artifacts: ArtifactRef[]; subject: Subject }
type Lost = { at: string; decision: ArtifactRef; reason: string }

const describe = (s: Subject): string => `${s.type} ${s.ref}${s.version ? ` at ${s.version}` : ''}`
const refusal = (error: BoardError): string => `${error.failure}: ${error.message}`
/** A budget amount at a millionth, as the ledger compares them. */
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6

export class TaskRuns {
  /** Lease renewals of the runs live in this process. */
  private readonly renewals = new Map<string, NodeJS.Timeout>()
  private readonly reporting = new Map<string, Promise<void>>()
  private readonly retries = new Map<string, { timer: NodeJS.Timeout; tries: number }>()
  /** The digests of the results the runs reported. */
  readonly digests: TaskDigests

  constructor(private readonly e: Engine) {
    this.digests = new TaskDigests(e)
  }

  row(runId: string): TaskRow | undefined {
    return this.e.ctx.store.db.prepare('SELECT * FROM workflow_tasks WHERE run_id = ?').get(runId) as TaskRow | undefined
  }

  /** Whether the run serves a board task. */
  bound(runId: string): boolean {
    return this.row(runId) !== undefined
  }

  /** Whether the board no longer holds the run's generation: the run then starts nothing new. */
  lost(runId: string): boolean {
    return !!this.row(runId)?.lost
  }

  /** The task a run serves, as its view shows it. */
  view(runId: string): TaskView | undefined {
    const row = this.row(runId)
    if (!row) return undefined
    return {
      taskId: row.task_id, generation: row.generation, claim: row.claim, phase: row.phase,
      ...(row.lost ? { lost: (JSON.parse(row.lost) as Lost).decision } : {}), ...(row.outcome ? { outcome: JSON.parse(row.outcome) as TaskOutcome } : {}),
      ...(row.digest ? { digest: this.digests.view(row)! } : {}),
    }
  }

  /** `ctx.board` came up: runs that waited for it go on, and outcomes not yet reported are reported. */
  attach(board: Board): void {
    this.e.board = board
    if (this.e.stopped.signal.aborted) return
    const pending = this.e.ctx.store.db.prepare(`SELECT t.run_id, r.status FROM workflow_tasks t JOIN workflow_runs r ON r.run_id = t.run_id
      WHERE t.phase != 'reported' ORDER BY t.created_at`).all() as Array<{ run_id: string; status: string }>
    for (const { run_id, status } of pending) {
      if (status === 'running') this.e.schedule(run_id)
      else void this.report(run_id)
    }
    this.digests.recover()
  }

  detach(board: Board): void {
    if (this.e.board === board) this.e.board = undefined
  }

  /** On start: outcomes a stop or crash left unreported are reported (running runs resume through their advance). */
  recover(): void {
    this.digests.recover()
    if (!this.e.board) return
    const pending = this.e.ctx.store.db.prepare(`SELECT t.run_id FROM workflow_tasks t JOIN workflow_runs r ON r.run_id = t.run_id
      WHERE t.phase != 'reported' AND r.status != 'running' ORDER BY t.created_at`).all() as Array<{ run_id: string }>
    for (const { run_id } of pending) void this.report(run_id)
  }

  async close(): Promise<void> {
    for (const timer of this.renewals.values()) clearTimeout(timer)
    this.renewals.clear()
    for (const { timer } of this.retries.values()) clearTimeout(timer)
    this.retries.clear()
    await Promise.allSettled(this.reporting.values())
    await this.digests.close()
  }

  // --- taking the task ---

  /**
   * Start a run for one attempt of a board task. Every check that needs no write runs first; then
   * the engine takes the task (it adopts the caller's live claim, or claims the ready task as the
   * run), writes the run `starting`, and has the board record it before anything runs. A refusal
   * at any step leaves no run behind, and nothing is sent.
   */
  async start(input: TaskStartInput): Promise<RunView> {
    const e = this.e
    const { task: claim, ...plain } = input
    const prepared = e.prepare(plain)
    const board = e.board
    if (!board) throw new WorkflowFailure('config_error', `no board is loaded: a run for board task ${claim.taskId} needs ctx.board (its bundle row on, over the approval queue); nothing was started`)
    if ((claim.holder === undefined) !== (claim.generation === undefined)) throw new WorkflowFailure('invalid_input', 'a claim handed to a run names its holder and its generation, both or neither')
    const again = this.repeated(plain, prepared)
    if (again) {
      if (this.row(again.run_id)?.task_id !== claim.taskId) throw new WorkflowFailure('invalid_input', 'clientRequestId was reused with a different request')
      return view(e, again)
    }
    // The bounds refuse before the task is taken, so an overloaded host claims nothing.
    e.bounded()
    const task = await board.task(claim.taskId)
    if (!task) throw new WorkflowFailure('invalid_input', `unknown board task ${claim.taskId}; nothing was started`)
    if (task.template !== undefined && task.template !== plain.template) {
      throw new WorkflowFailure('invalid_input', `board task ${task.taskId} runs template ${task.template}, not ${plain.template}; nothing was started`)
    }
    const project = await board.project(task.projectId)
    const classification = classificationOf(plain.classification, project?.classification, task)
    const runId = newId('run')
    // What every brief of the run carries, and whether the run resumes the session of the work
    // before it; both settled before the task is taken, so a failure here claims nothing.
    const frame = await this.frameOf(board, task)
    const session = plain.sessionId === undefined ? await this.session(task, prepared, plain.template, runId) : undefined
    const started = { ...plain, ...(classification ? { classification } : {}), ...(session?.sessionId ? { sessionId: session.sessionId } : {}) }
    const admittedAs = session?.sessionId ? e.prepare(started) : prepared
    const { option, generation, expiresAt, decision } = await this.take(board, task, claim, runId)
    const bound = { runId, taskId: task.taskId, holder: claim.holder ?? ownerOf(runId), generation, claim: option === 'adopt' ? 'adopted' as const : 'own' as const, writes: task.writes, frame }
    // A concurrent start under the same clientRequestId admitted its own run: this one starts nothing,
    // and the claim it took lapses back to ready on its own.
    const admitted = e.admit(started, admittedAs, bound)
    if (admitted.runId !== runId) return admitted
    // Run first, then work: the board records the run before any node runs (fail-closed rule 3).
    try {
      await board.start(task.taskId, generation, { runId })
    } catch (error) {
      // A refusal changed nothing on the board; anything else may have committed: the board's record decides.
      const record = error instanceof BoardError ? undefined : await board.task(task.taskId).catch(() => undefined)
      if (record?.run?.runId !== runId) {
        if (!(error instanceof BoardError) && record === undefined) {
          // The board answers nothing: the run stays starting, and its first advance reconciles it.
          e.schedule(runId)
          throw new WorkflowFailure('overloaded', `the board did not answer the start of run ${runId} for task ${task.taskId} (${(error as Error).message}); the run starts only once the board shows it recorded`)
        }
        this.discard(runId)
        const why = error instanceof BoardError ? refusal(error) : (error as Error).message
        const refused = this.admission(task, undefined, 'refuse', claim, `the board refused to record the run before it started (${why})`, [decision])
        throw new WorkflowFailure('invalid_input', `the board refused to start task ${task.taskId} (${why}); nothing ran (decision ${refused})`)
      }
    }
    this.activate(runId, { expiresAt, schedule: true })
    return e.get(runId)!
  }

  /**
   * The run a repeated `clientRequestId` already started for a task, if any. That run may have
   * resumed an earlier session, which its spec names: the same request is the same template and
   * input, resolved with or without that session.
   */
  private repeated(input: StartInput, prepared: Prepared): RunRow | undefined {
    if (!prepared.requestKey) return undefined
    const existing = this.e.ctx.store.db.prepare('SELECT * FROM workflow_runs WHERE request_key = ?').get(prepared.requestKey) as RunRow | undefined
    if (!existing) return undefined
    const same = existing.input === input.input && (existing.spec_hash === prepared.spec.specHash
      || (input.sessionId === undefined && !!existing.session_id && this.e.prepare({ ...input, sessionId: existing.session_id }).spec.specHash === existing.spec_hash))
    if (!same) throw new WorkflowFailure('invalid_input', 'clientRequestId was reused with a different request')
    return existing
  }

  /**
   * What every brief of a task's run carries (docs/design/workflow-engine.md#briefs): the task, the
   * attempt the run will be, its goal and acceptance criteria, and pointers, never content, to the
   * accepted results of the tasks it depends on (their digests when they have one), to its previous
   * attempt's result, and to the decision behind this attempt (a rejection's reasons, the answers to
   * its questions). Only stored artifacts are pointed at, at most {@link FRAME_POINTERS}. The
   * budget is what the task may still draw: its lines less the usage the ledger counts for it.
   */
  private async frameOf(board: Board, task: BoardTask): Promise<TaskFrame> {
    const attempt = task.attempts.count + 1
    const pointers: BriefPointer[] = []
    const add = (ref: ArtifactRef, role: BriefPointer['role'], note: string): void => {
      if (pointers.length < FRAME_POINTERS && !pointers.some((p) => p.ref === ref) && this.e.ctx.artifacts.get(ref)) pointers.push({ ref, role, note: clampText(note, BRIEF_LIMITS.note) })
    }
    for (const id of task.dependsOn) {
      const done = await board.task(id)
      if (!done?.result) continue
      for (const ref of done.result.digest ? [done.result.digest] : done.result.artifacts) add(ref, 'input', `${done.result.digest ? 'the digest of ' : ''}the accepted result of ${id}: ${done.title}`)
    }
    if (task.attempts.count > 0) {
      for (const ref of task.result?.artifacts ?? []) add(ref, 'prior', `the result of attempt ${task.attempts.count}`)
      if (task.result?.digest) add(task.result.digest, 'prior', `the digest of attempt ${task.attempts.count}'s result`)
      if (task.lastDecision) add(task.lastDecision, 'review', `the decision behind attempt ${attempt}: why attempt ${task.attempts.count} did not finish the task`)
    }
    return {
      projectId: task.projectId, taskId: task.taskId, attempt, goal: clampText(task.goal, BRIEF_LIMITS.goal),
      acceptance: task.acceptance.map(({ id, statement }) => ({ id, statement })), pointers, budget: await this.budgetOf(task),
    }
  }

  /**
   * What the task may still draw, per budget line: the line less the usage spent on the task.
   * The ledger counts usage by run: a record names the task (or the run was reserved for it), the
   * workflow run, or the Worker's own execution (an agent Worker's run). The engine attributes to
   * the task every counted record of the runs that served it and of the executions they started
   * (`workflow_tasks`, and each run's `workflow.node.started` events), each record once by its
   * `(source, requestId)`. Tokens are input and output tokens; minutes are not totalled by the
   * ledger and stay as declared. With no ledger loaded, or one that cannot answer, the lines as
   * declared: the brief informs the Worker, and the ledger's reservations enforce the pools.
   */
  private async budgetOf(task: BoardTask): Promise<BriefBudgetLine[]> {
    const lines = task.budget ?? []
    const resources = this.e.ctx.get('resources')
    if (!lines.length || !resources) return lines
    try {
      const records = new Map<string, UsageRecord>()
      const count = (found: UsageRecord[]): void => {
        for (const record of found) records.set(`${record.source}\0${record.requestId}`, record)
      }
      count((await resources.usage({ taskId: task.taskId })).records)
      for (const runId of this.runsOf(task.taskId)) count((await resources.usage({ runId })).records)
      return lines.map((line) => {
        let used = 0
        for (const record of records.values()) {
          if (record.pool !== line.pool) continue
          used += line.unit === 'tokens' ? (record.usage?.inputTokens ?? 0) + (record.usage?.outputTokens ?? 0)
            : line.unit === 'usd' ? record.cost?.amount ?? 0 : line.unit === 'turns' ? record.turns ?? 0 : line.unit === 'runs' ? 1 : 0
        }
        return { ...line, amount: Math.max(0, round6(line.amount - used)) }
      })
    } catch (error) {
      this.warn(`the resource ledger did not count task ${task.taskId}'s usage; its brief names its budget as declared`, error)
      return lines
    }
  }

  /**
   * The ids the ledger may count a task's usage under: every run that served one of its attempts,
   * and every execution those runs started, retries included (each start is a
   * `workflow.node.started` event; a node's current execution as well, should the events be
   * trimmed). A run deleted by retention no longer counts.
   */
  private runsOf(taskId: string): string[] {
    const db = this.e.ctx.store.db
    const runs = (db.prepare('SELECT run_id FROM workflow_tasks WHERE task_id = ? ORDER BY created_at').all(taskId) as Array<{ run_id: string }>).map((r) => r.run_id)
    const ids = new Set(runs)
    for (const runId of runs) {
      for (const { execution_id } of db.prepare('SELECT execution_id FROM workflow_nodes WHERE run_id = ? AND execution_id IS NOT NULL').all(runId) as Array<{ execution_id: string }>) ids.add(execution_id)
      let afterSeq: number | undefined
      for (;;) {
        const page = this.e.ctx.eventLog.query({ runId, type: 'workflow.node.started', limit: 1000, ...(afterSeq !== undefined ? { afterSeq } : {}) })
        for (const event of page) if (typeof event.data?.['executionId'] === 'string') ids.add(event.data['executionId'])
        if (page.length < 1000) break
        afterSeq = page.at(-1)!.seq
      }
    }
    return [...ids]
  }

  /**
   * Whether a task's run resumes the session of the work before it: its previous attempt's run, or,
   * on a first attempt, the run of the one task it depends on (a chain). It does when the template
   * keeps a conversation, the session's Worker keeps a native session it can resume and is ready
   * to, and the session has served fewer than `maxSessionRuns` runs (INV-9); the new brief is then
   * that session's next message. Otherwise the run starts a fresh session, given the brief. The
   * choice is an `admission` decision (`workflow.task-session`). Undefined when there was no work
   * before it with a session, or the caller named a session itself.
   */
  private async session(task: BoardTask, prepared: Prepared, template: string, runId: string): Promise<{ sessionId?: string; decision: ArtifactRef } | undefined> {
    const previous = this.previousSession(task.taskId, 'attempt') ?? (task.attempts.count === 0 && task.dependsOn.length === 1 ? this.previousSession(task.dependsOn[0]!, 'dependency') : undefined)
    if (!previous) return undefined
    const workers = this.e.ctx.workers
    const max = this.e.config.maxSessionRuns ?? 5
    const what = previous.via === 'attempt' ? `attempt ${task.attempts.count}'s run ${previous.runId}` : `run ${previous.runId} of task ${previous.taskId}, which it depends on`
    let fresh: string | undefined
    let handle: string | undefined
    if (!prepared.spec.nodes.some((n) => n.session.persist)) fresh = `template ${template} keeps no conversation across its steps, so there is no session to resume`
    else {
      handle = workers.handle(previous.sessionId)
      const bound = workers.affinity(previous.sessionId) ?? []
      const listed = (await workers.list()).filter((w) => bound.includes(w.worker))
      const ready = listed.find((w) => (w.state === 'ready' || w.state === 'busy') && w.capabilities.some((c) => c.capability === 'persistent-conversation'))
      const served = (this.e.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM workflow_runs WHERE session_id = ?').get(previous.sessionId) as { n: number }).n
      if (!handle) fresh = `session ${previous.sessionId} of ${what} has no native session its Worker can resume`
      else if (!ready) fresh = `the Worker of session ${previous.sessionId} cannot resume it now (${listed.length ? listed.map((w) => `${w.worker} is ${w.state}`).join(', ') : `${bound.join(', ') || 'no Worker'} is not listed`})`
      else if (served >= max) fresh = `session ${previous.sessionId} has served ${served} runs (limit ${max}, workflow.maxSessionRuns; INV-9)`
    }
    const resume = !fresh
    const decision = this.e.ctx.artifacts.recordDecision({
      decisionType: 'admission',
      question: `Does run ${runId}, attempt ${task.attempts.count + 1} of board task ${task.taskId}, resume the session of ${what}?`,
      inputs: [],
      candidates: [
        { option: 'resume', selected: resume, reasons: resume ? [`session ${previous.sessionId} of ${what} keeps native session ${handle}, and its Worker can resume it`, 'the brief is the session\'s next message: the Worker keeps its context'] : [`not resume: ${fresh}`] },
        { option: 'fresh', selected: !resume, reasons: resume ? ['not fresh: the session can be resumed, so the Worker keeps the context it built'] : [fresh!, 'a fresh session is given the brief, which points at the earlier work'] },
      ],
      decider: { type: 'rule', id: 'workflow.task-session', version: '1' },
      outcome: { option: resume ? 'resume' : 'fresh', detail: { taskId: task.taskId, from: previous.runId, sessionId: previous.sessionId, ...(resume ? { nativeHandle: handle } : {}) } },
      deterministic: true,
    }, { ...PRODUCER, runId }).id as ArtifactRef
    return { ...(resume ? { sessionId: previous.sessionId } : {}), decision }
  }

  /** The session of the latest run that served a task, and that run. */
  private previousSession(taskId: string, via: 'attempt' | 'dependency'): { sessionId: string; runId: string; taskId: string; via: 'attempt' | 'dependency' } | undefined {
    const row = this.e.ctx.store.db.prepare(`SELECT r.session_id, r.run_id FROM workflow_tasks t JOIN workflow_runs r ON r.run_id = t.run_id
      WHERE t.task_id = ? AND r.session_id IS NOT NULL ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1`).get(taskId) as { session_id: string; run_id: string } | undefined
    return row ? { sessionId: row.session_id, runId: row.run_id, taskId, via } : undefined
  }

  /** What every brief of a task's run carries, fixed when the run was admitted. */
  frame(runId: string): TaskFrame | undefined {
    const frame = this.row(runId)?.frame
    return frame ? JSON.parse(frame) as TaskFrame : undefined
  }

  /**
   * Take the task for the run, as the caller asked: adopt its live claim, proven by a renewal the
   * board fences by generation, or claim the ready task as the run. The choice is an `admission`
   * decision made before the board is asked; a refusal is one too, and refuses the start.
   */
  private async take(board: Board, task: BoardTask, claim: TaskStartInput['task'], runId: string): Promise<{ option: 'adopt' | 'claim'; generation: number; expiresAt: string; decision: ArtifactRef }> {
    const adopting = claim.holder !== undefined
    const refuse = (why: string, inputs: ArtifactRef[] = []): never => {
      const refused = this.admission(task, undefined, 'refuse', claim, why, inputs)
      throw new WorkflowFailure('invalid_input', `${why}; nothing was started (decision ${refused})`)
    }
    if (adopting) {
      if (task.state !== 'claimed') refuse(`task ${task.taskId} is ${task.state}, not claimed, so there is no claim to hand to the run`)
      if (task.holder?.owner !== claim.holder || task.holder?.generation !== claim.generation) {
        refuse(`a stale claim: task ${task.taskId} is held by ${task.holder?.owner ?? 'no one'} at generation ${task.holder?.generation ?? '(none)'}, not by ${claim.holder} at ${claim.generation}`)
      }
      const decision = this.admission(task, runId, 'adopt', claim, `${claim.holder} hands its live claim (generation ${claim.generation}) to the run`)
      try {
        const renewed = await board.renew(task.taskId, claim.generation!, TASK_LEASE_TTL_MS)
        return { option: 'adopt', generation: claim.generation!, expiresAt: renewed.leaseExpiresAt, decision }
      } catch (error) {
        if (!(error instanceof BoardError)) throw error
        return refuse(`the board refuses the claim handed to the run (${refusal(error)})`, [decision])
      }
    }
    if (task.state !== 'ready') refuse(`task ${task.taskId} is ${task.state}, not ready to claim`)
    const decision = this.admission(task, runId, 'claim', claim, `the caller holds no claim on task ${task.taskId}, which is ready: the run claims it as ${ownerOf(runId)}`)
    try {
      const taken = await board.claim(task.taskId, ownerOf(runId), TASK_LEASE_TTL_MS)
      return { option: 'claim', generation: taken.generation, expiresAt: taken.leaseExpiresAt, decision }
    } catch (error) {
      if (!(error instanceof BoardError)) throw error
      return refuse(`the board refuses the claim (${refusal(error)})`, [decision])
    }
  }

  /** The engine's choice of how a run takes its task: adopt the caller's claim, claim it, or refuse (INV-13). */
  private admission(task: BoardTask, runId: string | undefined, option: 'adopt' | 'claim' | 'refuse', claim: TaskStartInput['task'], why: string, inputs: ArtifactRef[] = []): ArtifactRef {
    const adopting = claim.holder !== undefined
    const reasons = (candidate: 'adopt' | 'claim' | 'refuse'): string[] => {
      if (candidate === option) return candidate === 'refuse' ? [why, 'nothing was started: no node runs, nothing is sent (fail closed)'] : [why]
      if (candidate === 'refuse') return ['not refuse: the task is the caller\'s to start, as the board shows it']
      if (option === 'refuse') return [`not ${candidate}: ${why}`]
      return candidate === 'adopt' ? ['not adopt: the caller hands the run no claim'] : ['not claim: the caller hands the run its live claim, so the task is claimed, not ready']
    }
    const order: Array<'adopt' | 'claim' | 'refuse'> = adopting ? ['adopt', 'claim', 'refuse'] : ['claim', 'adopt', 'refuse']
    return this.e.ctx.artifacts.recordDecision({
      decisionType: 'admission',
      question: `How does ${runId ? `run ${runId}` : 'a new run'} take board task ${task.taskId} for its attempt ${task.attempts.count + 1}?`,
      inputs,
      candidates: order.map((candidate) => ({ option: candidate, selected: candidate === option, reasons: reasons(candidate) })),
      decider: { type: 'rule', id: 'workflow.task-admission', version: '1' },
      outcome: { option, detail: { taskId: task.taskId, ...(claim.holder !== undefined ? { holder: claim.holder, generation: claim.generation } : {}) } },
      deterministic: true,
    }, { ...PRODUCER, ...(runId ? { runId } : {}) }).id as ArtifactRef
  }

  /** The board recorded the run: it opens (team groups, the started event) and, unless its advance is the caller, is scheduled. */
  activate(runId: string, options: { expiresAt?: string | undefined; schedule: boolean }): void {
    this.e.ctx.store.transaction((db) => {
      db.prepare("UPDATE workflow_tasks SET phase = 'started', updated_at = ? WHERE run_id = ? AND phase = 'starting'").run(now(), runId)
      this.e.open(runId)
    })
    if (options.expiresAt) this.renewLater(runId, { expiresAt: options.expiresAt })
    if (options.schedule) this.e.schedule(runId)
  }

  /** A run the board refused to record: nothing of it ran and nothing refers to it, so it leaves no row. */
  private discard(runId: string): void {
    this.e.ctx.store.transaction((db) => {
      db.prepare('DELETE FROM workflow_nodes WHERE run_id = ?').run(runId)
      db.prepare('DELETE FROM workflow_runs WHERE run_id = ?').run(runId)
      db.prepare('DELETE FROM workflow_tasks WHERE run_id = ?').run(runId)
    })
  }

  // --- while the run lives ---

  /**
   * Before a task's run advances: `go` once the board recorded it and the engine knows whether it
   * still holds the task; `wait` while the board is not loaded or did not answer; `stop` when the
   * run will never run (its attempt was settled, or the board never recorded it).
   */
  async gate(runId: string): Promise<'go' | 'wait' | 'stop'> {
    const row = this.row(runId)!
    if (row.phase === 'reported') return 'stop'
    const board = this.e.board
    if (!board) return 'wait'
    if (row.phase === 'starting') {
      const resumed = await this.resume(row, board)
      if (resumed !== 'go') return resumed
    } else if (row.lost || this.renewals.has(runId)) {
      return 'go'
    }
    // After a restart, the lease is renewed before anything runs: a lapse shows now, not later.
    return (await this.renew(this.row(runId)!, board)) === 'unknown' ? 'wait' : 'go'
  }

  /**
   * A run left `starting` by a crash between its admission and the board's record: the board's
   * record decides. Recorded, it opens; still claimed under the run's generation, the start is
   * asked again (nothing has run yet); otherwise it is abandoned, nothing of it having run.
   */
  private async resume(row: TaskRow, board: Board): Promise<'go' | 'wait' | 'stop'> {
    let task: BoardTask | undefined
    try {
      task = await board.task(row.task_id)
    } catch (error) {
      this.warn(`could not read board task ${row.task_id} for run ${row.run_id}`, error)
      return 'wait'
    }
    if (task?.run?.runId === row.run_id) {
      this.activate(row.run_id, { schedule: false })
      return 'go'
    }
    if (task?.state === 'claimed' && task.holder?.owner === row.holder && task.holder.generation === row.generation) {
      try {
        await board.start(row.task_id, row.generation, { runId: row.run_id })
        this.activate(row.run_id, { schedule: false })
        return 'go'
      } catch (error) {
        if (!(error instanceof BoardError)) {
          this.warn(`the board did not answer the start of run ${row.run_id}`, error)
          return 'wait'
        }
      }
    }
    this.abandon(row, task)
    return 'stop'
  }

  /** A run the board never recorded, and now never will: it fails with nothing of it run, and that is its report. */
  private abandon(row: TaskRow, task: BoardTask | undefined): void {
    const where = task ? `task ${task.taskId} is ${task.state}${task.run ? ` with run ${task.run.runId}` : ''}` : `task ${row.task_id} is unknown to the board`
    const decision = this.e.ctx.artifacts.recordDecision({
      decisionType: 'recovery',
      question: `Does run ${row.run_id}, which the board never recorded for task ${row.task_id}, run?`,
      inputs: [],
      candidates: [
        { option: 'abandon', selected: true, reasons: [`${where}, and generation ${row.generation} no longer starts it: nothing of the run has run`] },
        { option: 'run', selected: false, reasons: ['not run: a run the board has not recorded never starts (run first, then work; INV-4)'] },
      ],
      decider: { type: 'rule', id: 'workflow.task-admission', version: '1' },
      outcome: { option: 'abandon', detail: { taskId: row.task_id, generation: row.generation } },
      deterministic: true,
    }, { ...PRODUCER, runId: row.run_id }).id as ArtifactRef
    this.settled(row, { status: 'not-started', ...(task ? { state: task.state } : {}), decision, reason: where })
    const error: WorkflowError = { kind: 'task_not_started', disposition: 'NONE', message: `the board never recorded this run for task ${row.task_id} (${where}); nothing of it ran` }
    this.e.finish(this.e.runRow(row.run_id)!, 'failed', { error: JSON.stringify(error) })
  }

  /** Renew the run's lease on its task; a refusal means the board no longer holds the run's generation. */
  private async renew(row: TaskRow, board: Board): Promise<'live' | 'lost' | 'unknown'> {
    try {
      const renewed = await board.renew(row.task_id, row.generation, TASK_LEASE_TTL_MS)
      this.renewLater(row.run_id, { expiresAt: renewed.leaseExpiresAt })
      return 'live'
    } catch (error) {
      if (error instanceof BoardError && error.failure !== 'conflict') {
        this.markLost(row, refusal(error))
        return 'lost'
      }
      this.warn(`could not renew the lease of run ${row.run_id} on task ${row.task_id}`, error)
      this.renewLater(row.run_id, { delayMs: RENEW_RETRY_MS })
      return 'unknown'
    }
  }

  private renewLater(runId: string, when: { expiresAt: string } | { delayMs: number }): void {
    clearTimeout(this.renewals.get(runId))
    if (this.e.stopped.signal.aborted) return
    const delay = 'delayMs' in when ? when.delayMs : Math.max(1000, Math.floor((Date.parse(when.expiresAt) - Date.now()) / 3))
    const timer = setTimeout(() => void this.tick(runId), Math.min(delay, 2 ** 31 - 1))
    timer.unref()
    this.renewals.set(runId, timer)
  }

  private async tick(runId: string): Promise<void> {
    this.renewals.delete(runId)
    if (this.e.stopped.signal.aborted) return
    const row = this.row(runId)
    if (!row || row.phase !== 'started' || row.lost || this.e.runRow(runId)?.status !== 'running') return
    const board = this.e.board
    if (!board) return this.renewLater(runId, { delayMs: RENEW_RETRY_MS })
    // A lost holder winds the run down: its advance, if any is waiting, looks again.
    if ((await this.renew(row, board)) === 'lost') this.e.schedule(runId)
  }

  /** The board no longer holds the run's generation: a `recovery` decision, then the run starts nothing new. */
  private markLost(row: TaskRow, reason: string): void {
    const decision = this.e.ctx.artifacts.recordDecision({
      decisionType: 'recovery',
      question: `Does run ${row.run_id} go on after the board no longer holds its generation ${row.generation} of task ${row.task_id}?`,
      inputs: [],
      candidates: [
        { option: 'wind-down', selected: true, reasons: [`the board refuses generation ${row.generation} (${reason})`, 'the executions in flight are reconciled and their results taken; nothing new starts (INV-4)'] },
        { option: 'go-on', selected: false, reasons: ['not go on: without the holder, a new step could write beside an attempt the board starts next (INV-15)'] },
      ],
      decider: { type: 'rule', id: 'workflow.task-holder', version: '1' },
      outcome: { option: 'wind-down', detail: { taskId: row.task_id, generation: row.generation } },
      deterministic: true,
    }, { ...PRODUCER, runId: row.run_id }).id as ArtifactRef
    const lost: Lost = { at: now(), decision, reason }
    this.e.ctx.store.transaction((db) => {
      db.prepare('UPDATE workflow_tasks SET lost = ?, updated_at = ? WHERE run_id = ? AND lost IS NULL').run(JSON.stringify(lost), now(), row.run_id)
      this.e.ctx.eventLog.append({ type: 'workflow.task.lost', runId: row.run_id, decision, data: { taskId: row.task_id, generation: row.generation, reason } })
    })
    clearTimeout(this.renewals.get(row.run_id))
    this.renewals.delete(row.run_id)
  }

  /** Nothing is in flight in a run that lost its holder: what is left fails, and the run with it. */
  windDown(run: RunRow, nodes: NodeRow[], lease: () => Lease): void {
    const row = this.row(run.run_id)!
    const lost = JSON.parse(row.lost!) as Lost
    const error: WorkflowError = {
      kind: 'holder_lost', disposition: 'NONE',
      message: `the board no longer holds this run's generation ${row.generation} of task ${row.task_id} (${lost.reason}); nothing new started, and the board decides the next attempt`,
    }
    for (const node of nodes) {
      if (node.state === 'COMPLETED' || node.state === 'FAILED' || node.state === 'RETIRED') continue
      this.e.writeNode(node, { state: 'FAILED', error: JSON.stringify(error) }, (r) => ({ ...r, lastDecision: lost.decision }), lease)
    }
    this.e.finish(run, 'failed', { error: JSON.stringify(error) }, lease)
  }

  // --- the outcome ---

  /**
   * A task's run completed: bind its result to the exact subject the task leaves, and decide on it
   * (the `acceptance` decision the board applies). The subject is the task's written subject at
   * the version the run left it (the latest result on that type and ref, still current when it
   * names a working tree), else the result artifact itself. Undefined when the run is not a task's,
   * or the result binds; else why it does not, and the run fails (INV-5).
   */
  complete(run: RunRow, nodes: NodeRow[], final: ArtifactRef): WorkflowError | undefined {
    const row = this.row(run.run_id)
    if (!row) return undefined
    const writes = row.writes ? JSON.parse(row.writes) as Subject : undefined
    const done = nodes.filter((n) => n.state === 'COMPLETED')
    const resultOf = (n: NodeRow): ArtifactRef => (JSON.parse(n.record) as NodeRecord).outputReceipt!.result
    let subject: Subject = { type: 'artifact', ref: final }
    let artifacts: ArtifactRef[] = [final]
    if (writes) {
      const source = [...done].reverse().map(resultOf).find((r) => {
        const body = this.e.ctx.artifacts.get(r)?.body as { subject?: Subject } | undefined
        return body?.subject?.type === writes.type && body.subject.ref === writes.ref
      })
      const body = source ? this.e.ctx.artifacts.get(source)!.body as { subject: Subject; workspace?: string } : undefined
      const current = body?.workspace && body.subject.type === 'git-head' ? captureGitSubject(body.workspace) : undefined
      const problem = !body ? `no result of the run is on ${writes.type} ${writes.ref}, the subject task ${row.task_id} writes`
        : body.workspace && body.subject.type === 'git-head' && (!current || current.subject.ref !== body.subject.ref || current.subject.version !== body.subject.version)
          ? `the working tree ${body.workspace} is no longer ${describe(body.subject)}${current ? ` (now ${describe(current.subject)})` : ''}`
          : undefined
      if (problem) return this.unbound(run, row, problem, source)
      subject = { type: body!.subject.type, ref: body!.subject.ref, ...(body!.subject.version !== undefined ? { version: body!.subject.version } : {}) }
      artifacts = [...new Set([source!, final])]
    }
    const checks = this.checksOf(done, subject)
    const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([check]) => check)
    const option = failed.length ? 'reject' : 'accept'
    const ran = Object.keys(checks).length ? `the checks it ran: ${Object.entries(checks).map(([c, p]) => `${c} ${p ? 'passed' : 'failed'}`).join(', ')}` : 'it ran none of the checks a policy can require; the board binds those'
    const acceptance = this.e.ctx.artifacts.recordDecision({
      decisionType: 'acceptance',
      question: `Does run ${run.run_id}'s result complete its attempt of board task ${row.task_id}?`,
      inputs: artifacts,
      candidates: [
        { option: 'accept', selected: !failed.length, reasons: failed.length ? [`not accept: the run's own ${failed.join(', ')} check failed`] : [`every step of the run was accepted by its contract, and its result is on ${describe(subject)}`, ran] },
        { option: 'reject', selected: !!failed.length, reasons: failed.length ? [`the run's own ${failed.join(', ')} check failed on ${describe(subject)}: the work goes back as another attempt`] : ['not reject: no check the run ran failed'] },
      ],
      decider: { type: 'rule', id: 'workflow.task-acceptance', version: '1' },
      outcome: { option, detail: { taskId: row.task_id, runId: run.run_id, subject, checks } },
      deterministic: true,
    }, { ...PRODUCER, runId: run.run_id }).id as ArtifactRef
    const result: Result = { artifacts, subject }
    this.e.ctx.store.transaction((db) => {
      db.prepare('UPDATE workflow_tasks SET result = ?, acceptance = ?, updated_at = ? WHERE run_id = ?').run(JSON.stringify(result), acceptance, now(), run.run_id)
    })
    return undefined
  }

  /** The run's result does not bind to the subject its task writes: a `gate` decision, and the run fails as `stale_subject`. */
  private unbound(run: RunRow, row: TaskRow, problem: string, source: ArtifactRef | undefined): WorkflowError {
    this.e.ctx.artifacts.recordDecision({
      decisionType: 'gate',
      question: `Does run ${run.run_id}'s result bind to the subject board task ${row.task_id} writes?`,
      inputs: source ? [source] : [],
      candidates: [
        { option: 'fail', selected: true, reasons: [problem] },
        { option: 'pass', selected: false, reasons: ['not pass: a task\'s result is on the exact subject it writes, at the version the run left it (INV-5, INV-15)'] },
      ],
      decider: { type: 'rule', id: 'workflow.task-subject', version: '1' },
      outcome: { option: 'fail', detail: { taskId: row.task_id } },
      deterministic: true,
    }, { ...PRODUCER, runId: run.run_id })
    return { kind: 'stale_subject', disposition: 'NONE', message: `the result does not bind to board task ${row.task_id}: ${problem}` }
  }

  /**
   * The checks the run itself ran on its result, by the board's names: `schema`, when the final
   * step's answer was checked against a result schema; `review`, when an exact-subject review of
   * the very subject the result is on passed its gate (passed when it approved). Nothing else is
   * reported: a check the run did not run is never claimed.
   */
  checksOf(done: NodeRow[], subject: Subject): Partial<Record<'schema' | 'review', boolean>> {
    const checks: Partial<Record<'schema' | 'review', boolean>> = {}
    const final = done.at(-1)
    if (final && (JSON.parse(final.spec) as ResolvedNode).resultSchema) checks.schema = true
    if (subject.type !== 'git-head' || subject.version === undefined) return checks
    const id = `git:${subject.ref}:${subject.version}`
    for (const node of done) {
      const bound = node.subject ? (JSON.parse(node.subject) as { subject?: { ref: string; version: string } }).subject : undefined
      if (!bound || `git:${bound.ref}:${bound.version}` !== id) continue
      for (const ref of node.decisions ? JSON.parse(node.decisions) as ArtifactRef[] : []) {
        const body = this.e.ctx.artifacts.get(ref)?.body as { decisionType?: string; decider?: { id?: string }; outcome?: { option?: string; detail?: { assessment?: ArtifactRef } } } | undefined
        if (body?.decisionType !== 'gate' || body.decider?.id !== 'workflow.exact-subject' || body.outcome?.option !== 'pass' || !body.outcome.detail?.assessment) continue
        const verdict = (this.e.ctx.artifacts.get(body.outcome.detail.assessment)?.body as { verdict?: string } | undefined)?.verdict
        // The latest review of the subject decides, as remediation's last cycle does.
        if (verdict) checks.review = verdict === 'approve'
      }
    }
    return checks
  }

  /** The run finished: its lease is no longer renewed, and its outcome is reported. */
  finished(runId: string): void {
    clearTimeout(this.renewals.get(runId))
    this.renewals.delete(runId)
    if (this.bound(runId)) void this.report(runId)
  }

  /** Report a finished run's outcome to its task, once at a time; a board that does not answer is asked again later. */
  report(runId: string): Promise<void> {
    const busy = this.reporting.get(runId)
    if (busy) return busy
    const reporting = this.settle(runId)
      .catch((error: unknown) => {
        this.warn(`the outcome of run ${runId} did not reach its board task; it is reported again`, error)
        this.reportLater(runId)
      })
      .finally(() => this.reporting.delete(runId))
    this.reporting.set(runId, reporting)
    return reporting
  }

  private reportLater(runId: string): void {
    if (this.e.stopped.signal.aborted) return
    const previous = this.retries.get(runId)
    clearTimeout(previous?.timer)
    const tries = (previous?.tries ?? 0) + 1
    const timer = setTimeout(() => void this.report(runId), Math.min(REPORT_RETRY_MS * 2 ** (tries - 1), REPORT_RETRY_MAX_MS))
    timer.unref()
    this.retries.set(runId, { timer, tries })
  }

  /**
   * The board's own move for the run's outcome, read against the board's record first so a
   * report repeated after a crash moves nothing twice: a completed run with its holder is
   * submitted, then its acceptance applied; a completed run without it, and a failed run, is
   * reported with `reconcileRun`. A task that no longer waits on this run takes no report.
   */
  private async settle(runId: string): Promise<void> {
    const row = this.row(runId)
    const run = this.e.runRow(runId)
    if (!row || row.phase === 'reported' || !run || run.status === 'running') return
    const board = this.e.board
    // Reported once the board is back (attach).
    if (!board) return
    const task = await board.task(row.task_id)
    // Stopped before the board's record was seen: the record decides whether anything is reported.
    if (row.phase === 'starting' && task?.run?.runId !== runId) return this.settled(row, { status: 'not-started', ...(task ? { state: task.state } : {}) })
    if (task && row.acceptance && task.lastDecision === row.acceptance) return this.settled(row, { status: task.state === 'done' ? 'accepted' : 'rejected', state: task.state, decision: row.acceptance })
    if (!task || task.run?.runId !== runId) {
      return this.settled(row, { status: 'moved-on', ...(task ? { state: task.state } : {}), reason: task ? `task ${task.taskId} is ${task.state} and no longer waits on run ${runId}` : `task ${row.task_id} is unknown to the board` })
    }
    const waits = task.state === 'running' || (task.state === 'waiting-for-approval' && task.waiting?.reason === 'reconciliation-failed')
    if (run.status === 'completed' && row.result && row.acceptance) {
      const result = JSON.parse(row.result) as Result
      const outcome: RunOutcome = { status: 'completed', result, acceptance: row.acceptance as ArtifactRef }
      if (task.state === 'review') return this.accept(row, board, row.acceptance as ArtifactRef)
      if (task.state === 'running' && !row.lost) {
        try {
          await board.submit(row.task_id, row.generation, result)
        } catch (error) {
          if (!(error instanceof BoardError)) throw error
          if (error.failure !== 'stale-generation') return this.settled(row, { status: 'refused', state: task.state, reason: `submit: ${refusal(error)}` })
          return this.reconcile(row, board, outcome, `generation ${row.generation} lapsed before the result was submitted`)
        }
        return this.accept(row, board, row.acceptance as ArtifactRef)
      }
      if (waits) return this.reconcile(row, board, outcome, row.lost ? 'the run lost its holder, then completed what was in flight' : `the task waits on the run (${task.state})`)
    } else if (waits) {
      const error = run.error ? (JSON.parse(run.error) as WorkflowError) : undefined
      return this.reconcile(row, board, { status: 'failed' }, `the run failed${error ? ` (${error.kind})` : ''}: an attempt the board counts`)
    }
    return this.settled(row, { status: 'moved-on', state: task.state, reason: `task ${task.taskId} is ${task.state}, and takes no report of a ${run.status} run` })
  }

  /**
   * Apply the engine's acceptance decision. One the board does not apply because only the
   * operator's acceptance accepts the result now (a required check not reported) leaves the task
   * in review, held by the board for the operator.
   */
  private async accept(row: TaskRow, board: Board, acceptance: ArtifactRef): Promise<void> {
    try {
      const task = await board.accept(row.task_id, acceptance)
      if (task.state === 'review') {
        return this.settled(row, { status: 'review', state: task.state, decision: acceptance, reason: `held for the operator until ${task.waiting?.expiresAt ?? '(no expiry)'}${task.waiting?.pendingChecks?.length ? `: ${task.waiting.pendingChecks.join(', ')} pending` : ''}` })
      }
      return this.settled(row, { status: task.state === 'done' ? 'accepted' : 'rejected', state: task.state, decision: acceptance })
    } catch (error) {
      if (!(error instanceof BoardError)) throw error
      return this.settled(row, { status: 'refused', state: 'review', decision: acceptance, reason: `accept: ${refusal(error)}` })
    }
  }

  /** Report the run's known outcome with `reconcileRun`, after a `reconciliation` decision saying why (INV-4). */
  private async reconcile(row: TaskRow, board: Board, outcome: RunOutcome, why: string): Promise<void> {
    const decision = this.e.ctx.artifacts.recordDecision({
      decisionType: 'reconciliation',
      question: `Does run ${row.run_id} report its ${outcome.status} outcome to board task ${row.task_id} as the run's owner?`,
      inputs: outcome.status === 'completed' ? [outcome.acceptance] : [],
      candidates: [
        { option: 'report', selected: true, reasons: [why, `the run ${outcome.status}, as its own records show: a known outcome, reconciled, never replayed (INV-4)`] },
        { option: 'withhold', selected: false, reasons: ['not withhold: only an unknown outcome is withheld, and this run\'s is known'] },
      ],
      decider: { type: 'rule', id: 'workflow.task-report', version: '1' },
      outcome: { option: 'report', detail: { taskId: row.task_id, runId: row.run_id, status: outcome.status } },
      deterministic: true,
    }, { ...PRODUCER, runId: row.run_id }).id as ArtifactRef
    try {
      const task = await board.reconcileRun(row.task_id, row.run_id, outcome)
      return this.settled(row, { status: 'reconciled', state: task.state, decision })
    } catch (error) {
      if (!(error instanceof BoardError)) throw error
      return this.settled(row, { status: 'refused', decision, reason: `reconcileRun: ${refusal(error)}` })
    }
  }

  private settled(row: TaskRow, outcome: TaskOutcome): void {
    // A result that reached the board is due its digest, in the transaction that reports it, so a restart asks for it once.
    const due = this.e.ctx.store.transaction((db) => {
      db.prepare("UPDATE workflow_tasks SET phase = 'reported', outcome = ?, updated_at = ? WHERE run_id = ?").run(JSON.stringify(outcome), now(), row.run_id)
      this.e.ctx.eventLog.append({ type: 'workflow.task.reported', runId: row.run_id, ...(outcome.decision ? { decision: outcome.decision } : {}), data: { taskId: row.task_id, ...outcome } })
      return this.digests.due(row, outcome.status)
    })
    if (due) this.digests.drive(row.run_id)
    clearTimeout(this.retries.get(row.run_id)?.timer)
    this.retries.delete(row.run_id)
    if (outcome.status === 'review' || outcome.status === 'refused') this.e.ctx.logger.warn(`workflow: run ${row.run_id}'s outcome left board task ${row.task_id} ${outcome.state ?? 'as it was'}: ${outcome.reason ?? outcome.status}`)
  }

  private warn(what: string, error: unknown): void {
    this.e.ctx.logger.warn(`workflow: ${what}: ${(error as Error)?.message ?? String(error)}`)
  }
}

/** The lease owner of a run that claims its task itself. */
const ownerOf = (runId: string): string => `workflow:${runId}`

/**
 * A task's run is classified at least as strictly as its project (INV-12): the project's
 * classification when the caller names none, and a laxer one is refused.
 */
function classificationOf(given: Classification | undefined, project: Classification | undefined, task: BoardTask): Classification | undefined {
  if (!project) return given
  if (!given) return project
  if (RANK[given] < RANK[project]) throw new WorkflowFailure('invalid_input', `project ${task.projectId} is ${project}: a run for its task ${task.taskId} cannot be ${given} (INV-12); nothing was started`)
  return given
}

