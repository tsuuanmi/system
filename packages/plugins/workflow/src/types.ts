/**
 * The engine's record, view, and config types, its row shapes in the store, and its typed
 * refusal. Shared by every module of the engine; nothing here touches the store.
 */
import { randomBytes } from 'node:crypto'
import type { UnreleasedHold } from '@tsuuanmi/system-board-core'
import type { ContentId, DrawFigure } from '@tsuuanmi/system-libs'
import type { ArtifactRef, Classification, RunLiveness, Tier, WorkRequirement } from '@tsuuanmi/system-workers-core'
import type { AdvisorConfig } from './advisor.ts'
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
   * ended (`usage.unknown`), for this reason; a cap of its task or project in its pool is refused
   * until it is reconciled (ADR-0065). The report and health say whether a record of it was counted since.
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
   * remediation fix put to the approval queue, the verdict on `approvalRequest` there; a team's
   * `tie`, a deciding `vote` on `decision` (one of `options`) until `until`; or, for a board task's
   * step whose Worker stopped at a tool call deferred to the operator, the `tool-call`'s verdict on
   * `approvalRequest` in the queue, until `until` (docs/design/workflow-engine.md#a-deferred-tool-call).
   */
  blocked?: { kind: 'gate'; nodeId: string; plan: ArtifactRef; until?: string; approvalRequest?: string } | { kind: 'tie'; nodeId: string; decision: ArtifactRef; options: Array<{ option: string; summary: string }>; until: string }
    | { kind: 'tool-call'; nodeId: string; approvalRequest: string; until: string; executionId?: string }
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
/**
 * Which runs `usage` lists (contract 1.7, optional): only runs in these states, whenever they started; and
 * only runs whose state changed after `changedSince` (an ISO time), the latest changed first.
 */
export interface UsageFilter {
  status?: readonly RunStatus[]
  changedSince?: string
}

export interface UsageRunView extends Pick<RunView, 'runId' | 'template' | 'status' | 'sessionId' | 'createdAt' | 'updatedAt'> {
  nodes: Array<Omit<NodeView, 'result' | 'brief' | 'error'>>
}

/**
 * What agent runs drew from their accounts' windows (`quota.draw`, PROP-0015 E2), as the MCP `usage`
 * report shows it: over the latest records the log keeps, per kind and window and per kind, template
 * step, and window, the clean draws counted with their median and 90th percentile in percentage
 * points, and the entries left out by why (docs/design/resources.md#quota-drawn-per-run).
 */
export interface UsageDraws {
  byKind: DrawFigure[]
  byStep: DrawFigure[]
  /** The records read, the latest first, at most `MAX_USAGE_DRAWS`. */
  records: number
  /** Entries that are not a valid `quota-draw@1.0` record, so no figure counts them. */
  unreadable: number
  /** Older records were in the log than were read. */
  unread: boolean
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
 * Without a claim, the run claims the ready task itself. With `revision` (contract 1.7), the task's
 * revision the caller read its input from: a start whose task has moved since is refused before
 * anything is written, so the run's input and every brief come from one reading of the task (INV-5).
 */
export interface TaskClaim {
  taskId: string
  holder?: string | undefined
  generation?: number | undefined
  revision?: number | undefined
}

/**
 * One step of a template as a person reads it before a start (`templateSteps`): what it does and
 * the Worker it needs. `team` for a team step (its kind and members, each on a different provider
 * family), `source` for a step the engine runs itself, `plans` for a planner whose steps are added
 * once it answers.
 */
export interface TemplateStep {
  nodeId: string
  objective: string
  capabilities: string[]
  tier: Tier
  kind?: string
  team?: { kind: 'brainstorm' | 'review'; members: number }
  source?: true
  plans?: true
}

/** A start for a board task: admission is asynchronous, since the board takes the task first. */
export interface TaskStartInput extends StartInput {
  task: TaskClaim
  /** Who asks for the start (contract 1.10): `operator` from the operator's own surface (Start on `/ui`), else `lead` (the default). */
  startedBy?: 'lead' | 'operator' | undefined
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
  /** The landing of the run's accepted result, when it is on a worktree a Worker source holds (docs/design/workflow-engine.md#landing-an-accepted-result). */
  landing?: TaskLanding
  /** Whether the run started from the work its task's previous attempt left (docs/design/workflow-engine.md#starting-from-the-previous-attempts-work). */
  carry?: TaskCarry
  /**
   * Who started the run (contract 1.10, PROP-0014 D2): `dispatch` when the dispatch pass did (its row
   * names the ask), `operator` for Start on `/ui`, `lead` for any other start (MCP `run` or `task`, the CLI).
   */
  startedBy: StartedBy
}

/** Who started a board task's run, read from the engine's own rows. */
export type StartedBy = 'dispatch' | 'lead' | 'operator'

/**
 * Whether a task's run starts from the work its previous attempt left (ADR-0061), decided when the
 * run is admitted, once that attempt left a writing step's result in a worktree: `due` until the
 * run's first turn, before any step, asks the Worker source that holds the tree to carry it; then
 * `carried` (the run's worktree holds it) or `fresh` (the worktree is cut from HEAD, as for any
 * attempt; `cause` and `reason` say why).
 */
export interface TaskCarry {
  state: 'due' | 'carried' | 'fresh'
  /**
   * The previous attempt: its run, its number, its writing step and that step's result, and the tree it
   * left. Absent only from a `fresh` carry decided because the engine's record of that attempt could not
   * be read (`reason` says so).
   */
  from?: { runId: string; attempt: number; nodeId: string; result: ArtifactRef; workspace: string; subject: { ref: string; version: string } }
  /** The admission decision, then the `gate` decision that records what the source did (rule `workflow.task-worktree`). */
  decisions: ArtifactRef[]
  /** Once carried: where, and the commit on the earlier run's branch the run's worktree holds. */
  repository?: string
  worktree?: string
  branch?: string
  commit?: string
  cause?: string
  reason?: string
  at: string
}

/**
 * Where the landing of a task's accepted result stands (ADR-0060): `watch` until the board has the
 * task done on it; `commit` while its worktree is committed on its branch; then, when the base moved
 * since the result's work started (ADR-0068), `rebase` while it is made again on top of the base,
 * `resolving` while a writing step resolves the rebase's conflict, `returning` while a rebase that
 * cannot go on is abandoned and the result sent back (persisted before either, so a restart finishes
 * both, INV-4), and `recheck` while its required checks run again on the rebased tree; `committed`,
 * then `asked` while the `merge` request waits for
 * the operator; `merging` on the approval; then `merged`, or `returned` (it could not land on its
 * target as that is now, and went back to the board as another attempt), `refused` (a step changed
 * nothing, `cause` and `reason` say why), `rejected` (the request was not approved), or `none`
 * (nothing to land: the task moved on, or no source holds the tree).
 */
export interface TaskLanding {
  state: 'watch' | 'commit' | 'rebase' | 'resolving' | 'returning' | 'recheck' | 'committed' | 'asked' | 'merging' | 'merged' | 'returned' | 'refused' | 'rejected' | 'none'
  /** Where the result forked from the base, as its commit found it (ADR-0068). */
  fork?: string
  /** The landing's rebase onto its target, once the base moved since the result's work started (ADR-0068). */
  rebase?: TaskRebase
  /** The working tree the result is on, and its exact subject there. */
  workspace?: string
  subject?: { ref: string; version: string }
  /** The board's acceptance decision on the result. */
  acceptance?: ArtifactRef
  repository?: string
  /** The run's branch, and the commit on it that holds the accepted change. */
  branch?: string
  head?: string
  /** The repository's checked-out branch and its head, where it merges into. */
  base?: { branch: string; sha: string }
  /** The change against the base (`git diff --stat`, bounded). */
  stat?: string
  /** The `merge` request on the approval queue, and until when it waits. */
  requestId?: string
  expiresAt?: string
  /** What lets it merge: the operator's `approval` decision, or the policy's `autonomy` decision. */
  approval?: ArtifactRef
  /** The base branch's head that holds the change, once merged. */
  commit?: string
  cause?: string
  reason?: string
  /** The landing's own `gate` decisions (rule `workflow.landing`), in order. */
  decisions?: ArtifactRef[]
  /** When it last changed or was looked at. */
  at: string
}

/**
 * A landing's rebase of its result onto the base as it is now (ADR-0068): from the branch's head
 * (the accepted commit, or an earlier rebase of it) onto the base, forked from it at `fork`.
 */
export interface TaskRebase {
  from: string
  base: { branch: string; sha: string }
  fork: string
  /** Rebases this landing made before this one: a target that keeps moving is followed a bounded number of times. */
  count: number
  /** Once rebased: the branch's new head, the worktree's exact subject at it, and the change against the base. */
  head?: string
  subject?: { ref: string; version: string }
  stat?: string
  /** A conflict: the files it left marked (and how many more), and the base's commits since the fork. */
  files?: string[]
  more?: number
  moved?: string[]
  /**
   * The writing step that resolves a conflict: the result's own author (the run's writing step that
   * wrote the tree, its Worker and source), what it is told, the brief it is started on (a board task's
   * brief, naming the task and its project, recorded once) and how long that renders, its execution once
   * started, and since when it waits to be.
   */
  nodeId?: string
  worker?: string
  source?: string
  prompt?: string
  brief?: ArtifactRef
  chars?: number
  executionId?: string
  since?: string
  /** The required checks run again on the rebased tree. */
  checks?: string[]
  /**
   * A rebase that cannot go on (`returning`): why the result goes back and the decisions that say so,
   * kept before the branch is put back; then the `return` decision, once recorded, so a restart
   * neither records it twice nor loses it.
   */
  returning?: { why: string; inputs: ArtifactRef[]; decision?: ArtifactRef }
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
  /**
   * The engine's decisions on the run as a whole, which no step holds, in the order they were made:
   * a board task's admission, session, and start from its previous attempt's work, its holder, the result's subject and acceptance, the
   * report, the funding gate, and the digest. Only when there are any.
   */
  decisions?: ExplainedDecision[]
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
   * Team membership: `excludeWorkers` names Workers (by Worker id) and accounts (`<group>/<id>`,
   * or the bare id when one group has it) that no team member joins on, with every other Worker on
   * their accounts; they stay available for every other node
   * (docs/design/teams.md#workers-left-out-of-teams).
   */
  teams?: { excludeWorkers?: string[] }
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
   * Minutes a board task's step waits on the operator for its Worker's deferred tool call of class
   * `command`, from its request's creation (default 10; INV-9); past it the call is treated as
   * denied, for it alone: the request is withdrawn and the session continues once, told so. 0 waits
   * until the request expires.
   */
  deferredCommandMinutes?: number
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
  /** Dispatch (ADR-0064): System starts ready board tasks on free Workers chosen by quota, within these bounds (./dispatch.ts). */
  dispatch?: DispatchConfig
}

/**
 * The dispatch pass's settings (ADR-0064, PROP-0014 D1), each validated when the row loads; a value
 * out of its range refuses the row with its path. `maxRunning` and `leaveRunsFree` default to what
 * `maxActiveRuns` leaves room for (8 and 4 of the default 16).
 */
export interface DispatchConfig {
  /** Whether the pass runs at all (default true; off: nothing is asked or started). */
  enabled?: boolean
  /** Seconds between passes (10 to 3600, default 60); one runs at start too, after the runs are reconciled. */
  sweepSeconds?: number
  /** Starts or asks one pass makes at most (1 to 16, default 2). */
  maxPerPass?: number
  /** Dispatched runs not finished, with the asks open or approved (1 to maxActiveRuns − leaveRunsFree, default 8). */
  maxRunning?: number
  /** The same, per project (1 to 16, default 2). */
  maxRunningPerProject?: number
  /** The same, per account of the chosen Worker; also the most an account's load may be for it to be free (1 to 16, default 1). */
  maxRunningPerAccount?: number
  /** The same, per repository: the chosen writing Worker's workspace (1 to 16, default 4; D64). */
  maxRunningPerRepository?: number
  /** Active runs kept for the lead's and the operator's own starts (0 to maxActiveRuns − 1, default 4). */
  leaveRunsFree?: number
  /** Dispatch requests open at once, waiting for the operator's go (1 to 32, default 4). */
  maxOpenAsks?: number
  /** Minutes an approved start waits for its Worker to be free, then is used for nothing (1 to 240, default 30). */
  approvedHoldMinutes?: number
  /** Starts dispatch makes in any rolling hour, counted from its rows (0 to 120, default 6; 0 starts nothing; PROP-0014 D2). */
  maxPerHour?: number
  /** The same, per project (0 to maxPerHour, default 3 or maxPerHour when lower). */
  maxPerHourPerProject?: number
  /**
   * The advisor asked in shadow at every dispatch choice (PROP-0015 J1, ./advisor.ts): `none` by
   * default (no advisor), `local` (a logistic regression on this host), or `model` (a configured
   * model Worker, metered; off unless set). Its advice is recorded and changes no choice.
   */
  advisor?: AdvisorConfig
}

/**
 * What a run started by dispatch keeps on its `workflow_tasks` row (`dispatch`): the ask it served,
 * the decisions that chose it (named by its `workflow.task-admission` decision), and the Worker its
 * writing step routes to first.
 */
export interface TaskDispatch {
  askId: string
  /** The `dispatch.select`, `dispatch.choice`, and `autonomy` decisions, then the `approval` or the board approval's `gate` decision (none under `auto` or `notify`). */
  decisions: ArtifactRef[]
  prefer: { node: string; worker: string; decision: ArtifactRef }
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
  /** JSON {@link TaskLanding}: the landing of the run's accepted result, once it was reported on a working tree. */
  landing?: string | null
  /** JSON {@link TaskCarry}: whether the run starts from the work its task's previous attempt left. */
  carry?: string | null
  /** JSON {@link TaskDispatch}: set when dispatch started the run (ADR-0064). */
  dispatch?: string | null
  /** Who started the run ({@link StartedBy}); null only on a row the migration that added it could not read. */
  started_by?: StartedBy | null
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

/**
 * A workflow-level refusal, typed like a turn failure. `runId` names a run that was admitted all the
 * same and still starts on its own (a board task's start the board did not answer: it starts once the
 * board shows it recorded, or is dropped with nothing run), so a caller never reads the failure as
 * "nothing was started" (T127).
 */
export class WorkflowFailure extends Error {
  readonly disposition: string
  readonly runId?: string
  constructor(readonly kind: 'invalid_input' | 'overloaded' | 'config_error', message: string, options: { runId?: string } = {}) {
    super(message)
    this.name = 'WorkflowFailure'
    this.disposition = kind === 'overloaded' ? 'BACKOFF' : kind === 'config_error' ? 'CODE_FIX' : 'NONE'
    if (options.runId !== undefined) this.runId = options.runId
  }
}

export function errorOf(error: unknown): WorkflowError {
  const typed = error as { kind?: unknown; disposition?: unknown; message?: unknown }
  if (typeof typed?.kind === 'string' && typeof typed.disposition === 'string') {
    return { kind: typed.kind, disposition: typed.disposition, message: String(typed.message ?? '') }
  }
  return { kind: 'internal', disposition: 'CODE_FIX', message: error instanceof Error ? error.message : String(error) }
}
