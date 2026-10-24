/**
 * The engine's record, view, and config types, its row shapes in the store, and its typed
 * refusal. Shared by every module of the engine; nothing here touches the store.
 */
import { randomBytes } from 'node:crypto'
import type { UnreleasedHold } from '@tsuuanmi/system-board-core'
import type { ContentId } from '@tsuuanmi/system-libs'
import type { ArtifactRef, Classification, RunLiveness, Tier, WorkRequirement } from '@tsuuanmi/system-workers-core'
import type { CallerOptions, NodeTemplate } from './spec.ts'

export type RunStatus = 'running' | 'completed' | 'failed'
/** `RETIRED` (workflow-node@1.1): a node a re-plan took out of the graph; it stays as history and never runs. */
export type NodeState = 'WAITING' | 'READY' | 'RUNNING' | 'BLOCKED' | 'COMPLETED' | 'FAILED' | 'RETIRED'

export interface WorkflowError {
  kind: string
  disposition: string
  message: string
}

/** A durable node record (`workflow-node@1.0`; `@1.1` once it is `RETIRED`; `@1.2` once an execution names its brief). */
export interface NodeRecord {
  schema: 'workflow-node@1.0' | 'workflow-node@1.1' | 'workflow-node@1.2'
  runId: string
  nodeId: string
  objective: string
  /** `team`: a team's deterministic tally or decision (no Worker). */
  executor: 'worker' | 'gate' | 'team' | 'effect'
  requirement: WorkRequirement
  dependsOn: string[]
  state: NodeState
  inputReceipt?: { inputHash: ContentId; bundle: ArtifactRef[] }
  outputReceipt?: { result: ArtifactRef; acceptance: ArtifactRef }
  execution?: { executionId: string; attempt: number; owner: string; generation: number; route: ArtifactRef; brief?: ArtifactRef }
  lastDecision?: ArtifactRef
  revision: number
}

export interface NodeView {
  nodeId: string
  state: NodeState
  /** The node's minimum tier. */
  minTier: Tier
  attempt: number
  /** The execution on the Worker's own runtime (a turn id for website Workers). */
  executionId?: string
  /** The Worker source that runs it. */
  source?: string
  worker?: string
  /** The tier of the Worker that served the node. */
  tier?: Tier
  quotaClass?: string
  result?: ArtifactRef
  /** The brief its latest execution was started with (docs/design/workflow-engine.md#briefs). */
  brief?: ArtifactRef
  /** Tokens the result reports spending, when its Worker counts them (model Workers). */
  usage?: { inputTokens: number; outputTokens: number }
  /** It waits until then for an assigned account's limit to reset, sending nothing meanwhile (ADR-0052). */
  waitingUntil?: string
  /**
   * In the usage report only: the resource ledger could not count its execution's usage when it
   * ended (`usage.unknown`), for this reason; a cap counts it as 0. The report and health say
   * whether a record of it was counted since.
   */
  usageUnknown?: 'not-reported' | 'interrupted' | 'refused' | 'failed'
  error?: WorkflowError
}

/** What callers see: never the input text. */
export interface RunView {
  runId: string
  template: string
  status: RunStatus
  specHash: ContentId
  sessionId?: string
  /** The final node's result, and its text. */
  result?: ArtifactRef
  answer?: string
  nodes: NodeView[]
  /**
   * What the run waits for: a `gate`, the operator's approval of `plan` (`approve`), or, for a
   * remediation fix put to the approval queue, the verdict on `approvalRequest` there; or a team's
   * `tie`, a deciding `vote` on `decision` (one of `options`) until `until`.
   */
  blocked?: { kind: 'gate'; nodeId: string; plan: ArtifactRef; until?: string; approvalRequest?: string } | { kind: 'tie'; nodeId: string; decision: ArtifactRef; options: Array<{ option: string; summary: string }>; until: string }
  error?: WorkflowError
  /** The board task the run serves (one attempt of it), when it serves one. */
  task?: TaskView
  createdAt: string
  /** The run's last progress: its own last change or any node's, whichever is later. */
  updatedAt: string
}

