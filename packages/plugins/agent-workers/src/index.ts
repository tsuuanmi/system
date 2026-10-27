/**
 * The `agents` Worker source (docs/design/agent-runtimes.md): each configured Worker is an
 * agent runtime (`ctx.agentRuntimes`) held to a policy from configuration (workspace,
 * sandbox, tool allow-list; INV-6). Its capabilities are what `probe()` proves now; a policy
 * the runtime cannot enforce leaves the Worker unavailable, never loosened. Runs are durable
 * and run one at a time per Worker (one writer per workspace, INV-15). A run that started
 * and did not finish is never run again by itself: the agent may already have acted (INV-4).
 * A Worker configured with a resource pool meters its runs through `ctx.resources`
 * (docs/design/resources.md): a reservation before the run (none, nothing runs), one
 * `usage-record` from the runtime's own numbers after it, and its limit observations as readings.
 * A run that fails `quota_exhausted` with no limit reading the ledger keeps closes its pool for a
 * bounded cooldown; with no pool, every Worker of its runtime cools down (one home, one sign-in).
 * Each account's own usage report (`limits`, ADR-0059) is read into its pool after its runs and
 * every `limitReadSeconds` (./reports.ts), and never opens a window a limit closed.
 * Every Worker of one runtime is one account, its `siblings`: a cooldown or a closed pool of any of
 * them holds them all, and a failover or a team counts them as one.
 * A Worker configured with `worktreePerRun` works in a git worktree of its own per workflow run
 * (./worktrees.ts). Every tool call of a run passes the run's gate first (./gate.ts): the autonomy
 * policy through `ctx.approvals` (optional; none, and no tool call runs), so a Worker whose runtime
 * cannot ask a gate before each tool call is unavailable. A run that a gate deferred fails, naming
 * the approval request it waits for; a later run of its session makes the call once approved.
 * Each runtime's enrollment slots and the agent accounts in them, identified by their verified
 * login, are kept by ./accounts.ts (ADR-0051), with the operator's tools in ./tools.ts. Workers are
 * derived as account × role (./roles.ts, PROP-0012 phase F): each takes work only while its account
 * is `ready`, runs in its account's home, and shares its account's concurrency, load, cooldowns, and
 * pool. Hand-named Workers, the row's earlier shape, run as before in their runtime's own home (no
 * work while the account enrolled there is not `ready`, nor `unverified` for want of a reader), until
 * the operator applies the move to derived Workers (./migrate.ts); from then on they are refused.
 * @module @tsuuanmi/system-agent-workers
 */
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  type AgentRuntimeProvider, type LimitObservation, type RunMetering, type RunObserver, type RunResult, type RunSpec, type RuntimeEvidence, type SandboxMode, WEB_RUN_TOOLS, WORKSPACE_READ_BOUNDS, type WorkspaceReadBounds,
  meteringOf, readLimits, workspaceReadBounds,
} from '@tsuuanmi/system-agent-runtime-core'
import { webAccessOf } from '@tsuuanmi/system-approvals-core'
import type {} from '@tsuuanmi/system-artifacts'
import type { Classification } from '@tsuuanmi/system-egress'
import type {} from '@tsuuanmi/system-event-log'
import { type Lease, LeaseLost, StaleGeneration } from '@tsuuanmi/system-leases'
import {
  type AccountSetting, accountSettings, ASSIGNED, bodyText, BRIEF_FILE_PATH, type BriefFile, captureGitSubject, type ContentId, currentProcess, DESCRIPTION, drawEntries, dshHome, LABEL, type LeaseProbe, type Liveness, LIVENESS_RULE, livenessOf, MAX_DESCRIPTION, MAX_LABEL,
  type ProcessIdentity, processIdentity, processIdentityOf, type ProcessProbe, pooledTermsDecision, probeProcess, QUOTA_DRAW_EVENT, type QuotaDraw, quotaDraw, sha256, USAGE_UNKNOWN_EVENT, type UsageUnknown, usageUnknown,
} from '@tsuuanmi/system-libs'
import { ProviderError, ProviderScheduler, dispositionOf, promptOfStart, toProviderError } from '@tsuuanmi/system-provider-core'
import { type LimitState, type PoolState, type Resources, ResourcesError, templatePool, type UsageRecord } from '@tsuuanmi/system-resources-core'
import type {} from '@tsuuanmi/system-store'
import {
  type ArtifactRef, type CapabilityDescriptor, type CapabilityOffer, type ExecutionInfrastructure, type ExecutionStatus, type LivenessQuery, type LivenessReport, type LivenessState, MAX_LIVENESS_RUNS, type QuotaClass, type RunLiveness, type Tier,
  type TierOffer, TIERS, type WorkerExecution, type WorkerSandbox, type WorkerStart, type WorkScope,
} from '@tsuuanmi/system-workers-core'
import { ACCOUNTS_MIGRATION, type AgentAccount, AgentAccounts, type HomeGate, MAX_SLOTS } from './accounts.ts'
import { commandRecorder, type DossierCaller, dossiersOf, dossierTools, type StepDossiers } from './dossier.ts'
import { DENIAL_MIGRATION, GATE_MIGRATION, type Deferral, readToolsOf, recordDenial, runGate, unaskedNote } from './gate.ts'
import { HANDBOOK_SOURCE_EVENT, handbookSelection, type SourcePart } from './handbook.ts'
import { repositoryLessonsFor } from './lessons.ts'
import { type Applied, CUTOVER_MIGRATION, Cutover, type CutoverRecord, type MigrationPlan, type Moved, planMigration, type RolledBack } from './migrate.ts'
import { Overlaps } from './overlaps.ts'
import { Probes, isLate, provenBefore, refused } from './probes.ts'
import { regenerationOf } from './regenerate.ts'
import { ReportSchedule, type ReportTarget } from './reports.ts'
import {
  type AgentAssignmentConfig, type AgentProviderConfig, type AgentRoleConfig, checkProviders, DEFAULT_LIMIT_READ_SECONDS, type DerivedTier, type DerivedWorker, deriveWorkers, kindsProblem, MAX_CONCURRENT_PER_ACCOUNT,
  MAX_LIMIT_READ_SECONDS, MAX_MODEL_POOLS, setsDerivedOnly,
} from './roles.ts'
import { researchProblem, withResearchDefaults } from './research.ts'
import { type WebProof, WebProbes } from './web-probe.ts'
import { CHECKS_MIGRATION, DEFAULT_MAX_CONCURRENT_CHECKS, RunChecks } from './checks.ts'
import { type RunReport, type RunReported, runReport } from './run-report.ts'
import { loadSetups, SETUP_MIGRATION, type Setup, type WorktreeSetupConfig, WorktreeSetups } from './setup.ts'
import { registerAccountTools, registerRunTools } from './tools.ts'
import { CARRY_MIGRATION, FORK_MIGRATION, notKnownGone, RUN_ID, type RepositoryCheck, type RunWorktree, type RunWorktreeRelease, type SweepOutcome, type WorktreeRelease, Worktrees } from './worktrees.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentWorkers: AgentWorkers
  }
}

export interface AgentWorkerConfig {
  /** Worker id suffix: the Worker is `agent:<id>`. */
  id: string
  /** Agent runtime kind, as its provider registers it (for example `claude-agent-sdk`). */
  runtime: string
  /** Absolute workspace root the agent works in. */
  workspace: string
  sandbox: SandboxMode
  tools?: string[]
  model?: string
  maxTurns?: number
  tier: Tier
  /** Default `agent-plan` (purpose P1). */
  quotaClass?: QuotaClass
  /**
   * The resource pool its runs draw on: a pool id from the resources configuration, with the
   * `account` it belongs to. Set, the Worker's runs are metered through `ctx.resources` and fail
   * closed without it (INV-2); unset, they are not metered.
   */
  pool?: string
  account?: string
  /**
   * The runtime's own limit window names mapped to the pool's window ids (for example
   * `five_hour: five-hour`). An observation of a window not mapped here is not recorded.
   */
  windows?: Record<string, string>
  /**
   * Each run that belongs to a workflow run works in that run's own git worktree of `workspace`
   * (which must then be the top level of a git repository with a commit), on the branch
   * `system/run/<runId>`, never in the repository's main working tree. Default false.
   */
  worktreePerRun?: boolean
  /**
   * How long a limit hit with no reset time keeps the pool closed, in seconds (default 3600); for a
   * Worker with no pool, how long every Worker of its runtime cools down.
   */
  limitCooldownSeconds?: number
  /**
   * Its provider family (ADR-0027): an opaque string the operator gives, the same as other Workers'
   * of the vendor whose models it runs, so routing keeps team members of one vendor apart. Default:
   * the runtime. Required for a review member.
   */
  family?: string
  /**
   * The operator places this read-only Worker's review team member steps under the enforced
   * review-member profile (ADR-0049): no tool call runs, its workspace is an empty directory outside
   * any repository, and its material is its prompt alone. The profile, while it can be enforced,
   * grants `reason` for those steps only, never for other work; a runtime that cannot resume a
   * conversation keeps the member's by replay. Default false; refused unless the sandbox is
   * `read-only`, `family` is set, and `worktreePerRun` is off.
   */
  reviewMember?: boolean
  /**
   * The kinds of work the operator gives it (ADR-0057), such as `code` or `docs`: it takes only work
   * whose step names one of them, never work that names none. Unset: it takes any work. Never with
   * `reviewMember` (a member's steps name no kind).
   */
  kinds?: string[]
  /** What it is for, in the operator's words (`capability-descriptor@1.7`); never a routing input. */
  description?: string
  /**
   * A read-only research Worker (T262, ADR-0074, ./research.ts): its tools, at every tier, are reads
   * and the web tools only (default all of them), it takes research work only (kinds default
   * `[research]`), its gate refuses a write or a command, and its web calls are judged under the
   * autonomy policy's web access grant. It proves `reason`, and `web-search` once its web probe
   * searched. Default false; refused unless `read-only` and not a review member.
   */
  research?: boolean
}

/** A Worker as this source runs it: a hand-named row, or one derived as account × role (`derived`), with the tiers it offers (ADR-0073). */
type WorkerSpec = AgentWorkerConfig & { derived?: DerivedWorker['derived']; tiers?: DerivedTier[] }
/** What a run at its tier runs (ADR-0073): the tier, its model and options, and its model's pool. */
type AtTier = Pick<AgentWorkerConfig, 'tools' | 'model' | 'maxTurns'> & { tier: Tier; modelPool?: DerivedTier['modelPool']; declared: boolean }

export type { AgentAssignmentConfig, AgentModelPool, AgentProviderConfig, AgentRoleConfig, AgentRoleRuntime, AgentRoleTier } from './roles.ts'
export type { WorktreeGeneratedConfig, WorktreeSetupConfig, WorktreeSetupView } from './setup.ts'
export type { MigrationPlan } from './migrate.ts'

/** What `system account migrate` gives (`mcp-agent-accounts` `account-migrate-output`). */
export type MigrateOutput = {
  outcome: 'planned' | 'applied' | 'already-applied' | 'rolled-back' | 'not-applied'
  plan: MigrationPlan
  row: Record<string, unknown>
  cutover?: CutoverRecord
  moved?: Moved
}

export interface Config {
  /**
   * Hand-named Workers (the shape before PROP-0012 phase F). They load, and run as they always did,
   * until the operator applies `system account migrate`; from then on they are refused. Never with
   * `roles` or `assignments`.
   */
  workers: AgentWorkerConfig[]
  /**
   * How each agent provider's (runtime's) accounts are used (ADR-0052, ADR-0055): `assigned` (the
   * default) or `pooled`, which needs `pooledTerms`, the operator's recorded decision. A runtime
   * no entry names is assigned. `slots`: how many accounts may be enrolled for it (ADR-0051; default
   * 1, its own home adopted as slot 1). With roles and assignments only: `maxConcurrentRunsPerAccount`,
   * what each of its accounts draws on (`pool`, a template of the resources row; `windows`;
   * `limitCooldownSeconds`), and how often its usage report is read into that pool (`limitReadSeconds`).
   */
  providers?: AgentProviderConfig[]
  /** Role templates (PROP-0012 phase F), each defined once: what the work needs, whatever account serves it. */
  roles?: AgentRoleConfig[]
  /** Which roles each enrolled account serves, by its id (D24: assigned): one Worker `agent:<accountId>/<role>` per role. */
  assignments?: AgentAssignmentConfig[]
  /** Where enrollment slots 2 and later keep their homes (default `<DSH_HOME>/system/agent-homes`): `<accountHomes>/<provider>/<n>`. */
  accountHomes?: string
  /**
   * The most characters of earlier turns a review member's replayed conversation holds (default
   * 200,000); a turn past it fails before anything is sent, never cut (ADR-0049, INV-9).
   */
  maxReplayChars?: number
  /**
   * How long a runtime's probe result stands, from when its probe started (default 5 min): the
   * next probe starts in the background at half of it, and a result past it admits no Worker until
   * one finishes (./probes.ts). 0 keeps none: every read waits for a probe.
   */
  probeTtlMs?: number
  /** Hard deadline per run; the agent is stopped and the run fails as `timeout` (default 15 min). */
  runTimeoutMs?: number
  /**
   * A running agent whose process is present and that showed no activity for this long is `stalled`
   * (default 300 s): reported once per stall, never prodded or stopped (PROP-0013, ADR-0056).
   */
  stallSeconds?: number
  /**
   * A run that started and was not finished by its holder is `dead`, and reconciled, only when its
   * holder and its agent process are both positively gone and no activity was seen for this long
   * (default 120 s, twice the run's lease) (PROP-0013, ADR-0056).
   */
  deadAfterSeconds?: number
  /**
   * How many verdicts in a row other than `dead` a started run gets, looked at again with a bounded
   * backoff, before it goes to the operator, never declared dead (default 3).
   */
  maxUnknownVerdicts?: number
  /** Where the worktrees of `worktreePerRun` Workers go (default `<DSH_HOME>/system/worktrees`). */
  worktreeRoot?: string
  /**
   * Hours a workflow run's worktree is kept after its last agent run ended, every one finished;
   * then its changes are committed on its branch and it is removed (default 168; 0 keeps them).
   */
  worktreeRetentionHours?: number
  /**
   * Per repository, the commands that set a workflow run's new worktree up before any agent run
   * works in it (dependencies installed without a network, say), each allowed by the autonomy
   * policy, run confined: the host read-only but the worktree and the views named, no network
   * (./setup.ts, ADR-0058). A worktree whose setup did not run under this definition takes no run.
   * Its `checks` name the command of each check a policy can require, which a workflow run runs on
   * its result in the same confinement, but with the worktree read-only to it except its
   * `checkScratch` paths (./checks.ts, T151).
   */
  worktreeSetup?: WorktreeSetupConfig[]
  /**
   * The bounds of the workspace reads server a runtime gives its agent (T200b, INV-9): bytes a
   * `read_file` returns and a file is read through, entries a `list_dir` returns, and a `search`'s
   * matches, files, line length, pattern length, and deadline. Each within its range
   * (`WORKSPACE_READ_BOUNDS` in agent-runtime-core), at its default when not given; passed with every
   * run (`RunSpec.workspaceReads`).
   */
  workspaceReads?: Partial<WorkspaceReadBounds>
  /**
   * The load acceptance checks put on the host (T292): at most `maxConcurrent` check runs at once across
   * every run (default 2), the rest queued in order; each runs its tests with `maxWorkers` workers
   * (default the host's cores shared among `maxConcurrent`).
   */
  checks?: { maxConcurrent?: number; maxWorkers?: number }
}

interface RunRow {
  run_id: string
  request_key: string
  worker: string
  session_id: string | null
  prompt: string
  classification: string
  status: ExecutionStatus
  submitted_at: string | null
  native_handle: string | null
  result: string | null
  error: string | null
  /** The run's egress decision (INV-12), part of its decision chain. */
  egress_decision?: string | null
  /** The run's `budget` decision, when its Worker is metered (INV-13). */
  budget_decision?: string | null
  /** The reservation the run holds while it runs, released once its usage is recorded. */
  reservation_id?: string | null
  /** The workflow run the run belongs to, when it belongs to one (`WorkerStart.runId`). */
  workflow_run_id?: string | null
  /** The board task and project its brief serves, when it serves one: its usage is recorded under them. */
  task_id?: string | null
  project_id?: string | null
  /** JSON `[{ path, text }]`: the brief's files, resolved at start, written into the run's worktree before the agent starts. */
  files?: string | null
  /** The kind of work the run was admitted for (`WorkRequirement.scope`): a review member's step may be replayed (ADR-0049). */
  scope?: string | null
  /** The generation of its session it belongs to: a replay holds that generation's earlier turns only. */
  session_generation?: number | null
  /** JSON: the earlier runs of its session it replays, in order, fixed when it is first prepared (ADR-0049). */
  replay?: string | null
  /** JSON `ProcessIdentity`: the process that submitted the run and held it while it ran (PROP-0013). */
  holder?: string | null
  /** JSON `ProcessIdentity`: the agent process its runtime started, when the runtime reported it. */
  agent_process?: string | null
  /** The latest activity of its agent recorded (at most once per heartbeat); the submission counts as one. */
  activity_at?: string | null
  /** When its current stall was reported (cleared once the agent is active again). */
  stalled_at?: string | null
  /** The approval request its gate deferred a call on: the run stopped there. */
  deferred_request?: string | null
  /** The liveness verdicts it got after its holder stopped holding it, in a row, and the last of them. */
  liveness_looks?: number | null
  liveness_verdict?: string | null
  /** The `reconciliation` decision that ended it after a restart, a lost lease, or the operator's cancel (INV-4, INV-13). */
  liveness_decision?: string | null
  /** The operator's `reconciliation` decision that freed what it held, once it ended not known to be gone. */
  liveness_freed?: string | null
  /** The `gate` decision of its worktree's setup (ADR-0058), when its repository has one. */
  setup_decision?: string | null
  /** The kind of work it was admitted for (`WorkRequirement.kind`, ADR-0057), for what it drew. */
  kind?: string | null
  /** The workflow template and step it serves (`WorkerStart.step`), for what it drew. */
  step_template?: string | null
  step_node?: string | null
  /** The tier it runs at (ADR-0073): the routed one, of the tiers its Worker offers, so its model is that tier's. */
  tier?: string | null
  /** The model its tier's configuration gave it when it was started, on a Worker that offers tiers (ADR-0073): it runs no other. */
  configured_model?: string | null
  /** When the host's own stop ended its runtime while it ran (T283): set before this source stopped, so the next start runs it again instead of failing it. */
  host_stopped_at?: string | null
  /** How many times a host stop cut it and it ran again (bounded, INV-9). */
  resumes?: number | null
  /** The `reconciliation` decision of its latest resume or restart after a host stop (T283, INV-13). */
  resume_decision?: string | null
  /**
   * JSON `{ role, touched? }`: who the run's brief selected its handbook slice for (`brief@1.6`
   * `handbook.selection`), so the lessons it is given are that role's and paths' (docs/design/handbook.md).
   */
  handbook?: string | null
  created_at: string
  updated_at: string
}

const ID = /^[a-z][a-z0-9-]*$/
/** A kind of work (`common@1` workKind) and an id (`common@1` id), as a quota draw names them. */
const WORK_KIND = /^[a-z][a-z0-9-]{0,31}$/
const DRAW_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
const LEASE_TTL_MS = 60_000
const PREFIX = 'agent:'
const newId = (): string => `arun_${randomBytes(8).toString('hex')}`
/** At most this many per-model entries go into a record (`agent-result@1.2`, `usage-record@1.0`). */
const MAX_MODELS = 16
/** How often finished workflow runs' worktrees are looked at for removal. */
const SWEEP_MS = 60 * 60_000
/** The kind of work a review member's offers are scoped to (ADR-0049). */
const REVIEW_MEMBER: WorkScope = 'review-member'
const RANK: Record<Classification, number> = { public: 0, 'operator-shared': 1, 'local-private': 2 }
const now = (): string => new Date().toISOString()
/** The longest a runtime cools down for one limit hit, whatever reset time its runtime named (INV-9). */
const MAX_COOLDOWN_MS = 604_800_000
/** The row's settings at their defaults, left out of the row `system account migrate` prints. */
const SETTING_DEFAULTS: Record<string, unknown> = {
  maxReplayChars: 200_000, probeTtlMs: 5 * 60_000, runTimeoutMs: 15 * 60_000, worktreeRetentionHours: 168, stallSeconds: 300, deadAfterSeconds: 120, maxUnknownVerdicts: 3,
}
/** How often a running agent's activity is written and its stall looked at: the run lease's heartbeat (a bounded write rate). */
const BEAT_MS = LEASE_TTL_MS / 3
/** The longest a started run waits between two liveness verdicts (INV-9). */
const MAX_LOOK_MS = 15 * 60_000
/** The rule a started run's reconciliation applies (PROP-0013, ADR-0056). */
const RECONCILE_RULE = { type: 'rule', id: 'agent-workers.reconcile', version: '2' } as const
/** The rule that runs a run the host's own stop cut again (T283): resumed in its native session, or started again in its worktree. */
const RESUME_RULE = { type: 'rule', id: 'agent-workers.resume-cut', version: '1' } as const
/** A run the host's stop cut runs again at most this many times (INV-9); past it, it is reconciled as any run its holder lost. */
const MAX_RESUMES = 5
/** How many seconds a run the host cut waits at the start for its runtime to register, at most; then it is sent as any run is. */
const MAX_RUNTIME_WAITS = 60
/** The event that tells a run the host's stop cut ran again (`resumed` or `restarted`). */
const RESUMED_EVENT = 'agent-workers.run.resumed'
/** What a resumed agent is told: the conversation continues, and its workspace holds what it did. */
const RESUME_PROMPT = 'The host you ran on was restarted while you worked, and your session was stopped without notice. This conversation and your workspace hold everything you had done. Check the workspace, then continue the task you were given and finish it.'
/** What an agent that starts again is told, after its original prompt. */
const RESTART_NOTE = '\n\n(The host you ran on was restarted while an earlier start of this task ran, and that start was stopped. Your workspace may already hold part of its work: check it before you change anything, and finish the task.)'
/** Why the usage record of a run that ran again after a host stop is a lower bound of the run (T283): what it used before the stop is not in it. */
const againPartial = (resumes: number): string => `it ran again after the host's stop cut it (${resumes} time(s)): this counts only what it used since; what it used before the stop is left to transcript reconciliation`
/** The operator's word that a run's agent is gone, freeing what the run held (INV-13). */
const FREE_DECIDER = { type: 'operator', id: 'operator.free', version: '1' } as const
/** The operator who removes finished run worktrees before the retention would (D12). */
const WORKTREES_DECIDER = { type: 'operator', id: 'operator.worktrees', version: '1' } as const
/** The most run worktrees one listing shows (INV-9). */
const MAX_LISTED_WORKTREES = 100
/** A run ended without being known to be gone, and what it held stays held. */
const UNKNOWN_EVENT = 'agent-workers.run.unknown'
/** The operator freed what such a run held. */
const FREED_EVENT = 'agent-workers.run.freed'
/** Where the operator's steps for a run whose liveness is unknown are written. */
const RUNBOOK = 'docs/operations/runbooks.md#a-runs-liveness-is-unknown'
/**
 * The agent runs whose agent this process is running now, across every instance of this source in
 * it: a run recorded as held by this very process is gone from it only when it is not among them.
 */
const executing = new Set<string>()
/**
 * The account a Worker runs on: a derived Worker's own (PROP-0012 phase F); for a hand-named one its
 * runtime's, whose one home holds one sign-in (phase C). Its siblings, cooldowns, and limits are that
 * account's.
 */
const accountOf = (worker: WorkerSpec): string => worker.derived?.accountId ?? worker.runtime
/** Whether an account takes work now, and when not, until when (when known) and why. */
interface AccountGate { state: 'ready' | 'quota-exhausted' | 'unavailable'; until?: string | undefined; why?: string }
/** The board task and project a run serves, as its reservation and usage record name them. */
const scopeOf = (row: RunRow): { taskId?: string; projectId?: string } => ({ ...(row.task_id ? { taskId: row.task_id } : {}), ...(row.project_id ? { projectId: row.project_id } : {}) })

/**
 * The row's Workers as its configuration names them (hand-named, or derived as account × role), and
 * its runtimes' account settings, checked as the load checks them: a malformed Worker or role, a
 * review member that is not read-only or names no family, malformed `kinds` (ADR-0057), Workers of
 * one workspace that disagree on `worktreePerRun`. Throws `config_error`, naming the first problem.
 */
function configuredWorkers(config: Partial<Config>): { derived: boolean; workers: Map<string, WorkerSpec>; accounts: Map<string, AccountSetting> } {
  const providers = config.providers ?? []
  checkProviders(providers)
  const derived = !!(config.roles?.length || config.assignments?.length)
  if (derived && config.workers?.length) {
    throw new ProviderError('config_error', 'agent-workers: workers (hand-named) and roles with assignments are two shapes of one row; load one of them (system account migrate prints the roles and assignments the hand-named Workers become)')
  }
  const derivedOnly = providers.find(setsDerivedOnly)
  if (!derived && derivedOnly) {
    throw new ProviderError('config_error', `agent-workers.providers (${derivedOnly.provider}): maxConcurrentRunsPerAccount, pool, windows, modelPools, limitCooldownSeconds, and limitReadSeconds apply to Workers derived from roles and assignments; a hand-named Worker sets its own`)
  }
  const workers = new Map<string, WorkerSpec>()
  for (const configured of [...config.workers ?? [], ...derived ? deriveWorkers(config.roles ?? [], config.assignments ?? [], providers) : []] as WorkerSpec[]) {
    // A research role reads and searches the web only (T262): refused unless it can hold that, then given its defaults.
    const research = researchProblem(configured)
    if (research) throw new ProviderError('config_error', `agent Worker ${configured.id}: ${research}`)
    const worker = withResearchDefaults(configured)
    if (!worker.derived && !ID.test(worker.id)) throw new ProviderError('config_error', `agent Worker id ${worker.id} must match ${ID}`)
    if (typeof worker.workspace !== 'string' || !isAbsolute(worker.workspace)) throw new ProviderError('config_error', `agent Worker ${worker.id}: workspace must be an absolute path`)
    if (workers.has(PREFIX + worker.id)) throw new ProviderError('config_error', `duplicate agent Worker ${worker.id}`)
    if ((worker.pool === undefined) !== (worker.account === undefined)) throw new ProviderError('config_error', `agent Worker ${worker.id}: pool and account are set together`)
    if (worker.pool === undefined && Object.keys(worker.windows ?? {}).length) throw new ProviderError('config_error', `agent Worker ${worker.id}: windows map limit windows to a pool, and no pool is set`)
    if (worker.family !== undefined && (typeof worker.family !== 'string' || !worker.family.length || worker.family.length > 128)) throw new ProviderError('config_error', `agent Worker ${worker.id}: family must be 1 to 128 characters`)
    if (worker.description !== undefined && (typeof worker.description !== 'string' || !DESCRIPTION.test(worker.description))) throw new ProviderError('config_error', `agent Worker ${worker.id}: description must be plain text on one line, 1 to ${MAX_DESCRIPTION} characters`)
    if (worker.reviewMember) {
      // A writer never reviews: a review is independent of the change (INV-15).
      if (worker.sandbox !== 'read-only') throw new ProviderError('config_error', `agent Worker ${worker.id}: a review member must be read-only (sandbox: read-only); a writer never reviews (INV-15)`)
      // Members are kept apart by provider family, which a runtime's name does not tell (ADR-0027).
      if (worker.family === undefined) throw new ProviderError('config_error', `agent Worker ${worker.id}: a review member names its provider family (family), the same as other Workers' of the vendor whose models it runs, so team members of one vendor stay apart`)
      // Its workspace is an empty directory outside any repository: a worktree per run is neither.
      if (worker.worktreePerRun) throw new ProviderError('config_error', `agent Worker ${worker.id}: a review member works in an empty directory outside any repository, never a worktree per run (worktreePerRun)`)
    }
    const kinds = kindsProblem(worker.kinds, worker.reviewMember)
    if (kinds) throw new ProviderError('config_error', `agent Worker ${worker.id}: kinds ${kinds}`)
    // Workers of one workspace agree on worktreePerRun: a reviewer must read the tree it reviews, the writer's worktree.
    const other = [...workers.values()].find((w) => resolve(w.workspace) === resolve(worker.workspace) && !!w.worktreePerRun !== !!worker.worktreePerRun)
    if (other) throw new ProviderError('config_error', `agent Workers ${other.id} and ${worker.id} share the workspace ${worker.workspace}, and only one of them works in a worktree per run (worktreePerRun): set it on both`)
    workers.set(PREFIX + worker.id, worker)
  }
  try {
    return { derived, workers, accounts: accountSettings(config.providers, 'agent-workers.providers') }
  } catch (error) {
    throw new ProviderError('config_error', (error as Error).message)
  }
}

