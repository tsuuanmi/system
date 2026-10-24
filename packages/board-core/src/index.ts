/**
 * Work state machine seam definition: `ctx.board`, projects with charters and board tasks that
 * outlive a run (docs/design/board.md). The types mirror `project@1.0` and `board-task@1.1`; the
 * schemas in `schemas/` are canonical. Only the board moves a task, each move naming the decision
 * behind it (INV-13). A guarantee seam: it fails closed (INV-2), and its contract changes only by
 * an ADR (ADR-0036). It asks for approvals through `ctx.approvals`, never on its own.
 * @module @tsuuanmi/system-board-core
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import type { ActionClass, ArtifactRef, Check, Classification, Subject } from '@tsuuanmi/system-approvals-core'

export type { ActionClass, ArtifactRef, Check, Classification, Subject }
export { renderTasks } from './projection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    board: Board
  }
}

/**
 * The contract version of this seam; its conformance suite names the same. 1.1 adds the optional
 * {@link Board.attachDigest}: a provider at 1.0 has none. 1.2 adds the optional `funding` of a
 * `budget-spent` {@link Board.block}: the lines the holder asks to raise the task's budget by,
 * bound to the request's subject and applied, exactly, once the operator approves it. 1.3 adds the
 * optional `unreleased` of a `budget-spent` {@link Board.block}: the ledger's reservations the
 * holder could not release, which still count against the task's budget, named in the request.
 */
export const BOARD_CONTRACT = '1.3'

export type Unit = 'tokens' | 'usd' | 'turns' | 'runs' | 'minutes'
export interface BudgetLine { pool: string; unit: Unit; amount: number }
export type CheckKind = 'tests' | 'typecheck' | 'lint' | 'schema' | 'quote-check' | 'review' | 'operator'

export interface Charter {
  version: number
  intent: string
  criteria: Array<{ id: string; statement: string; measure: { kind: 'accepted-results' | 'tests' | 'benchmark' | 'metric' | 'operator'; target?: number; comparison?: 'at-least' | 'at-most'; unit?: string } }>
  constraints: { deadline?: string; egressPolicy?: string; notes?: string[] }
  stopRules: Array<{ id: string; condition: string; action: 'stop' | 'pivot' | 'pause' }>
  budget: { pools: BudgetLine[]; attention?: { maxBatchesPerDay?: number; maxInterruptionsPerDay?: number } }
  approval?: ArtifactRef
}
export interface Milestone { id: string; title: string; criteria?: string[]; state: 'planned' | 'funded' | 'done' | 'dropped'; due?: string; budget?: BudgetLine[]; funding?: ArtifactRef }

export type ProjectState = 'proposed' | 'active' | 'paused' | 'closed'
/** `project@1.0`. */
export interface Project {
  schema: 'project@1.0'
  projectId: string
  title: string
  state: ProjectState
  template?: string
  classification?: Classification
  charter: Charter
  proposedCharter?: Charter
  policy?: string
  milestones: Milestone[]
  closure?: { outcome: 'achieved' | 'stopped' | 'abandoned'; decision: ArtifactRef; lessons?: ArtifactRef; at: string }
  createdAt: string
  updatedAt?: string
  lastDecision?: ArtifactRef
  revision: number
}

export type TaskState = 'proposed' | 'ready' | 'claimed' | 'running' | 'review' | 'waiting-for-input' | 'waiting-for-approval' | 'done' | 'cancelled'
export const TERMINAL: readonly TaskState[] = ['done', 'cancelled']
/** `operator-review`: a task in review whose acceptance only the operator can give now (a required check not passed); the board holds it, not a lease. */
export type WaitReason = 'approval-needed' | 'budget-spent' | 'reconciliation-failed' | 'retries-spent' | 'question' | 'rejected' | 'review-expired' | 'operator-review'
export type CancelReason = 'operator' | 'lead' | 'project-closed' | 'input-expired' | 'superseded' | 'forbidden' | 'dependency-cancelled'

/**
 * A reservation on the resource ledger that one of the task's runs could not release, so it still
 * counts against the task's budget until it expires (1.3): the run, the step that reserved it
 * (`run` for a run's one reservation), and when it stops counting, when the holder knows.
 */