/**
 * A run as the MCP `usage` report shows it: who served each step and what it spent, and nothing a
 * run's `result` already gives (its answer, result and brief ids, what it waits for, errors, its
 * task), so a page of recent runs stays small.
 */
export interface UsageRunView extends Pick<RunView, 'runId' | 'template' | 'status' | 'sessionId' | 'createdAt' | 'updatedAt'> {
  nodes: Array<Omit<NodeView, 'result' | 'brief' | 'error'>>
}

export interface StartInput extends CallerOptions {
  template: string
  /** The caller's text: the prompt or the research question. */
  input: string
  classification?: Classification | undefined
  /** Retry-safe request key: the same key returns the same run. */
  clientRequestId?: string | undefined
}

/**
 * The board task a run serves, one attempt of it (docs/design/board.md): its id, and the claim a
 * lead holds when it hands that claim to the run (`holder` and `generation`, both or neither).
 * Without a claim, the run claims the ready task itself.
 */
export interface TaskClaim {
  taskId: string
  holder?: string | undefined
  generation?: number | undefined
}

/** A start for a board task: admission is asynchronous, since the board takes the task first. */
export interface TaskStartInput extends StartInput {
  task: TaskClaim
}

/** The board task a run serves, as its view shows it. */
export interface TaskView {
  taskId: string
  /** The holder's generation the run presents on every board write. */
  generation: number
  /** `adopted`: a lead's claim handed to the run; `own`: the run claimed the task itself. */
  claim: 'adopted' | 'own'
  /** `starting` until the board recorded the run, `started` while it is the task's run, `reported` once its outcome reached the board. */
  phase: 'starting' | 'started' | 'reported'
  /** The board no longer held the run's generation: nothing new started after that (the decision says why). */
  lost?: ArtifactRef
  /** How the outcome reached the board, once reported. */
  outcome?: TaskOutcome
  /** The digest of the run's result: asked for once the result reached the board, and set on the task when written. */
  digest?: TaskDigest
  /** The run's reservation of its task's budget lines, for a task that declares any (docs/design/workflow-engine.md#a-tasks-budget). */
  budget?: TaskBudgetView
  /** The questions a step of the run asked instead of answering (docs/design/workflow-engine.md#a-question-from-a-run). */
  question?: TaskQuestion
}

/**
 * Questions a step of a task's run asked instead of a result: `asked` once the engine read them
 * (its `gate` decision), then `raised` when the board took the question wait, or `refused` when it
 * did not (the run is then reported as a failed one).
 */
export interface TaskQuestion {
  state: 'asked' | 'raised' | 'refused'
  nodeId: string
  questions: string[]
  /** The engine's `gate` decision (`workflow.task-question`). */
  decision: ArtifactRef
  /** Why the board did not take the wait, when it refused it. */
  reason?: string
}

/**
 * Where a task run's reservations stand. The run reserves before each Worker execution of it (a
 * step), not once (ADR-0047, step 1): `due` while no step holds a reservation (before the first, and
 * between steps); `reserved` while a step's reservation is held (the ledger holds it while that
 * execution may draw), each released once its step is no longer in flight; `released` once the run
 * finished and every reservation was released; or `refused`, after which no new step starts:
 * `spent` when a line of the task's budget is reached, which blocks the task (`budget-spent`) unless
 * the run was its last attempt, and otherwise because a pool cannot be drawn on, which fails the run.
 */
export interface TaskBudgetView {
  state: 'due' | 'reserved' | 'refused' | 'released'
  /** The ledger's `budget` decision on the latest step's reservation (the refusal, once refused). */
  decision?: ArtifactRef
  spent?: boolean
  /** The task was blocked (`budget-spent`) on this run's refusal. */
  blocked?: boolean
  /** The lines the block asked to raise the task's budget by (empty: it asked only to go on), fixed before the block. */
  funding?: Array<{ pool: string; unit: 'tokens' | 'usd' | 'turns' | 'runs' | 'minutes'; amount: number }>
  /**
   * The reservations of the task's runs the ledger did not release and that still count against
   * its caps (the step that reserved each as `<nodeId>:<attempt>:<escalations>`, or `run` for an
   * earlier engine's one reservation per run), fixed with `funding` before the block, which names
   * them: the next attempt may be refused again until they expire (operator decision D31).
   */
  unreleased?: UnreleasedHold[]
  /**
   * The spent run was its task's last attempt, so it asked for no funding: the engine's `gate`
   * decision (`workflow.task-funding`), kept with the run's failure; its report leaves the task
   * waiting for input (`retries-spent`).
   */
  lastAttempt?: ArtifactRef
}