/** The workspace reads server's bounds (T200b): each given one within its range, the rest at their defaults; `config_error` otherwise (INV-9). */
function readBoundsOf(bounds: Partial<WorkspaceReadBounds> | undefined): WorkspaceReadBounds {
  try {
    return workspaceReadBounds(bounds)
  } catch (error) {
    throw new ProviderError('config_error', `agent Workers: workspaceReads: ${(error as Error).message}`)
  }
}

/** The checks' bounds (T292): `maxConcurrent` 1 to 32 and `maxWorkers` 1 to 256 when given; `config_error` otherwise (INV-9). */
function checkBoundsOf(checks: Config['checks']): { maxConcurrent?: number; maxWorkers?: number } {
  const bounded = (name: 'maxConcurrent' | 'maxWorkers', max: number): number | undefined => {
    const value = checks?.[name]
    if (value === undefined) return undefined
    if (!Number.isInteger(value) || value < 1 || value > max) throw new ProviderError('config_error', `agent Workers: checks.${name} is 1 to ${max}`)
    return value
  }
  const maxConcurrent = bounded('maxConcurrent', 32)
  const maxWorkers = bounded('maxWorkers', 256)
  return { ...maxConcurrent !== undefined ? { maxConcurrent } : {}, ...maxWorkers !== undefined ? { maxWorkers } : {} }
}

/**
 * What the load would refuse in this row's Workers and their worktree setups, before a host starts
 * on it (`system check`): the first problem {@link configuredWorkers} or {@link loadSetups} finds, or
 * none. What only the host can tell (a runtime, a sign-in, a repository) is checked when the Workers
 * are probed.
 */
export function checkConfig(config: Partial<Config> = {}): string[] {
  try {
    const { workers } = configuredWorkers(config)
    loadSetups(config.worktreeSetup, [...workers.values()].filter((w) => w.worktreePerRun).map((w) => w.workspace))
    readBoundsOf(config.workspaceReads)
    checkBoundsOf(config.checks)
    return []
  } catch (error) {
    return [(error as Error).message]
  }
}

export class AgentWorkers extends Service {
  static inject = ['store', 'artifacts', 'leases', 'workers', 'agentRuntimes', 'egress']

  static Config: z<Config> = z.object({
    workers: z.array(z.object({
      id: z.string().pattern(ID).required(),
      runtime: z.string().required(),
      workspace: z.string().required(),
      sandbox: z.union(['read-only', 'workspace-write']).required(),
      tools: z.array(z.string()),
      model: z.string(),
      maxTurns: z.natural().min(1),
      tier: z.union(['economy', 'standard', 'frontier']).required(),
      quotaClass: z.union(['subscription-chat', 'agent-plan', 'metered', 'local']).default('agent-plan'),
      pool: z.string().description('The resource pool its runs draw on (a pool id from the resources configuration); unset: not metered'),
      account: z.string().description('The account the pool belongs to; required with pool'),
      windows: z.dict(z.string()).description('The runtime\'s limit window names mapped to the pool\'s window ids, for example five_hour: five-hour'),
      worktreePerRun: z.boolean().default(false).description('Each run of a workflow run works in that run\'s own git worktree of the workspace (the top level of a git repository), on branch system/run/<runId>'),
      limitCooldownSeconds: z.natural().min(60).max(604_800).default(3600).description('How long a limit hit with no reset time keeps the pool closed; with no pool, how long every Worker of its runtime cools down'),
      family: z.string().min(1).max(128).description('Its provider family (ADR-0027; default: the runtime): the same as other Workers\' of the vendor whose models it runs, so team members of one vendor stay apart. Required for a review member'),
      reviewMember: z.boolean().default(false).description('Its review team member steps run under the enforced review-member profile (ADR-0049): no tool call runs, its workspace is an empty directory outside any repository, and the profile grants reason for those steps only; a runtime that cannot resume keeps the member\'s conversation by replay. Read-only Workers with a family only'),
      // Not z.array: an omitted array would come back as [], a Worker given no kind at all; checked at load.
      kinds: z.any().description('The kinds of work it takes (ADR-0057), such as [code] or [docs, tests]: only steps that name one of them, never a step that names none; unset, any work. Not for a review member'),
      description: z.string().max(MAX_DESCRIPTION).pattern(DESCRIPTION).description('What it is for, in your words: plain text on one line, at most 200 characters; shown on the roster, never a routing input'),
      research: z.boolean().default(false).description('A read-only research Worker (ADR-0074): its tools are Read, Grep, Glob, WebSearch, and WebFetch only (default all), it takes research work only (kinds default [research]), its gate denies a write or a command, and its web calls run unasked only under the autonomy policy\'s web access grant; it proves reason, and web-search once its web probe searched'),
    })).default([]).description('Hand-named agent-runtime Workers (the shape before Workers are account × role): they run as before until system account migrate --apply, then are refused; never with roles or assignments. Each policy comes from here only (INV-6)'),
    roles: z.array(z.object({
      id: z.string().pattern(/^[a-z][a-z0-9-]{0,31}$/).required().description('Role id: its Workers are agent:<accountId>/<role>'),
      workspace: z.string().required().description('Absolute workspace root its work is done in'),
      sandbox: z.union(['read-only', 'workspace-write']).required(),
      tier: z.union(['economy', 'standard', 'frontier']).description('Its one tier on a runtime that declares no tiers (runtimes.<runtime>.tiers); may be left out when every runtime it is assigned on declares them'),
      quotaClass: z.union(['subscription-chat', 'agent-plan', 'metered', 'local']).default('agent-plan'),
      worktreePerRun: z.boolean().default(false).description('Each run of a workflow run works in that run\'s own git worktree of the workspace, as a hand-named Worker\'s'),
      reviewMember: z.boolean().default(false).description('Its review team member steps run under the enforced review-member profile (ADR-0049); read-only, and each runtime it is assigned on names its family'),
      research: z.boolean().default(false).description('A read-only research role (ADR-0074): its Workers\' tools are Read, Grep, Glob, WebSearch, and WebFetch only, at every tier (default all), on the standard tier when it gives no tier or tiers, they take research work only (kinds default [research]), their gate denies a write or a command, and their web calls run unasked only under the autonomy policy\'s web access grant; on a runtime that offers web tools'),
      // Not z.array, as a hand-named Worker's.
      kinds: z.any().description('The kinds of work its Workers take (ADR-0057), as a hand-named Worker\'s; unset, any work. Not for a review member'),
      description: z.string().max(MAX_DESCRIPTION).pattern(DESCRIPTION).description('What the role\'s Workers are for, in your words: plain text on one line, at most 200 characters; every Worker of the role shows it on the roster, never a routing input'),
      runtimes: z.dict(z.object({
        tools: z.array(z.string()),
        model: z.string(),
        maxTurns: z.natural().min(1),
        family: z.string().min(1).max(128).description('Its provider family on this runtime (ADR-0027; default the runtime); required for a review member'),
        // Not z.dict: an omitted object would come back as {}, a runtime declaring no tier at all; checked at load.
        tiers: z.any().description('The tiers its Workers on this runtime offer (ADR-0073), {economy, standard, frontier}, each {model, tools?, maxTurns?}: one Worker offers them all, routing serves it at the lowest a step admits, and its run uses that tier\'s model. Replaces the role\'s tier on this runtime. Model names are configuration only'),
      })).description('What differs per runtime, by runtime kind: tools, model, maxTurns, family, and tiers (ADR-0073: runtimes.<runtime>.tiers = {economy?, standard?, frontier?}, each {model, tools?, maxTurns?}, in place of the role\'s tier and the runtime\'s model there; one Worker per account then offers every tier, each run on its tier\'s model; models named in the live profile only; docs/operations/runbooks.md#give-a-role-tiers); never a routing input'),
    })).default([]).description('Role templates (PROP-0012 phase F), each defined once: what the work needs, whatever account serves it'),
    assignments: z.array(z.object({
      account: z.string().pattern(/^[a-z][a-z0-9-]{0,63}:[0-9a-f]{16}$/).required().description('An enrolled agent account, by the id system account list shows'),
      roles: z.array(z.string()).required().description('The roles it serves: one Worker agent:<account>/<role> each'),
      label: z.string().max(MAX_LABEL).pattern(LABEL).description('Its display label in your words, such as science or lead: plain text on one line, at most 64 characters; shown in the roster\'s and the Workers tab\'s names (<runtime> · science · develop [code]) and system account list, never a routing input, never part of a Worker id'),
    })).default([]).description('Which roles each enrolled account serves (D24: assigned); an account with no assignment has no Worker'),
    providers: z.array(z.object({
      provider: z.string().required().description('The agent runtime kind, as its provider registers it (the runtime of its Workers)'),
      accounts: z.union(['assigned', 'pooled']).default('assigned').description('assigned (the default): a limit on one account never moves its work to another account of this runtime, the work waits; pooled: only with pooledTerms'),
      // Not z.object: an omitted object would come back as {}; checked when loaded.
      pooledTerms: z.any().description('{confirmedBy, confirmedAt, terms}: the operator\'s decision to pool this runtime\'s accounts: who decided, when (ISO time), and which terms on what basis (that they allow it, or, for a personal subscription, that the operator accepts the risk); required for pooled (ADR-0055)'),
      slots: z.natural().min(1).max(MAX_SLOTS).description('How many accounts of this runtime may be enrolled (default 1: its own home, adopted as slot 1); each slot is an owner-only home (ADR-0051)'),
      maxConcurrentRunsPerAccount: z.natural().min(1).max(MAX_CONCURRENT_PER_ACCOUNT).description('How many runs one of its accounts runs at once, across all its roles (default 1; one per Worker as well); with roles and assignments only'),
      pool: z.string().description('The pool template (resources templates) each of its accounts draws on: pool <pool>/<accountId>; unset: not metered. With roles and assignments only'),
      windows: z.dict(z.string()).description('The runtime\'s limit window names mapped to the template\'s window ids; with pool only'),
      limitCooldownSeconds: z.natural().min(60).max(604_800).description('How long a limit hit with no reset time closes an account\'s pool, or with no pool cools the account down (default 3600); with roles and assignments only'),
      limitReadSeconds: z.natural().max(MAX_LIMIT_READ_SECONDS).description(`How often each ready account with a pool has its runtime's usage report read into its pool's windows (ADR-0059; default ${DEFAULT_LIMIT_READ_SECONDS}, at least 60; 0 turns the periodic read off); with pool only`),
      modelPools: z.array(z.object({
        model: z.string().required().description('The model, as the roles\' tiers name it'),
        pool: z.string().required().description('The pool template (resources templates, of this runtime\'s group) its accounts draw on for this model: pool <pool>/<accountId>'),
        windows: z.dict(z.string()).description('The runtime\'s window names for this model (a weekly window per model) mapped to the template\'s window ids'),
      })).description(`Per-model quota (ADR-0073): a model whose provider reports a window of its own draws on one more pool per account; a run on it reserves on both, and its limit closes only the tiers that run it. At most ${MAX_MODEL_POOLS}; with pool only`),
    })).default([]).description('How each agent runtime\'s accounts are used and how many may be enrolled; a runtime not listed is assigned, with one slot (ADR-0051, ADR-0052)'),
    accountHomes: z.string().description('Where enrollment slots 2 and later keep their homes, <accountHomes>/<provider>/<n> (default <DSH_HOME>/system/agent-homes); hidden from every agent'),
    maxReplayChars: z.natural().min(1).max(2_000_000).default(200_000).description('Characters of earlier turns a review member\'s replayed conversation holds, at most; a turn past it fails, never cut'),
    probeTtlMs: z.natural().default(5 * 60_000).description('How long a runtime\'s probe result stands, from when its probe started: the next probe starts in the background at half of it, a result past it admits no Worker until one finishes, and a probe not settled within it is refused as timed out (0: every read waits for a probe, bounded at 5 min)'),
    runTimeoutMs: z.natural().min(1).default(15 * 60_000).description('Hard deadline per run'),
    stallSeconds: z.natural().min(1).max(86_400).default(300).description('A running agent whose process is present and that showed no activity for this long is stalled: reported once per stall, never prodded or stopped'),
    deadAfterSeconds: z.natural().min(1).max(86_400).default(120).description('A started run its holder did not finish is dead, and reconciled, only when its holder and its agent process are both positively gone and no activity was seen for this long'),
    maxUnknownVerdicts: z.natural().min(1).max(20).default(3).description('Verdicts other than dead a started run gets in a row, looked at again with a bounded backoff, before it goes to the operator, never declared dead'),
    worktreeRoot: z.string().description('Where the worktrees of worktreePerRun Workers go (default <DSH_HOME>/system/worktrees)'),
    worktreeRetentionHours: z.natural().default(168).description('Hours a workflow run\'s worktree is kept after its last agent run ended; then its changes are committed on its branch and it is removed (0 keeps them)'),
    worktreeSetup: z.array(z.object({
      repository: z.string().required().description('The repository (absolute): the workspace of the worktreePerRun Workers whose worktrees it sets up'),
      commands: z.array(z.string()).required().description('1 to 16 commands run in order in a new worktree before any agent run works in it, each its words split on single spaces (no shell), each judged by the autonomy policy as a command with that exact argv'),
      views: z.array(z.object({
        path: z.string().required().description('A host directory (absolute) the setup sees as a private, writable directory of its own, removed when the setup ends'),
        copy: z.array(z.string()).description('Files of it (names) copied into the private directory first, for example a package store\'s index'),
        readOnly: z.array(z.string()).description('Paths inside it (relative) bound back read-only into the private directory, for example a package store\'s files'),
      })).description('Host directories the setup sees as private copies; never a path hidden from agents'),
      timeoutSeconds: z.natural().min(1).max(3600).default(600).description('The whole setup\'s deadline'),
      checks: z.object({
        tests: z.string().description('The command of the tests check, its words split on single spaces (no shell)'),
        typecheck: z.string().description('The command of the typecheck check'),
        lint: z.string().description('The command of the lint check'),
      }).description('The command of each check a policy can require, run by a workflow run on its result\'s exact tree in this setup\'s confinement, only when the autonomy policy allows it unasked (T151)'),
      checkTimeoutSeconds: z.natural().min(1).max(3600).default(1800).description('Each check\'s deadline'),
      checkStallSeconds: z.natural().min(1).max(3600).default(300).description('Seconds a check may print nothing before it is reported as stalled in the run\'s explain and the web UI; it goes on to its deadline (T235)'),
      dependencyFiles: z.array(z.string()).description('File names (at any depth) that say what the setup installs, default package.json, pnpm-lock.yaml, pnpm-workspace.yaml, .npmrc, .pnpmfile.cjs: when a result changes any of them, the setup runs again, offline and confined, on the result\'s tree before its checks (T235)'),
      checkScratch: z.array(z.string()).description('Paths inside the worktree (relative, each ignored by git and holding nothing tracked) its checks see as fresh private writable directories, such as a test runner\'s cache (node_modules/.vite); the checks see the rest of the worktree read-only'),
      // An omitted object comes back as {}: read as none declared when loaded (src/setup.ts).
      generated: z.object({
        paths: z.array(z.string()).description('1 to 32 repository-relative paths of generated files; a * stands for any characters within one path segment, for example packages/*/plugin-manifest.json'),
        commands: z.array(z.string()).description('1 to 16 commands that regenerate them, run in order, each its words split on single spaces (no shell), each judged by the autonomy policy as a command with that exact argv and run only when it allows it unasked'),
      }).description('The repository\'s generated files: a landing whose merge conflicts only in them takes either side, runs the commands in the run\'s worktree in this setup\'s confinement, and merges only when they exit 0, change no other file, and change nothing on a repeat (T166)'),
    })).default([]).description('Per repository, the setup of a workflow run\'s new worktree: commands the autonomy policy allows, run confined (the host read-only but the worktree, no network) before any agent run works in it; one not allowed, or that fails, fails the run at start (ADR-0058)'),
    checks: z.object({
      maxConcurrent: z.natural().min(1).max(32).default(2).description('How many acceptance check runs the host runs at once, across every workflow run; the rest wait their turn, in order, and never fail for the wait (T292)'),
      maxWorkers: z.natural().min(1).max(256).description('The test workers each check run gets (the vitest config reads SYSTEM_CHECK_MAX_WORKERS); default the host\'s cores less one, shared among maxConcurrent checks, at most 32 each (T292)'),
    }).description('The load acceptance checks put on the host (T292)'),
    workspaceReads: z.object(Object.fromEntries(Object.entries(WORKSPACE_READ_BOUNDS).map(([name, bound]) => [
      name, z.natural().min(bound.min).max(bound.max).default(bound.default).description(`${bound.description} (${bound.min} to ${bound.max})`),
    ]))).description('The bounds of the workspace reads server a runtime gives its agent to read its workspace without a shell (read_file, list_dir, search; T200b), each within its range'),
  }) as unknown as z<Config>

  private readonly workers = new Map<string, WorkerSpec>()
  /** Whether the Workers are derived as account × role (roles and assignments), not hand-named rows. */
  private readonly derived: boolean
  /** Each runtime's provider entry (its derived Workers' concurrency and what they draw on). */
  private readonly providerOf: Map<string, AgentProviderConfig>
  /** Each runtime's probe, in its own home and in each account home a Worker runs in, refreshed in the background (./probes.ts). */
  private readonly probes: Probes
  /** Each research Worker's web probe (T262, ./web-probe.ts): what its web-search offer rests on. */
  private readonly webProbes: WebProbes
  private readonly schedulers = new Map<string, ProviderScheduler>()
  /** One scheduler per account of derived Workers: `maxConcurrentRunsPerAccount` at once, one per Worker. */
  private readonly accountSchedulers = new Map<string, ProviderScheduler>()
  /** Admissions routed to an account's derived Workers and not started yet (`load.pending`, ADR-0033). */
  private readonly pending = new Map<string, number>()
  /** What the ledger was last told of this source's accounts, so it is told again only on a change. */
  private readonly declaredTo = new WeakMap<object, string>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly inflight = new Set<Promise<void>>()
  /** The looks a run the host cut took while its runtime was not registered yet, by run (at most {@link MAX_RUNTIME_WAITS}). */
  private readonly runtimeWaits = new Map<string, number>()
  private readonly cancels = new Map<string, AbortController>()
  private readonly stopped = new AbortController()
  private readonly retries = new Set<NodeJS.Timeout>()
  private readonly warned = new Set<string>()
  /** Whether each `worktreePerRun` Worker's workspace can hold a worktree per run, as last checked. */
  private readonly repositories = new Map<string, { at: number; check: RepositoryCheck }>()
  private readonly worktrees: Worktrees
  /** Each repository's worktree setup, by its path as configured (resolved), and what runs them (ADR-0058). */
  private readonly setups: Map<string, Setup>
  private readonly worktreeSetups: WorktreeSetups
  /** Where each writing run's report file is made (an owner-only directory beside the worktrees, T265). */
  private readonly reportDir: string
  /** A workflow run's required checks, run on its result's worktree in its repository's setup's confinement (./checks.ts, T151). */
  private readonly runChecks: RunChecks
  /** Each runtime's account setting (ADR-0052); a runtime not configured is assigned. */
  private readonly accounts: Map<string, AccountSetting>
  /** The enrollment slots of each runtime and the accounts in them (ADR-0051). */
  readonly agentAccounts: AgentAccounts
  /** The move from hand-named rows to derived Workers, once the operator applied it (PROP-0012 phase F). */
  private readonly cutover: Cutover
  /** The periodic read of each account's usage report into its pool (ADR-0059, ./reports.ts). */
  private readonly reports: ReportSchedule
  /** Each account whose last usage report could not be read: why, and when (for the roster); a report read clears it. */
  private readonly unreadReports = new Map<string, { why: string; at: string }>()
  /** The runs in flight on each account, for whether a draw was confounded (PROP-0015 E2). */
  private readonly overlaps = new Overlaps()
  private sweeping: Promise<SweepOutcome> | undefined
  /** The workspace reads server's bounds every run is given (T200b), checked at load. */
  private readonly readBounds: WorkspaceReadBounds

  constructor(ctx: Context, private readonly config: Config = { workers: [] }) {
    super(ctx, 'agentWorkers')
    const providers = config.providers ?? []
    const configured = configuredWorkers(config)
    this.providerOf = new Map(providers.map((p) => [p.provider, p]))
    this.derived = configured.derived
    for (const [id, worker] of configured.workers) this.workers.set(id, worker)
    this.accounts = configured.accounts
    if (config.worktreeRoot !== undefined && !isAbsolute(config.worktreeRoot)) throw new ProviderError('config_error', 'agent Workers: worktreeRoot must be an absolute path')
    const worktreeRoot = config.worktreeRoot ?? join(dshHome(), 'system', 'worktrees')
    // A landing whose merge conflicts only in a repository's declared generated files makes them again, in the setup's confinement (T166).
    this.worktrees = new Worktrees(ctx, worktreeRoot, (repository, setupHash) => regenerationOf(ctx, this.setups, join(worktreeRoot, '.setup'), repository, setupHash, this.worktreeSetups))
    // A setup is for the worktrees of a repository a worktreePerRun Worker works in; any other is refused at load.
    this.setups = loadSetups(config.worktreeSetup, [...this.workers.values()].filter((w) => w.worktreePerRun).map((w) => w.workspace))
    // Its private views are made beside the worktrees (a name no repository's directory there takes).
    this.worktreeSetups = new WorktreeSetups(ctx, join(worktreeRoot, '.setup'))
    // Each writing run's report file is made there too, outside every worktree (T265).
    this.reportDir = join(worktreeRoot, '.setup')
    this.runChecks = new RunChecks(ctx, this.worktrees, this.setups, join(worktreeRoot, '.setup'), { setups: this.worktreeSetups, hostStopped: this.stopped.signal, ...checkBoundsOf(config.checks) })
    if (config.accountHomes !== undefined && !isAbsolute(config.accountHomes)) throw new ProviderError('config_error', 'agent Workers: accountHomes must be an absolute path')
    this.readBounds = readBoundsOf(config.workspaceReads)
    const slots = new Map<string, number>()
    for (const entry of providers) {
      if (entry.slots === undefined) continue
      if (!Number.isInteger(entry.slots) || entry.slots < 1 || entry.slots > MAX_SLOTS) throw new ProviderError('config_error', `agent-workers.providers: ${entry.provider} has slots ${String(entry.slots)}; 1 to ${MAX_SLOTS}`)
      slots.set(entry.provider, entry.slots)
    }
    this.agentAccounts = new AgentAccounts(ctx, {
      slots: (provider) => slots.get(provider) ?? 1,
      root: config.accountHomes ?? join(dshHome(), 'system', 'agent-homes'),
      workersIn: (account) => this.workersIn(account),
      labelOf: (accountId) => config.assignments?.find((a) => a.account === accountId)?.label,
      unreadReport: (accountId) => this.unreadReports.get(accountId),
    })
    this.probes = new Probes({
      ttlMs: config.probeTtlMs ?? 5 * 60_000,
      provider: (runtime) => this.ctx.agentRuntimes.get(runtime),
      // Each probe reads the runtime's ready accounts again (a named home's alone): one no longer signed in as its pinned principal is taken out (ADR-0051).
      after: (runtime, home) => this.agentAccounts.recheck(runtime, home).catch((error: unknown) => {
        this.ctx.logger.warn(`agent Workers: the accounts of ${runtime} could not be read again: ${(error as Error).message}`)
      }),
      inUse: (runtime, home) => this.runsIn(runtime, home),
      stopped: this.stopped.signal,
      // A stop waits for a probe in flight, no longer than its bound (probeTtlMs, ./probes.ts).
      track: (probe) => {
        const tracked = probe.then(() => undefined, () => undefined)
        this.inflight.add(tracked)
        void tracked.finally(() => this.inflight.delete(tracked))
      },
      warn: (message) => this.warnOnce(message),
    })
    this.webProbes = new WebProbes(ctx, {
      stopped: this.stopped.signal,
      // A stop waits for a web probe in flight, which the stop aborts (its own deadline bounds it too).
      track: (probe) => {
        const tracked = probe.then(() => undefined, () => undefined)
        this.inflight.add(tracked)
        void tracked.finally(() => this.inflight.delete(tracked))
      },
    })
    this.reports = new ReportSchedule({
      targets: () => this.reportTargets(),
      stopped: this.stopped.signal,
      // A stop waits for a read in flight, each bounded (readLimits) and aborted by the stop.
      track: (work) => {
        const tracked = work.then(() => undefined, () => undefined)
        this.inflight.add(tracked)
        void tracked.finally(() => this.inflight.delete(tracked))
      },
    })
    ctx.store.migrate('agent-workers', [{
      version: 1,
      sql: `CREATE TABLE agent_runs (
        run_id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, worker TEXT NOT NULL, session_id TEXT, prompt TEXT NOT NULL,
        classification TEXT NOT NULL, status TEXT NOT NULL, submitted_at TEXT, native_handle TEXT, result TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX agent_runs_status ON agent_runs (status);
      CREATE TABLE agent_sessions (session_id TEXT PRIMARY KEY, worker TEXT NOT NULL, native_handle TEXT, created_at TEXT NOT NULL);`,
    }, {
      // The egress decision of each run (INV-12): the agent runs here, but its model is remote.
      version: 2,
      sql: 'ALTER TABLE agent_runs ADD COLUMN egress_decision TEXT;',
    }, {
      // Metering (docs/design/resources.md): the run's budget decision, and the reservation it holds.
      version: 3,
      sql: 'ALTER TABLE agent_runs ADD COLUMN budget_decision TEXT; ALTER TABLE agent_runs ADD COLUMN reservation_id TEXT;',
    }, {
      // A worktree per workflow run (./worktrees.ts): the run each agent run belongs to, and each run's worktree of a repository.
      version: 4,
      sql: `ALTER TABLE agent_runs ADD COLUMN workflow_run_id TEXT;
      CREATE INDEX agent_runs_workflow_run ON agent_runs (workflow_run_id);
      CREATE TABLE agent_worktrees (
        repository TEXT NOT NULL, workflow_run_id TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, gitdir TEXT NOT NULL,
        created_at TEXT NOT NULL, removed_at TEXT, decision TEXT, failure TEXT, failed_at TEXT,
        PRIMARY KEY (repository, workflow_run_id)
      );`,
    }, GATE_MIGRATION, {
      // The board task a run's brief serves (brief@1.x taskId, projectId): its reservation and usage name it.
      version: 6,
      sql: 'ALTER TABLE agent_runs ADD COLUMN task_id TEXT; ALTER TABLE agent_runs ADD COLUMN project_id TEXT;',
    }, {
      // A brief's files (brief@1.2 files, the board's TASKS.md): their text, resolved at start like the prompt.
      version: 7,
      sql: 'ALTER TABLE agent_runs ADD COLUMN files TEXT;',
    }, {
      // A review member's conversation kept by replay (ADR-0049): the kind of work a run is, the
      // session's generation it belongs to (a reset starts a new one, whose replay starts empty), and
      // the earlier runs it replays, fixed when first prepared.
      version: 8,
      sql: `ALTER TABLE agent_runs ADD COLUMN scope TEXT;
      ALTER TABLE agent_runs ADD COLUMN session_generation INTEGER;
      ALTER TABLE agent_runs ADD COLUMN replay TEXT;
      ALTER TABLE agent_sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;`,
    }, {
      // A limit no ledger reading holds: the runtime's Workers cool down until then (one home, one sign-in).
      version: 9,
      // Keyed by the account the limit holds: a hand-named Worker's runtime, a derived Worker's account id.
      sql: 'CREATE TABLE agent_cooldowns (runtime TEXT PRIMARY KEY, until TEXT NOT NULL, worker TEXT NOT NULL, run_id TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);',
    }, ACCOUNTS_MIGRATION, CUTOVER_MIGRATION, {
      // The liveness verdict (PROP-0013, ADR-0056): who held a run, its agent process, its latest
      // activity, a stall reported, the request it stopped on, and the verdicts it got after its holder stopped.
      version: 12,
      sql: `ALTER TABLE agent_runs ADD COLUMN holder TEXT;
      ALTER TABLE agent_runs ADD COLUMN agent_process TEXT;
      ALTER TABLE agent_runs ADD COLUMN activity_at TEXT;
      ALTER TABLE agent_runs ADD COLUMN stalled_at TEXT;
      ALTER TABLE agent_runs ADD COLUMN deferred_request TEXT;
      ALTER TABLE agent_runs ADD COLUMN liveness_looks INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE agent_runs ADD COLUMN liveness_verdict TEXT;
      ALTER TABLE agent_runs ADD COLUMN liveness_decision TEXT;
      CREATE INDEX agent_runs_session ON agent_runs (session_id, created_at);`,
    }, SETUP_MIGRATION, {
      // The operator frees what a run that ended not known to be gone held, on their word that its agent is gone.
      version: 14,
      sql: 'ALTER TABLE agent_runs ADD COLUMN liveness_freed TEXT;',
    }, CARRY_MIGRATION, FORK_MIGRATION, CHECKS_MIGRATION, DENIAL_MIGRATION, {
      // What a run drew (PROP-0015 E2, quota-draw@1.0) names the kind of work it was admitted for and
      // the template step it served, from the trusted requirement and the engine's start (INV-6).
      version: 19,
      sql: `ALTER TABLE agent_runs ADD COLUMN kind TEXT;
      ALTER TABLE agent_runs ADD COLUMN step_template TEXT;
      ALTER TABLE agent_runs ADD COLUMN step_node TEXT;`,
    }, {
      // The tier a run runs at (ADR-0073), of the tiers its Worker offers: its model is that tier's.
      // A run from before has none, and runs its Worker's lowest tier, as it would have. The model
      // its tier gave it at the start, on a Worker that offers tiers: it runs no other.
      version: 20,
      sql: `ALTER TABLE agent_runs ADD COLUMN tier TEXT;
      ALTER TABLE agent_runs ADD COLUMN configured_model TEXT;`,
    }, {
      // A run the host's own stop cut (T283): when its runtime was ended by this source's stop, how
      // many times that happened to it, and the decision of its latest resume or restart.
      version: 21,
      sql: `ALTER TABLE agent_runs ADD COLUMN host_stopped_at TEXT;
      ALTER TABLE agent_runs ADD COLUMN resumes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE agent_runs ADD COLUMN resume_decision TEXT;`,
    }, {
      // Who the run's brief selected its handbook slice for (brief@1.6 handbook.selection): the lessons it is given follow it.
      version: 22,
      sql: 'ALTER TABLE agent_runs ADD COLUMN handbook TEXT;',
    }])
    this.cutover = new Cutover(ctx)
    // Once the operator applied the move, the hand-named rows are refused: one implementation, no second path.
    const applied = config.workers?.length ? this.cutover.state() : undefined
    if (applied) {
      throw new ProviderError('config_error', `agent-workers.workers: the hand-named agent Workers (${config.workers.map((w) => `agent:${w.id}`).join(', ')}) were migrated to accounts × roles on ${applied.appliedAt} (decision ${applied.decision}): `
        + 'replace them in the row with the providers, roles, and assignments system account migrate prints, or undo the move first (system account migrate --rollback; docs/operations/runbooks.md#migrate-agent-workers-to-accounts--roles)')
    }
    // A pooled runtime's recorded terms, as a gate decision at each start (ADR-0052, INV-13).
    for (const [provider, setting] of this.accounts) {
      if (setting.mode === 'pooled' && setting.pooledTerms) ctx.artifacts.recordDecision(pooledTermsDecision(provider, setting.pooledTerms, 'agent-workers.pooled-terms'), { producer: { type: 'system', ref: 'agent-workers' } })
    }
    ctx.workers.register({
      name: 'agents',
      describe: () => this.describe(),
      start: (request) => this.start(request),
      get: (id) => {
        const row = this.row(id)
        return row && execution(row)
      },
      wait: (id, timeoutMs) => this.wait(id, timeoutMs),
      cancel: (id) => this.cancel(id),
      reserve: (worker) => this.admit(worker),
      sandbox: (worker, runId) => this.sandboxOf(worker, runId),
      // The model a run of a Worker that offers tiers asks for at a tier (ADR-0073), for its brief.
      model: (worker, tier) => {
        const spec = this.workers.get(worker)
        return spec?.tiers?.some((t) => t.tier === tier) ? this.atTier(spec, tier).model : undefined
      },
      affinity: (sessionId) => {
        const session = this.ctx.store.db.prepare('SELECT worker FROM agent_sessions WHERE session_id = ?').get(sessionId) as { worker: string } | undefined
        return session ? [session.worker] : undefined
      },
      // Every role on one sign-in is one account: a failover and a team leave them all out.
      siblings: (worker) => {
        const config = this.workers.get(worker)
        return config && this.siblingsOf(config)
      },
      handle: (sessionId) => (this.ctx.store.db.prepare('SELECT native_handle FROM agent_sessions WHERE session_id = ?').get(sessionId) as { native_handle: string | null } | undefined)?.native_handle ?? undefined,
      // The Worker stays (session affinity); without a handle the next run starts a new agent session,
      // and in a new generation a replayed conversation starts empty (ADR-0049).
      reset: (sessionId) => Number(this.ctx.store.db.prepare('UPDATE agent_sessions SET native_handle = NULL, generation = generation + 1 WHERE session_id = ?').run(sessionId).changes) > 0,
      held: (sessionId) => this.held(sessionId),
      liveness: (query) => this.liveness(query),
      // Landing an accepted result made in a workflow run's worktree (ADR-0060): its commit, then its merge.
      land: (step) => this.worktrees.land(step),
      // A workflow run's change in its worktrees, read only, for the operator's review (T122).
      changes: (runId) => this.worktrees.changes(runId),
      // A board task's next attempt starting from the work its previous attempt left (ADR-0061).
      carry: (step) => this.worktrees.carry(step),
      // A workflow run's required checks, run on its result's exact tree (T151).
      check: (step, signal) => this.runChecks.check(step, signal),
    })
    // The operator's enrollment tools and the tool that frees a run's holds, when the MCP endpoint is mounted (operator scope).
    ctx.inject(['mcp'], (c) => {
      registerAccountTools(c, this.agentAccounts, this)
      registerRunTools(c, this)
    })
    ctx.effect(() => {
      queueMicrotask(() => {
        this.recover()
        this.sweepSafely()
        this.reports.start()
      })
      const hourly = setInterval(() => this.sweepSafely(), SWEEP_MS)
      hourly.unref()
      return async () => {
        clearInterval(hourly)
        // A stop is not a failure: a started run stays as it is, and the next start reconciles it.
        this.stopped.abort()
        this.reports.close()
        this.probes.close()
        for (const timer of this.retries) clearTimeout(timer)
        for (const scheduler of [...this.schedulers.values(), ...this.accountSchedulers.values()]) scheduler.close(new ProviderError('aborted', 'agent Workers stopped'))
        await Promise.allSettled(this.inflight)
        for (const set of this.waiters.values()) for (const wake of set) wake()
        this.waiters.clear()
      }
    })
  }

