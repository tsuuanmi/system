/**
 * Work state machine seam definitions: `ctx.board` and `ctx.leases` (the one-writer fence, INV-15).
 * `ctx.board`: projects with charters and board tasks that
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
export * from './leases.ts'

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
 * 1.4 adds the optional {@link Board.reopen} (ADR-0068): a done task's result that could not land
 * on its target as it is now goes back as another attempt. 1.5 adds the optional `infrastructure`
 * of a failed {@link RunOutcome}: a run that failed only on the infrastructure (the host stopped
 * it, nothing of it was sent, or a Worker became unavailable) is not counted as an attempt, within
 * a bound of free retries per task (ADR-0069, INV-9).
 */
export const BOARD_CONTRACT = '1.5'

/** The longest reason a {@link Board.reopen} carries (INV-9). */
export const REOPEN_REASON_MAX = 2000

/** What sends a done task's result back ({@link Board.reopen}, 1.4): the run whose result it is, its acceptance, the decision that sends it back, and why. */
export interface Reopening {
  runId: string
  acceptance: ArtifactRef
  decision: ArtifactRef
  reason: string
}

/** The line of the auto-accept circuit breaker (ADR-0067, D93): it trips at `escapes` escaped defects within `days` days. */
export interface BreakerLine { escapes: number; days: number }
/** The default line: 2 escaped defects in 7 days. */
export const BREAKER_DEFAULT: BreakerLine = { escapes: 2, days: 7 }
/** A defect found after an auto-accepted result landed, recorded by the operator or the lead against the task whose result it was in. */
export interface Escape {
  escapeId: string
  projectId: string
  branch: string
  taskId: string
  /** The auto-accepting `board` decision of the task (rule `board.auto-accept`). */
  acceptance: ArtifactRef
  foundAt: string
  recordedAt: string
  recordedBy: 'operator' | 'lead'
  note: string
}
/** Where auto-accept stands for one project and branch once the breaker has tripped. */
export interface Breaker {
  breakerId: string
  projectId: string
  branch: string
  state: 'tripped' | 'reset'
  line: BreakerLine
  trippedAt: string
  /** The `board` decision (rule `board.auto-accept-breaker`) that turned auto-accept off, naming the escapes it counted. */
  decision: ArtifactRef
  /** The escapes it counted. */
  escapes: Escape[]
  /** Escapes of the project and branch within the line's window now, and whether the line holds (fewer than the line). */
  now?: { counted: number; lineHolds: boolean }
  reset?: { at: string; by: 'operator' | 'lead'; decision: ArtifactRef }
}

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

/** Who set a {@link Defect} link: the task's filer, the lead, the reviewer, or the operator. */
export type DefectBy = 'filed' | 'lead' | 'reviewer' | 'operator'
/** The shortest and longest landing sha a {@link Defect} names (a git abbreviation to a SHA-256 object id). */
export const DEFECT_SHA = { min: 7, max: 64 } as const
/**
 * The `defect` link of a task (`board-task@1.2`): it fixes a defect of `fixes`, a done task, in the
 * change that landed at `sha`. Set when the task is filed (`TaskInput.fixes`) or later by the lead or
 * the reviewer ({@link Board.linkDefect}); `system metrics` counts the fixed tasks as escaped defects.
 */
export interface Defect { fixes: string; sha: string; at: string; by: DefectBy }

/** `board-task@1.0`; `board-task@1.1` once it carries a funding ask (`waiting.funding`) or a raise (`funding`); `board-task@1.2` once it carries a `defect` link. */
export interface BoardTask {
  schema: 'board-task@1.0' | 'board-task@1.1' | 'board-task@1.2'
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
  /** 1.2: the task this one fixes a defect of, and the landing sha of the change that held it. */
  defect?: Defect
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
  /** The defect this task fixes: a done task of the project and the sha its change landed at (the task's `defect` link). */
  fixes?: { taskId: string; sha: string }
}

export interface Claim { taskId: string; generation: number; leaseExpiresAt: string }