/**
 * One step's reservation, recorded on the run's row before its execution starts: `step` is the
 * execution's node, attempt, and escalation (`<nodeId>:<attempt>:<escalations>`, as its start key
 * names them), so a hold whose step is not in flight is known and released.
 */
export interface StepHold {
  step: string
  nodeId: string
  reservationId: string
  /** The ledger's `budget` decision that reserved it. */
  decision: ArtifactRef
  /** When the ledger stops counting it if it is not released (absent on a hold an earlier engine recorded). */
  expiresAt?: string
}

/** A task run's budget as its row keeps it (`workflow_tasks.budget`): the task's lines (the caps), and its steps' reservations. */
export interface TaskBudget extends TaskBudgetView {
  caps: Array<{ pool: string; unit: 'tokens' | 'usd' | 'turns' | 'runs' | 'minutes'; amount: number }>
  /** The reservations of the run's steps not yet released. */
  holds?: StepHold[]
  /** The run's one reservation, as an engine before ADR-0047 step 1 kept it: read as a hold no step owns, released at once. */
  reservationId?: string
  reasons?: string[]
  /** Why the board did not take the block, when it refused it. */
  refused?: string
}

/**
 * Where the digest of a task run's result stands (docs/design/workflow-engine.md#a-digest-of-a-tasks-result):
 * `due` once the result reached the board; `requesting` once the engine decided to ask (its
 * `admission` decision, and the time that counts against `digestsPerHour`); `requested` with the
 * digest request; then `attached` (the digest set on the task's result) or `bypassed` (it keeps
 * none), with why and the digest's own settling decision when it settled.
 */
export type TaskDigest =
  | { state: 'due' }
  | { state: 'requesting'; decision: ArtifactRef; requestedAt: string }
  | { state: 'requested'; decision: ArtifactRef; requestedAt: string; requestId: string }
  | { state: 'attached'; decision: ArtifactRef; requestedAt: string; requestId: string; digest: ArtifactRef; settled?: ArtifactRef; at: string }
  | { state: 'bypassed'; decision?: ArtifactRef; requestedAt?: string; requestId?: string; settled?: ArtifactRef; reason: string; at: string }

/** How a run's outcome reached its board task. */
export interface TaskOutcome {
  /**
   * `accepted` or `rejected`: submitted, and the acceptance decision applied; `review`: submitted,
   * and only the operator's acceptance accepts it now (a required check not reported), so the board
   * holds the review for the operator; `reconciled`: reported with `reconcileRun`; `not-started`: the board never
   * recorded the run, so nothing of it ran; `blocked`: the run blocked its task before it had a
   * result (a spent budget, or a step's questions), and the task waits on that; `moved-on`: the task no longer waited on
   * this run; `refused`: the board refused the report.
   */
  status: 'accepted' | 'rejected' | 'review' | 'reconciled' | 'not-started' | 'blocked' | 'moved-on' | 'refused'
  /** The task's state after the report, as the board returned it. */
  state?: string
  /** The decision the report applied or recorded (acceptance or reconciliation). */
  decision?: ArtifactRef
  reason?: string
}

export interface ExplainedDecision {
  id: ArtifactRef
  type: string
  outcome: string
  /** Reasons of the selected candidate. */
  reasons: string[]
  /** The result an acceptance decision judged (read it with `system artifact`). */
  result?: ArtifactRef
  /** A team vote's ballots, per round: who chose what, how sure, and why. */
  ballots?: Array<{ round: number; member: string; choice: string; confidence: string; rationale: string }>
}