  /**
   * Each configured Worker, with what its runtime's probe in its runs' home proves now. Once the
   * first probe there has finished, this never waits for one: a result past `probeTtlMs` admits
   * nothing until the probe in the background replaces it (./probes.ts).
   */
  private async describe(): Promise<CapabilityDescriptor[]> {
    const observedAt = now()
    const loads = this.derived ? this.loads() : undefined
    return Promise.all([...this.workers].map(async ([id, worker]): Promise<CapabilityDescriptor> => {
      const evidence = await this.evidence(worker, 'described')
      // A Worker that works in a worktree per run takes no work while its workspace cannot hold one.
      const repository = worker.worktreePerRun ? await this.repository(id, worker) : undefined
      // A Worker whose runtime cannot keep the host state unreadable (ADR-0024), or cannot ask the
      // run's gate before each tool call, is never admitted.
      const proof = admits(evidence, worker) && (!repository || 'repository' in repository)
      // A Worker takes work only while its account does (INV-2): no Worker of it while its runtime
      // cools down from a limit no ledger reading holds, or while the pool of any of them is closed.
      // A Worker whose probe is only late is gated too (T282), so it stands only while its pools can be read.
      const { state: pool, until, why: gateWhy } = proof || isLate(evidence) ? await this.accountGate(worker, true) : { state: 'ready' as const, until: undefined, why: undefined }
      const ready = proof && pool !== 'unavailable'
      // A probe that is only late (the last past probeTtlMs and the next not finished, or one timed
      // out) says nothing against what the Worker proved (T282): it still lists what its runtime's last
      // available probe proved (its role's offers when its first probe is the late one), and reads
      // unavailable. A step that needs it is then refused for its state, which passes, never told that
      // no Worker proves the work, which fails it as a configuration problem. Never admitted while late.
      const before = isLate(evidence) ? provenBefore(evidence) : undefined
      const standing = ready || (isLate(evidence) && pool !== 'unavailable' && (before === undefined || admits(before, worker)) && !(repository && 'problem' in repository))
      const shown = before ?? evidence
      // Why it takes no work, for the roster and its readers (`@1.9`): the probe's detail, the
      // repository's problem, or the account's or pool's gate (the live incident of 2026-10-26).
      const refusal = refusalOf(evidence, worker)
      const why = ready ? undefined
        : refusal ?? (repository && 'problem' in repository ? `it works in a worktree per run, and ${repository.problem}` : undefined) ?? gateWhy ?? 'its account or pool cannot be read'
      const probed = { kind: 'probe' as const, at: observedAt }
      // A research role (T262, ADR-0074) proves reason, and web-search by its web probe's real search only.
      // It takes research work only (kinds), so its reason never serves an ordinary ask (P1).
      const web = ready && worker.research ? this.webProofOf(id, worker) : undefined
      const research: CapabilityOffer[] = [
        { capability: 'reason', evidence: probed },
        ...(web ? [{ capability: 'web-search', evidence: { kind: 'probe' as const, ref: web.decision as ArtifactRef, at: web.at } }] : []),
        ...(shown.resume ? [{ capability: 'persistent-conversation', evidence: probed }] : []),
      ]
      const proven: CapabilityOffer[] = standing && worker.research ? research : standing
        ? [
            ...[
              'local-data',
              // A review is independent of the change, so only a Worker that cannot write proves it (INV-15).
              ...(worker.sandbox === 'workspace-write' ? ['develop', ...(shown.executes ? ['validate'] : [])] : ['review']),
              ...(shown.resume ? ['persistent-conversation'] : []),
              // A writer whose runtime gives its runs the dossier tools (ADR-0070) can show its checks' output there (T267).
              ...(worker.sandbox === 'workspace-write' && shown.hostTools === true && dossiersOf(this.ctx) ? ['dossier'] : []),
            ].map((capability) => ({ capability, evidence: probed })),
            // The review-member profile (ADR-0049) grants reason for a review team member's steps only,
            // and only while it is enforced: the Worker is read-only (checked at load) and its runtime
            // enforces the read-only sandbox, keeps host state unreadable, and asks the run's gate before
            // every tool call, which the gate denies. It is admitted only while ready: listed while its
            // probe is late (T282), it reads unavailable and routing refuses it for its state. Never plain
            // reason, so an ordinary ask never spends agent-plan quota (P1). Its conversation is kept
            // natively when the runtime resumes one, else by this source's replay, for that work only.
            ...(worker.reviewMember ? [{ capability: 'reason', evidence: probed, scope: REVIEW_MEMBER }] : []),
            ...(worker.reviewMember && !shown.resume ? [{ capability: 'persistent-conversation', evidence: { kind: 'conformance' as const, at: observedAt }, scope: REVIEW_MEMBER }] : []),
          ]
        : []
      // A Worker runs on its account (a hand-named one on its runtime's one home), compared within the
      // runtime under its setting (ADR-0052); out of quota, it says until when its account is back.
      const mode = (this.accounts.get(worker.runtime) ?? ASSIGNED).mode
      const account = { id: accountOf(worker), group: worker.runtime, mode, ...(pool === 'quota-exhausted' && until ? { limitUntil: until } : {}) }
      // A derived Worker reports its account's load: what runs and waits on it across its roles (ADR-0033).
      const load = loads && worker.derived ? this.loadOf(worker, loads) : undefined
      const state = !ready ? 'unavailable' : pool === 'ready' && load && load.running >= load.slots ? 'busy' : pool
      // The tiers it offers (ADR-0073), each with the pools a run at it draws on, closed while its model's pool is.
      const tiers = worker.tiers ? await this.tierOffers(id, worker, ready && pool === 'ready') : undefined
      // Standing while its probe is late (T282): the next result is due within one probe's bound, so
      // routing looks again then and the step waits, bounded, instead of failing (`@1.12`).
      const expectedBack = !ready && standing ? new Date(Date.now() + (this.config.probeTtlMs || 5 * 60_000)).toISOString() : undefined
      return {
        // The operator's family, else the runtime, who serves the work (ADR-0027); the kinds of work
        // the operator gives it, so it takes no other (ADR-0057).
        ...(expectedBack !== undefined ? { expectedBack } : {}),
        schema: expectedBack !== undefined ? 'capability-descriptor@1.12' : tiers ? 'capability-descriptor@1.11' : why !== undefined ? 'capability-descriptor@1.9' : worker.description ? 'capability-descriptor@1.7' : worker.kinds ? 'capability-descriptor@1.6' : 'capability-descriptor@1.5', account, ...(worker.kinds ? { kinds: [...worker.kinds] } : {}),
        ...(worker.description ? { description: worker.description } : {}),
        ...(why !== undefined ? { unavailableReason: boundedReason(why) } : {}),
        worker: id, provider: worker.runtime, family: worker.family ?? worker.runtime, ...(load ? { load } : {}), tier: worker.tier, ...(tiers ? { tiers } : {}), quotaClass: worker.quotaClass ?? 'agent-plan',
        locality: 'local', capabilities: proven, state, observedAt,
      }
    }))
  }

  /**
   * The tiers a Worker offers (ADR-0073), lowest first: each with the pools a run at it draws on (its
   * account's, and its model's when the provider names one), and closed while its model's pool is
   * unavailable, with when it is expected back. A model's pool that cannot be read closes its tier
   * (INV-2). `read` false (the Worker takes no work anyway): the tiers alone, no pool read.
   */
  private async tierOffers(id: string, worker: WorkerSpec, read: boolean): Promise<TierOffer[]> {
    const gates = new Map<string, Promise<{ state: string; until?: string | undefined }>>()
    return Promise.all(worker.tiers!.map(async (t): Promise<TierOffer> => {
      const pools = worker.pool !== undefined ? [worker.pool, ...(t.modelPool ? [t.modelPool.pool] : [])] : undefined
      // What a run at this tier uses (its model as the live profile names it, and its turn limit), for people to read.
      const at = this.atTier(worker, t.tier)
      const shown = { ...(at.model ? { label: at.model } : {}), ...(at.maxTurns ? { maxTurns: at.maxTurns } : {}) }
      if (!read || !t.modelPool) return { tier: t.tier, ...(pools ? { pools } : {}), ...shown }
      const pool = t.modelPool.pool
      if (!gates.has(pool)) gates.set(pool, this.poolGate(id, { ...worker, pool }))
      const gate = await gates.get(pool)!
      return { tier: t.tier, ...(pools ? { pools } : {}), ...shown, ...(gate.state !== 'ready' ? { closed: true as const, ...(gate.until ? { until: gate.until } : {}) } : {}) }
    }))
  }

  /**
   * The tier a run of this Worker runs at (ADR-0073), and what it runs there: the routed tier
   * (`WorkerStart.tier`) when the Worker offers it, else the lowest it offers at or above the
   * requirement's minimum. A Worker that offers no tiers runs its one, as before. Refuses a tier it
   * does not offer: nothing is started.
   */
  private tierOfStart(worker: WorkerSpec, request: WorkerStart): Tier {
    if (!worker.tiers) {
      if (request.tier !== undefined && request.tier !== worker.tier) throw new ProviderError('invalid_input', `${request.worker} offers tier ${worker.tier} only, not ${request.tier}; nothing was started`)
      return worker.tier
    }
    const offered = worker.tiers.map((t) => t.tier)
    if (request.tier !== undefined) {
      if (!offered.includes(request.tier)) throw new ProviderError('invalid_input', `${request.worker} offers the tiers ${offered.join(', ')}, not ${request.tier}; nothing was started`)
      return request.tier
    }
    const min = TIERS.indexOf(request.requirement.tier.min)
    const found = offered.find((t) => TIERS.indexOf(t) >= min)
    if (!found) throw new ProviderError('invalid_input', `${request.worker} offers the tiers ${offered.join(', ')}, none at or above ${request.requirement.tier.min}; nothing was started`)
    return found
  }

  /**
   * Why a run its Worker no longer serves as it was started (ADR-0073), or undefined: the
   * configuration changed while it waited (a restart, a live update) so that the tier it was routed
   * at is no longer offered (its tiers removed or changed, or a one-tier Worker's tier another), or,
   * on a Worker that offered tiers, that tier runs another model now, or none of its own. A run from
   * before tiers names none and runs its Worker's lowest tier, as it would have.
   */
  private offerChanged(row: RunRow, worker: WorkerSpec): string | undefined {
    if (row.tier == null) return undefined
    const offered = worker.tiers?.map((t) => t.tier) ?? [worker.tier]
    if (!offered.includes(row.tier as Tier)) {
      return `${row.worker} was started at tier ${row.tier}, and it no longer offers tier ${row.tier}: it offers ${offered.length === 1 ? `tier ${offered[0]} only` : `the tiers ${offered.join(', ')}`}`
    }
    if (row.configured_model == null) return undefined
    const model = this.atTier(worker, row.tier).model
    if (model === row.configured_model) return undefined
    return `${row.worker} was started at tier ${row.tier} for the model its configuration gave that tier then, and tier ${row.tier} now ${model === undefined ? 'names no model of its own' : 'runs another model'}`
  }

  /** What a run at its tier runs (ADR-0073): the tier's model and options, else the Worker's own. */
  private atTier(worker: WorkerSpec, tier: string | null | undefined): AtTier {
    const at = worker.tiers?.find((t) => t.tier === tier) ?? (tier == null ? worker.tiers?.[0] : undefined)
    if (!at) return { tier: worker.tier, ...(worker.tools ? { tools: worker.tools } : {}), ...(worker.model ? { model: worker.model } : {}), ...(worker.maxTurns ? { maxTurns: worker.maxTurns } : {}), declared: false }
    const tools = at.tools ?? worker.tools
    const model = at.model ?? worker.model
    const maxTurns = at.maxTurns ?? worker.maxTurns
    return { tier: at.tier, declared: at.declared, ...(at.modelPool ? { modelPool: at.modelPool } : {}), ...(tools ? { tools } : {}), ...(model ? { model } : {}), ...(maxTurns ? { maxTurns } : {}) }
  }

  /**
   * A research Worker's web probe proof now (T262, ./web-probe.ts), when one stands; a probe starts in
   * the background otherwise, in the home its runs use, on its lowest tier's model. None while that
   * home cannot be named.
   */
  private webProofOf(id: string, worker: WorkerSpec): WebProof | undefined {
    const provider = this.ctx.agentRuntimes.get(worker.runtime)
    if (!provider) return undefined
    const named = this.namedHome(worker, provider)
    if (named && 'why' in named) return undefined
    const model = this.atTier(worker, undefined).model
    return this.webProbes.proof({ worker: id, workerKind: worker.runtime, provider, workspace: worker.workspace, ...(named ? { home: named.home } : {}), ...(model ? { model } : {}) })
  }

  /** Each Worker's queued and running runs now, by Worker id. */
  private loads(): Map<string, { running: number; queued: number }> {
    const counts = new Map<string, { running: number; queued: number }>()
    for (const row of this.ctx.store.db.prepare("SELECT worker, status, COUNT(*) AS n FROM agent_runs WHERE status IN ('queued', 'running') GROUP BY worker, status").all() as Array<{ worker: string; status: 'queued' | 'running'; n: number }>) {
      const count = counts.get(row.worker) ?? { running: 0, queued: 0 }
      count[row.status] = row.n
      counts.set(row.worker, count)
    }
    return counts
  }

  /** A derived Worker's load: its account's running and queued runs across its roles, admissions not started yet, and how many run at once. */
  private loadOf(worker: WorkerSpec, counts: Map<string, { running: number; queued: number }>): { running: number; queued: number; pending: number; slots: number } {
    const load = { running: 0, queued: 0, pending: this.pending.get(accountOf(worker)) ?? 0, slots: this.capacityOf(worker) }
    for (const id of this.siblingsOf(worker)) {
      load.running += counts.get(id)?.running ?? 0
      load.queued += counts.get(id)?.queued ?? 0
    }
    return load
  }

  /** How many runs a derived Worker's account runs at once. */
  private capacityOf(worker: WorkerSpec): number {
    return this.providerOf.get(worker.runtime)?.maxConcurrentRunsPerAccount ?? 1
  }

  /**
   * An admission routed to a derived Worker, counted in its account's `load.pending` until its run is
   * started or given up (ADR-0033); starting is synchronous, so the run is queued by then. A
   * hand-named Worker reports no load, so nothing is counted for it.
   */
  private admit(id: string): () => void {
    const worker = this.workers.get(id)
    if (!worker?.derived) return () => undefined
    const account = worker.derived.accountId
    this.pending.set(account, (this.pending.get(account) ?? 0) + 1)
    let held = true
    return () => {
      if (!held) return
      held = false
      const left = (this.pending.get(account) ?? 1) - 1
      if (left > 0) this.pending.set(account, left)
      else this.pending.delete(account)
    }
  }

  /** The Workers that run on an enrolled account, for the operator's listing: those assigned to it, or, with hand-named rows, its runtime's when it is in the runtime's own home. */
  private workersIn(account: AgentAccount): string[] {
    if (this.derived) return account.accountId ? [...this.workers].filter(([, w]) => w.derived?.accountId === account.accountId).map(([id]) => id).sort() : []
    if (this.ctx.agentRuntimes.get(account.provider)?.home !== account.home) return []
    return [...this.workers].filter(([, w]) => w.runtime === account.provider).map(([id]) => id).sort()
  }

  /**
   * The move from the hand-named rows to Workers derived as account × role (`system account migrate`):
   * printed by default, applied with `apply` (refused while it has blockers or a run of an old Worker is
   * queued or running; applied already, nothing changes), or undone with `rollback`. `stop`: runtimes
   * whose Workers stop at the cutover, their account not ready. `check` sees the output an apply or a
   * rollback would give before anything it does commits; one that throws leaves everything as it was.
   */
  async migrate(options: { apply?: boolean; rollback?: boolean; stop?: readonly string[] } = {}, check?: (out: MigrateOutput) => void): Promise<MigrateOutput> {
    if (options.apply && options.rollback) throw new ProviderError('invalid_input', 'apply or roll back, not both')
    if (options.rollback) {
      // A rollback with nothing to undo plans the move as it stands now; the plan is read before the transaction.
      const plan = this.cutover.state() ? undefined : await this.plan(options.stop ?? [])
      const outputOf = (undone: RolledBack): MigrateOutput => {
        const shown = undone.cutover?.plan ?? plan
        // Only when a cutover was applied between the two reads, and so nothing was rolled back.
        if (!shown) throw new ProviderError('invalid_input', 'a cutover was applied while the rollback read it, and nothing changed: run the rollback again')
        return { outcome: undone.rolledBack ? 'rolled-back' : 'not-applied', plan: shown, row: this.rowOf(shown), moved: undone.moved }
      }
      return outputOf(this.cutover.rollback(check && ((undone) => check(outputOf(undone)))))
    }
    const current = this.cutover.state()
    // Applied already: what was applied is what stands, whatever is loaded now.
    if (current) return { outcome: options.apply ? 'already-applied' : 'planned', plan: current.plan, row: this.rowOf(current.plan), cutover: current }
    const plan = await this.plan(options.stop ?? [])
    if (!options.apply) return { outcome: 'planned', plan, row: this.rowOf(plan) }
    const slotDecision = (account: string): ContentId | undefined => this.agentAccounts.decisionOf(account)
    const outputOf = (applied: Applied): MigrateOutput => ({
      outcome: applied.applied ? 'applied' : 'already-applied', plan: applied.cutover.plan, row: this.rowOf(applied.cutover.plan), cutover: applied.cutover, moved: applied.moved,
    })
    return outputOf(this.cutover.apply(plan, slotDecision, check && ((applied) => check(outputOf(applied)))))
  }

  /** The move as it stands now: from the loaded hand-named rows (none, when derived Workers are loaded). */
  private async plan(stop: readonly string[]): Promise<MigrationPlan> {
    const rows = this.derived ? [] : [...this.workers.values()]
    const metered = rows.some((r) => r.pool !== undefined)
    const resources = this.ctx.get('resources')
    const pools = metered && resources ? await resources.pools().catch(() => undefined) : undefined
    const runtimes = new Map(this.ctx.agentRuntimes.list().map((kind) => {
      const runtime = this.ctx.agentRuntimes.get(kind)
      return [kind, { home: runtime?.home, identity: typeof runtime?.identity === 'function' }]
    }))
    const plan = planMigration({ rows, providers: this.config.providers ?? [], accounts: this.agentAccounts.list(), runtimes, pools: metered && resources ? pools ?? [] : undefined, stop })
    if (this.derived) plan.blockers.push('Workers derived from roles and assignments are loaded: there are no hand-named rows to migrate')
    return plan
  }

  /** The `agent-workers` row's configuration after the move: its settings as loaded, with the plan's providers, roles, and assignments in place of the hand-named Workers. */
  private rowOf(plan: MigrationPlan): Record<string, unknown> {
    const { workers: _, providers: __, roles: ___, assignments: ____, ...settings } = this.config
    // A setting at its default (an empty worktreeSetup among them) is left out.
    const { workspaceReads, checks, ...rest } = settings
    const kept = Object.fromEntries(Object.entries(rest).filter(([key, value]) => value !== undefined && value !== SETTING_DEFAULTS[key] && !(Array.isArray(value) && !value.length)))
    // So is each workspace reads bound at its default, and the setting when all are (T200b).
    const reads = Object.fromEntries(Object.entries(workspaceReads ?? {}).filter(([name, value]) => value !== WORKSPACE_READ_BOUNDS[name as keyof WorkspaceReadBounds]?.default))
    // And each checks bound at its default (or unset), and the setting when all are (T292).
    const bounds = Object.fromEntries(Object.entries(checks ?? {}).filter(([name, value]) => value !== undefined && !(name === 'maxConcurrent' && value === DEFAULT_MAX_CONCURRENT_CHECKS)))
    return { ...kept, ...(Object.keys(reads).length ? { workspaceReads: reads } : {}), ...(Object.keys(bounds).length ? { checks: bounds } : {}), providers: plan.providers, roles: plan.roles, assignments: plan.assignments }
  }

  /** The ledger a metered Worker's runs go through, or undefined for a Worker with no pool. */
  private meter(id: string, worker: WorkerSpec, model?: DerivedTier['modelPool']): Meter | undefined {
    if (worker.pool === undefined || worker.account === undefined) return undefined
    const resources = this.ctx.get('resources')
    // Configured to be metered, and no ledger: no run starts (INV-2; docs/design/resources.md).
    if (!resources) throw new ProviderError('config_error', `${id} draws on pool ${worker.pool}, and no resource ledger (ctx.resources) is loaded`)
    return { resources, pool: worker.pool, account: worker.account, ...(model ? { model } : {}), models: this.modelPoolsOf(worker) }
  }

  /** Every model's own pool on a derived Worker's account (ADR-0073), with its window map; none for a hand-named Worker. */
  private modelPoolsOf(worker: WorkerSpec): Meter['models'] {
    if (!worker.derived || worker.pool === undefined) return []
    return (this.providerOf.get(worker.runtime)?.modelPools ?? []).map((m) => ({ pool: templatePool(m.pool, worker.derived!.accountId), windows: { ...m.windows } }))
  }