export interface UnreleasedHold { runId: string; step: string; expiresAt?: string }

/** One raise of a task's budget (`board-task@1.1`): the lines the operator approved, that approval, and the board's decision that applied them. */
export interface Funding { lines: BudgetLine[]; approval: ArtifactRef; decision: ArtifactRef; at: string }

/**
 * The subject version of a `budget-spent` request that asks for `funding`, given the sha256 content
 * id of the lines' canonical JSON (as `contentId` in `@tsuuanmi/system-libs` gives it): the verdict
 * binds to exactly those lines (INV-5). A request that asks for none keeps the version
 * `budget-spent`.
 */
export const fundingVersion = (contentIdOfLines: `sha256:${string}`): string => `budget-spent:${contentIdOfLines}`

/** Unreleased reservations a `budget-spent` block names, at most (1.3, INV-9). */
export const UNRELEASED_MAX = 8

/**
 * Why `unreleased` is not what a `budget-spent` block may name ({@link Board.block}, 1.3), or
 * undefined: 1 to {@link UNRELEASED_MAX} holds, each a run id and a step of 1 to 200 characters and
 * an optional ISO date `expiresAt`. A provider refuses such a block as `invalid`.
 */
export function unreleasedProblem(unreleased: unknown): string | undefined {
  if (!Array.isArray(unreleased) || unreleased.length < 1 || unreleased.length > UNRELEASED_MAX) return `a budget-spent block names 1 to ${UNRELEASED_MAX} unreleased reservations`
  const text = (v: unknown): boolean => typeof v === 'string' && v.length > 0 && v.length <= 200
  for (const hold of unreleased as unknown[]) {
    const h = hold as Partial<Record<keyof UnreleasedHold, unknown>> | null
    const date = h?.expiresAt
    if (typeof hold !== 'object' || hold === null || !text(h!.runId) || !text(h!.step)
      || (date !== undefined && (typeof date !== 'string' || !Number.isFinite(Date.parse(date)) || date.length > 40))) {
      return `${JSON.stringify(hold)} is not an unreleased reservation (runId and step, 1 to 200 characters; expiresAt an ISO date when given)`
    }
  }
  return undefined
}

/** The request text that names unreleased reservations (1.3), as every provider writes it. */
export function unreleasedText(unreleased: readonly UnreleasedHold[]): string {
  const named = unreleased.map((h) => `${h.step === 'run' ? 'the reservation' : `step ${h.step}`} of run ${h.runId}${h.expiresAt ? ` (until ${h.expiresAt})` : ''}`).join(', ')
  return `The resource ledger did not release ${named}: ${unreleased.length === 1 ? 'it still counts' : 'they still count'} against the task's budget until ${unreleased.length === 1 ? 'it expires' : 'they expire'}, so the next attempt may be refused again before then.`
}

/** `board-task@1.0`; `board-task@1.1` once it carries a funding ask (`waiting.funding`) or a raise (`funding`). */
export interface BoardTask {
  schema: 'board-task@1.0' | 'board-task@1.1'
  taskId: string
  projectId: string
  milestone?: string
  title: string
  goal: string
  acceptance: Array<{ id: string; statement: string; check?: CheckKind }>
  dependsOn: string[]
  actionClass: ActionClass
  template?: string
  writes?: Subject
  budget?: BudgetLine[]
  state: TaskState
  attempts: { count: number; max: number }
  holder?: { owner: string; generation: number; leaseExpiresAt: string }
  run?: { runId: string; brief?: ArtifactRef; startedAt: string }
  result?: { artifacts: ArtifactRef[]; digest?: ArtifactRef; subject: Subject; files?: string[]; acceptance?: ArtifactRef; next?: string }
  /** `funding` (1.1): for a `budget-spent` wait, the lines its request asks to raise the budget by. */
  waiting?: { reason: WaitReason; approvalRequest?: string; questions?: string[]; pendingChecks?: Check[]; funding?: BudgetLine[]; since: string; expiresAt: string }
  cancellation?: { reason: CancelReason; note?: string; at: string }
  /** 1.1: every raise of `budget` an approved funding request applied, oldest first. */
  funding?: Funding[]
  createdAt: string
  updatedAt?: string
  lastDecision?: ArtifactRef
  revision: number
}