/**
 * Why a failed run failed only on the infrastructure, as its owner found it (1.5, ADR-0069): the
 * host stopped it (`host-stopped`: a drain or restart interrupted it), nothing of it was sent
 * (`unsent`: a Worker's own failure before the send, nothing submitted to any Worker; never a
 * refusal by the task's own budget, policy, or input), or a Worker it needed
 * became unavailable while it ran (`worker-unavailable`). `reason` says what happened, in words.
 */
export interface InfrastructureFailure { kind: 'host-stopped' | 'unsent' | 'worker-unavailable'; reason: string }

/** The kinds of {@link InfrastructureFailure}. */
export const INFRASTRUCTURE_KINDS: readonly InfrastructureFailure['kind'][] = ['host-stopped', 'unsent', 'worker-unavailable']

/** The most characters an {@link InfrastructureFailure}'s reason holds. */
export const INFRASTRUCTURE_REASON_MAX = 500

/**
 * Failed runs of one task that a board does not count as attempts, at most, by default (1.5, INV-9):
 * past it, an infrastructure failure counts as any failed run does, so one that persists still ends
 * the task waiting for input (`retries-spent`), with the reason.
 */
export const FREE_RETRIES_DEFAULT = 3
/** The most a board may be configured to allow (INV-9). */
export const FREE_RETRIES_MAX = 10

/**
 * Why `infrastructure` is not what a failed run's outcome may carry ({@link RunOutcome}, 1.5), or
 * undefined: a known kind and a reason of 1 to {@link INFRASTRUCTURE_REASON_MAX} characters, nothing
 * else. A provider refuses such a report as `invalid`.
 */
export function infrastructureProblem(infrastructure: unknown): string | undefined {
  const i = infrastructure as Partial<Record<keyof InfrastructureFailure, unknown>> | null
  if (typeof infrastructure !== 'object' || i === null || Array.isArray(infrastructure)) return 'a failed run\'s infrastructure is an object with its kind and reason'
  if (Object.keys(i).some((k) => k !== 'kind' && k !== 'reason')) return 'a failed run\'s infrastructure names only its kind and reason'
  if (!INFRASTRUCTURE_KINDS.includes(i.kind as InfrastructureFailure['kind'])) return `a failed run's infrastructure kind is one of ${INFRASTRUCTURE_KINDS.join(', ')}`
  if (typeof i.reason !== 'string' || i.reason.length === 0 || [...i.reason].length > INFRASTRUCTURE_REASON_MAX) return `a failed run's infrastructure reason is 1 to ${INFRASTRUCTURE_REASON_MAX} characters`
  return undefined
}

/**
 * The free retries a board allows per task, as configured: {@link FREE_RETRIES_DEFAULT} when unset,
 * else a whole number from 0 to {@link FREE_RETRIES_MAX}; anything else is refused (TypeError), so a
 * malformed bound never starts a board (INV-2, INV-9).
 */
export function freeRetriesOf(configured: unknown): number {
  if (configured === undefined) return FREE_RETRIES_DEFAULT
  if (typeof configured !== 'number' || !Number.isInteger(configured) || configured < 0 || configured > FREE_RETRIES_MAX) {
    throw new TypeError(`board.maxFreeRetries is a whole number from 0 to ${FREE_RETRIES_MAX}, not ${JSON.stringify(configured)}`)
  }
  return configured
}

/**
 * A run's outcome as its owner (the workflow engine) reconciled it: completed, with its result and
 * the `acceptance` decision on it, or failed. An unknown outcome is never reported. A failed run may
 * say it failed only on the infrastructure (`infrastructure`, 1.5): the board then does not count it
 * as an attempt while the task has free retries left ({@link FREE_RETRIES_DEFAULT}), and says so.
 */