  /** The Workers on this Worker's account, itself included, ordered by id (`siblings`, PROP-0012 phase C). */
  private siblingsOf(worker: WorkerSpec): string[] {
    return [...this.workers].filter(([, w]) => accountOf(w) === accountOf(worker)).map(([id]) => id).sort()
  }

  /**
   * Whether the account a Worker runs on takes work now. A limit seen on any of its Workers holds
   * them all, since they share one sign-in: its runtime's cooldown, or a closed pool of any of them,
   * `quota-exhausted` until the last of those is back (no time when one of them names none). A pool
   * of any of them that cannot be read leaves it `unavailable` (INV-2). `own` false leaves out the
   * Worker's own pool, which its run's reservation checks with a `budget` decision.
   */
  private async accountGate(worker: WorkerSpec, own: boolean): Promise<AccountGate> {
    // A derived Worker's account takes work only while it is ready (REQ-ACC-11); a hand-named one's,
    // enrolled in its runtime's home when one is, while it is not quarantined or signed out (ADR-0051),
    // and only until the operator moved the hand-named Workers to accounts × roles.
    const enrolled = worker.derived ? this.agentAccounts.accountGate(worker.derived.accountId) : this.handNamedGate(worker)
    if (enrolled.state === 'unavailable') {
      this.warnOnce(`agent Workers: ${enrolled.why}`)
      return { state: 'unavailable', why: enrolled.why }
    }
    const cooled = this.cooldown(accountOf(worker))
    if (cooled) return { state: 'quota-exhausted', until: cooled.until, why: `${accountOf(worker)} hit a usage limit (run ${cooled.run_id} on ${cooled.worker}); its Workers take no run until ${cooled.until}` }
    const meter = (w: AgentWorkerConfig): string => JSON.stringify([w.account, w.pool])
    const seen = new Set(own || worker.pool === undefined ? [] : [meter(worker)])
    const closed: Array<{ id: string; pool: string; until: string | undefined }> = []
    for (const id of this.siblingsOf(worker)) {
      const sibling = this.workers.get(id)!
      if (sibling.pool === undefined || seen.has(meter(sibling))) continue
      seen.add(meter(sibling))
      const gate = await this.poolGate(id, sibling)
      if (gate.state === 'unavailable') return { state: 'unavailable', why: `the pool ${sibling.pool} of ${id}, on the same sign-in, cannot be read${gate.why ? ` (${gate.why})` : ''}` }
      if (gate.state === 'quota-exhausted') closed.push({ id, pool: sibling.pool, until: gate.until })
    }
    if (!closed.length) return { state: 'ready' }
    const until = closed.every((c) => c.until) ? closed.map((c) => c.until!).sort().at(-1) : undefined
    return { state: 'quota-exhausted', until, why: `${closed.map((c) => `the pool ${c.pool} of ${c.id}`).join(' and ')}, on the same sign-in, ${closed.length > 1 ? 'are at their limits' : 'is at its limit'}${until ? ` until ${until}` : ''}` }
  }

  /** Whether a hand-named Worker takes work as the account in its runtime's home says, and while the move to accounts × roles is not applied. */
  private handNamedGate(worker: WorkerSpec): HomeGate {
    const applied = this.cutover.state()
    if (applied) {
      return { state: 'unavailable', why: `agent:${worker.id} is a hand-named Worker, and the operator moved them to accounts × roles on ${applied.appliedAt} (decision ${applied.decision}): load the derived Workers, or undo the move (system account migrate --rollback)` }
    }
    return this.agentAccounts.homeGate(worker.runtime)
  }

  /**
   * Tell the ledger which accounts this source's derived Workers draw on (ADR-0052): each ready
   * account assigned on a metered provider, so the ledger makes its pool of the provider's template.
   * Told again only when that changes, or the ledger is another one (a restart of its row). A ledger
   * that cannot be told leaves those pools unmade, and their Workers unavailable (INV-2).
   */
  private async declareAccounts(resources: Resources): Promise<void> {
    if (!this.derived) return
    const accounts = [...new Set([...this.workers.values()].filter((w) => w.derived && w.pool !== undefined).map((w) => w.derived!.accountId))]
      .filter((account) => this.agentAccounts.accountGate(account).state === 'ready').sort()
      .map((account) => ({ account, group: [...this.workers.values()].find((w) => w.derived?.accountId === account)!.runtime }))
    const told = JSON.stringify(accounts)
    if (this.declaredTo.get(resources) === told) return
    if (typeof resources.declare !== 'function') {
      this.warnOnce('agent Workers: the resource ledger makes no pools of templates (no declare), so no derived Worker\'s pool exists')
      return
    }
    await resources.declare('agents', accounts).then(() => this.declaredTo.set(resources, told), (error: unknown) => {
      this.warnOnce(`agent Workers: the resource ledger refused this source's accounts: ${(error as Error).message}`)
    })
  }

  /**
   * Whether a metered Worker's pool takes work now: `ready`, `quota-exhausted` while it is
   * unavailable (with `until`, when the ledger expects it back), or `unavailable` when it cannot be read.
   */
  private async poolGate(id: string, worker: WorkerSpec): Promise<{ state: 'ready' | 'quota-exhausted' | 'unavailable'; until?: string | undefined; why?: string }> {
    try {
      const meter = this.meter(id, worker)
      if (!meter) return { state: 'ready' }
      await this.declareAccounts(meter.resources)
      const pool = (await meter.resources.pools({ account: meter.account })).find((p) => p.pool === meter.pool)
      if (!pool) {
        const why = `${id} draws on pool ${meter.pool} of ${meter.account}, which the resource ledger does not configure`
        this.warnOnce(`agent Workers: ${why}`)
        return { state: 'unavailable', why }
      }
      return pool.available ? { state: 'ready' } : { state: 'quota-exhausted', until: pool.until }
    } catch (error) {
      const why = `the pool of ${id} cannot be read: ${(error as Error).message}`
      this.warnOnce(`agent Workers: ${why}`)
      return { state: 'unavailable', why }
    }
  }

  /**
   * Read now each account's usage report that is due (ADR-0059): the periodic read's pass, which
   * also runs on its own schedule. Resolves when the reads it started ended; never rejects.
   */
  readUsageReports(): Promise<void> {
    return this.reports.pass()
  }

  /**
   * The accounts the periodic read covers (ADR-0059): each ready, assigned account whose derived
   * Workers draw on a declared pool, whose provider's `limitReadSeconds` is not 0, and whose runtime
   * reads a usage report (`limits`), once each.
   */
  private reportTargets(): ReportTarget[] {
    if (!this.derived) return []
    const targets = new Map<string, ReportTarget>()
    for (const [id, worker] of this.workers) {
      const account = worker.derived?.accountId
      if (account === undefined || worker.pool === undefined || targets.has(account)) continue
      const seconds = this.providerOf.get(worker.runtime)?.limitReadSeconds ?? DEFAULT_LIMIT_READ_SECONDS
      if (!seconds || typeof this.ctx.agentRuntimes.get(worker.runtime)?.limits !== 'function') continue
      if (this.agentAccounts.accountGate(account).state !== 'ready') continue
      targets.set(account, { account, runtime: worker.runtime, periodMs: seconds * 1000, read: () => this.periodicReport(id, worker) })
    }
    return [...targets.values()]
  }

  /** One periodic read of the account a derived Worker runs on, in its account's home, recorded as readings of its pool. Never rejects. */
  private async periodicReport(id: string, worker: WorkerSpec): Promise<void> {
    try {
      const provider = this.ctx.agentRuntimes.get(worker.runtime)
      const named = provider ? this.namedHome(worker, provider) : undefined
      if (!provider || (named && 'why' in named)) return
      const limits = await this.usageReport(worker, named?.home, 'its periodic read')
      const meter = limits?.length ? this.meter(id, worker) : undefined
      if (!meter) return
      await this.declareAccounts(meter.resources)
      await this.observe(id, worker, meter, limits!, true)
    } catch (error) {
      this.ctx.logger.warn(`agent Workers: the periodic read of ${accountOf(worker)}'s usage report failed, and nothing was recorded: ${(error as Error).message}`)
    }
  }

  /**
   * The usage report of the account a Worker runs on, read in `home` (its runtime's own when
   * undefined) through `readLimits`: bounded, aborted by a stop, and fail-closed (ADR-0059). Undefined
   * when its runtime reads none, or when the report cannot be read: that is logged and kept as the
   * account's last unread report (the roster shows why on a window with no reading yet), nothing is
   * recorded, and its windows keep their last readings.
   */
  private async usageReport(worker: WorkerSpec, home: string | undefined, when: 'its periodic read' | `after run ${string}`): Promise<LimitObservation[] | undefined> {
    const provider = this.ctx.agentRuntimes.get(worker.runtime)
    if (typeof provider?.limits !== 'function') return undefined
    const account = accountOf(worker)
    this.reports.noted(account)
    const report = await readLimits(provider, home !== undefined ? { home } : {}, this.stopped.signal)
    if ('limits' in report) {
      this.unreadReports.delete(account)
      return report.limits
    }
    if (this.stopped.signal.aborted) return undefined
    this.unreadReports.set(account, { why: report.unreadable, at: new Date().toISOString() })
    const message = `agent Workers: the usage report of ${account} (${when}) cannot be read, so nothing is recorded and its windows keep their last readings: ${report.unreadable}`
    // The periodic read says a standing problem once; a run's own read, each time.
    if (when === 'its periodic read') this.warnOnce(message)
    else this.ctx.logger.warn(message)
    return undefined
  }

  /**
   * Whether a `worktreePerRun` Worker's workspace can hold a worktree per run (the top level of a
   * git repository with a commit), checked at most once per `probeTtlMs`. A problem is a
   * configuration error: logged once, and the Worker takes no work.
   */
  private async repository(id: string, worker: AgentWorkerConfig): Promise<RepositoryCheck> {
    const cached = this.repositories.get(id)
    if (cached && Date.now() - cached.at < (this.config.probeTtlMs ?? 5 * 60_000)) return cached.check
    const check = await this.worktrees.check(worker.workspace)
    this.repositories.set(id, { at: Date.now(), check })
    if ('problem' in check) this.warnOnce(`agent Workers: ${id} works in a worktree per run, and ${check.problem} (config_error); it takes no work`)
    return check
  }

  /**
   * Where a run works: the configured workspace, or, for a run of a `worktreePerRun` Worker that
   * belongs to a workflow run, that run's own worktree, created on first use. Nothing has reached
   * the agent yet: a workspace that cannot be prepared fails the run unsubmitted.
   */
  private async workspaceOf(row: RunRow, worker: AgentWorkerConfig): Promise<string> {
    if (!worker.worktreePerRun) return worker.workspace
    const check = await this.repository(row.worker, worker)
    if ('problem' in check) throw new ProviderError('config_error', `${row.worker} works in a worktree per run, and ${check.problem}; nothing was run`)
    if (!row.workflow_run_id) return worker.workspace
    return this.worktrees.acquire(check.repository, row.workflow_run_id).catch((error: unknown) => {
      throw new ProviderError('config_error', `${row.worker}: the worktree of run ${row.workflow_run_id} cannot be prepared: ${(error as Error).message}; nothing was run`, { cause: error })
    })
  }

  /**
   * The workflow engine denies the call a Worker's gate deferred on approval request `requestId`,
   * for good in its session (docs/design/approvals.md#a-deferred-call): recorded on the request's
   * row, in the caller's transaction, with the engine's `recovery` decision `deny` and its cause.
   * Every later run of that session, in any workflow, is denied that exact call, whatever the queue
   * says of the request later and however long the event log keeps its events. False when no gate
   * of this source opened that request.
   */
  denyToolCall(requestId: string, denial: { decision: string; cause: string }): boolean {
    return recordDenial(this.ctx, requestId, denial)
  }

  /**
   * Retire the worktrees of finished workflow runs (INV-9): those whose agent runs have all
   * finished, the last more than `worktreeRetentionHours` before `at`, have their changes committed
   * on their branch and are removed; one that cannot be is left in place and tried again next
   * time. Runs hourly; a sweep already running is returned.
   */
  sweepWorktrees(at: number = Date.now()): Promise<SweepOutcome> {
    const hours = this.config.worktreeRetentionHours ?? 168
    if (!hours || this.stopped.signal.aborted) return Promise.resolve({ removed: [], kept: [] })
    if (this.sweeping) return this.sweeping
    const sweeping = this.worktrees.sweep(hours, at, this.stopped.signal).finally(() => {
      this.sweeping = undefined
    })
    this.sweeping = sweeping
    // A stop waits for it: a git command it started is bounded.
    const tracked = sweeping.then(() => undefined, () => undefined)
    this.inflight.add(tracked)
    void tracked.finally(() => this.inflight.delete(tracked))
    return sweeping
  }

  private sweepSafely(): void {
    this.sweepWorktrees().catch((error: unknown) => {
      this.ctx.logger.warn(`agent Workers: the worktree sweep failed; the next one tries again: ${(error as Error).message}`)
    })
  }

  /** `describe` runs on every route: a standing problem is logged once. */
  private warnOnce(message: string): void {
    if (this.warned.has(message)) return
    this.warned.add(message)
    this.ctx.logger.warn(message)
  }

  /**
   * What a Worker's runtime proves now, in the home its runs run in: a hand-named Worker's, its
   * runtime's own; a derived one's, its account's (none while the account is not ready, so nothing is
   * probed for it). For a describe (`described`, which waits only for the first probe there) or a
   * run's own check (`proven`, which waits for a result that stands); ./probes.ts.
   */
  private async evidence(worker: WorkerSpec, read: 'described' | 'proven'): Promise<RuntimeEvidence> {
    const provider = this.ctx.agentRuntimes.get(worker.runtime)
    if (!provider) return refused(`no ${worker.runtime} runtime is registered`)
    const home = this.namedHome(worker, provider)
    if (home && 'why' in home) return refused(home.why)
    return read === 'described' ? this.probes.described(worker.runtime, home?.home) : this.probes.proven(worker.runtime, home?.home)
  }

  /** Whether a named home is one a loaded derived Worker's runs run in now (its account ready): only those are probed in the background. */
  private runsIn(runtime: string, home: string): boolean {
    const provider = this.ctx.agentRuntimes.get(runtime)
    if (!provider) return false
    return [...this.workers.values()].some((worker) => {
      if (worker.runtime !== runtime) return false
      const named = this.namedHome(worker, provider)
      return named !== undefined && 'home' in named && named.home === home
    })
  }

  /**
   * The home a Worker's runs name (`RunSpec.home`): none for a hand-named Worker, or a derived one
   * whose account is in the runtime's own home (slot 1); else its account's. A derived Worker whose
   * account is not ready has none to run in: why.
   */
  private namedHome(worker: WorkerSpec, provider: AgentRuntimeProvider): { home: string } | { why: string } | undefined {
    if (!worker.derived) return undefined
    const gate = this.agentAccounts.accountGate(worker.derived.accountId)
    if (gate.state !== 'ready') return { why: gate.why }
    return gate.account.home === provider.home ? undefined : { home: gate.account.home }
  }

  /**
   * The confinement a run on an agent Worker is held to, for its brief (brief@1.x `sandbox`): the
   * configured sandbox in the workspace the run works in (with `worktreePerRun`, the workflow run's
   * own worktree), commands only where the runtime proved it confines them (`executes`) and the
   * workspace is writable, and network only as the egress policy and the run's tool gate allow.
   */
  private sandboxOf(id: string, runId: string | undefined): WorkerSandbox | undefined {
    const worker = this.workers.get(id)
    if (!worker) return undefined
    const workspace = worker.worktreePerRun && runId !== undefined && RUN_ID.test(runId) ? this.worktrees.pathOf(worker.workspace, runId) : worker.workspace
    // Only a result that still stands, in the home the run runs in, proves it; none (a derived
    // Worker's account not ready included), and the brief claims no commands.
    const provider = this.ctx.agentRuntimes.get(worker.runtime)
    const home = provider ? this.namedHome(worker, provider) : undefined
    const executes = !(home && 'why' in home) && this.probes.current(worker.runtime, home?.home)?.executes === true
    return { mode: worker.sandbox, workspace, network: 'allow-list', commands: worker.sandbox === 'workspace-write' && executes }
  }

  /** Accept a run on an admitted agent Worker: durable at once, idempotent by key. */
  private start(request: WorkerStart): WorkerExecution {
    const worker = this.workers.get(request.worker)
    if (!worker) throw new ProviderError('invalid_input', `${request.worker} is not an agent Worker`)
    // A hand-named Worker takes nothing new once the operator moved them to accounts × roles.
    const moved = worker.derived ? undefined : this.cutover.state()
    if (moved) throw new ProviderError('config_error', `${request.worker} is a hand-named Worker, and the operator moved them to accounts × roles (decision ${moved.decision}); nothing was started`)
    // A run of a workflow run on a Worker with a worktree per run writes the brief's files there (brief@1.2 files).
    const places = !!worker.worktreePerRun && request.runId !== undefined
    // A brief is rendered here, at start, its pointers resolved to their artifacts' text (INV-12).
    const { prompt, classification } = promptOfStart(request, (ref) => this.ctx.artifacts.get(ref), { placesFiles: places })
    if (!prompt.trim()) throw new ProviderError('invalid_input', 'prompt must not be empty')
    // It may name a branch and a directory (a worktree per run): letters, digits, `_`, and `-` only.
    if (request.runId !== undefined && !RUN_ID.test(request.runId)) throw new ProviderError('invalid_input', `run id ${JSON.stringify(request.runId)} must match ${RUN_ID}`)
    // The board task the brief serves, from the engine's own record (never from model text): the run's usage is recorded under it.
    const task = request.brief ? this.ctx.artifacts.get(request.brief)?.body as { taskId?: unknown; projectId?: unknown; files?: BriefFile[]; handbook?: unknown } | undefined : undefined
    const taskId = typeof task?.taskId === 'string' ? task.taskId : null
    // Who its handbook slice was selected for (brief@1.6), from the engine's record: its lessons follow it.
    const handbook = handbookSelection(task?.handbook)
    const projectId = taskId !== null && typeof task?.projectId === 'string' ? task.projectId : null
    // Its files' text, resolved now like the prompt, so the egress check reads what the agent will (INV-12).
    const files = places && Array.isArray(task?.files) && task.files.length ? JSON.stringify(task.files.map((file) => this.fileOf(file))) : null
    // The template step it serves, as the engine named it: kept only when both are ids.
    const step = request.step && DRAW_ID.test(request.step.template) && DRAW_ID.test(request.step.node) ? request.step : undefined
    // The tier it runs at (ADR-0073): the routed one, so its model is that tier's, kept with it, as its brief names it.
    const tier = this.tierOfStart(worker, request)
    const configuredModel = worker.tiers ? this.atTier(worker, tier).model ?? null : null
    const key = sha256(`agent\0${request.key}`)
    return this.ctx.store.transaction((db) => {
      const existing = db.prepare('SELECT * FROM agent_runs WHERE request_key = ?').get(key) as RunRow | undefined
      if (existing) {
        if (existing.prompt !== prompt) throw new ProviderError('invalid_input', 'the request key was reused with a different prompt')
        return execution(existing)
      }
      let generation: number | null = null
      if (request.sessionId) {
        db.prepare('INSERT OR IGNORE INTO agent_sessions (session_id, worker, native_handle, created_at) VALUES (?, ?, NULL, ?)').run(request.sessionId, request.worker, now())
        const session = db.prepare('SELECT worker, generation FROM agent_sessions WHERE session_id = ?').get(request.sessionId) as { worker: string; generation: number }
        if (session.worker !== request.worker) throw new ProviderError('invalid_input', `session ${request.sessionId} belongs to ${session.worker}, not ${request.worker}`)
        generation = session.generation
      }
      const row: RunRow = {
        run_id: newId(), request_key: key, worker: request.worker, session_id: request.sessionId ?? null, prompt,
        classification, status: 'queued', submitted_at: null, native_handle: null, result: null, error: null,
        workflow_run_id: request.runId ?? null, task_id: taskId, project_id: projectId, files,
        // The work it was admitted for, from the trusted requirement (INV-6): only a review member's step is ever replayed.
        scope: request.requirement.scope ?? null, session_generation: generation,
        // Its kind of work and template step, for what it draws (PROP-0015 E2): only well-formed ones, never guessed.
        kind: request.requirement.kind !== undefined && WORK_KIND.test(request.requirement.kind) ? request.requirement.kind : null,
        step_template: step?.template ?? null, step_node: step?.node ?? null, tier, configured_model: configuredModel,
        handbook: handbook ? JSON.stringify(handbook) : null,
        created_at: now(), updated_at: now(),
      }
      db.prepare(`INSERT INTO agent_runs (run_id, request_key, worker, session_id, prompt, classification, status, workflow_run_id, task_id, project_id, files, scope, session_generation, kind, step_template, step_node, tier, configured_model, handbook, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.run_id, key, row.worker, row.session_id, row.prompt, row.classification, row.workflow_run_id ?? null, taskId, projectId, files,
        row.scope ?? null, generation, row.kind ?? null, row.step_template ?? null, row.step_node ?? null, tier, configuredModel, row.handbook ?? null, row.created_at, row.updated_at)
      this.ctx.store.afterCommit(() => this.schedule(row.run_id))
      return execution(row)
    })
  }

  /** A brief's file as the run keeps it: its path, checked again, and its artifact's text; one not stored refuses the start, with nothing sent. */
  private fileOf(file: BriefFile): { path: string; text: string } {
    if (typeof file?.path !== 'string' || !BRIEF_FILE_PATH.test(file.path)) throw new ProviderError('invalid_input', `the brief names a file ${JSON.stringify(file?.path)} that is not under .system/; nothing was sent`)
    const stored = this.ctx.artifacts.get(file.ref)
    if (!stored || stored.body === undefined) throw new ProviderError('invalid_input', `the brief's file ${file.path} points at ${file.ref}, which is not stored here; nothing was sent`)
    return { path: file.path, text: bodyText(stored.body) }
  }

  private async wait(runId: string, timeoutMs: number): Promise<WorkerExecution> {
    const current = this.row(runId)
    if (!current) throw new ProviderError('invalid_input', `unknown agent run ${runId}`)
    if (current.status === 'completed' || current.status === 'failed' || this.stopped.signal.aborted) return execution(current)
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(runId) ?? new Set()
      this.waiters.set(runId, set)
      const wake = (): void => {
        clearTimeout(timer)
        set.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, timeoutMs)
      set.add(wake)
    })
    return execution(this.row(runId)!)
  }

  /** Cancel a run (REQ-WRK-4): a running agent is stopped, a queued run never starts. */
  private cancel(runId: string): boolean {
    const row = this.row(runId)
    if (!row || row.status === 'completed' || row.status === 'failed') return false
    const running = this.cancels.get(runId)
    if (running) {
      running.abort(new ProviderError('aborted', 'cancelled by the operator'))
      return true
    }
    const lease = this.ctx.leases.acquire(`agent-run:${runId}`, LEASE_TTL_MS)
    if (!lease) return false
    try {
      if (row.submitted_at) this.cancelStarted(row, () => lease)
      else this.fail(row, new ProviderError('aborted', 'cancelled by the operator'), () => lease)
    } finally {
      this.ctx.leases.release(lease)
    }
    return true
  }

  /**
   * The operator cancels a run that started and that no process holds now (between two liveness looks
   * after a restart, say): its agent cannot be stopped from here, and may still act (INV-4). It gets a
   * verdict first, as a reconciliation does (PROP-0013, ADR-0056): `dead` ends it as gone; any other
   * verdict ends it not known to be gone, so its session and worktree stay held until the operator
   * frees them (INV-15). Either way it fails `aborted`, its decision on it, and is never run again.
   */
  private cancelStarted(row: RunRow, lease: () => Lease): void {
    const liveness = this.livenessOf(row)
    const looks = row.liveness_looks ?? 0
    const decision = this.reconciled(row, liveness, looks, 'cancel')
    const dead = liveness.verdict === 'dead'
    this.fail(row, new ProviderError('aborted', dead
      ? `cancelled by the operator; it had started, and it is gone (liveness dead, decision ${decision})`
      : `cancelled by the operator; it had started, no process holds it, and it is not known to be gone (liveness ${liveness.verdict}: ${liveness.reasons.join('; ')}; decision ${decision}), so its session and worktree stay held: system free ${row.run_id} --agent-gone, once its agent is gone`),
    lease, { liveness_looks: looks, liveness_verdict: liveness.verdict, liveness_decision: decision })
    if (!dead) this.toldUnknown(row, liveness.verdict, looks, decision, 'cancel')
    // Its usage is not invented, as for a run reconciled after a restart; its reservation is released.
    if (row.reservation_id) {
      this.interruptedUsage(row)
      const released = this.release(row.worker, row.reservation_id)
      this.inflight.add(released)
      void released.finally(() => this.inflight.delete(released))
    }
  }

  /**
   * The runs of this source whose liveness needs the operator's look (PROP-0013, ADR-0056), from its
   * durable facts: `unknown`, ended without being known to be gone and not freed (what they ran in
   * stays held); `looking`, started, their holder gone, verdicts being taken; `stalled`, running with
   * a stall reported. At most {@link MAX_LIVENESS_RUNS}, the latest first, with the counts of all.
   */
  private async liveness(query: LivenessQuery = {}): Promise<LivenessReport> {
    const state = `CASE WHEN status = 'failed' THEN 'unknown' WHEN COALESCE(liveness_looks, 0) > 0 THEN 'looking' ELSE 'stalled' END`
    const where = [
      `((status = 'failed' AND ${notKnownGone('')}) OR (status = 'running' AND submitted_at IS NOT NULL AND (COALESCE(liveness_looks, 0) > 0 OR stalled_at IS NOT NULL)))`,
      ...(query.runId !== undefined ? ['workflow_run_id = ?'] : []), ...(query.execution !== undefined ? ['run_id = ?'] : []),
    ].join(' AND ')
    const params = [...(query.runId !== undefined ? [query.runId] : []), ...(query.execution !== undefined ? [query.execution] : [])]
    const db = this.ctx.store.db
    const counts: Record<LivenessState, number> = { unknown: 0, looking: 0, stalled: 0 }
    for (const c of db.prepare(`SELECT ${state} AS state, COUNT(*) AS n FROM agent_runs WHERE ${where} GROUP BY 1`).all(...params) as Array<{ state: LivenessState; n: number }>) counts[c.state] = c.n
    const rows = db.prepare(`SELECT *, ${state} AS state FROM agent_runs WHERE ${where} ORDER BY updated_at DESC, run_id LIMIT ?`).all(...params, MAX_LIVENESS_RUNS) as unknown as Array<RunRow & { state: LivenessState }>
    return { runs: rows.map((row) => this.livenessView(row, row.state)), counts }
  }

  /** One run as {@link liveness} tells it: since when, the verdict and the looks, why, what it holds, and what the operator can do. */
  private livenessView(row: RunRow, state: LivenessState): RunLiveness {
    const max = this.config.maxUnknownVerdicts ?? 3
    const holds = this.holdsOf(row)
    const base = { execution: row.run_id, worker: row.worker, state, holds, ...(row.workflow_run_id ? { runId: row.workflow_run_id } : {}), ...(row.session_id ? { sessionId: row.session_id } : {}) }
    const verdict = row.liveness_verdict ? { verdict: `${row.liveness_verdict} (${LIVENESS_RULE.id}@${LIVENESS_RULE.version})` } : {}
    if (state === 'unknown') {
      const decided = row.liveness_decision ? this.ctx.artifacts.get(row.liveness_decision)?.body as { candidates?: Array<{ option: string; reasons: string[] }> } | undefined : undefined
      const reasons = decided?.candidates?.find((c) => c.option === 'dead')?.reasons.filter((r) => !r.startsWith('not dead:'))
      return {
        ...base, since: row.updated_at, ...verdict, looks: { taken: row.liveness_looks ?? 0, max },
        reasons: reasons?.length ? reasons : [`its decision ${row.liveness_decision} is not stored here`],
        decision: row.liveness_decision as ArtifactRef,
        action: `${holds.length ? `it holds ${holds.join(' and ')}: ` : ''}confirm that no process of its agent runs (its holder and agent process, among the reasons), then free it: system free ${row.run_id} --agent-gone (${RUNBOOK})`,
      }
    }
    if (state === 'looking') {
      const now = this.livenessOf(row, { state: 'unknown', why: 'not read for this listing' })
      const taken = row.liveness_looks ?? 0
      return {
        ...base, since: row.updated_at, ...verdict, looks: { taken, max }, reasons: now.reasons,
        action: `nothing yet: its holder stopped, and it is looked at again (${taken} of ${max} verdicts); found gone, it fails, else it reaches you as unknown`,
      }
    }
    const quiet = row.activity_at ?? row.submitted_at ?? row.updated_at
    return {
      ...base, since: row.stalled_at ?? row.updated_at,
      reasons: [`the agent process: ${describeProbe(probeProcess(processIdentityOf(parsed(row.agent_process))))}`, `activity: none recorded since ${quiet}`, `stalled: quiet for ${this.bounds().stallSeconds} s or more`],
      action: `nothing is sent to it and nothing stops it: its own deadline (${Math.round((this.config.runTimeoutMs ?? 15 * 60_000) / 1000)} s) or turn limit ends it${row.workflow_run_id ? `; to stop it now: system stop ${row.workflow_run_id}` : ''}`,
    }
  }

  /** What a run holds while it is not known to be gone: its session, and its workflow run's worktrees, in words. */
  private holdsOf(row: RunRow): string[] {
    const worker = this.workers.get(row.worker)
    return [
      ...(row.session_id ? [`session ${row.session_id}`] : []),
      ...(worker?.worktreePerRun && row.workflow_run_id ? this.worktrees.of(row.workflow_run_id).map((w) => `worktree ${w.path} (branch ${w.branch})`) : []),
    ]
  }

  /**
   * The operator frees what an agent run that ended without being known to be gone holds: its
   * session, and, for a Worker with a worktree per run, its workflow run's worktree (PROP-0013,
   * ADR-0056; INV-15). Only on the operator's word that its agent is gone (`agentGone`), recorded
   * first as their `reconciliation` decision (INV-13), with the signals as this host shows them now.
   * Refused, changing nothing (INV-2): a run that holds nothing; while it, or another started run of
   * its session or worktree, has not finished (its liveness is still being looked at); while a
   * process holds its lease; and while its holder or its agent process is present on this host. A
   * worktree is removed only while nothing else of its workflow run is unfinished or held, and only
   * when it holds nothing uncommitted, or, with `commitWorktree`, once its changes are committed on
   * its branch; the branch always stays. A run already freed may be freed again for its worktree.
   */
  async free(input: { agentRun: string; agentGone: boolean; commitWorktree?: boolean; note?: string }): Promise<FreeOutcome> {
    if (input.agentGone !== true) throw new ProviderError('invalid_input', 'freeing a run is your word that its agent is gone: confirm it (agentGone; system free --agent-gone) once no process of it runs; nothing was freed')
    const row = this.row(input.agentRun)
    if (!row) throw new ProviderError('invalid_input', `no agent run ${input.agentRun}; nothing was freed`)
    const max = this.config.maxUnknownVerdicts ?? 3
    if (row.status === 'queued' || row.status === 'running') {
      throw new ProviderError('invalid_input', row.submitted_at && (row.liveness_looks ?? 0) > 0
        ? `${row.run_id}'s liveness is still being looked at (${row.liveness_looks} of ${max} verdicts): wait for it to fail as gone or reach you as unknown; nothing was freed`
        : `${row.run_id} has not finished (${row.status}); nothing was freed`)
    }
    if (!row.liveness_decision || row.liveness_verdict === 'dead') throw new ProviderError('invalid_input', `${row.run_id} ${row.status === 'completed' ? 'completed' : row.liveness_decision ? 'was found gone (liveness dead)' : 'ended with its agent stopped by its holder'}, so it holds nothing to free; nothing was freed`)
    const worker = this.workers.get(row.worker)
    const worktrees = !!worker?.worktreePerRun && !!row.workflow_run_id
    // Another run started in what it held, and not finished: its liveness is looked at, or it runs.
    const other = this.ctx.store.db.prepare(`SELECT run_id, status, liveness_looks FROM agent_runs WHERE run_id != ? AND status IN ('queued', 'running') AND submitted_at IS NOT NULL
      AND (session_id = ? OR (? AND workflow_run_id = ?)) LIMIT 1`).get(row.run_id, row.session_id, worktrees ? 1 : 0, row.workflow_run_id ?? null) as { run_id: string; status: string; liveness_looks: number | null } | undefined
    if (other) {
      throw new ProviderError('invalid_input', `run ${other.run_id}, in the same ${row.session_id ? 'session or ' : ''}worktree, ${(other.liveness_looks ?? 0) > 0 ? 'is still being looked at' : 'is running'}: wait for it to end; nothing was freed`)
    }
    const commit = input.commitWorktree === true
    // What freeing does to its worktrees, read before anything is decided (git; bounded).
    const plans = worktrees ? await this.worktrees.plan(row.workflow_run_id!, commit, row.run_id) : []
    // Freed already, it is asked again for its worktree only: with none left, nothing is decided.
    if (row.liveness_freed && !plans.length) throw new ProviderError('invalid_input', `${row.run_id} was freed already (decision ${row.liveness_freed}), and no worktree of it is left; nothing was freed`)
    const lease = this.ctx.leases.acquire(`agent-run:${row.run_id}`, LEASE_TTL_MS)
    if (!lease) throw new ProviderError('invalid_input', `a process holds ${row.run_id} now; nothing was freed`)
    let decision: ContentId
    const again = !!row.liveness_freed
    const holds = this.holdsOf(row)
    try {
      const current = this.row(row.run_id)!
      if (current.liveness_freed !== row.liveness_freed || current.status !== row.status) throw new ProviderError('invalid_input', `${row.run_id} changed while it was being freed; nothing was freed, try again`)
      // The holder or the agent process present on this host: it is not gone, whatever the operator saw.
      const holder = this.holderProbe(row)
      const agent = probeProcess(processIdentityOf(parsed(row.agent_process)))
      if (holder.state === 'present' || agent.state === 'present') {
        throw new ProviderError('invalid_input', `${row.run_id}'s ${holder.state === 'present' ? 'holder' : 'agent process'} is present on this host, so its agent is not gone; nothing was freed`)
      }
      const note = input.note?.trim().slice(0, 1000)
      decision = this.ctx.artifacts.recordDecision({
        decisionType: 'reconciliation',
        question: `Is what agent run ${row.run_id} on ${row.worker} holds${holds.length ? ` (${holds.join(', ')})` : ''} freed, on the operator's word that its agent is gone?`,
        inputs: [],
        candidates: [
          {
            option: 'free', selected: true,
            reasons: [
              `the operator confirms its agent is gone${note ? `: ${note}` : ''}`,
              again ? `it was freed already (decision ${row.liveness_freed}): only its worktree is looked at again` : `it ended without being known to be gone (liveness ${row.liveness_verdict ?? 'unknown'}, decision ${row.liveness_decision})`,
              `as this host shows them now: the holder's process ${describeProbe(holder)}; the agent process ${describeProbe(agent)}`,
              ...plans.map((p) => `worktree ${p.path}: ${p.why}`),
            ],
          },
          { option: 'keep', selected: false, reasons: ['not kept: no process holds the run, neither its holder nor its agent process is present on this host, and the operator confirms its agent is gone'] },
        ],
        decider: FREE_DECIDER,
        outcome: {
          option: 'free',
          detail: {
            agentRun: row.run_id, worker: row.worker, ...(row.session_id ? { sessionId: row.session_id } : {}), verdict: row.liveness_verdict ?? 'unknown', reconciliation: row.liveness_decision, again, commitWorktree: commit,
            worktrees: plans.map((p) => ({ path: p.path, branch: p.branch, outcome: p.outcome })),
          },
        },
        ...(note ? { rationale: note } : {}),
        deterministic: false,
      }, { producer: { type: 'operator', ref: 'operator' }, ...(row.workflow_run_id ? { runId: row.workflow_run_id } : {}), classification: row.classification as Classification }).id as ContentId
      // Fenced like every write of a run: freed once, by the decision first recorded; a later one is about its worktree only.
      if (!again) this.update(row.run_id, { liveness_freed: decision }, () => lease)
    } finally {
      this.ctx.leases.release(lease)
    }
    try {
      this.ctx.get('eventLog')?.append({
        type: FREED_EVENT, ...(row.workflow_run_id ? { runId: row.workflow_run_id } : {}), ...(row.session_id ? { sessionId: row.session_id } : {}), decision,
        data: { agentRun: row.run_id, worker: row.worker, again, worktrees: plans.length },
      })
    } catch (error) {
      this.ctx.logger.warn(`agent Workers: that the operator freed ${row.run_id} was not appended: ${(error as Error).message}`)
    }
    const released = plans.length ? await this.worktrees.release(row.workflow_run_id!, decision, commit, plans, row.run_id) : []
    this.ctx.logger.info(`agent Workers: the operator freed ${row.run_id} on ${row.worker}${again ? ' again' : ''} (decision ${decision})${released.length ? `; ${released.map((w) => `${w.path} ${w.outcome}`).join(', ')}` : ''}`)
    return { agentRun: row.run_id, worker: row.worker, decision, again, freed: again ? [] : holds, worktrees: released }
  }

  /**
   * The workflow runs' worktrees not removed (D12): each with its state (in use, held, or finished),
   * what it holds, and when the retention removes it; at most `limit` (default and most 100), oldest
   * first, and how many there are in all (`agent_worktrees`, `system worktrees`).
   */
  async runWorktrees(input: { limit?: number } = {}): Promise<WorktreeListing> {
    const limit = input.limit ?? MAX_LISTED_WORKTREES
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LISTED_WORKTREES) throw new ProviderError('invalid_input', `limit is a whole number from 1 to ${MAX_LISTED_WORKTREES}`)
    const retentionHours = this.config.worktreeRetentionHours ?? 168
    return { retentionHours, ...await this.worktrees.list(retentionHours, limit) }
  }