export interface CharterInput {
  /** Absent to found a project; present to amend its charter. */
  projectId?: string
  title: string
  template?: string
  classification?: Classification
  /** Version 1 for a new project, the current one plus 1 for an amendment; never carries its approval. */
  charter: Charter
  milestones?: Milestone[]
}

export interface TaskInput {
  projectId: string
  title: string
  goal: string
  acceptance: BoardTask['acceptance']
  dependsOn?: string[]
  actionClass: ActionClass
  milestone?: string
  template?: string
  writes?: Subject
  budget?: BudgetLine[]
  /** Attempts allowed (default 3, at most 10). */
  maxAttempts?: number
}

export interface Claim { taskId: string; generation: number; leaseExpiresAt: string }

/**
 * A run's outcome as its owner (the workflow engine) reconciled it: completed, with its result and
 * the `acceptance` decision on it, or failed. An unknown outcome is never reported.
 */
export type RunOutcome =
  | { status: 'completed'; result: { artifacts: ArtifactRef[]; digest?: ArtifactRef; subject: Subject; files?: string[]; next?: string }; acceptance: ArtifactRef }
  | { status: 'failed' }

/** Why a board call was refused. Nothing changed. */
export type BoardFailure = 'unknown-project' | 'unknown-task' | 'invalid' | 'invalid-transition' | 'stale-generation' | 'conflict'
export class BoardError extends Error {
  constructor(readonly failure: BoardFailure, message: string) {
    super(message)
    this.name = 'BoardError'
  }
}

export abstract class Board extends Service {
  constructor(ctx: Context) {
    super(ctx, 'board')
  }

  /**
   * Found a project or amend its charter; either asks the operator (action class `charter`) and
   * returns the request. A new project's milestones are all planned, with no funding.
   */
  abstract charter(input: CharterInput, at?: Date): Promise<{ project: Project; approvalRequest: string }>

  abstract project(projectId: string): Promise<Project | undefined>
  abstract projects(filter?: { state?: ProjectState }): Promise<Project[]>

  /** Pause or resume an active project: a paused project starts no task. */
  abstract pause(projectId: string, at?: Date): Promise<Project>
  abstract resume(projectId: string, at?: Date): Promise<Project>

  /** Close a project; refused while one of its tasks is running or in review. Its other open tasks are cancelled. */
  abstract close(projectId: string, outcome: 'achieved' | 'stopped', at?: Date): Promise<Project>

  /** Propose a task; it becomes ready on a later sweep, once its dependencies are done and the policy allows it. */
  abstract propose(input: TaskInput, at?: Date): Promise<BoardTask>

  abstract task(taskId: string): Promise<BoardTask | undefined>
  abstract tasks(filter: { projectId: string; states?: TaskState[] }): Promise<BoardTask[]>

  /** Take a ready task's lease (ready → claimed). */
  abstract claim(taskId: string, owner: string, ttlMs: number, at?: Date): Promise<Claim>

  /** Renew the holder's lease. */
  abstract renew(taskId: string, generation: number, ttlMs: number, at?: Date): Promise<Claim>

  /** Record the run before it starts (claimed → running); each start is an attempt. */
  abstract start(taskId: string, generation: number, run: { runId: string; brief?: ArtifactRef }, at?: Date): Promise<BoardTask>

  /**
   * Record the attempt's result and the exact subject it leaves (running → review), which is the
   * subject the task writes when it names one. Never done directly.
   */
  abstract submit(taskId: string, generation: number, result: { artifacts: ArtifactRef[]; digest?: ArtifactRef; subject: Subject; files?: string[]; next?: string }, at?: Date): Promise<BoardTask>

  /**
   * Apply the `acceptance` decision on the result: done when accepted, else another attempt
   * (through the gate again) or a wait for input. The decision names the task and the result's
   * exact subject in `outcome.detail` and every result artifact in its inputs; one that is not the
   * operator's accepts only when the policy finds none of the class's required checks failed,
   * given the checks it reports (`outcome.detail.checks`). Otherwise the board holds the review
   * for the operator: the lease released, `waiting.reason` `operator-review` with the checks still
   * pending, until the policy's wait for the class; it returns the task in review. A review held so
   * refuses such a decision again; the operator's acceptance, or a rejection, applies.
   */
  abstract accept(taskId: string, acceptance: ArtifactRef, at?: Date): Promise<BoardTask>