export interface Explanation {
  runId: string
  template: string
  status: RunStatus
  specHash: ContentId
  nodes: Array<{ nodeId: string; state: NodeState; executionId?: string; worker?: string; quotaClass?: string; decisions: ExplainedDecision[] }>
  /**
   * The run's executions whose liveness needs a look, as their Worker sources tell it
   * (`ctx.workers.liveness`, PROP-0013): stalled, looked at, or ended not known to be gone, with the
   * verdict, its looks, why, what each holds, and what the operator can do. Only when there are any.
   */
  liveness?: Array<RunLiveness & { source: string }>
  /** Each source that could not tell, with why: such a source is never read as having none (INV-2). */
  livenessUnread?: Array<{ source: string; detail: string }>
}

export interface Config {
  /** Workflow templates by name, added to (or replacing) the built-in `ask` and `research`. */
  templates?: Record<string, NodeTemplate[]>
  /** Attempts per node for IMMEDIATE, BACKOFF, and RECREATE_SESSION failures (default 3). */
  maxAttempts?: number
  /** First back-off delay; doubles per attempt (default 5 s). */
  retryDelayMs?: number
  /** Unfinished runs that execute at once (default 16); more are refused (INV-9). A run waiting only on an approval or a vote is not one. */
  maxActiveRuns?: number
  /** Runs waiting only on an approval or a vote, beyond `maxActiveRuns` (default 16): with that many, new runs are refused (INV-9). */
  maxWaitingRuns?: number
  /** A finished run's input text and prompts are cleared after this many days (default 30); the run stays. */
  retainDays?: number
  /** Days a finished run is kept, then deleted with what only it needed; 0 keeps every run (default 0). */
  retainRunsDays?: number
  /**
   * When no Worker of another provider family (or, for a team member, another account) is
   * admitted, run on the same family instead of failing: a team member first on an account of
   * its own (`same-family`), then sharing one (`same-family-shared-account`) (ADR-0029,
   * ADR-0035). Off by default.
   */
  allowSameFamily?: boolean
  /**
   * Hours a node refused only for assigned accounts' limits may wait for their reset, in all from
   * its first wait (default 24; 0 never waits); past it, it fails `quota_exhausted` (ADR-0052, INV-9).
   */
  maxLimitWaitHours?: number
  /** Approve a high-confidence plan by policy (`by: policy`) instead of waiting for the operator (default false). */
  autoApprovePlans?: boolean
  /** Reviews of one change, the first included, before remediation stops (default 3). */
  maxReviewCycles?: number
  /** Hours a tied team waits for a deciding `vote`, then completes `inconclusive` by rule (default 24; INV-9). */
  tieTimeoutHours?: number
  /** Hours a plan's gate waits for the operator's verdict, then closes and fails the run by rule (default 24; INV-9). */
  gateTimeoutHours?: number
  /**
   * Seconds between the engine's reads of the approval queue (default 15; INV-9): a remediation
   * fix's request while its run waits on it, and the requests a Worker's deferred tool call waits on.
   */
  approvalPollSeconds?: number
  /**
   * Runs one session may serve when a board task's next attempt, or the next task of a chain,
   * resumes the session of the work before it (default 5; INV-9): past it, the run starts fresh.
   */
  maxSessionRuns?: number
  /**
   * Digests of board task results the engine asks `ctx.digests` for in any hour, at most (default
   * 6; INV-9); 0 asks for none. Past it, a result keeps no digest, recorded with why.
   */
  digestsPerHour?: number
  /**
   * The board's `TASKS.md` projection a board task's run is given, written into its own worktree by
   * a Worker source that has one: at most `maxTasks` tasks (default 200; 0 writes no file) and
   * `maxChars` characters (default 65,536), past which it is cut with a note (INV-9).
   */
  tasksFile?: { maxTasks?: number; maxChars?: number }
  /** A review's repository reads: the hosts allowed (default github.com) and the bounds (40 files, 300 KB, 48 KB a file; INV-9). */
  repositories?: { hosts?: string[]; maxFiles?: number; maxBytes?: number; maxFileBytes?: number; maxSourceChars?: number }
}