  /**
   * The operator removes finished worktrees now instead of waiting for the retention (D12), every one
   * or those of one workflow run (`runId`): a worktree is removed only while no agent run of its
   * workflow run is unfinished or ended without being known to be gone, and only when it holds
   * nothing uncommitted, or, with `commitChanges`, once its changes are committed on its branch, as
   * the retention does: nothing is ever discarded, and the branch always stays. Recorded first as the
   * operator's `retention` decision (INV-13), naming each worktree planned; with none to remove,
   * nothing is decided. `check` sees the output the plan would give before anything is decided: one
   * that throws decides and removes nothing. At most 50 worktrees a call (the sweep's batch; INV-9).
   */
  async removeWorktrees(input: { runId?: string; commitChanges?: boolean; note?: string } = {}, check?: (planned: WorktreeRemoval) => void): Promise<WorktreeRemoval> {
    if (input.runId !== undefined && !RUN_ID.test(input.runId)) throw new ProviderError('invalid_input', `${String(input.runId).slice(0, 80)} is not a workflow run id; nothing was removed`)
    const commit = input.commitChanges === true
    const { plans, more } = await this.worktrees.planRemoval(input.runId, commit)
    const removing = plans.filter((p) => p.outcome === 'remove')
    // What the call would answer if every planned removal went through: checked before anything is decided.
    check?.({ worktrees: plans.map((p) => (p.outcome === 'remove' ? { ...p, outcome: 'removed' } : p)), more })
    if (!removing.length) return { worktrees: plans, more }
    const note = input.note?.trim().slice(0, 1000)
    const decision = this.ctx.artifacts.recordDecision({
      schema: 'decision@1.3', decisionType: 'retention',
      question: `Are ${removing.length} finished run worktree(s) removed now, on the operator's word, before the retention would?`,
      inputs: [],
      candidates: [
        { option: 'remove', selected: true, reasons: removalReasons(`the operator asked to remove the finished worktrees${input.runId ? ` of workflow run ${input.runId}` : ''}${note ? `: ${note}` : ''}`, removing) },
        { option: 'keep', selected: false, reasons: ['not kept: no agent run of their workflow runs is unfinished or held, and each holds nothing uncommitted or has its changes committed on its branch first, so nothing is lost; the branch stays'] },
      ],
      decider: WORKTREES_DECIDER,
      outcome: { option: 'remove', detail: { commitChanges: commit, ...(input.runId ? { runId: input.runId } : {}), worktrees: removing.map((p) => ({ runId: p.runId, path: p.path, branch: p.branch })) } },
      ...(note ? { rationale: note } : {}),
      deterministic: false,
    }, { producer: { type: 'operator', ref: 'operator' }, ...(input.runId ? { runId: input.runId } : {}), classification: 'operator-shared' }).id as ContentId
    const done: RunWorktreeRelease[] = []
    for (const runId of new Set(plans.map((p) => p.runId))) {
      const ofRun = plans.filter((p) => p.runId === runId)
      for (const released of await this.worktrees.release(runId, decision, commit, ofRun, null)) done.push({ runId, ...released })
    }
    this.ctx.logger.info(`agent Workers: the operator removed finished worktrees (decision ${decision}): ${done.map((w) => `${w.path} ${w.outcome}`).join(', ')}`)
    return { decision, worktrees: done, more }
  }

  private recover(): void {
    if (this.stopped.signal.aborted) return
    const rows = this.ctx.store.db.prepare("SELECT run_id FROM agent_runs WHERE status IN ('queued', 'running') ORDER BY created_at").all() as Array<{ run_id: string }>
    for (const { run_id } of rows) this.schedule(run_id)
  }

  /** Look again later: a lease held elsewhere expires, a lost one is retaken (a started run then fails, INV-4). */
  private retryLater(runId: string, delayMs: number): void {
    if (this.stopped.signal.aborted) return
    const timer = setTimeout(() => {
      this.retries.delete(timer)
      this.schedule(runId)
    }, delayMs)
    timer.unref()
    this.retries.add(timer)
  }

  /** The liveness bounds, from configuration (INV-9). */
  private bounds(): { stallSeconds: number; deadAfterSeconds: number } {
    return { stallSeconds: this.config.stallSeconds ?? 300, deadAfterSeconds: this.config.deadAfterSeconds ?? 120 }
  }

  /**
   * The verdict on a started run whose lease this process has just taken (PROP-0013, ADR-0056): the
   * holder's lease lapsed (it could be taken: expired or released), the holder's process and the
   * agent process as this host shows them now, and the latest activity recorded (its submission at
   * least). A signal never recorded, as on a run from before this was kept, is unknown.
   */
  private livenessOf(row: RunRow, lease: LeaseProbe = { state: 'lapsed', why: 'this process took it, so it had expired or was released' }): Liveness {
    const activity = [row.submitted_at, row.activity_at].map((t) => (t ? Date.parse(t) : Number.NaN)).filter(Number.isFinite)
    return livenessOf({
      at: Date.now(),
      holder: { lease, process: this.holderProbe(row) },
      runtime: probeProcess(processIdentityOf(parsed(row.agent_process))),
      lastActivityAt: activity.length ? Math.max(...activity) : undefined,
    }, this.bounds())
  }

  /**
   * A started run whose runtime this source's own stop ended (T283): marked before the source
   * stopped, so only a stop of the host (a drain, shutdown, update) marks it, never a crash, a lost
   * lease, the operator's cancel, or an agent that died on its own. It runs again unless its Worker is
   * gone, it was cut more than {@link MAX_RESUMES} times (INV-9), or an agent process of it is still
   * present on this host (it may be acting: the liveness verdict takes it, INV-4).
   */
  private cutByHost(row: RunRow): boolean {
    if (!row.host_stopped_at || (row.resumes ?? 0) >= MAX_RESUMES || !this.workers.has(row.worker)) return false
    return probeProcess(processIdentityOf(parsed(row.agent_process))).state !== 'present'
  }

  /**
   * Mark a run that was in flight when this source stopped: its runtime was ended by that stop, and
   * the next start runs it again (T283). A run the operator cancelled, or one that is not started or
   * is over, is not marked. A mark that cannot be written leaves the run as a crash would, and is logged.
   */
  private markCut(runId: string, lease: () => Lease): void {
    try {
      const row = this.row(runId)
      if (!row || !row.submitted_at || row.status !== 'running' || this.cancels.get(runId)?.signal.aborted) return
      this.update(runId, { host_stopped_at: now() }, lease)
    } catch (error) {
      this.ctx.logger.warn(`agent Workers: ${runId} was in flight when this source stopped, and that could not be recorded, so its next start reconciles it as a run its holder lost: ${(error as Error).message}`)
    }
  }

  /**
   * What a run the host cut is sent when it runs again (T283). Its own native conversation continued,
   * told only to go on, when its runtime resumes one and the run's own handle was recorded: only then
   * is its prompt in that conversation. Otherwise its own prompt is sent again, with a note that
   * earlier work may be in the worktree, exactly as the run would be sent anew: continuing its
   * session's conversation (`session`, an earlier run's) where the runtime resumes one, else in a
   * fresh one. Its task is never left out. Nothing is failed: the run keeps its id, step, and attempt.
   */
  private async againAfterCut(row: RunRow, worker: AgentWorkerConfig, turn: Turn): Promise<{ turn: Turn; how: 'resumed' | 'restarted'; handle?: string; session?: string }> {
    const evidence = await this.evidence(worker, 'proven')
    if (evidence.resume && row.native_handle) return { turn: { ...turn, prompt: RESUME_PROMPT, resume: row.native_handle }, how: 'resumed', handle: row.native_handle }
    // `turn.resume` is set only where the runtime resumes (turnOf): the session's own conversation, never this run's.
    return { turn: { ...turn, prompt: `${turn.prompt}${RESTART_NOTE}` }, how: 'restarted', ...(turn.resume ? { session: turn.resume } : {}) }
  }

  /**
   * Record that a run the host cut runs again, before it is sent (T283): a `reconciliation` decision
   * on the run (INV-13), its count of cuts, an `agent-workers.run.resumed` event, and a log line.
   * Returns its count of cuts, which its usage record names (`account`).
   */
  private noteAgain(row: RunRow, again: { how: 'resumed' | 'restarted'; handle?: string; session?: string }, lease: () => Lease): number {
    const resumes = (row.resumes ?? 0) + 1
    const was = `${row.worker} was running this task when this source stopped (the host's drain, shutdown, or update: recorded at ${row.host_stopped_at}), its runtime was ended by that stop, and no agent process of it is present`
    const restart = again.session
      ? `its own conversation was never recorded (the stop came before its runtime reported it), so its prompt is sent again, in the same worktree, continuing its session's conversation ${again.session} as any later turn of the session does`
      : 'it has no native conversation of its own to continue: it starts again from the same worktree with its prompt'
    const decision = this.ctx.artifacts.recordDecision({
      decisionType: 'reconciliation',
      question: `Does agent run ${row.run_id} on ${row.worker}, which the host's own stop cut while it ran, run again?`,
      inputs: [],
      candidates: [
        { option: 'resume', selected: again.how === 'resumed', reasons: again.how === 'resumed' ? [was, `its runtime resumes a conversation: it continues native session ${again.handle}, in the same workspace`] : ['not resume: its runtime cannot resume, or its own native conversation was never recorded, so its prompt may be in none'] },
        { option: 'restart', selected: again.how === 'restarted', reasons: again.how === 'restarted' ? [was, restart] : ['not restart: it continues its own native conversation, which holds its prompt'] },
        { option: 'fail', selected: false, reasons: [`not fail: only its host's stop cut it (not its agent, a lost lease, or the operator), so it is not reconciled as lost and costs no attempt; cut ${resumes} of at most ${MAX_RESUMES} times (INV-9)`] },
      ],
      decider: RESUME_RULE,
      outcome: { option: again.how === 'resumed' ? 'resume' : 'restart', detail: { agentRun: row.run_id, worker: row.worker, resumes, max: MAX_RESUMES, ...(again.handle ? { nativeHandle: again.handle } : {}), ...(again.session ? { sessionHandle: again.session } : {}) } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'agent-workers' }, ...(row.workflow_run_id ? { runId: row.workflow_run_id } : {}), classification: row.classification as Classification }).id as ContentId
    this.update(row.run_id, { resumes, resume_decision: decision }, lease)
    this.ctx.logger.info(`agent Workers: ${row.run_id} on ${row.worker} was cut by the host's stop and ${again.how === 'resumed' ? `resumes native session ${again.handle}` : `starts again in its worktree with its prompt${again.session ? `, in its session's conversation ${again.session}` : ''}`} (cut ${resumes} of at most ${MAX_RESUMES}); decision ${decision}`)
    try {
      this.ctx.get('eventLog')?.append({
        type: RESUMED_EVENT, ...(row.workflow_run_id ? { runId: row.workflow_run_id } : {}), ...(row.workflow_run_id && row.step_node ? { nodeId: row.step_node } : {}), ...(row.session_id ? { sessionId: row.session_id } : {}), decision,
        data: { agentRun: row.run_id, worker: row.worker, how: again.how, resumes, ...(row.step_node ? { step: row.step_node } : {}), ...(again.handle ? { nativeHandle: again.handle } : {}), ...(again.session ? { sessionHandle: again.session } : {}) },
      })
    } catch (error) {
      this.ctx.logger.warn(`agent Workers: that ${row.run_id} ran again after the host's stop was not appended: ${(error as Error).message}`)
    }
    return resumes
  }

  /** The process that held a run: when it is this one, gone only once this process runs no agent of the run; else as this host shows it. */
  private holderProbe(row: RunRow): ProcessProbe {
    const recorded = processIdentityOf(parsed(row.holder))
    const self = currentProcess()
    if (recorded && self && recorded.host === self.host && recorded.boot === self.boot && recorded.pid === self.pid && recorded.startTicks === self.startTicks) {
      return executing.has(row.run_id) ? { state: 'present' } : { state: 'gone', why: 'it is this process, which runs no agent of this run now' }
    }
    return probeProcess(recorded)
  }

