/**
 * Work state machine seam definition: `ctx.board`, projects with charters and board tasks that
 * outlive a run (docs/design/board.md). The types mirror `project@1.0` and `board-task@1.0`; the
 * schemas in `schemas/` are canonical. Only the board moves a task, each move naming the decision
 * behind it (INV-13). A guarantee seam: it fails closed (INV-2), and its contract changes only by
 * an ADR (ADR-0036). It asks for approvals through `ctx.approvals`, never on its own.
 * @module @tsuuanmi/system-board-core
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import type { ActionClass, ArtifactRef, Check, Classification, Subject } from '@tsuuanmi/system-approvals-core'

export type { ActionClass, ArtifactRef, Check, Classification, Subject }

declare module '@deepseek-ai/cordis' {
  interface Context {
    board: Board
  }
}

/** The contract version of this seam; its conformance suite names the same. */
export const BOARD_CONTRACT = '1.0'

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

/** `board-task@1.0`. */
export interface BoardTask {
  schema: 'board-task@1.0'
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
  waiting?: { reason: WaitReason; approvalRequest?: string; questions?: string[]; pendingChecks?: Check[]; since: string; expiresAt: string }
  cancellation?: { reason: CancelReason; note?: string; at: string }
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
   */
  abstract block(taskId: string, generation: number, wait: { reason: 'budget-spent' | 'reconciliation-failed' | 'question'; questions?: string[] }, at?: Date): Promise<BoardTask>

  /** Answer a question wait's questions, every one (waiting-for-input → ready, through the gate again); no other wait takes answers. */
  abstract answer(taskId: string, answers: string[], at?: Date): Promise<BoardTask>

  /** Cancel a task that is not running or in review. */
  abstract cancel(taskId: string, reason: 'operator' | 'lead' | 'superseded', note?: string, at?: Date): Promise<BoardTask>

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