export interface RunRow {
  run_id: string
  request_key: string | null
  template: string
  spec_hash: string
  input: string
  classification: Classification | null
  session_id: string | null
  status: RunStatus
  result: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface NodeRow {
  run_id: string
  node_id: string
  ordinal: number
  spec: string
  record: string
  state: NodeState
  prompt: string | null
  /** JSON instructions composed at promotion (`Instructions`): what every brief of the node carries. */
  brief_parts?: string | null
  /** JSON `{ workspace, subject }` of a review bound to an exact subject. */
  subject?: string | null
  execution_id: string | null
  source: string | null
  attempt: number
  not_before: string | null
  worker: string | null
  served_tier: Tier | null
  quota_class: string | null
  /** The turn's egress, tier, and route (or admission) decisions, kept here because runs outlive turns. */
  decisions: string | null
  /** Rejected results retried at a higher tier so far. */
  escalations: number
  /** JSON array of the Workers this node failed over from, unsent (ADR-0034); its routes leave them out. */
  excluded?: string | null
  /** A remediation gate's approval request in `ctx.approvals`, once its plan was put to the queue. */
  approval_request?: string | null
  /** JSON `WorkerAccount` of the Worker its latest attempt was routed to, when it declared one (ADR-0052). */
  account?: string | null
  /** JSON `{ group, account }`: after an unsent failure on an assigned account, no other account of its group takes the node (ADR-0052). */
  assignment?: string | null
  /** When the node first waited for an assigned account's limit: its waits are bounded from here (`maxLimitWaitHours`). */
  limit_wait_since?: string | null
  error: string | null
  updated_at: string
}

/** A run that serves a board task (`workflow_tasks`): how it holds the task, and where its report stands. */
export interface TaskRow {
  run_id: string
  task_id: string
  /** The lease owner: the lead's, when its claim was adopted, else `workflow:<runId>`. */
  holder: string
  generation: number
  claim: 'adopted' | 'own'
  phase: 'starting' | 'started' | 'reported'
  /** JSON subject the task writes (type and ref), read at admission: the result binds to it. */
  writes: string | null
  /** JSON `{ at, decision, reason }` once the board no longer held the run's generation. */
  lost: string | null
  /** JSON `{ artifacts, subject }`: the completed run's result, as it is submitted. */
  result: string | null
  /** The engine's `acceptance` decision on that result. */
  acceptance: string | null
  /** JSON {@link TaskOutcome}, once reported. */
  outcome: string | null
  /** JSON `TaskFrame`: what the run adds to every brief it writes (the task, its attempt, criteria, pointers, budget). */
  frame?: string | null
  /** JSON {@link TaskDigest}: the digest of the run's result, once its result reached the board. */
  digest?: string | null
  /** JSON {@link TaskBudget}: the task's budget lines and the run's reservation of them, for a task that declares any. */
  budget?: string | null
  /** JSON {@link TaskQuestion}: the questions a step asked instead of answering. */
  question?: string | null
  created_at: string
  updated_at: string
}

export interface NodeHelpers {
  dependsOnCompleted: (all: NodeRow[]) => boolean
}

export const LEASE_TTL_MS = 60_000
/** The lease a run asks for on its board task; `leases.maxTtlMs` caps it, and the run renews it at a third of what is left. */
export const TASK_LEASE_TTL_MS = 600_000
/** How long a run for a board task waits before it looks again for the board, when none is loaded or it did not answer. */
export const TASK_WAIT_MS = 30_000
export const newId = (prefix: string): string => `${prefix}_${randomBytes(8).toString('hex')}`
export const now = (): string => new Date().toISOString()

/** A workflow-level refusal, typed like a turn failure. */
export class WorkflowFailure extends Error {
  readonly disposition: string
  constructor(readonly kind: 'invalid_input' | 'overloaded' | 'config_error', message: string) {
    super(message)
    this.name = 'WorkflowFailure'
    this.disposition = kind === 'overloaded' ? 'BACKOFF' : kind === 'config_error' ? 'CODE_FIX' : 'NONE'
  }
}

export function errorOf(error: unknown): WorkflowError {
  const typed = error as { kind?: unknown; disposition?: unknown; message?: unknown }
  if (typeof typed?.kind === 'string' && typeof typed.disposition === 'string') {
    return { kind: typed.kind, disposition: typed.disposition, message: String(typed.message ?? '') }
  }
  return { kind: 'internal', disposition: 'CODE_FIX', message: error instanceof Error ? error.message : String(error) }
}