  /**
   * The `reconciliation` decision that ends a started run its holder no longer holds (INV-4, INV-13):
   * the verdict and every signal behind it. `cancel`: the operator cancelled it while no process held
   * it, so it ends now whatever the verdict, and only `dead` frees what it held.
   */
  private reconciled(row: RunRow, liveness: Liveness, looks: number, cause: 'holder' | 'cancel' = 'holder'): ContentId {
    const dead = liveness.verdict === 'dead'
    const max = this.config.maxUnknownVerdicts ?? 3
    const operator = cause === 'cancel'
      ? 'the operator cancelled it, and no process holds it, so it ends now; it is not known to be gone, so its session and worktree stay held until the operator frees them'
      : `${looks} verdicts in a row, none dead (at most ${max}): a failed probe is never death, so it goes to the operator, and its session stays held`
    return this.ctx.artifacts.recordDecision({
      decisionType: 'reconciliation',
      question: cause === 'cancel'
        ? `Is agent run ${row.run_id} on ${row.worker}, which started and which the operator cancelled while no process held it, gone?`
        : `Is agent run ${row.run_id} on ${row.worker}, which started and which its holder no longer holds, gone?`,
      inputs: [],
      candidates: [
        { option: 'dead', selected: dead, reasons: dead ? liveness.reasons : [`not dead: the verdict is ${liveness.verdict}, and only dead is death`, ...liveness.reasons] },
        {
          option: 'operator', selected: !dead,
          reasons: dead ? ['not the operator\'s: it is positively gone, so it fails and is never run again'] : [operator],
        },
      ],
      decider: RECONCILE_RULE,
      outcome: {
        option: dead ? 'dead' : 'operator',
        detail: { agentRun: row.run_id, worker: row.worker, verdict: liveness.verdict, rule: `${LIVENESS_RULE.id}@${LIVENESS_RULE.version}`, looks, ...this.bounds(), ...(cause === 'cancel' ? { cause } : {}) },
      },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'agent-workers' }, ...(row.workflow_run_id ? { runId: row.workflow_run_id } : {}), classification: row.classification as Classification }).id as ContentId
  }

  /**
   * Tell the event log that a run ended without being known to be gone (`agent-workers.run.unknown`):
   * what it holds stays held until the operator frees it. Appended after the run's state is committed;
   * one that cannot be appended is logged, and the run's state is the fact.
   */
  private toldUnknown(row: RunRow, verdict: string, looks: number, decision: ContentId, cause: 'holder' | 'cancel'): void {
    try {
      this.ctx.get('eventLog')?.append({
        type: UNKNOWN_EVENT, ...(row.workflow_run_id ? { runId: row.workflow_run_id } : {}), ...(row.session_id ? { sessionId: row.session_id } : {}), decision,
        data: { agentRun: row.run_id, worker: row.worker, verdict, looks, cause, rule: `${LIVENESS_RULE.id}@${LIVENESS_RULE.version}` },
      })
    } catch (error) {
      this.ctx.logger.warn(`agent Workers: that ${row.run_id} ended not known to be gone was not appended: ${(error as Error).message}`)
    }
  }

  /**
   * Why a session of this source takes no input now (PROP-0013, ADR-0056), derived when asked from
   * durable facts, never stored as a flag: its latest run has not finished; or it ended without being
   * known to be gone; or it stopped on a tool call whose approval request is still open (asked of the
   * queue: none loaded, or unreadable, and it cannot be shown free). Undefined when the session is
   * free, or not this source's.
   */
  private async held(sessionId: string): Promise<string | undefined> {
    const db = this.ctx.store.db
    if (!db.prepare('SELECT 1 FROM agent_sessions WHERE session_id = ?').get(sessionId)) return undefined
    const latest = db.prepare('SELECT * FROM agent_runs WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(sessionId) as RunRow | undefined
    if (!latest) return undefined
    if (latest.status !== 'failed' && latest.status !== 'completed') return `its latest run ${latest.run_id} has not finished (${latest.status}), and one native session is driven by one run at a time`
    // Any run of it that ended without being known to be gone, the latest or one a later run was refused after.
    const alive = db.prepare(`SELECT run_id, liveness_verdict, liveness_decision FROM agent_runs WHERE session_id = ? AND ${notKnownGone('')} LIMIT 1`)
      .get(sessionId) as { run_id: string; liveness_verdict: string | null; liveness_decision: string } | undefined
    if (alive) return `its run ${alive.run_id} ended without being known to be gone (liveness ${alive.liveness_verdict ?? 'unknown'}, decision ${alive.liveness_decision}), so its agent may still be running; the operator frees it once its agent is gone (system free ${alive.run_id} --agent-gone)`
    if (latest.status === 'completed') return undefined
    const request = this.deferredOn(latest)
    if (!request) return undefined
    const waits = `its latest run ${latest.run_id} stopped on a tool call that waits for approval request ${request}`
    const approvals = this.ctx.get('approvals')
    if (!approvals) return `${waits}, and no approval queue is loaded to tell whether it is still open`
    let state: string | undefined
    try {
      state = (await approvals.get(request))?.state
    } catch (error) {
      return `${waits}, which cannot be read now (${(error as Error).message.slice(0, 200)})`
    }
    if (state === undefined) return `${waits}, which the approval queue does not hold`
    if (state === 'open' || state === 'batched') return `${waits}, still ${state}: the session takes no input but that request's resolution`
    return undefined
  }

  /**
   * The approval request a failed run's gate deferred a call on, if any: as the run records it, or,
   * for a run from before that was recorded, as the gate's `agent-workers.tool.deferred` event of it names it.
   */
  private deferredOn(row: RunRow): string | undefined {
    if (row.deferred_request) return row.deferred_request
    if (!row.submitted_at || !row.session_id || !row.error?.includes('"config_error"')) return undefined
    const event = this.ctx.get('eventLog')?.query({ type: 'agent-workers.tool.deferred', sessionId: row.session_id, limit: 1000 })
      .filter((e) => e.data?.['agentRun'] === row.run_id && typeof e.data['requestId'] === 'string').at(-1)
    return event ? String(event.data!['requestId']) : undefined
  }

  /**
   * What a running agent reports of itself (PROP-0013): its process, recorded once, and its activity,
   * recorded at most once per beat (a bounded write rate), each write fenced by the run's lease. At
   * each beat a run whose process is present and that has been quiet for `stallSeconds` is `stalled`:
   * reported once per stall (`agent-workers.run.stalled`), never prodded or stopped; the run's own
   * deadline and turn limit end it. A record that cannot be written is logged and changes nothing.
   */
  private watch(row: RunRow, lease: () => Lease): { observer: RunObserver; stop: () => void } {
    let last = Date.now()
    let written = last
    let agent: ProcessIdentity | undefined
    let reported = false
    let stalled = false
    let warned = false
    const write = (fields: Partial<Omit<RunRow, 'run_id'>>): void => {
      try {
        this.update(row.run_id, fields, lease)
      } catch (error) {
        if (!warned) this.ctx.logger.warn(`agent Workers: what ${row.run_id} on ${row.worker} reports of its agent could not be recorded: ${(error as Error).message}`)
        warned = true
      }
    }
    const observer: RunObserver = {
      onProcess: ({ pid }) => {
        if (reported) return
        reported = true
        agent = processIdentity(pid)
        if (agent) write({ agent_process: JSON.stringify(agent) })
        else this.ctx.logger.warn(`agent Workers: the agent process ${pid} of ${row.run_id} could not be read as it started; its liveness stays unknown`)
      },
      onActivity: (at) => {
        if (!Number.isFinite(at) || at <= last) return
        last = at
        if (stalled) {
          // Active again: this stall is over, and a later one is reported anew.
          stalled = false
          written = last
          write({ stalled_at: null, activity_at: new Date(last).toISOString() })
        } else if (last - written >= BEAT_MS) {
          written = last
          write({ activity_at: new Date(last).toISOString() })
        }
      },
    }
    const beat = setInterval(() => {
      if (last > written) {
        written = last
        write({ activity_at: new Date(last).toISOString() })
      }
      if (stalled) return
      const liveness = livenessOf({
        at: Date.now(), holder: { lease: { state: 'live' }, process: { state: 'present' } }, runtime: agent ? probeProcess(agent) : { state: 'unknown', why: 'never reported' }, lastActivityAt: last,
      }, this.bounds())
      if (liveness.verdict !== 'stalled') return
      stalled = true
      write({ stalled_at: now() })
      this.ctx.logger.warn(`agent Workers: ${row.run_id} on ${row.worker} is stalled (${liveness.reasons.join('; ')}); nothing is sent to it, and its own deadline ends it`)
      try {
        this.ctx.get('eventLog')?.append({
          type: 'agent-workers.run.stalled', ...(row.workflow_run_id ? { runId: row.workflow_run_id } : {}), ...(row.session_id ? { sessionId: row.session_id } : {}),
          data: { agentRun: row.run_id, worker: row.worker, quietSeconds: Math.floor((Date.now() - last) / 1000), stallSeconds: this.bounds().stallSeconds, rule: `${LIVENESS_RULE.id}@${LIVENESS_RULE.version}` },
        })
      } catch (error) {
        this.ctx.logger.warn(`agent Workers: the stall of ${row.run_id} was not appended: ${(error as Error).message}`)
      }
    }, Math.min(BEAT_MS, this.bounds().stallSeconds * 500))
    beat.unref()
    return { observer, stop: () => clearInterval(beat) }
  }

  private schedule(runId: string): void {
    if (this.stopped.signal.aborted) return
    const running = this.runOwned(runId).catch(() => undefined)
    this.inflight.add(running)
    void running.finally(() => this.inflight.delete(running))
  }

  private async runOwned(runId: string): Promise<void> {
    // While another process holds it, it finishes the run, or crashed and its lease expires.
    const outcome = await this.ctx.leases.hold(`agent-run:${runId}`, LEASE_TTL_MS, async ({ lease: current, lost }) => {
      const cancel = new AbortController()
      this.cancels.set(runId, cancel)
      const signal = AbortSignal.any([lost, this.stopped.signal, cancel.signal])
      try {
        const row = this.row(runId)
        if (!row || row.status === 'completed' || row.status === 'failed') return
        // Started, and its runtime ended by this source's own stop (a drain, shutdown, or update): not a
        // loss of its holder. It runs again as itself, not as a new attempt (T283).
        const cut = row.submitted_at !== null && this.cutByHost(row)
        // Taken up at the start, before its runtime registered: what the runtime can resume is not known
        // yet, so it waits for it, bounded (INV-9), rather than being sent as if it could not.
        if (cut && !this.ctx.agentRuntimes.get(this.workers.get(row.worker)!.runtime) && (this.runtimeWaits.get(runId) ?? 0) < MAX_RUNTIME_WAITS) {
          this.runtimeWaits.set(runId, (this.runtimeWaits.get(runId) ?? 0) + 1)
          this.retryLater(runId, 1000)
          return
        }
        this.runtimeWaits.delete(runId)
        if (row.submitted_at && !cut) {
          // Started, and its holder no longer holds it: the agent may already have acted in its
          // workspace, and may still be acting. It is never run again (INV-4); it is reconciled as
          // gone only on a `dead` verdict, and otherwise looked at again, then left to the operator.
          const liveness = this.livenessOf(row)
          const max = this.config.maxUnknownVerdicts ?? 3
          if (liveness.recheckAt !== undefined) {
            // Every signal is positively gone, and only the activity bound is not past yet: no probe
            // failed, so this look is not counted; the verdict is given again once the bound is past.
            this.retryLater(runId, Math.min(MAX_LOOK_MS, Math.max(1000, liveness.recheckAt - Date.now() + 1000)))
            return
          }
          const looks = (row.liveness_looks ?? 0) + 1
          if (liveness.verdict !== 'dead' && looks < max) {
            this.update(row.run_id, { liveness_looks: looks, liveness_verdict: liveness.verdict }, current)
            const delay = Math.min(MAX_LOOK_MS, LEASE_TTL_MS * 2 ** (looks - 1))
            this.ctx.logger.warn(`agent Workers: ${row.run_id} on ${row.worker} started and its holder no longer holds it, and it is not known to be gone (${liveness.verdict}: ${liveness.reasons.join('; ')}); looked at again in ${Math.round(delay / 1000)} s (${looks} of ${max})`)
            this.retryLater(runId, delay)
            return
          }
          const decision = this.reconciled(row, liveness, looks)
          this.fail(row, new ProviderError('reconciliation_failed', liveness.verdict === 'dead'
            ? `${row.worker} was running this task when its holder stopped, and it is gone (liveness ${liveness.verdict}, decision ${decision})${row.native_handle ? `; native session ${row.native_handle}` : ''}; it is not run again automatically`
            : `${row.worker} was running this task when its holder stopped, and after ${looks} looks it is not known to be gone (liveness ${liveness.verdict}: ${liveness.reasons.join('; ')}; decision ${decision}); it is not declared dead, so its session stays held, and the operator decides${row.native_handle ? ` (native session ${row.native_handle})` : ''}: system free ${row.run_id} --agent-gone, once its agent is gone`),
          // Its holder stopped with it in flight, and that alone ended it: the host's, not the run's (ADR-0069).
          current, { liveness_looks: looks, liveness_verdict: liveness.verdict, liveness_decision: decision }, 'host-stopped')
          if (liveness.verdict !== 'dead') this.toldUnknown(row, liveness.verdict, looks, decision, 'holder')
          // Its usage is not invented: it comes from the agent's transcript, reconciled later. Until
          // then the ledger counts none of it, which is recorded (docs/design/resources.md).
          if (row.reservation_id) {
            this.interruptedUsage(row)
            await this.release(row.worker, row.reservation_id)
          }
          return
        }
        const worker = this.workers.get(row.worker)
        if (!worker) throw new ProviderError('config_error', `${row.worker} is no longer configured`)
        // Its Worker's configuration changed while it waited (ADR-0073): a tier, or a tier's model, it no
        // longer offers runs nothing else in its place; routing serves the work again.
        const changed = this.offerChanged(row, worker)
        if (changed) throw new ProviderError('worker_changed', `${changed}; nothing was run, and routing serves the work again`)
        // A derived Worker's account that is not ready takes nothing, whatever the run would send (REQ-ACC-11).
        const account = worker.derived ? this.agentAccounts.accountGate(worker.derived.accountId) : undefined
        if (account?.state === 'unavailable') throw new ProviderError('config_error', `${row.worker}: ${account.why}; nothing was run`)
        // What the agent is sent: its prompt, or a review member's conversation replayed before it (ADR-0049).
        // The source's half of its handbook slice, recorded with what it rendered (./handbook.ts).
        const rendered: SourcePart[] = []
        let turn = await this.withUnasked(await this.withLessons(await this.turnOf(row, worker, current), row, worker, rendered), row, worker, rendered)
        this.recordHalf(row, rendered)
        // A run the host cut is told so, and resumes from its native conversation or starts again in its worktree.
        const again = cut ? await this.againAfterCut(row, worker, turn) : undefined
        if (again) turn = again.turn
        // INV-12: the prompt reaches the agent's remote model, so it is checked before anything starts,
        // with the files it will read in its worktree: one check of exactly what the agent is given.
        const placed = row.files ? (JSON.parse(row.files) as Array<{ path: string; text: string }>) : []
        const payload = [turn.prompt, ...placed.map((f) => `${f.path}:\n${f.text}`)].join('\n\n')
        const egress = await this.ctx.egress.check({ payload, classification: turn.classification, workerClass: 'agent' })
        // Fenced like every write of a run: a holder that lost the run writes nothing.
        this.update(row.run_id, { egress_decision: egress.decision }, current)
        if (!egress.allowed) {
          this.fail(row, new ProviderError('egress_denied', `${egress.reason} (decision ${egress.decision})`), current)
          return
        }
        // Run with its count of cuts, so its usage record is its own unit and a lower bound of the run (`account`).
        const ran = again ? { ...row, resumes: this.noteAgain(row, again, current) } : row
        await this.scheduler(row.worker, worker).runTurn(row.worker, signal, async (slot) => this.execute(ran, worker, turn, AbortSignal.any([signal, slot.signal]), current))
      } catch (error) {
        if (this.stopped.signal.aborted) {
          this.markCut(runId, current)
          return
        }
        if (error instanceof LeaseLost || error instanceof StaleGeneration || lost.aborted) {
          this.retryLater(runId, LEASE_TTL_MS)
          return
        }
        const row = this.row(runId)
        if (cancel.signal.aborted && row && row.status !== 'completed' && row.status !== 'failed') {
          this.fail(row, new ProviderError('aborted', 'cancelled by the operator'), current)
          return
        }
        if (row && row.status !== 'completed' && row.status !== 'failed') {
          // Sent, and its Worker is positively unavailable now: it went away mid-run, and that alone ended the run (ADR-0069).
          const gone = row.submitted_at ? await this.workerGone(row, error) : undefined
          if (gone) {
            const typed = toProviderError(error)
            this.fail(row, new ProviderError(typed.kind, `${typed.message}; ${row.worker} became unavailable while it ran: ${gone}`, { cause: error }), current, {}, 'worker-unavailable')
          } else this.fail(row, error, current)
        }
      } finally {
        this.cancels.delete(runId)
      }
    })
    if (!outcome.held) this.retryLater(runId, outcome.retryInMs)
  }

  /**
   * Why a run that was sent and then failed failed only because its Worker became unavailable while
   * it ran (ADR-0069), or undefined. Only a failure of the runtime or its session (its process or
   * connection gone, an internal or setup failure), never one of the run's own (a timeout, a limit,
   * a violation, a denial, its own answer), and only when the Worker, looked at again now, is
   * positively unavailable: no longer configured, its runtime no longer registered or its probe
   * failing (or no longer proving what the Worker needs), or its account signed out, quarantined, or
   * not ready. A look that fails says nothing (fail closed: the attempt pays for the run).
   */
  private async workerGone(row: RunRow, error: unknown): Promise<string | undefined> {
    if (!WORKER_GONE_KINDS.has(toProviderError(error).kind)) return undefined
    try {
      const worker = this.workers.get(row.worker)
      if (!worker) return `${row.worker} is no longer configured`
      const refusal = refusalOf(await this.evidence(worker, 'proven'), worker)
      if (refusal) return refusal
      const enrolled = worker.derived ? this.agentAccounts.accountGate(worker.derived.accountId) : this.handNamedGate(worker)
      if (enrolled.state === 'unavailable') return enrolled.why
    } catch (caught) {
      this.ctx.logger.warn(`agent Workers: whether ${row.worker} became unavailable while ${row.run_id} ran could not be told: ${(caught as Error).message}`)
    }
    return undefined
  }

  /**
   * What a run sends its agent. Outside a session, or on a runtime that resumes a conversation, its
   * own prompt (continuing the session's native conversation, once it has one). On a runtime that
   * cannot resume, a session's later turn replays the session's earlier completed turns before its
   * prompt, each its own message and its answer, exactly as they were (ADR-0049): only for a review
   * member's step on a Worker under the review-member profile, every earlier turn one too (so no
   * tool ran in it), bounded by `maxReplayChars` and never cut, at the strictest classification of
   * what it holds (INV-12). The runs it replays are fixed when it is first prepared. A continuation
   * that can be neither resumed nor replayed whole is refused: a member is never given a fresh
   * conversation in its place. Nothing has reached the agent yet.
   */
  private async turnOf(row: RunRow, worker: AgentWorkerConfig, lease: () => Lease): Promise<Turn> {
    const own: Turn = { prompt: row.prompt, classification: row.classification as Classification, native: true }
    if (!row.session_id) return own
    const member = row.scope === REVIEW_MEMBER
    const evidence = await this.evidence(worker, 'proven')
    if (evidence.resume) {
      const session = this.ctx.store.db.prepare('SELECT native_handle FROM agent_sessions WHERE session_id = ?').get(row.session_id) as { native_handle: string | null } | undefined
      if (session?.native_handle) return { ...own, resume: session.native_handle }
      if (member) {
        const earlier = this.earlierRuns(row).filter((r) => r.status !== 'failed')
        if (earlier.length) throw new ProviderError('invalid_input', `${row.worker}: session ${row.session_id} has ${earlier.length} earlier turn(s) and no native conversation to resume, and a review member is never given a fresh conversation for a continuation; nothing was sent`)
      }
      return own
    }
    const replay = row.replay ? (JSON.parse(row.replay) as string[]) : undefined
    const earlier = replay ? undefined : this.earlierRuns(row)
    // A first turn: no earlier one, or only failed ones, which are no part of the conversation.
    if (!replay && earlier!.every((r) => r.status === 'failed')) return { ...own, native: false }
    if (!worker.reviewMember || !member) {
      throw new ProviderError('config_error', `${row.worker} cannot continue session ${row.session_id}: its runtime cannot resume a conversation, and this source keeps one by replay only for a review member's steps (ADR-0049); nothing was run`)
    }
    // A turn still open would be left out of the conversation: refused, never replayed without it.
    const open = earlier?.find((r) => r.status !== 'completed' && r.status !== 'failed')
    if (open) throw new ProviderError('invalid_input', `${row.worker}: run ${open.run_id} of session ${row.session_id} has not finished, so the conversation cannot be replayed whole; nothing was sent`)
    const ids = replay ?? earlier!.filter((r) => r.status === 'completed').map((r) => r.run_id)
    let classification = own.classification
    const turns = ids.map((id, i) => {
      const run = this.row(id)
      if (!run || run.status !== 'completed' || run.session_id !== row.session_id) throw new ProviderError('invalid_input', `${row.worker}: turn ${i + 1} of session ${row.session_id} (run ${id}) is no longer a completed turn of it; nothing was sent`)
      // Only a turn in which no tool ran is exactly its message and its answer.
      if (run.scope !== REVIEW_MEMBER) throw new ProviderError('invalid_input', `${row.worker}: turn ${i + 1} of session ${row.session_id} (run ${id}) did not run under the review-member profile, so tools may have run in it that a replay cannot hold; nothing was sent`)
      const answer = run.result ? this.ctx.artifacts.get(run.result as ArtifactRef) : undefined
      const text = (answer?.body as { text?: unknown } | undefined)?.text
      if (typeof text !== 'string') throw new ProviderError('invalid_input', `${row.worker}: the answer of turn ${i + 1} of session ${row.session_id} (run ${id}) is no longer stored, so its conversation cannot be replayed; nothing was sent`)
      for (const c of [run.classification as Classification, answer!.classification as Classification]) if (RANK[c] > RANK[classification]) classification = c
      return { runId: id, answer: answer!.id as ArtifactRef, prompt: run.prompt, text }
    })
    const chars = turns.reduce((n, t) => n + [...t.prompt].length + [...t.text].length, 0)
    const max = this.config.maxReplayChars ?? 200_000
    if (chars > max) {
      throw new ProviderError('invalid_input', `${row.worker}: session ${row.session_id}'s ${turns.length} earlier turn(s) hold ${chars} characters, over the ${max} its replay holds (agent-workers maxReplayChars); nothing was sent, and the history is never cut`)
    }
    // Fixed once: a run taken up again after a restart replays exactly these turns.
    if (!replay) this.update(row.run_id, { replay: JSON.stringify(ids) }, lease)
    return {
      prompt: replayed(turns.map((t) => ({ prompt: t.prompt, answer: t.text })), row.prompt), classification, native: false,
      replay: { runs: ids, answers: turns.map((t) => t.answer) },
    }
  }

  /**
   * The turn with its Tools section appended (gate.ts `unaskedNote`, T199 and T207): the workspace,
   * the calls its gate lets run unasked (the autonomy policy's exact lines), the gate's refusals,
   * and whether an approval resumes the step, so the agent asks the operator less and is denied
   * less: for every Worker, fit to its sandbox (a read-only one is told it writes nothing and given
   * no writing tool or commands list), never for a review member (its gate allows no call). Read from `ctx.approvals.policy()` now, and the
   * runtime's evidence of clean shells and of the workspace reads server (T200b: its tools are the
   * reading tools, and the agent is told to read with them, never with a shell), as the gate reads
   * it (a probe that fails: neither); with no
   * queue, or one that cannot be read, the turn is sent as it is (logged), since the gate still
   * decides every call. Appended before the egress check, which sees it.
   */
  private async withUnasked(turn: Turn, row: RunRow, worker: AgentWorkerConfig, rendered: SourcePart[] = []): Promise<Turn> {
    if (row.scope === REVIEW_MEMBER) return turn
    const approvals = this.ctx.get('approvals')
    if (!approvals) return turn
    const workspace = worker.worktreePerRun && row.workflow_run_id && RUN_ID.test(row.workflow_run_id) ? this.worktrees.pathOf(worker.workspace, row.workflow_run_id) : worker.workspace
    try {
      const evidence = await this.evidence(worker, 'proven').catch(() => undefined)
      // A research run is told its web tools and the grant its gate judges them under (T262), the project's as well.
      const grant = worker.research ? webAccessOf((await approvals.policy(row.project_id ?? undefined)).policies, 'research') : undefined
      const policy = await approvals.policy()
      const note = unaskedNote(policy, workspace, {
        shellReads: evidence?.cleanShells === true, workspaceReads: evidence?.workspaceReads === true, readTools: readToolsOf(evidence, this.atTier(worker, row.tier).tools), resumes: row.session_id !== null && row.session_id !== undefined, sandbox: worker.sandbox,
        dossier: this.dossierOf(row, evidence) !== undefined,
        ...(worker.research ? { research: { tools: (this.atTier(worker, row.tier).tools ?? []).filter((t) => WEB_RUN_TOOLS.includes(t)), grant: grant ?? null } } : {}),
      })
      // Its version is the policy it was rendered from: each policy's id and version, and the set in force.
      const version = `policy:${policy.policies.map((p) => `${p.id}@${p.version}`).join(',') || 'none'}:${policy.set?.hash ?? 'unhashed'}`.slice(0, 300)
      rendered.push({ layer: 2, part: 'L2.gate-view', version, sha256: sha256(note).slice('sha256:'.length), tokens: Math.ceil(Buffer.byteLength(note, 'utf8') / 4) })
      return { ...turn, prompt: `${turn.prompt}\n\n${note}` }
    } catch (error) {
      this.ctx.logger.warn(`agent Workers: the autonomy policy could not be read for ${row.run_id}'s note of the calls that run unasked; it is sent without it: ${(error as Error).message}`)
      return turn
    }
  }

  /**
   * The turn with the repository's lessons appended (lessons.ts, T220), from the lessons file as its
   * repository (the configured workspace, whose HEAD a run's worktree is cut from) has it committed
   * at HEAD, within its bound (lessons.ts `LESSONS_LIMITS`). A run whose brief records its handbook
   * slice (`brief@1.6`, docs/design/handbook.md) is given the lessons that apply to the role and paths
   * the slice was selected for, whatever its sandbox: a reviewer is given the lessons whose check is
   * the review (X3; a review member's empty workspace holds no repository, so it has none). Any other
   * run: a writing Worker (`workspace-write`) only, never a review member, every lesson. No such
   * file, or none committed, is no section; one that cannot be read is none either (logged), since
   * nothing else depends on it. Appended before the egress check, which sees it; what was given is
   * recorded in `rendered`.
   */
  private async withLessons(turn: Turn, row: RunRow, worker: AgentWorkerConfig, rendered: SourcePart[] = []): Promise<Turn> {
    const who = row.handbook ? handbookSelection({ selection: JSON.parse(row.handbook) as unknown }) : undefined
    if (!who && (row.scope === REVIEW_MEMBER || worker.sandbox !== 'workspace-write')) return turn
    try {
      const read = await repositoryLessonsFor(worker.workspace, who)
      if (read && who) rendered.push({ layer: 5, part: 'L5.lessons', version: read.version, ...(read.sha256 ? { sha256: read.sha256 } : {}), tokens: read.tokens, lessons: read.lessons })
      const section = read?.section
      return section ? { ...turn, prompt: `${turn.prompt}\n\n${section}` } : turn
    } catch (error) {
      this.ctx.logger.warn(`agent Workers: the lessons of ${worker.workspace} could not be read for ${row.run_id}; it is sent without them: ${(error as Error).message}`)
      return turn
    }
  }

  /**
   * Record what this source rendered of a run's handbook slice (./handbook.ts): for a run of a
   * workflow run whose brief records its slice, one {@link HANDBOOK_SOURCE_EVENT} event naming the
   * execution and step, and each part's version, sha256, and estimated tokens (none: the part was not
   * rendered). Logged, never failing the run, when the log cannot take it.
   */
  private recordHalf(row: RunRow, rendered: readonly SourcePart[]): void {
    if (!row.handbook || !row.workflow_run_id) return
    try {
      this.ctx.get('eventLog')?.append({ type: HANDBOOK_SOURCE_EVENT, runId: row.workflow_run_id, data: { execution: row.run_id, ...(row.step_node ? { node: row.step_node } : {}), parts: rendered } })
    } catch (error) {
      this.ctx.logger.warn(`agent Workers: what ${row.run_id} was given of its handbook slice could not be recorded: ${(error as Error).message}`)
    }
  }

  /** The runs of a run's session before it, of the same generation (a reset starts a new one), in order. */
  private earlierRuns(row: RunRow): Array<{ run_id: string; status: ExecutionStatus }> {
    return this.ctx.store.db.prepare(`SELECT run_id, status FROM agent_runs
      WHERE session_id = ? AND run_id != ? AND COALESCE(session_generation, 0) = ? AND created_at <= ?
      ORDER BY created_at, run_id`).all(row.session_id, row.run_id, row.session_generation ?? 0, row.created_at) as Array<{ run_id: string; status: ExecutionStatus }>
  }

  /**
   * Why a review member's run cannot hold its profile in `workspace` (ADR-0049), or undefined when
   * it can: the Worker is under the profile, read-only, and its workspace an empty directory outside
   * any repository, so nothing there reaches the agent without a tool call (a runtime may read
   * instruction files from its working directory and the repository above it on its own).
   */
  private profileProblem(worker: AgentWorkerConfig, workspace: string): string | undefined {
    if (!worker.reviewMember || worker.sandbox !== 'read-only') return 'it is not under the review-member profile (reviewMember, read-only)'
    let entries: string[]
    try {
      entries = readdirSync(workspace)
    } catch (error) {
      return `its workspace ${workspace} cannot be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`
    }
    if (entries.length) return `its workspace ${workspace} is not empty (it holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}), and a review member's material is its prompt alone`
    let repository: string | undefined
    try {
      repository = repositoryOf(workspace)
    } catch (error) {
      return `git cannot tell whether its workspace ${workspace} is inside a repository (${(error as Error).message.slice(0, 200)})`
    }
    return repository === undefined ? undefined : `its workspace ${workspace} is inside the repository ${repository}, whose files a runtime may read on its own`
  }

  /**
   * The engine's dossier and the step a run's dossier tools are bound to (ADR-0070), when the run
   * gets them: its runtime offers host tools (`evidence.hostTools`), it serves a step of a board
   * task's workflow run (its row's workflow run, step, and task, from the engine's own start request),
   * it is no review member's (whose gate allows no call), and an engine that keeps a dossier is
   * loaded. The execution is this run itself.
   */
  private dossierOf(row: RunRow, evidence: RuntimeEvidence | undefined): { dossiers: StepDossiers; caller: DossierCaller } | undefined {
    if (evidence?.hostTools !== true || row.scope === REVIEW_MEMBER || !row.task_id || !row.workflow_run_id || !row.step_node) return undefined
    const dossiers = dossiersOf(this.ctx)
    return dossiers ? { dossiers, caller: { runId: row.workflow_run_id, nodeId: row.step_node, execution: row.run_id } } : undefined
  }

  private async execute(row: RunRow, worker: WorkerSpec, turn: Turn, signal: AbortSignal, lease: () => Lease): Promise<void> {
    const provider = this.ctx.agentRuntimes.get(worker.runtime)
    if (!provider) throw new ProviderError('config_error', `no ${worker.runtime} runtime is registered`)
    // Admission proved it once; a queued run, or one taken up after a restart, runs only on
    // proof that still holds (ADR-0024), never one past probeTtlMs. Nothing has reached the agent yet.
    const evidence = await this.evidence(worker, 'proven')
    if (!admits(evidence, worker)) {
      throw new ProviderError('config_error', `${worker.runtime} cannot run this Worker now: ${evidence.gatesToolCalls ? evidence.detail : `${evidence.detail}; it cannot ask the run's gate before each tool call`}`)
    }
    // The home the run names: a derived Worker's account's, unless it is the runtime's own.
    const named = this.namedHome(worker, provider)
    if (named && 'why' in named) throw new ProviderError('config_error', `${row.worker}: ${named.why}; nothing was run`)
    // The account in the run's home is read again before the run: a principal changed since the
    // probe quarantines it, and the gate below fails the run unsubmitted (ADR-0051, INV-2).
    const home = named?.home ?? provider.home
    if (home !== undefined && (worker.derived || provider.home !== undefined)) await this.agentAccounts.recheck(worker.runtime, home)
    // Queued before its account hit a limit (its runtime's cooldown, or another of its Workers' pools):
    // it would hit it again (INV-2). Its own pool is its reservation's to check.
    const held = await this.accountGate(worker, false)
    if (held.state !== 'ready') throw new ProviderError(held.state === 'quota-exhausted' ? 'quota_exhausted' : 'config_error', `${row.worker}: ${held.why}; nothing was run`)
    // One writer per worktree and one driver per native session (INV-15): an earlier run that ended
    // without being known to be gone may still be acting there (PROP-0013).
    const alive = this.notKnownGone(row, worker)
    if (alive) throw new ProviderError('config_error', `${row.worker}: run ${alive.run_id} of ${alive.why} ended without being known to be gone (liveness ${alive.liveness_verdict ?? 'unknown'}, decision ${alive.liveness_decision}); its agent may still be acting, so nothing was run`)
    const workspace = await this.workspaceOf(row, worker)
    // A new worktree is set up first, when its repository has a setup (ADR-0058): a setup not allowed,
    // or that failed, fails the run here, its decision on the run; nothing has reached the agent yet.
    const setup = workspace !== worker.workspace ? this.setups.get(resolve(worker.workspace)) : undefined
    if (setup) {
      const outcome = await this.worktreeSetups.ensure({
        agentRun: row.run_id, worker: row.worker, workflowRunId: row.workflow_run_id!, sessionId: row.session_id ?? undefined, taskId: row.task_id ?? undefined,
        classification: row.classification as 'public' | 'operator-shared' | 'local-private', worktree: workspace, repository: realpathSync(worker.workspace),
      }, setup, signal)
      this.update(row.run_id, { setup_decision: outcome.decision }, lease)
      if (outcome.failure) throw outcome.failure
    }
    // The brief's files go into the run's own worktree before the agent starts; nothing has reached it yet.
    // Its `.system/` then holds this brief's files only (T267): one a step before placed is gone, so a
    // step given none (an author's fresh-context self-review) cannot read another step's dossier there.
    if (workspace !== worker.workspace) {
      await this.worktrees.place(workspace, row.files ? JSON.parse(row.files) as Array<{ path: string; text: string }> : []).catch((error: unknown) => {
        throw new ProviderError('config_error', `${row.worker}: the brief's files cannot be written into ${workspace}: ${(error as Error).message}; nothing was run`, { cause: error })
      })
    }
    // A review member's step runs under the review-member profile, or not at all (ADR-0049).
    const member = row.scope === REVIEW_MEMBER
    const problem = member ? this.profileProblem(worker, workspace) : undefined
    if (problem) throw new ProviderError('config_error', `${row.worker} cannot run a review member's step under the review-member profile: ${problem}; nothing was run`)
    // Its board task's dossier tools (ADR-0070), bound to the step this run serves from its own row,
    // never from the agent's input; only where the runtime offers host tools.
    const dossier = this.dossierOf(row, evidence)
    const hostTools = dossier ? dossierTools(dossier.dossiers, dossier.caller) : []
    // Every tool call passes the run's gate before it runs; the runtime's own policy still holds.
    // Under the review-member profile, the gate denies every one.
    const gate = runGate(this.ctx, {
      runId: row.run_id, worker: row.worker, workerKind: worker.runtime, workspace, ...(workspace !== worker.workspace ? { repository: realpathSync(worker.workspace) } : {}), sessionId: row.session_id ?? undefined, workflowRunId: row.workflow_run_id ?? undefined,
      classification: row.classification as 'public' | 'operator-shared' | 'local-private', ...(member ? { profile: REVIEW_MEMBER } : worker.research ? { profile: 'research' as const } : {}),
      // A research run's web calls are judged under its task's project's policy and grant too, and name its step (T262).
      ...(row.project_id ? { projectId: row.project_id } : {}), ...(row.task_id ? { taskId: row.task_id } : {}), ...(row.step_node ? { nodeId: row.step_node } : {}),
      // A shell command is taken for a read only where the runtime enforces shells that read no startup code (T198).
      shellReads: evidence.cleanShells === true,
      // The workspace reads server's tools are reads only where the runtime gives its agent that server (T200b).
      workspaceReads: evidence.workspaceReads === true,
      // A shell inspection command the agent has a reading tool for is denied at once, naming it (T222).
      readTools: readToolsOf(evidence, this.atTier(worker, row.tier).tools),
      // Only the host tools this run was given are classified (ADR-0070).
      hostTools: hostTools.map((tool) => tool.name),
    })
    // What it runs at its tier (ADR-0073): that tier's model, tools, and turn limit, else the Worker's own
    // (one it still offers, with the model it was started for: checked before the egress check).
    const at = this.atTier(worker, row.tier)
    const spec: RunSpec = {
      prompt: turn.prompt, workspace, sandbox: worker.sandbox,
      // A research role's run lists the web tools beside its reads (T262): never on a review member's step.
      ...(worker.research && !member ? { web: true } : {}),
      // Omitted or empty means the runtime's minimal set: the config schema turns an omitted list into [].
      ...(at.tools?.length ? { tools: at.tools } : {}), ...(at.model ? { model: at.model } : {}), ...(at.maxTurns ? { maxTurns: at.maxTurns } : {}),
      // Only a runtime that reports `resume` is ever asked to continue a conversation.
      ...(turn.resume ? { resume: turn.resume } : {}),
      // A derived Worker's account in another home than the runtime's own runs there, and only there (ADR-0051).
      ...(named ? { home: named.home } : {}),
      // A runtime that gives its agent the workspace reads server bounds it so (T200b); one that gives none ignores it.
      workspaceReads: this.readBounds,
      ...(hostTools.length ? { hostTools } : {}),
      toolGate: gate.gate,
      // The commands a writing step's Worker ran, with the exit code and output tail its runtime reports, are recorded by the System itself (T284).
      ...(dossier && worker.sandbox === 'workspace-write' ? { onToolResult: commandRecorder(this.ctx, dossier.dossiers, dossier.caller) } : {}),
    }
    // A writing run's commands say on a report file of its own what their tests did not run, as a
    // check's command does (T265): its result says so, and its review is told. One that cannot be
    // made is said on the result (`reportUnread`), never taken for a report naming no skip.
    let report: RunReport | undefined
    let unmade: RunReported | undefined
    if (worker.sandbox === 'workspace-write' && !member) {
      try {
        report = runReport(this.reportDir)
        spec.reportFile = report.path
      } catch (error) {
        unmade = { unread: `its report file could not be made in ${this.reportDir}: ${(error as Error).message}`.slice(0, 300) }
        this.ctx.logger.warn(`agent Workers: ${row.worker}'s run ${row.run_id} has no report file (${unmade.unread}); its result says so`)
      }
    }
    try {
      // Metered: nothing runs without a reservation (INV-2, INV-9), on its model's pool too when it has one (ADR-0073).
      const meter = this.meter(row.worker, worker, at.modelPool)
      if (meter) await this.declareAccounts(meter.resources)
      const reservation = meter ? await this.reserve(row, meter, lease) : undefined
      try {
        const result = await this.submit(row, worker, provider, spec, turn.native, signal, lease, meter, gate.deferral)
        this.complete(row, worker, workspace, result, turn, lease, at, report?.read() ?? unmade)
      } finally {
        if (reservation) await this.release(row.worker, reservation)
      }
    } finally {
      report?.dispose()
    }
  }

  /**
   * Run the agent, and meter what it consumed, completed or not. A session keeps the run's native
   * handle only when its runtime can resume it (`native`); a replayed conversation keeps none, so no
   * brief names one and no run is asked to resume it.
   */
  private async submit(row: RunRow, worker: WorkerSpec, provider: AgentRuntimeProvider, spec: RunSpec, native: boolean, signal: AbortSignal, lease: () => Lease, meter: Meter | undefined, deferral: () => Deferral | undefined): Promise<RunResult> {
    // What a run of a derived Worker on a declared pool draws (PROP-0015 E2): its pool's readings
    // before it, taken before it is submitted, and the runs on its account it overlaps from now on.
    const drawing = worker.derived && meter ? await this.beginDraw(row, meter) : undefined
    try {
      return await this.submitRun(row, worker, provider, spec, native, signal, lease, meter, deferral, drawing)
    } finally {
      drawing?.end()
    }
  }

  private async submitRun(row: RunRow, worker: WorkerSpec, provider: AgentRuntimeProvider, spec: RunSpec, native: boolean, signal: AbortSignal, lease: () => Lease, meter: Meter | undefined, deferral: () => Deferral | undefined, drawing: Drawing | undefined): Promise<RunResult> {
    // Submitted from here on: the agent may act as soon as it starts. Its holder, this process, is
    // recorded with it, and the submission is its first activity (PROP-0013).
    const submittedAt = now()
    const holder = currentProcess()
    // A host stop's mark is cleared as it runs: a later loss of its holder is a crash, never that stop.
    this.update(row.run_id, { status: 'running', submitted_at: submittedAt, activity_at: submittedAt, host_stopped_at: null, ...(holder ? { holder: JSON.stringify(holder) } : {}) }, lease)
    const startedAt = Date.now()
    const deadline = AbortSignal.timeout(this.config.runTimeoutMs ?? 15 * 60_000)
    const watched = this.watch(row, lease)
    // After the run, the account's own usage report (ADR-0059), once, before its usage is recorded and
    // its reservation released: after each run of a derived Worker on a declared pool, so the latest
    // reading has the share; and after any run that hit a limit, so a reset read there wins over the
    // cooldown fallback. In the home the run ran in.
    const reportAfter = async (failed: string | undefined): Promise<LimitObservation[]> =>
      (worker.derived && meter) || failed === 'quota_exhausted' ? await this.usageReport(worker, spec.home, `after run ${row.run_id}`) ?? [] : []
    executing.add(row.run_id)
    let result: RunResult
    try {
      result = await provider.run(spec, AbortSignal.any([signal, deadline]), (handle) => {
        this.ctx.store.transaction((db) => {
          this.ctx.leases.fence(lease())
          db.prepare('UPDATE agent_runs SET native_handle = ?, updated_at = ? WHERE run_id = ?').run(handle, now(), row.run_id)
          if (row.session_id && native) db.prepare('UPDATE agent_sessions SET native_handle = ? WHERE session_id = ?').run(handle, row.session_id)
        })
      }, watched.observer)
    } catch (error) {
      const deferred = deferral()
      if (deferred && !signal.aborted) this.noteDeferral(row, deferred, lease)
      const failure = deadline.aborted && !signal.aborted
        ? new ProviderError('timeout', `${row.worker} did not finish within ${this.config.runTimeoutMs ?? 15 * 60_000} ms; it was stopped`, { cause: error })
        : deferred && !signal.aborted ? waiting(row, deferred, error) : error
      const kind = toProviderError(failure).kind
      const metering = meteringOf(error)
      const durationMs = Date.now() - startedAt
      const endedAt = now()
      const report = await reportAfter(kind)
      // How it ended, in plain words, for a fact of its usage (docs/design/resources.md#usage-the-ledger-cannot-count).
      const ending = deadline.aborted && !signal.aborted ? `it ran past its timeout of ${this.config.runTimeoutMs ?? 15 * 60_000} ms and was stopped`
        : signal.aborted ? this.stopOf(signal)
          : deferred ? `it stopped at a ${deferred.tool} call that waits for approval request ${deferred.requestId}`
            : `it failed (${kind})`
      const outcome = kind === 'aborted' ? 'aborted' : 'failed'
      const limited = meter ? await this.account(row, worker, meter, metering, outcome, durationMs, report, ending) : false
      if (drawing && meter) await this.finishDraw(row, meter, drawing, outcome, endedAt)
      // A limit hit that left no limited reading in the ledger is never retried there unseen (INV-2).
      if (kind === 'quota_exhausted' && !limited) {
        // The run's own outcome stays the limit, whatever recording it does.
        await this.limitHit(row, worker, meter, [...metering?.limits ?? [], ...report], toProviderError(failure).message).catch((caught: unknown) => {
          this.ctx.logger.warn(`agent Workers: the limit ${row.worker} hit could not be recorded: ${(caught as Error).message}`)
        })
      }
      throw failure
    } finally {
      executing.delete(row.run_id)
      watched.stop()
    }
    // A run whose gate deferred a call did not finish, whatever its runtime reported (INV-2).
    const deferred = deferral()
    const durationMs = Date.now() - startedAt
    const endedAt = now()
    if (deferred) {
      this.noteDeferral(row, deferred, lease)
      if (meter) await this.account(row, worker, meter, result, 'failed', durationMs, await reportAfter(undefined), `it stopped at a ${deferred.tool} call that waits for approval request ${deferred.requestId}`)
      if (drawing && meter) await this.finishDraw(row, meter, drawing, 'failed', endedAt)
      throw waiting(row, deferred)
    }
    if (meter) await this.account(row, worker, meter, result, 'completed', durationMs, await reportAfter(undefined), 'it completed')
    if (drawing && meter) await this.finishDraw(row, meter, drawing, 'completed', endedAt)
    return result
  }

  /** Who stopped a run whose signal aborted, in plain words: the host stopping (a drain), the operator, or a lost lease. */
  private stopOf(signal: AbortSignal): string {
    if (this.stopped.signal.aborted) return 'the host stopped while it ran, and stopped it (a drain at stop or restart)'
    const reason: unknown = signal.reason
    if (reason instanceof ProviderError) return `it was stopped: ${reason.message}`
    return 'it was stopped, its lease on the run lost'
  }

  /**
   * Begin watching what a run draws (PROP-0015 E2): the runs on its account it overlaps from now on,
   * then its pool's windows and their latest readings, the readings before it; none when the ledger
   * cannot tell (each window then has no reading before). Never throws.
   */
  private async beginDraw(row: RunRow, meter: Meter): Promise<Drawing> {
    const end = this.overlaps.begin(meter.account, row.run_id)
    const before = await this.poolNow(meter)
    return { before, startedAt: now(), end }
  }

  /** The run's pool now, its windows and their latest readings; undefined when the ledger cannot tell. */
  private poolNow(meter: Meter): Promise<PoolState | undefined> {
    return meter.resources.pools({ account: meter.account }).then((pools) => pools.find((p) => p.pool === meter.pool), () => undefined)
  }

  /**
   * Record what a run drew (PROP-0015 E2, docs/design/resources.md#quota-drawn-per-run), once its
   * account's usage report after it was recorded: each window's last reading before the run and first
   * after it (`drawEntries`), as a `quota-draw@1.0` `evidence` artifact and a `quota.draw` event whose
   * data is the record. A window that reset, read no share, or went down has no draw; another run on
   * the account while it ran marks it confounded. Never throws: the run's own outcome never depends on it.
   */
  private async finishDraw(row: RunRow, meter: Meter, drawing: Drawing, outcome: QuotaDraw['outcome'], endedAt: string): Promise<void> {
    try {
      const after = await this.poolNow(meter)
      const overlapping = drawing.end()
      const windows = (after ?? drawing.before)?.windows ?? []
      if (!windows.length) {
        this.ctx.logger.warn(`agent Workers: what ${row.run_id} on ${row.worker} drew is not recorded: the ledger gives pool ${meter.pool} no window`)
        return
      }
      const record = quotaDraw({
        runId: row.run_id, worker: row.worker, account: meter.account, pool: meter.pool,
        ...(row.workflow_run_id ? { workflowRunId: row.workflow_run_id } : {}),
        ...(row.step_template && row.step_node ? { template: row.step_template, step: row.step_node } : {}),
        ...(row.kind ? { kind: row.kind } : {}), ...scopeOf(row),
        outcome, startedAt: drawing.startedAt, endedAt, overlapping: Math.min(overlapping, 1000),
        windows: drawEntries({ windows, before: drawing.before?.readings ?? [], after: after?.readings ?? [], startedAt: drawing.startedAt, endedAt, overlapping }),
        observedAt: now(),
      })
      this.ctx.artifacts.put({
        kind: 'evidence', bodySchema: record.schema, body: record, classification: 'operator-shared', producer: { type: 'worker', ref: row.worker },
        runId: row.workflow_run_id ?? row.run_id, ...(row.workflow_run_id && row.step_node ? { nodeId: row.step_node } : {}),
      })
      const eventLog = this.ctx.get('eventLog')
      if (!eventLog) throw new Error('no event log (ctx.eventLog) is loaded, so no surface can read it back')
      eventLog.append({ type: QUOTA_DRAW_EVENT, ...(row.workflow_run_id ? { runId: row.workflow_run_id } : {}), ...(row.workflow_run_id && row.step_node ? { nodeId: row.step_node } : {}), data: { ...record } })
    } catch (error) {
      this.ctx.logger.warn(`agent Workers: what ${row.run_id} on ${row.worker} drew from pool ${meter.pool} could not be recorded: ${(error as Error).message}`)
    }
  }

  /**
   * An earlier run that ended without being known to be gone (reconciled, not `dead`) on what this run
   * would drive: its session, or, for a Worker with a worktree per run, its workflow run's worktree.
   */
  private notKnownGone(row: RunRow, worker: AgentWorkerConfig): { run_id: string; liveness_verdict: string | null; liveness_decision: string; why: string } | undefined {
    const unknown = `run_id != ? AND ${notKnownGone('')}`
    const db = this.ctx.store.db
    const session = row.session_id
      ? db.prepare(`SELECT run_id, liveness_verdict, liveness_decision FROM agent_runs WHERE session_id = ? AND ${unknown} LIMIT 1`).get(row.session_id, row.run_id) as { run_id: string; liveness_verdict: string | null; liveness_decision: string } | undefined
      : undefined
    if (session) return { ...session, why: `session ${row.session_id}` }
    const worktree = worker.worktreePerRun && row.workflow_run_id
      ? db.prepare(`SELECT run_id, liveness_verdict, liveness_decision FROM agent_runs WHERE workflow_run_id = ? AND ${unknown} LIMIT 1`).get(row.workflow_run_id, row.run_id) as { run_id: string; liveness_verdict: string | null; liveness_decision: string } | undefined
      : undefined
    return worktree ? { ...worktree, why: `the worktree of workflow run ${row.workflow_run_id}` } : undefined
  }

  /**
   * Record the approval request the run's gate deferred a call on, so its session is known to wait on
   * it (PROP-0013). A write the lease no longer allows is left out: the gate's event still names it.
   */
  private noteDeferral(row: RunRow, deferred: Deferral, lease: () => Lease): void {
    try {
      this.update(row.run_id, { deferred_request: deferred.requestId }, lease)
    } catch (error) {
      this.ctx.logger.warn(`agent Workers: the approval request ${deferred.requestId} that ${row.run_id} stopped on was not recorded on it (its gate's event names it): ${(error as Error).message}`)
    }
  }

  /** Store the result as a `report` artifact and complete the run. */
  private complete(row: RunRow, worker: WorkerSpec, workspace: string, result: RunResult, turn: Turn, lease: () => Lease, at?: AtTier, reported: RunReported = {}): void {
    const { notRun, unread: reportUnread } = reported
    const handle = result.nativeHandle ?? this.row(row.run_id)?.native_handle ?? undefined
    const native = turn.native
    const member = row.scope === REVIEW_MEMBER
    // A review member's workspace is still empty: else the read-only sandbox did not hold, and its answer is not trusted.
    if (member && !emptyDirectory(workspace)) {
      throw new ProviderError('reconciliation_failed', `${row.worker}'s workspace ${workspace} is no longer empty after a review member's step: the read-only sandbox did not hold, the answer is not trusted, and the workspace is left for the operator`)
    }
    // A worktree whose .git file the agent pointed elsewhere is not read by git: its result is not trusted.
    if (workspace !== worker.workspace && !this.worktrees.intact(workspace)) {
      throw new ProviderError('reconciliation_failed', `${row.worker} changed the .git file of its worktree ${workspace}; the result is not trusted, and the worktree is left for the operator`)
    }
    // The workspace's exact subject after the run, so a review can bind to it (REQ-WF-5). One git
    // cannot read is unknown: the result is never stored as if the workspace had no subject.
    let captured: ReturnType<typeof captureGitSubject>
    try {
      captured = captureGitSubject(workspace)
    } catch (error) {
      throw new ProviderError('reconciliation_failed', `${row.worker}: ${(error as Error).message}; the result is not stored without its subject, and the workspace is left for the operator`, { cause: error })
    }
    this.ctx.store.transaction((db) => {
      this.ctx.leases.fence(lease())
      if (handle && row.session_id && native) db.prepare('UPDATE agent_sessions SET native_handle = ? WHERE session_id = ?').run(handle, row.session_id)
      // `agent-result@1.5` when its commands reported tests they did not run, or what they reported is
      // not known (T265), `@1.4` for a Worker that offers tiers (ADR-0073: the tier it ran at and the model it
      // was given there), `@1.3` for a review member's step (its profile, and the turns it replayed),
      // else `@1.2` when the runtime reported its token usage, `@1.1` otherwise.
      const usage = usageOf(result)
      const tiered = at && worker.tiers ? { tier: at.tier, ...(at.model ? { configuredModel: at.model } : {}) } : undefined
      const schema = notRun !== undefined || reportUnread !== undefined ? 'agent-result@1.5' : tiered ? 'agent-result@1.4' : member ? 'agent-result@1.3' : usage.usage ? 'agent-result@1.2' : 'agent-result@1.1'
      const artifact = this.ctx.artifacts.put({
        kind: 'report', bodySchema: schema,
        body: {
          schema, worker: row.worker, runtime: worker.runtime, runId: row.run_id,
          ...(row.session_id ? { sessionId: row.session_id } : {}), ...(handle ? { nativeHandle: handle } : {}),
          promptHash: sha256(row.prompt), sandbox: worker.sandbox, workspace,
          ...(captured ? { subject: captured.subject } : {}),
          ...(result.turns !== undefined ? { turns: result.turns } : {}), ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
          ...(usage.usage && result.model ? { model: result.model } : {}), ...usage,
          ...tiered,
          // The answer is bound to exactly what it answered: the earlier turns replayed, by run and answer, and the hash of all it was sent.
          ...(member ? { profile: REVIEW_MEMBER } : {}),
          ...(turn.replay ? { replay: { runs: turn.replay.runs, answers: turn.replay.answers, promptHash: sha256(turn.prompt) } } : {}),
          // What its own test runs did not run, as they reported it, or that it is not known (T265): a review is told.
          ...(notRun !== undefined ? { notRun } : {}), ...(reportUnread !== undefined ? { reportUnread } : {}),
          text: result.text,
        },
        ...(turn.replay ? { inputs: turn.replay.answers } : {}),
        classification: row.classification as 'public' | 'operator-shared' | 'local-private',
        producer: { type: 'worker', ref: row.worker },
      })
      this.update(row.run_id, { status: 'completed', result: artifact.id, ...(handle ? { native_handle: handle } : {}) }, lease)
    })
  }

  /**
   * Reserve the run's draw on its pool, recording the `budget` decision on the run. A refusal fails
   * the run before anything reaches the agent: `quota_exhausted` while the pool is unavailable,
   * `config_error` when the ledger does not configure it. Returns the reservation id.
   */
  private async reserve(row: RunRow, meter: Meter, lease: () => Lease): Promise<string> {
    // A run on a model with a pool of its own draws on both (ADR-0073): either closed refuses it.
    const lines = [{ pool: meter.pool, unit: 'runs' as const, amount: 1 }, ...(meter.model ? [{ pool: meter.model.pool, unit: 'runs' as const, amount: 1 }] : [])]
    const reserved = await meter.resources.reserve({ runId: row.run_id, ...scopeOf(row), lines }).catch((error: unknown) => {
      throw error instanceof ResourcesError ? new ProviderError('config_error', `the resource ledger refused to reserve for ${row.worker}: ${error.message}`, { cause: error }) : error
    })
    try {
      this.update(row.run_id, { budget_decision: reserved.decision, ...(reserved.state === 'reserved' ? { reservation_id: reserved.reservationId } : {}) }, lease)
    } catch (error) {
      if (reserved.state === 'reserved') await this.release(row.worker, reserved.reservationId)
      throw error
    }
    if (reserved.state === 'reserved') return reserved.reservationId
    const configured = await meter.resources.pools({ account: meter.account }).then((pools) => lines.every((l) => pools.some((p) => p.pool === l.pool)), () => true)
    const reasons = reserved.reasons.join('; ')
    throw new ProviderError(configured ? 'quota_exhausted' : 'config_error', `${row.worker} may not draw on pool ${lines.map((l) => l.pool).join(' and ')} now: ${reasons} (budget decision ${reserved.decision}); nothing was run`)
  }

  private async release(worker: string, reservationId: string): Promise<void> {
    const resources = this.ctx.get('resources')
    if (!resources) return
    await resources.release(reservationId).catch((error: unknown) => {
      // Released already (the run's own release, before a restart), or the ledger forgot it.
      if (error instanceof ResourcesError && error.failure === 'unknown-reservation') return
      this.ctx.logger.warn(`agent Workers: the reservation ${reservationId} of ${worker} could not be released: ${(error as Error).message}`)
    })
  }

  /**
   * Record a run whose usage the ledger could not count, as one `usage.unknown` event, its data a
   * `usage-unknown@1.0` record (docs/design/resources.md#usage-the-ledger-cannot-count): the run,
   * Worker, pool, board task, how it ended, and why. A cap counts the run as 0 until the ledger
   * counts a record of it. A fact that cannot be appended (no event log, the store failing) is
   * logged, never dropped silently, with what still holds the run unknown (`held`: a lower bound's
   * own record, which says it is one); the run's own outcome never depends on it.
   */
  private unknownUsage(row: RunRow, meter: Pick<Meter, 'pool' | 'account'>, kind: UsageUnknown['kind'], reason: string, extra: Pick<UsageUnknown, 'outcome' | 'failure' | 'record' | 'partial'> = {}, held?: string): void {
    try {
      const eventLog = this.ctx.get('eventLog')
      if (!eventLog) throw new Error('no event log (ctx.eventLog) is loaded')
      const fact = usageUnknown({
        runId: row.run_id, kind, account: meter.account, pool: meter.pool, worker: row.worker, ...(row.session_id ? { sessionId: row.session_id } : {}), ...scopeOf(row), ...extra,
        observedAt: now(), reason,
      })
      eventLog.append({ type: USAGE_UNKNOWN_EVENT, ...(row.workflow_run_id ? { runId: row.workflow_run_id } : {}), ...(row.session_id ? { sessionId: row.session_id } : {}), data: { ...fact } })
    } catch (error) {
      this.ctx.logger.warn(`agent Workers: the usage of ${row.run_id} on ${row.worker} (pool ${meter.pool}) is unknown (${kind}: ${reason}), and that could not be recorded: ${(error as Error).message}${held ? `; ${held}` : ''}`)
    }
  }

  /**
   * The ledger did not take a run's usage record. What can be recorded is: a record refused as
   * `invalid` with a per-model split is offered again with its totals alone, which are what a cap
   * counts. Otherwise the run's usage is unknown: a refused record is kept as an `evidence`
   * artifact (when it is a valid `usage-record@1.0`) that the fact names, `refused` with the
   * ledger's failure; anything else the ledger threw is `failed`. Never throws. Returns what the
   * ledger counted, its totals, if it took them.
   */
  private async unrecorded(row: RunRow, meter: Meter, record: UsageRecord, error: unknown): Promise<{ ref: ArtifactRef } | undefined> {
    let cause = error
    if (cause instanceof ResourcesError && cause.failure === 'invalid' && record.models) {
      const { models: _, ...totals } = record
      let taken: { ref: ArtifactRef } | undefined
      cause = await meter.resources.record(totals).then((r) => { taken = { ref: r.ref as ArtifactRef } }, (again: unknown) => again)
      if (cause === undefined) {
        this.ctx.logger.warn(`agent Workers: the ledger refused the per-model split of ${row.run_id} on ${row.worker} (${(error as Error).message}); its totals were recorded`)
        return taken
      }
    }
    const message = cause instanceof Error ? cause.message : String(cause)
    this.ctx.logger.warn(`agent Workers: the usage of ${row.run_id} on ${row.worker} was not recorded: ${message}`)
    const failure = cause instanceof ResourcesError && (cause.failure === 'invalid' || cause.failure === 'unknown-pool') ? cause.failure : undefined
    const kept = failure ? this.keep(row, record) : undefined
    this.unknownUsage(row, meter, failure ? 'refused' : 'failed', message, { ...(record.outcome ? { outcome: record.outcome } : {}), ...(failure ? { failure } : {}), ...(kept ? { record: kept } : {}) })
    return undefined
  }

  /** A record the ledger refused, as an `evidence` artifact when it is a valid `usage-record@1.0`, so its numbers are not lost; else nothing. */
  private keep(row: RunRow, record: UsageRecord): ArtifactRef | undefined {
    try {
      return this.ctx.artifacts.put({ kind: 'evidence', bodySchema: record.schema, body: record, classification: 'operator-shared', producer: { type: 'worker', ref: row.worker }, runId: row.run_id }).id as ArtifactRef
    } catch {
      return undefined
    }
  }

  /**
   * A metered run the host stopped while it ran: no result came, so the ledger counts none of its
   * usage until its transcript is reconciled. Recorded under the pool its reservation drew on, while
   * its Worker still names that pool (the account is the Worker's); else logged.
   */
  private interruptedUsage(row: RunRow): void {
    const worker = this.workers.get(row.worker)
    const decision = row.budget_decision ? this.ctx.artifacts.get(row.budget_decision)?.body as { outcome?: { detail?: { lines?: Array<{ pool?: unknown }> } } } | undefined : undefined
    const pool = decision?.outcome?.detail?.lines?.[0]?.pool
    if (worker?.account === undefined || pool === undefined || worker.pool !== pool) {
      this.ctx.logger.warn(`agent Workers: the usage of ${row.run_id} on ${row.worker} is unknown (the host stopped while it ran), and its Worker no longer names the pool it drew on to record that under`)
      return
    }
    this.unknownUsage(row, { pool: worker.pool, account: worker.account }, 'interrupted', 'the host stopped while it ran, so no result came', { outcome: 'failed' })
  }

  /**
   * Meter a run from what its runtime reported: each limit observation as a `limit-state`
   * reading, then one `usage-record` (source `runtime-result`). Numbers the runtime did not report
   * stay missing; a run that reported neither tokens nor turns gets no record here (its transcript
   * is reconciled later). A run that ended before its runtime's final count (`partial`: a stop, a
   * timeout, a drain, a deferred call) is recorded with what the runtime did report, a lower bound
   * that says so on the record itself (`usage-record@1.1`, `partial`), and stays a `not-reported`
   * unit that names that record (`usage-unknown@1.1`): a lower bound never reconciles it, so a cap
   * of its scope stays closed (INV-2, ADR-0065), even when the fact is never appended. A partial report with
   * no number above 0 is no record: a reported 0 would read as known. `ending`: how the run ended,
   * in plain words. The run's own outcome never depends on the ledger: a refusal is logged.
   * `report`: what the account's usage report said after the run (ADR-0059), recorded after the run's
   * own observations, so the latest reading has its share, and never opening a window a limit closed.
   * Whether a `limited` reading of the pool was recorded.
   *
   * A run that runs again after a host stop cut it (T283, `resumes` above 0) is metered the same way,
   * but what its runtime reports now is only what it used since the restart: its record is a lower
   * bound of the run (`partial` says so), so it never reconciles the run's unknown usage from before
   * the stop, which is left to transcript reconciliation (INV-2, never invented); and it is its own
   * unit, never a duplicate of the cut execution's record.
   */
  private async account(row: RunRow, worker: AgentWorkerConfig, meter: Meter, metering: RunMetering | undefined, outcome: 'completed' | 'failed' | 'aborted', durationMs: number, report: readonly LimitObservation[], ending: string): Promise<boolean> {
    const ran = metering?.limits?.length ? await this.observe(row.worker, worker, meter, metering.limits) : false
    const reported = report.length ? await this.observe(row.worker, worker, meter, report, true) : false
    const limited = ran || reported
    const usage = usageOf(metering)
    const again = row.resumes ? againPartial(row.resumes) : undefined
    const partial = [metering?.partial, again].filter((p): p is string => p !== undefined).join('; ').slice(0, 300) || undefined
    if ((!usage.usage && metering?.turns === undefined) || (partial && !anyCounted(usage.usage, metering?.turns))) {
      const said = partial ? `its runtime reported no number above 0${metering?.partial ? ' before it ended' : ''}: ${partial}` : 'its runtime reported neither tokens nor turns'
      this.unknownUsage(row, meter, 'not-reported', `${ending}; ${said}`, { outcome })
      this.ctx.logger.warn(`agent Workers: ${row.run_id} on ${row.worker} reported no usage (${ending}); it is left to transcript reconciliation`)
      return limited
    }
    // The model it asked for is its tier's (ADR-0073).
    const asked = this.atTier(worker, row.tier).model
    const model = { ...(asked ? { request: asked } : {}), ...(metering?.model ? { response: metering.model } : {}) }
    const record: UsageRecord = {
      // A lower bound says so on its record (`@1.1`, `partial`), in the ledger's one write of it: a
      // crash or a failed append before its fact never leaves it reading as the run's usage (INV-2).
      schema: partial ? 'usage-record@1.1' : 'usage-record@1.0',
      // The runtime's own identity of its result, so another source of the same unit is a duplicate;
      // without one, a run that ran again after a host stop is a unit of its own each time (T283).
      requestId: `${worker.runtime}:${metering?.resultId ?? (row.resumes ? `${row.run_id}:again-${row.resumes}` : row.run_id)}`,
      source: 'runtime-result', observedAt: now(), account: meter.account, pool: meter.pool, worker: row.worker, runId: row.run_id,
      ...(row.session_id ? { sessionId: row.session_id } : {}), ...scopeOf(row),
      ...(Object.keys(model).length ? { model } : {}), ...usage,
      ...(metering?.turns !== undefined ? { turns: metering.turns } : {}), durationMs: Math.max(0, Math.round(durationMs)),
      ...(metering?.costUsd !== undefined ? { cost: { amount: metering.costUsd, currency: 'USD' as const, basis: 'runtime-estimate' as const } } : {}),
      outcome, ...(partial ? { partial } : {}),
    }
    const recorded = await meter.resources.record(record).catch((error: unknown) => this.unrecorded(row, meter, record, error))
    // A lower bound counted: the run stays unknown, named with what was counted and why it is partial.
    if (partial && recorded) {
      this.unknownUsage(row, meter, 'not-reported', `${ending}; the ledger counted what its runtime reported while it ran (${figures(usage.usage, metering?.turns)}), a lower bound: ${partial}`, { outcome, partial: recorded.ref as ArtifactRef },
        'its record says it is a lower bound, so a cap of its scope and pool stays closed (INV-2); without the fact, health and the report do not name the run')
    }
    return limited
  }

  /**
   * Record the runtime's limit observations as readings of the pool's mapped windows; whether a
   * `limited` one was recorded. `report`: the observations are an account's usage report (ADR-0059),
   * which closes a window as a run's do, and never opens one a `limited` reading closed until the
   * later of its reset and cooldown: such an `ok` reading is not recorded, and is logged. Its
   * rejections are recorded first, so its own `ok` of a window it closes is not either.
   *
   * Every model's pool of the account gets its readings, but only a `limited` reading of a pool the
   * run drew on (the account's, and its own model's, `meter.model`) counts in the answer (ADR-0073):
   * another model's limit says nothing of the limit this run hit, so it never stands in for it, and
   * the run's own limit still closes its pools when nothing placed it.
   */
  private async observe(id: string, worker: AgentWorkerConfig, meter: Meter, limits: readonly LimitObservation[], report = false): Promise<boolean> {
    // A window a model's pool maps (ADR-0073) is a reading of that pool: its limit closes only the tiers
    // that run that model. Every other observation is the account's, as before (an unplaced limit closes it whole).
    const ofModels = (name: string): boolean => meter.models.some((m) => m.windows[name] !== undefined)
    const own = limits.filter((l) => worker.windows?.[l.window] !== undefined || !ofModels(l.window))
    let limited = own.length ? await this.observeIn(id, worker, meter, { pool: meter.pool, windows: worker.windows ?? {}, account: true }, own, report) : false
    for (const model of meter.models) {
      const mine = limits.filter((l) => model.windows[l.window] !== undefined)
      if (!mine.length) continue
      const closed = await this.observeIn(id, worker, meter, { pool: model.pool, windows: model.windows, account: false }, mine, report)
      if (model.pool === meter.model?.pool) limited = closed || limited
    }
    return limited
  }

  /**
   * Record observations as readings of one pool's mapped windows (the account's, or a model's,
   * ADR-0073); whether a `limited` one was recorded. On the account's pool, a limit hit it cannot place
   * closes every window, as before.
   */
  private async observeIn(id: string, worker: AgentWorkerConfig, meter: Meter, target: { pool: string; windows: Record<string, string>; account: boolean }, limits: readonly LimitObservation[], report: boolean): Promise<boolean> {
    const pool = await meter.resources.pools({ account: meter.account }).then((pools) => pools.find((p) => p.pool === target.pool), () => undefined)
    const cooldownMs = (worker.limitCooldownSeconds ?? 3600) * 1000
    let limited = false
    /** Windows this call closed: a report's `ok` of one of them is not recorded either. */
    const closed = new Set<string>()
    const ordered = report ? [...limits].sort((a, b) => Number(b.status === 'rejected') - Number(a.status === 'rejected')) : limits
    // A usage report read every period names the same unmapped windows each time: it says so once.
    const unmapped = (message: string): void => (report ? this.warnOnce(message) : this.ctx.logger.warn(message))
    for (const limit of ordered) {
      const windowId = target.windows[limit.window]
      const mapped = windowId === undefined ? undefined : pool?.windows.find((w) => w.id === windowId)
      // A limit hit the ledger cannot place (an unmapped or unnamed window) closes every window of
      // the account's pool: it is never retried on the same pool unseen (INV-2). Anything else unmapped is skipped.
      const windows = mapped ? [mapped] : limit.status === 'rejected' && target.account ? pool?.windows ?? [] : []
      if (!windows.length) {
        unmapped(`agent Workers: ${report ? `the usage report of ${meter.account}` : id} observed limit window ${limit.window}, which ${windowId === undefined ? 'its windows do not map' : `maps to ${windowId}, not a window of pool ${target.pool}`}; not recorded`)
        continue
      }
      for (const window of windows) {
        if (report && limit.status !== 'rejected') {
          const until = closed.has(window.id) ? Number.POSITIVE_INFINITY : closedUntil(pool, window.id)
          if (until !== undefined && Date.parse(limit.observedAt) < until) {
            this.ctx.logger.info(`agent Workers: the usage report of ${meter.account} reads window ${window.id} of pool ${target.pool} open (${limit.window}), and a limit closed it until ${Number.isFinite(until) ? new Date(until).toISOString() : 'a later reading'}; not recorded: a report never opens a window a limit closed`)
            continue
          }
        }
        const reading: LimitState = {
          schema: 'limit-state@1.0', pool: target.pool, account: meter.account,
          window: { id: window.id, kind: window.kind, ...(window.seconds !== undefined ? { seconds: window.seconds } : {}) },
          // A limit hit is limited until its reset, or, with none given, for the configured cooldown:
          // never unknown, which a pool configured to admit unknown windows would ignore.
          ...(limit.status !== 'rejected' ? { state: 'ok' as const, ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}) }
            : limit.resetsAt ? { state: 'limited' as const, resetsAt: limit.resetsAt }
              : { state: 'limited' as const, cooldownUntil: new Date(Date.parse(limit.observedAt) + cooldownMs).toISOString() }),
          ...(mapped && limit.usedPercentage !== undefined ? { usedPercentage: limit.usedPercentage } : {}),
          source: 'runtime-result', observedAt: limit.observedAt,
        }
        const recorded = await meter.resources.observe(reading).then(() => true, (error: unknown) => {
          this.ctx.logger.warn(`agent Workers: a limit reading of ${id} was not recorded: ${(error as Error).message}`)
          return false
        })
        if (recorded && reading.state === 'limited') {
          limited = true
          closed.add(window.id)
        }
      }
    }
    return limited
  }

  /**
   * A run failed `quota_exhausted`, and no `limited` reading of its pool was recorded: the runtime
   * reported no limit (it read no reset time, docs/design/agent-runtimes.md#limit-readings), one the ledger could not place,
   * or the Worker has no pool. The limit is never retried unseen (INV-2):
   * - a metered Worker's pool gets a `limited` reading (source `limit-notice`, the runtime's failure)
   *   on every window, for `limitCooldownSeconds`, as a `rejected` limit on an unmapped window does.
   *   A later reading says otherwise (an `ok` one opens the window again);
   * - a Worker with no pool, or one whose ledger did not take the readings, cools its account down (a
   *   hand-named Worker's, its runtime's):
   *   its Workers share the account's one sign-in. Every one of them is
   *   `quota-exhausted` until the latest `rejected` reset time its runtime named, else for
   *   `limitCooldownSeconds`, never more than seven days (INV-9). Event `agent-workers.cooldown`.
   */
  private async limitHit(row: RunRow, worker: WorkerSpec, meter: Meter | undefined, limits: LimitObservation[], message: string): Promise<void> {
    const at = Date.now()
    const cooldownMs = (worker.limitCooldownSeconds ?? 3600) * 1000
    const source = message.slice(0, 200)
    if (meter) {
      const pool = await meter.resources.pools({ account: meter.account }).then((pools) => pools.find((p) => p.pool === meter.pool), () => undefined)
      let recorded = 0
      for (const window of pool?.windows ?? []) {
        const reading: LimitState = {
          schema: 'limit-state@1.0', pool: meter.pool, account: meter.account,
          window: { id: window.id, kind: window.kind, ...(window.seconds !== undefined ? { seconds: window.seconds } : {}) },
          state: 'limited', cooldownUntil: new Date(at + cooldownMs).toISOString(), source: 'limit-notice', observedAt: new Date(at).toISOString(),
        }
        await meter.resources.observe(reading).then(() => recorded++, (error: unknown) => {
          this.ctx.logger.warn(`agent Workers: the limit ${row.worker} hit was not recorded on pool ${meter.pool}: ${(error as Error).message}`)
        })
      }
      if (recorded) {
        this.ctx.logger.warn(`agent Workers: ${row.worker} hit a usage limit its runtime gave no reading for; pool ${meter.pool} is closed for ${cooldownMs / 1000} s`)
        return
      }
    }
    // The latest reset time a rejected limit names, when it is still ahead; else the configured cooldown.
    const reset = Math.max(0, ...limits.filter((l) => l.status === 'rejected' && l.resetsAt).map((l) => Date.parse(l.resetsAt!)).filter((ms) => Number.isFinite(ms) && ms > at))
    const until = new Date(Math.min(reset || at + cooldownMs, at + MAX_COOLDOWN_MS)).toISOString()
    this.ctx.store.db.prepare(`INSERT INTO agent_cooldowns (runtime, until, worker, run_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (runtime) DO UPDATE SET until = excluded.until, worker = excluded.worker, run_id = excluded.run_id, source = excluded.source, created_at = excluded.created_at
      WHERE excluded.until > agent_cooldowns.until`).run(accountOf(worker), until, row.worker, row.run_id, source, now())
    try {
      this.ctx.get('eventLog')?.append({
        type: 'agent-workers.cooldown', ...(row.workflow_run_id ? { runId: row.workflow_run_id } : {}), ...(row.session_id ? { sessionId: row.session_id } : {}),
        data: { runtime: worker.runtime, ...(worker.derived ? { account: worker.derived.accountId } : {}), worker: row.worker, agentRun: row.run_id, until, source },
      })
    } catch (error) {
      this.ctx.logger.warn(`agent Workers: the cooldown event of ${row.run_id} was not appended: ${(error as Error).message}`)
    }
    this.ctx.logger.warn(`agent Workers: ${row.worker} hit a usage limit no ledger reading holds; every ${worker.derived ? `Worker of ${worker.derived.accountId}` : `${worker.runtime} Worker`} takes no run until ${until}`)
  }

  /** The cooldown a runtime's Workers are in now, if any; a lapsed one is gone. */
  private cooldown(runtime: string): { until: string; worker: string; run_id: string } | undefined {
    this.ctx.store.db.prepare('DELETE FROM agent_cooldowns WHERE until <= ?').run(now())
    return this.ctx.store.db.prepare('SELECT until, worker, run_id FROM agent_cooldowns WHERE runtime = ?').get(runtime) as { until: string; worker: string; run_id: string } | undefined
  }

  /**
   * Where a run waits its turn: a hand-named Worker's own scheduler, one run at a time; a derived
   * Worker's account's, `maxConcurrentRunsPerAccount` runs at once across its roles and one per Worker
   * (each Worker its own session of it). In-process: one daemon owns the runs (INV-1).
   */
  private scheduler(id: string, worker: WorkerSpec): ProviderScheduler {
    if (this.stopped.signal.aborted) throw new ProviderError('aborted', 'agent Workers stopped')
    const [map, key, capacity] = worker.derived ? [this.accountSchedulers, worker.derived.accountId, this.capacityOf(worker)] : [this.schedulers, id, 1]
    let scheduler = map.get(key)
    if (!scheduler) map.set(key, (scheduler = new ProviderScheduler(capacity)))
    return scheduler
  }

  /** `infrastructure`: what of the infrastructure alone ended it, when this source knows it (ADR-0069). */
  private fail(row: RunRow, error: unknown, lease: () => Lease, fields: Partial<Omit<RunRow, 'run_id'>> = {}, infrastructure?: ExecutionInfrastructure): void {
    const typed = toProviderError(error)
    this.update(row.run_id, { ...fields, status: 'failed', error: JSON.stringify({ kind: typed.kind, disposition: dispositionOf(typed.kind), message: typed.message, ...(infrastructure ? { infrastructure } : {}) }) }, lease)
  }

  private update(runId: string, fields: Partial<Omit<RunRow, 'run_id'>>, lease: () => Lease): void {
    const entries = Object.entries({ ...fields, updated_at: now() })
    this.ctx.store.transaction((db) => {
      this.ctx.leases.fence(lease())
      db.prepare(`UPDATE agent_runs SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE run_id = ?`).run(...entries.map(([, v]) => v as string | null), runId)
    })
    if (fields.status === 'completed' || fields.status === 'failed') {
      this.ctx.store.afterCommit(() => {
        for (const wake of this.waiters.get(runId) ?? []) wake()
        this.waiters.delete(runId)
      })
    }
  }

  private row(runId: string): RunRow | undefined {
    return this.ctx.store.db.prepare('SELECT * FROM agent_runs WHERE run_id = ?').get(runId) as RunRow | undefined
  }
}