  /**
   * The run's owner reports the outcome of the task's recorded run, even after the holder's lease
   * lapsed: a completed run's accepted result makes it done (a rejected one, another attempt; one
   * only the operator may accept now, a review held for the operator, as in `accept`), a failed
   * run counts as an attempt. A pending `reconciliation-failed` approval is withdrawn once
   * the move committed. Fenced by the run id: an outcome for another run is refused.
   */
  abstract reconcileRun(taskId: string, runId: string, outcome: RunOutcome, at?: Date): Promise<BoardTask>

  /**
   * Interrupt a running task: budget spent or a failed reconciliation waits for approval (or, when
   * the policy's verdict is not ask, for input: it is never readied or cancelled on the policy
   * alone), a question waits for input.
   *
   * `funding` (1.2, optional, `budget-spent` only): the lines the holder asks to raise the task's
   * budget by, at most one per pool and unit of its budget, each above zero (`invalid` otherwise,
   * and nothing changes). The `funding` request then binds to exactly those lines (its subject's
   * version is {@link fundingVersion} of them), and the wait keeps them (`waiting.funding`). An ask
   * that would raise a line past the provider's bound per task opens no request: the task waits
   * for input (`rejected`, INV-9). Once the operator approves the request, the board adds exactly
   * those lines to the budget and records the raise (`funding`, and a `board` decision naming the
   * approval) before the next attempt goes through the gate; with no attempt left it raises
   * nothing. Rejected or expired, the budget stays as it was. Without `funding` the request asks
   * only to go on, as at 1.1.
   *
   * `unreleased` (1.3, optional, `budget-spent` only): 1 to {@link UNRELEASED_MAX} reservations the
   * holder could not release ({@link UnreleasedHold}: a run id and a step, each a non-empty string
   * of at most 200 characters, and an ISO date `expiresAt` when given), `invalid` otherwise and
   * nothing changes. The request's consequences name each one and say that the next attempt may be
   * refused again until they expire; they change neither its subject nor the wait, and nothing is
   * released or raised for them.
   */
  abstract block(taskId: string, generation: number, wait: { reason: 'budget-spent' | 'reconciliation-failed' | 'question'; questions?: string[]; funding?: BudgetLine[]; unreleased?: UnreleasedHold[] }, at?: Date): Promise<BoardTask>

  /** Answer a question wait's questions, every one (waiting-for-input → ready, through the gate again); no other wait takes answers. */
  abstract answer(taskId: string, answers: string[], at?: Date): Promise<BoardTask>

  /** Cancel a task that is not running or in review. */
  abstract cancel(taskId: string, reason: 'operator' | 'lead' | 'superseded', note?: string, at?: Date): Promise<BoardTask>

  /**
   * Attach the digest of the task's current result as `result.digest`, once (contract 1.1;
   * optional: a provider at 1.0 has none, and a result then keeps no digest). The digest is a
   * stored `digest@1.0` report whose sources are exactly the result's artifacts (`invalid`
   * otherwise). Refused (`invalid-transition`) while the task has no result, while its reviewer
   * holds the review (a digest would change what the acceptance being made binds to; a review held
   * for the operator takes one, and the operator's acceptance then names it), and once another
   * digest is attached; the same digest again changes nothing. No state moves and no board decision
   * is made: the digest's own settling decision records it, and a digest never accepts anything.
   */
  abstract attachDigest?(taskId: string, digest: ArtifactRef, at?: Date): Promise<BoardTask>

  /**
   * Make every move that is due at `at`: tasks whose dependencies are done become ready or wait
   * for approval; resolved approvals release or stop what waits on them; lost leases and expired
   * waits are applied, including the expiry of a request the queue never resolved or no longer
   * knows; a wait whose request the queue withdrew on a policy change (decider rule
   * `approvals.policy`) goes through its gate again under the current policy; an abandoned
   * project's open tasks are cancelled. Returns the tasks and projects it moved.
   */
  abstract sweep(at: Date): Promise<{ tasks: BoardTask[]; projects: Project[] }>
}