export type RunOutcome =
  | { status: 'completed'; result: { artifacts: ArtifactRef[]; digest?: ArtifactRef; subject: Subject; files?: string[]; next?: string }; acceptance: ArtifactRef }
  | { status: 'failed'; infrastructure?: InfrastructureFailure }

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
  /**
   * Whether the task's next start continues the attempt whose question was answered (T291): that
   * run is attempt `attempts.count` again, not `count + 1`. False for a board that keeps no such mark.
   */
  async continuing(_taskId: string): Promise<boolean> { return false }
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
   *
   * `infrastructure` (1.5, optional, failed only): the run failed only on the infrastructure. While
   * the task has free retries left (the provider's bound, {@link FREE_RETRIES_DEFAULT} unless
   * configured, at most {@link FREE_RETRIES_MAX}), the board does not count it: `attempts.count` goes
   * back down by one, the free retry is counted instead, and the task goes back for the same attempt
   * through the gate, on a `board` decision that names the kind, the reason, and the free retries
   * used and allowed (`outcome.detail.infrastructure`, `outcome.detail.freeRetry`). Past the bound it
   * counts as any failed run, and its decision says why, with the reason, so one that persists ends
   * waiting for input (`retries-spent`). Malformed (see {@link infrastructureProblem}), the report is
   * `invalid` and nothing changes. A task the sweep left waiting for input (`rejected`) on its lost
   * run, the policy giving `remediation` no ask, still takes such a report while a free retry is
   * left; any other report to that wait is `invalid-transition`, and nothing changes.
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
   * Send a done task's accepted result back as another attempt (contract 1.4, ADR-0068; optional: a
   * provider at 1.3 has none, and a result that cannot land then stays done for the operator). Only
   * while the task is `done` on exactly `back.runId`'s result, accepted by `back.acceptance`
   * (`invalid-transition` otherwise), and only on a stored `back.decision` with a `reason` of 1 to
   * {@link REOPEN_REASON_MAX} characters (`invalid` otherwise); nothing changes when refused. The move
   * is the one a rejected attempt makes: through the gate again for the next attempt when one is
   * left (ready, waiting for approval, or cancelled when the policy now forbids the class), else a
   * wait for input (`retries-spent`). Its `board` decision names `back.decision` among its inputs and
   * says why. The attempt the result was made in is already counted; the reopening counts none.
   */
  abstract reopen?(taskId: string, back: Reopening, at?: Date): Promise<BoardTask>

  /**
   * Bring a `review-expired` task back to review, held for the operator for the policy's wait for its
   * class (optional; T286). By the operator or the lead, with a reason of 1 to
   * {@link REOPEN_REASON_MAX} characters (`invalid` otherwise), while the task has its run and result
   * (`invalid-transition` otherwise); recorded as a `board` decision; no attempt is counted.
   */
  abstract reopenReview?(taskId: string, by: 'operator' | 'lead', reason: string, at?: Date): Promise<BoardTask>

  /**
   * Record a defect found after a task's auto-accepted result landed (optional; not yet in a contract
   * version, ADR-0067 amendment, D93). Only for a done task whose last decision is the auto-accept
   * rule's (`invalid` otherwise, and once per task). When the project and branch have escapes at the
   * line within its window, auto-accept for them turns off (the breaker trips) on a `board` decision
   * naming every escape it counted, in the same transaction.
   */
  recordEscape?(input: { taskId: string; by: 'operator' | 'lead'; note: string; foundAt?: string }, at?: Date): Promise<{ escape: Escape; breaker?: Breaker }>

  /**
   * Link a task to the defect it fixes (optional; `board-task@1.2`): `fixes` is a done task of the same
   * project, `sha` the landing sha of its change. Once per task (`invalid` otherwise, and for a task
   * that is not of the project's, a `fixes` that is not done, a sha that is not 7 to 64 hex characters,
   * or a task fixing itself); `by` is who set it. No state moves and no decision is made.
   */
  linkDefect?(taskId: string, defect: { fixes: string; sha: string; by: Exclude<DefectBy, 'filed'> }, at?: Date): Promise<BoardTask>

  /** The escapes recorded (of one project, or all), oldest first: what `system metrics` reads as escaped defects. */
  escapes?(projectId?: string): Promise<Escape[]>

  /** The tripped breakers (of one project, or all), each with the count now; a breaker never resets by itself. */
  breakers?(projectId?: string, at?: Date): Promise<Breaker[]>

  /**
   * Turn auto-accept on again for a project and branch, by the operator or the lead, and only once
   * the line holds: fewer escapes than the line within its window as of `at` (`invalid` otherwise).
   * Recorded as a `board` decision naming the trip's. Nothing else turns it on: not the sweep, not time.
   */
  resetBreaker?(projectId: string, branch: string, by: 'operator' | 'lead', at?: Date): Promise<Breaker>

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