/**
 * Until when a window's latest reading in `pool` closes it (ms): the later of its reset and cooldown
 * when it is `limited`, without end when it names neither; undefined when it is not `limited`.
 */
function closedUntil(pool: PoolState | undefined, windowId: string): number | undefined {
  const latest = pool?.readings.find((r) => r.window.id === windowId)
  if (latest?.state !== 'limited') return undefined
  const times = [latest.resetsAt, latest.cooldownUntil].filter((t): t is string => t !== undefined).map((t) => Date.parse(t)).filter((t) => Number.isFinite(t))
  return times.length ? Math.max(...times) : Number.POSITIVE_INFINITY
}

/**
 * Whether a runtime's evidence admits a Worker: available, reads confined, its sandbox enforced, and a
 * gate asked before each tool call; a research role's (T262), web tools offered on a read-only run too.
 */
function admits(evidence: RuntimeEvidence, worker: AgentWorkerConfig): boolean {
  return evidence.available && evidence.readsConfined && evidence.gatesToolCalls === true && evidence.sandboxes.includes(worker.sandbox) && (!worker.research || evidence.webTools === true)
}

/**
 * The failures of a sent run that its Worker going away can cause (its runtime, process, session, or
 * sign-in), so a source looks whether it did (ADR-0069). Never one of the run's own: a timeout, a
 * limit, a violation (`reconciliation_failed`), a denial, a stop, or its input.
 */
const WORKER_GONE_KINDS: ReadonlySet<string> = new Set(['session_broken', 'provider_stalled', 'network', 'internal', 'config_error', 'reauth_required'])

/** The longest reason an unavailable Worker's descriptor carries (`capability-descriptor@1.9`). */
const MAX_UNAVAILABLE_REASON = 300

/**
 * Why a runtime's evidence does not admit a Worker, for people: the probe's own detail, and what of
 * {@link admits} it misses beyond being unavailable. Undefined when it admits it.
 */
function refusalOf(evidence: RuntimeEvidence, worker: AgentWorkerConfig): string | undefined {
  if (admits(evidence, worker)) return undefined
  if (!evidence.available) return `its ${worker.runtime} probe failed: ${evidence.detail}`
  const missing = [
    ...(evidence.readsConfined ? [] : ['cannot keep host state unreadable']),
    ...(evidence.gatesToolCalls === true ? [] : ["cannot ask the run's gate before each tool call"]),
    ...(evidence.sandboxes.includes(worker.sandbox) ? [] : [`cannot enforce its ${worker.sandbox} sandbox`]),
    ...(!worker.research || evidence.webTools === true ? [] : ['offers no web tools to a research role\'s read-only run']),
  ]
  return `its ${worker.runtime} runtime ${missing.join(', and ')} (${evidence.detail})`
}

/** A reason as a descriptor carries it: one line, at most {@link MAX_UNAVAILABLE_REASON} characters. */
function boundedReason(text: string): string {
  const line = text.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim() || 'its Worker source gave no detail'
  const chars = [...line]
  return chars.length <= MAX_UNAVAILABLE_REASON ? line : `${chars.slice(0, MAX_UNAVAILABLE_REASON - 1).join('')}…`
}

/**
 * The failure of a run that stopped at a deferred tool call. The workers seam has no waiting
 * status, so it fails as `config_error` (never retried), naming the request; a later run of its
 * session makes the call once the operator approved it.
 */
function waiting(row: RunRow, deferred: Deferral, cause?: unknown): ProviderError {
  return new ProviderError('config_error', `${row.worker} stopped at its ${deferred.tool} call, which waits for the operator's approval (approval request ${deferred.requestId}); nothing of that call ran. `
    + `Once it is approved, a later run of session ${row.session_id ?? '(none)'} makes exactly that call`, cause === undefined ? undefined : { cause })
}

function execution(row: RunRow): WorkerExecution {
  return {
    id: row.run_id, status: row.status, submitted: row.submitted_at !== null,
    ...(row.result ? { result: row.result as ArtifactRef } : {}),
    ...(row.error ? { error: JSON.parse(row.error) as WorkerExecution['error'] & object } : {}),
    decisions: [row.egress_decision, row.setup_decision, row.budget_decision, row.liveness_decision, row.liveness_freed, row.resume_decision].filter((d): d is string => typeof d === 'string').map((d) => d as ContentId),
  }
}

/** A probe as a reason reads it: `present`, or its state and why. */
function describeProbe(probe: ProcessProbe): string {
  return 'why' in probe ? `${probe.state} (${probe.why})` : probe.state
}

/**
 * What freeing a run did: the operator's decision, what it held that is free now (none when it was
 * freed already), and each worktree of its workflow run, removed or kept, and why.
 */
export interface FreeOutcome {
  agentRun: string
  worker: string
  decision: ContentId
  again: boolean
  freed: string[]
  worktrees: WorktreeRelease[]
}

/** The run worktrees not removed (`agent_worktrees`): the retention in force, at most 100 of them, and how many in all. */
export interface WorktreeListing {
  retentionHours: number
  worktrees: RunWorktree[]
  total: number
}

/**
 * What the operator's removal of finished worktrees did (`agent_worktrees_remove`): their `retention`
 * decision, when one was removable; each worktree removed or kept, and why; and how many it did not
 * look at (more than 50).
 */
export interface WorktreeRemoval {
  decision?: ContentId
  worktrees: RunWorktreeRelease[]
  more: number
}

/** The most reasons a decision's candidate holds, and the longest one (decision@1.x `candidates[].reasons`). */
const DECISION_REASONS = 32
const DECISION_REASON_LENGTH = 300

/** `text` cut to `max` characters, an ellipsis marking the cut. */
function clip(text: string, max = DECISION_REASON_LENGTH): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * The reasons of the operator's removal (T250), within the decision's bounds however many worktrees
 * it removes: the operator's ask, then each worktree and why while they fit; else the worktrees
 * counted by why, the last line saying how many more. Every worktree is named in the outcome's detail.
 */
function removalReasons(ask: string, removing: ReadonlyArray<{ runId: string; path: string; why: string }>): string[] {
  const room = DECISION_REASONS - 1
  if (removing.length <= room) return [clip(ask), ...removing.map((p) => clip(`worktree ${p.path} of ${p.runId}: ${p.why}`))]
  const byWhy = new Map<string, number>()
  for (const p of removing) byWhy.set(p.why, (byWhy.get(p.why) ?? 0) + 1)
  const groups = [...byWhy].map(([why, n]) => ({ why, n }))
  const shown = groups.length <= room ? groups : groups.slice(0, room - 1)
  const rest = groups.slice(shown.length).reduce((sum, g) => sum + g.n, 0)
  return [
    clip(`${removing.length} worktrees, each named in the outcome's detail; ${ask}`),
    ...shown.map((g) => clip(`${g.n} worktree(s): ${g.why}`)),
    ...(rest ? [`and ${rest} more worktree(s), each with its own why, named in the outcome's detail`] : []),
  ]
}

/** A stored JSON column's value, or undefined when it holds nothing readable. */
function parsed(json: string | null | undefined): unknown {
  if (!json) return undefined
  try {
    return JSON.parse(json) as unknown
  } catch {
    return undefined
  }
}

/** Whether `dir` is a directory that can be read and holds nothing. */
function emptyDirectory(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0
  } catch {
    return false
  }
}

/**
 * The top level of the git work tree that holds `dir`, by git's own search; undefined when git
 * finds none. Throws when git cannot tell (a bare repository, an unsafe one, no git): the caller
 * then fails closed.
 */
function repositoryOf(dir: string): string | undefined {
  try {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
    return execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', dir, 'rev-parse', '--show-toplevel'], { env, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim() || dir
  } catch (error) {
    if (/not a git repository/i.test(String((error as { stderr?: unknown }).stderr ?? ''))) return undefined
    throw error
  }
}

/** What a run sends its agent, and how its session continues. */
interface Turn {
  prompt: string
  /** The strictest classification of what it holds (INV-12). */
  classification: Classification
  /** The native conversation it continues, on a runtime that resumes one. */
  resume?: string
  /** Its runtime keeps the conversation itself: the session keeps the run's native handle. */
  native: boolean
  /** The earlier turns it replays (ADR-0049): their runs and their answers, in order. */
  replay?: { runs: string[]; answers: ArtifactRef[] }
}

/** A part of a replayed conversation, between fence lines derived from its own text, which that text cannot close. */
function fenced(label: string, text: string): string {
  const fence = `~~~~ ${sha256(`${label}\0${text}`).slice(-12)} ~~~~`
  return `### ${label}, between the lines ${fence}\n${fence}\n${text}\n${fence}`
}

/**
 * A review member's conversation replayed for a runtime that cannot resume it (ADR-0049): its
 * earlier turns as they were, each the message it was given and its answer, in order, then the
 * conversation's next message.
 */
function replayed(turns: ReadonlyArray<{ prompt: string; answer: string }>, next: string): string {
  return [
    `This message continues a conversation you had earlier. Its ${turns.length} earlier turn(s) follow as they were, in order: each message you were given, and your answer to it. Then comes the conversation's next message, which you answer now.`,
    ...turns.flatMap((t, i) => [fenced(`Turn ${i + 1}: the message you were given`, t.prompt), fenced(`Turn ${i + 1}: your answer`, t.answer)]),
    `### The conversation's next message\n${next}`,
  ].join('\n\n')
}

/** The ledger a metered Worker draws on. */
interface Meter {
  resources: Resources
  /** The account's own pool: what every run of it draws on, and where its usage is recorded. */
  pool: string
  account: string
  /** The run's model's own pool (ADR-0073), when its tier's model has one: reserved on beside the account's. */
  model?: { pool: string; windows: Record<string, string> } | undefined
  /** Every model's own pool of the account (ADR-0073): an observation one of them maps is a reading of that pool, never of the account's. */
  models: Array<{ pool: string; windows: Record<string, string> }>
}

/** What a run's draw is watched with (PROP-0015 E2): its pool before it, when it started, and the end of its overlap watch (the other runs it overlapped). */
interface Drawing {
  before: PoolState | undefined
  startedAt: string
  end: () => number
}

/**
 * The token usage of a run as records carry it: totals, and the per-model split when it fits
 * (at most `MAX_MODELS`, or the totals alone).
 */
function usageOf(metering: RunMetering | undefined): Pick<UsageRecord, 'usage' | 'models'> {
  if (!metering?.usage) return {}
  const models = metering.models && metering.models.length <= MAX_MODELS ? metering.models : undefined
  return { usage: { ...metering.usage }, ...(models ? { models: models.map((m) => ({ model: m.model, usage: { ...m.usage }, ...(m.costUsd !== undefined ? { costUsd: m.costUsd } : {}) })) } : {}) }
}

/** Whether a partial report carries a number above 0: a token count or a turn. */
function anyCounted(usage: UsageRecord['usage'], turns: number | undefined): boolean {
  return (usage !== undefined && usage.inputTokens + usage.outputTokens > 0) || (turns ?? 0) > 0
}

/** A report's figures in words: "412,300 input and 9,800 output tokens, 14 turns". */
function figures(usage: UsageRecord['usage'], turns: number | undefined): string {
  const n = (value: number): string => value.toLocaleString('en-US')
  return [
    ...(usage ? [`${n(usage.inputTokens)} input and ${n(usage.outputTokens)} output tokens`] : []),
    ...(turns !== undefined ? [`${n(turns)} turn${turns === 1 ? '' : 's'}`] : []),
  ].join(', ')
}

export type { RunWorktree, RunWorktreeRelease, SweepOutcome } from './worktrees.ts'
export default AgentWorkers
