/**
 * Gate seam definitions: `ctx.workers` and `ctx.egress` (explicit data egress, INV-12; see
 * `./egress.ts`). `ctx.workers` is the routing seam: the Worker registry and deterministic router
 * (docs/design/routing.md). Worker sources (the website turn runtime today; agent runtimes
 * later) register for their plugin's lifetime and describe what each Worker proves now;
 * `route` turns a work requirement into one admitted Worker or an {@link AdmissionFailure}.
 * The vocabulary below mirrors `schemas/common.v1.json`, which is canonical.
 * @module @tsuuanmi/system-workers-core
 */
import { type Context, Service } from '@deepseek-ai/cordis'

export * from './egress.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workers: Workers
  }
}

/** A content id (`sha256:<hex>`) of an artifact. */
export type ArtifactRef = `sha256:${string}`
export type Tier = 'economy' | 'standard' | 'frontier'
/** Tiers in ascending order of intelligence (purpose P4). */
export const TIERS: readonly Tier[] = ['economy', 'standard', 'frontier']
export type QuotaClass = 'subscription-chat' | 'agent-plan' | 'metered' | 'local'
export type Classification = 'public' | 'operator-shared' | 'local-private'
export type WorkerState = 'ready' | 'busy' | 'quota-exhausted' | 'reauth-required' | 'unavailable'

/**
 * How busy a Worker's runtime is (`@1.3`; ADR-0033): turns running in its `slots`, queued, and
 * routed to it but not started yet (`pending`). Workers that share a runtime (the tiers of one
 * account) report the same numbers.
 */
export interface WorkerLoad {
  running: number
  queued: number
  pending: number
  slots: number
}

/**
 * A kind of work a capability offer may be limited to (ADR-0049): `review-member`, a step of a
 * review team's member. A requirement names it (`WorkRequirement.scope`); an offer scoped to it
 * proves its capability for that work only.
 */
export type WorkScope = 'review-member'
export const WORK_SCOPES: readonly WorkScope[] = ['review-member']

/** One capability a Worker proves, with its evidence; `scope` (`@1.4`) limits it to work of that scope. */
export interface CapabilityOffer {
  capability: string
  evidence: { kind: 'probe' | 'conformance' | 'plan' | 'sandbox-policy'; ref?: ArtifactRef; at: string }
  /** Proven only for work whose requirement names this scope, never for other work (`@1.4`; ADR-0049). */
  scope?: WorkScope
}

/** Whether an offer proves its capability for this work: an unscoped one always, a scoped one only for work of its scope. */
export const provesFor = (offer: CapabilityOffer, requirement: Pick<WorkRequirement, 'scope'>): boolean =>
  offer.scope === undefined || offer.scope === requirement.scope

/**
 * A kind of work the operator routes by (ADR-0057; `schemas/common.v1.json` `workKind`): an opaque
 * label a workflow step names (`WorkRequirement.kind`) and the operator's Worker configuration lists
 * (`CapabilityDescriptor.kinds`), such as `code` or `docs`. Never a tool, model, or vendor name (INV-11).
 */
export const WORK_KIND = /^[a-z][a-z0-9-]{0,31}$/

/**
 * Whether a Worker takes this work by its kind (ADR-0057): a Worker that lists no kinds takes work of
 * any kind, or of none; one that lists kinds takes only work that names one of them. Equality only.
 */
export const takesKind = (worker: Pick<CapabilityDescriptor, 'kinds'>, requirement: Pick<WorkRequirement, 'kind'>): boolean =>
  worker.kinds === undefined || (requirement.kind !== undefined && worker.kinds.includes(requirement.kind))

/**
 * How a provider's accounts are used (ADR-0052): `assigned` (the default), each account serving its
 * own work, a limit never moving that work to another account of the provider; or `pooled`, only on
 * the operator's recorded decision to pool that provider (ADR-0055).
 */
export type AccountMode = 'assigned' | 'pooled'

/**
 * The account a Worker runs on (`@1.5`; ADR-0052), as opaque values its source sets: routing
 * compares `id` and `group` for equality only and never names one (INV-11).
 */
export interface WorkerAccount {
  /** The account: every Worker of one account (its tiers, its roles) carries the same id. */
  id: string
  /** The accounts it is compared with: a website's provider, an agent runtime. */
  group: string
  mode: AccountMode
  /** When an account whose Worker reads `quota-exhausted` is expected back, when its source knows. */
  limitUntil?: string
}

/**
 * One tier a Worker offers (`@1.10`; ADR-0073): the tier, the ledger pools a run at it draws on (its
 * account's own and its model's, opaque ids), and, when its model's pool is closed now, until when
 * (`closed`; `until` when known). Routing serves a Worker at the lowest offered tier within a
 * requirement's bounds that is not closed ({@link servedTier}); it never names a model (INV-11).
 */
export interface TierOffer {
  tier: Tier
  /** The ledger pools a run at this tier draws on; absent: every pool of its account. */
  pools?: string[]
  /** Its model's limit closes this tier now (the Worker's other tiers stay open). */
  closed?: true
  /** When a closed tier is expected back, when its source knows. */
  until?: string
  /** `@1.11`: its model's display label, as the live profile gives it (for people only, never a routing input). */
  label?: string
  /** `@1.11`: the turn limit a run at this tier gets, when one is set. */
  maxTurns?: number
}

/** The tiers a Worker offers, lowest first: its `tiers` (`@1.10`), else its one `tier`. */
export const offeredTiers = (worker: Pick<CapabilityDescriptor, 'tier' | 'tiers'>): TierOffer[] =>
  worker.tiers?.length ? [...worker.tiers].sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier)) : [{ tier: worker.tier }]

/** The offers of a Worker within a requirement's tier bounds, lowest first, closed ones included. */
export const tiersWithin = (worker: Pick<CapabilityDescriptor, 'tier' | 'tiers'>, bounds: WorkRequirement['tier']): TierOffer[] =>
  offeredTiers(worker).filter((o) => TIERS.indexOf(o.tier) >= TIERS.indexOf(bounds.min) && (bounds.max === undefined || TIERS.indexOf(o.tier) <= TIERS.indexOf(bounds.max)))

/**
 * The offer a Worker serves work at (ADR-0073): the lowest offered tier within the requirement's
 * bounds whose model's pool is open; undefined when none is (routing then refuses it, for its `tier`
 * or, when its tiers in bounds are only closed, its limit).
 */
export const servedTier = (worker: Pick<CapabilityDescriptor, 'tier' | 'tiers'>, bounds: WorkRequirement['tier']): TierOffer | undefined =>
  tiersWithin(worker, bounds).find((o) => !o.closed)

/** What a Worker has proven right now (`capability-descriptor@1.0`; `@1.1` adds `family`). */
export interface CapabilityDescriptor {
  schema: 'capability-descriptor@1.0' | 'capability-descriptor@1.1' | 'capability-descriptor@1.2' | 'capability-descriptor@1.3' | 'capability-descriptor@1.4' | 'capability-descriptor@1.5' | 'capability-descriptor@1.6' | 'capability-descriptor@1.7' | 'capability-descriptor@1.8' | 'capability-descriptor@1.9' | 'capability-descriptor@1.10' | 'capability-descriptor@1.11' | 'capability-descriptor@1.12'
  worker: string
  /** Informational only; routing never branches on it (INV-11). */
  provider: string
  /**
   * Who ultimately serves the work, as an opaque string its Worker source sets (ADR-0027).
   * Routing only compares it for inequality (`RouteOptions.exclude`), and never names or ranks one.
   */
  family?: string
  /**
   * What the Worker is for, in the operator's words (`@1.7`): the `description` of the
   * configuration row that defines it, at most `MAX_DESCRIPTION` characters (`libs`; a website
   * Worker's carries its tier as well). For people only: routing never reads it.
   */
  description?: string
  /**
   * Its name for people (`@1.8`), as its source gives it: a website provider's own title (its
   * driver's), a model's from the operator's catalog entry; plain text on one line, at most
   * `MAX_LABEL` characters (`libs`). The roster's display name starts with it. For people only:
   * routing never reads it, and only a provider plugin or the operator names a tool in it (INV-11).
   */
  title?: string
  /**
   * Why it takes no work (`@1.9`), when its state is `unavailable` and its source knows: a failed
   * probe's detail, a workspace problem, a gate's reason. Plain text on one line, at most 300
   * characters. For people only (the roster, capacity, health): routing never reads it.
   */
  unavailableReason?: string
  /**
   * When its source expects to know again whether this unavailable Worker takes work (`@1.12`,
   * T282): it is unavailable only for a while that passes by itself, as an agent runtime's late
   * probe, whose next result is due by then. Only with state `unavailable`; its capabilities are what
   * it last proved. Routing tells a caller to try the work again then (`AdmissionFailure.retryAt`).
   */
  expectedBack?: string
  /**
   * The longest input this Worker takes, in characters (code points) of what it is sent, when its
   * source knows one (`@1.2`; ADR-0032). Admission refuses it work whose input is longer.
   */
  maxInputChars?: number
  /** How busy it is (`@1.3`; ADR-0033): among equally ranked Workers, the least busy is routed to. */
  load?: WorkerLoad
  /**
   * Capabilities it proves but may not use until `until`: a site's usage limit (`@1.3`; ADR-0034).
   * Work that needs one is not admitted here.
   */
  cooldowns?: Array<{ capability: string; until: string }>
  /**
   * The account it runs on (`@1.5`; ADR-0052). Under `assigned`, while it is refused only for its
   * limit, no other account of its group is admitted the same work (check `assignment`). A Worker
   * with none is routed as before.
   */
  account?: WorkerAccount
  /**
   * The kinds of work the operator gives it (`@1.6`; ADR-0057): it takes only work whose requirement
   * names one of them ({@link takesKind}; check `capability`). Absent: work of any kind, or of none.
   */
  kinds?: string[]
  /** Its lowest tier; with `tiers`, the first of them. */
  tier: Tier
  /**
   * Every tier it offers (`@1.10`; ADR-0073), each once, its lowest equal to `tier`: one Worker of an
   * agent role that declares a model per tier. Absent: it offers `tier` alone, as before.
   */
  tiers?: TierOffer[]
  quotaClass: QuotaClass
  locality: 'local' | 'remote'
  capabilities: CapabilityOffer[]
  state: WorkerState
  observedAt: string
}

/** The input to routing (`work-requirement@1.0`; `@1.1` adds `scope`, `@1.2` `kind`, `@1.3` `prefers`). */
export interface WorkRequirement {
  schema: 'work-requirement@1.0' | 'work-requirement@1.1' | 'work-requirement@1.2' | 'work-requirement@1.3'
  objective: string
  capabilities: string[]
  /**
   * Capabilities the work prefers but does not need (`@1.3`; T262): among the admitted Workers, one
   * that proves every one of them (for this work, as {@link provesFor} reads it) ranks before one that
   * does not, after the reserve key and before tier. Never a refusal, and never a family: the research
   * template's second review prefers `web-search`, so a Worker that can search is chosen before one
   * that can only cite. Set by the workflow engine from the admitted spec, never from model text.
   */
  prefers?: string[]
  /**
   * The kind of work this is (`@1.1`; ADR-0049), so offers scoped to it count: set by the workflow
   * engine from the admitted spec (a review team member's step), never from a template or model text.
   */
  scope?: WorkScope
  /**
   * The kind of work this is (`@1.2`; ADR-0057), for Workers the operator gives kinds: such a Worker
   * takes it only when it lists this kind. Set by the workflow engine from the admitted spec (a
   * template step, or the variant the caller chose), never from model text (INV-6).
   */
  kind?: string
  data: { classification: Classification; refs: ArtifactRef[] }
  /** Policy id from a trusted envelope (INV-6, INV-12). */
  egressPolicy: string
  boundaries?: string[]
  effort?: { maxToolCalls?: number; maxSubWorkers?: number; maxMinutes?: number }
  writes?: { type: 'content' | 'git-head' | 'pull-request' | 'artifact' | 'external'; ref: string; version?: string }
  tier: { min: Tier; max?: Tier; source: 'profile' | 'caller' | 'decision' | 'default'; decision?: ArtifactRef }
  budget?: { maxTokens?: number; preferQuota?: QuotaClass[] }
  acceptance: { contract: string; resultSchema?: string; maxEscalations?: number }
}

/** What a caller asks one admitted Worker to do. */
export interface WorkerStart {
  /** Idempotency key: the same key returns the same execution, and nothing runs twice. */
  key: string
  /** The admitted Worker, one of this source's. */
  worker: string
  /**
   * The input, already rendered, for a caller that composes no brief. Exactly one of `prompt` and
   * `brief`.
   */
  prompt?: string | undefined
  /**
   * The `brief@1.x` (an `objective` artifact) the execution serves, recorded before the start. The
   * source renders its own prompt from it at start, resolving each pointer to its artifact's text
   * (`renderBrief` in `@tsuuanmi/system-libs` is the default text rendering), and checks egress on
   * what it rendered, at the requirement's classification, as for any prompt (INV-12).
   * A brief it cannot render (a pointer no longer stored) refuses the start: nothing is sent.
   */
  brief?: ArtifactRef | undefined
  /** Continue (or open, on first use) this persistent session. */
  sessionId?: string | undefined
  /**
   * The workflow run this execution belongs to, when it belongs to one. A source may keep state
   * per run by it: the `agents` source gives a run a git worktree of its own.
   */
  runId?: string | undefined
  /**
   * The workflow template and the step (node id) of it this execution serves, when it serves one: set
   * by the workflow engine from its own record, never from model text (INV-6). A source may record it
   * with what the execution drew (the `agents` source's `quota-draw@1.0`, PROP-0015 E2).
   */
  step?: { template: string; node: string } | undefined
  /**
   * The tier routing served the work at (`AdmittedWorker.tier`, ADR-0073), for a Worker that offers
   * several: its source runs that tier's model. Absent: the source serves the lowest tier it offers at
   * or above the requirement's minimum, by the same rule.
   */
  tier?: Tier | undefined
  /** The requirement the Worker was admitted for, and the decisions that admitted it. */
  requirement: WorkRequirement
  decisions: { tier: ArtifactRef; route: ArtifactRef }
}

export type ExecutionStatus = 'queued' | 'running' | 'completed' | 'failed'

/**
 * The confinement a Worker's run is held to (`brief@1.x` `sandbox`), from its source's trusted
 * configuration, never from model text: whether it may write a workspace (which one), reach the
 * network beyond what the egress policy allows, and run commands.
 */
export interface WorkerSandbox {
  mode: 'read-only' | 'workspace-write'
  workspace?: string
  network: 'none' | 'allow-list'
  commands?: boolean
}

/** One execution, as its owning runtime reports it. */
/** What of the infrastructure alone ended an execution, as its source knows it (ADR-0069). */
export type ExecutionInfrastructure = 'host-stopped' | 'worker-unavailable'

export interface WorkerExecution {
  id: string
  status: ExecutionStatus
  /** The input reached the Worker: a caller must never start it again (INV-4). */
  submitted: boolean
  /** The stored result, once completed. */
  result?: ArtifactRef
  /**
   * Why it failed. `siteError` (optional, ADR-0062): the input was sent, and the site answered it with
   * its own error in place of an answer, read on the execution's own page; nothing was answered. Only
   * a source that read that says so; absent, nothing is known of it.
   *
   * `infrastructure` (optional, ADR-0069): the source knows it failed only on the infrastructure,
   * whatever was sent: `host-stopped`, its holder stopped with it in flight (a drain or restart of
   * the host) and the source ended it for that alone when it started again; `worker-unavailable`,
   * its Worker became unavailable while it ran (its runtime, account, or process gone) and that
   * alone ended it. Only a source that knows the cause says so; a failure for any reason of the
   * execution's own (a sandbox or worktree violation, a result not captured, its own answer) never
   * carries it. A caller does not count such a failure against the work it served.
   */
  error?: { kind: string; disposition: string; message: string; siteError?: true; infrastructure?: ExecutionInfrastructure }
  /** Decisions the runtime made for this execution, such as `egress`. */
  decisions: ArtifactRef[]
}

/**
 * Where a run's liveness needs the operator's look (PROP-0013, ADR-0056):
 * - `stalled`: running, its agent process present and quiet for the source's stall bound; nothing is
 *   sent to it, and its own deadline ends it;
 * - `looking`: started, its holder no longer holds it, and it is not known to be gone: verdicts are
 *   being taken, and it reaches the operator unless one finds it gone;
 * - `unknown`: it ended without being known to be gone, so what it ran in (its session, its
 *   workspace) stays held until the operator frees it.
 */
export type LivenessState = 'stalled' | 'looking' | 'unknown'
export const LIVENESS_STATES: readonly LivenessState[] = ['unknown', 'looking', 'stalled']

/** Runs one source lists at most in a {@link LivenessReport} (INV-9); its `counts` count them all. */
export const MAX_LIVENESS_RUNS = 64

/** A run whose liveness needs the operator's look, as the source that ran it tells it. */
export interface RunLiveness {
  /** The execution, by its source's id. */
  execution: string
  worker: string
  state: LivenessState
  /** Since when it is in this state (ISO 8601). */
  since: string
  /** The latest verdict given on it, by the rule the source names (such as `liveness@1`). */
  verdict?: string
  /** The verdicts taken in a row, and how many it gets before it goes to the operator. */
  looks?: { taken: number; max: number }
  /** Why: each signal as last found (the holder, the agent process, the activity). */
  reasons: string[]
  /** The decision that ended it, for `unknown`. */
  decision?: ArtifactRef
  /** What it holds: its session, its workspace, each in words. */
  holds: string[]
  /** What the operator can do now, in one sentence. */
  action: string
  /** The workflow run it served, and its session, when it has them. */
  runId?: string
  sessionId?: string
}

/** What a source tells of the runs whose liveness needs a look: at most {@link MAX_LIVENESS_RUNS}, the latest first, and how many there are in each state. */
export interface LivenessReport {
  runs: RunLiveness[]
  counts: Record<LivenessState, number>
}

/** Which runs to tell of: those of one workflow run, or one execution; none, every one. */
export interface LivenessQuery {
  runId?: string
  execution?: string
}

/**
 * One step of landing an accepted result (ADR-0060, PROP-0013 W5): what the source that owns a
 * workflow run's worktree does with it, on the workflow engine's ask.
 * - `commit`: commit the worktree's changes on its branch, only while the worktree is still exactly
 *   `subject` (the tree the result was accepted on), with `message`;
 * - `merge`: merge the branch, only while it is still at `head`, into the repository's checked-out
 *   branch `base.branch`, only while that is still at `base.sha` and its working tree is clean, as one
 *   merge commit with `message`. Never a force, a reset, or a push.
 * - `rebase` (ADR-0068): the result's change, the branch at `head` against where it forked from the
 *   base, made again on top of `base.sha` in the worktree, the branch moved there; `phase` `start`
 *   replays it (the declared generated files made again, the new commit on the branch with `message`
 *   when nothing else conflicts; else the worktree left on its branch at `base.sha`, the replay
 *   uncommitted, the conflicted files marked, for a writing step to resolve); `resolved` commits a
 *   resolution once no conflict marker is left; `abandon` puts the branch and the worktree back at
 *   `head`. Only while the worktree is intact and no agent run of the workflow run can still write it
 *   (INV-15). The pre-rebase head is kept under a ref of the repository's own; never a push.
 *   `stacked` (the landing queue's batch): `base.sha` is the rebased head of the result before it in the
 *   stack, not the base branch's own head; it is accepted while it holds the base branch's head.
 * - `record` (board T232): keep the worktree's tree, while it is still exactly `subject`, as a commit
 *   with `message` on the run's own history ref ({@link reviewRef}), on top of the last one recorded
 *   there (else the worktree's HEAD): what each review read, and each fix's result, one commit each.
 *   The worktree's HEAD, branch, index, and files are never touched, so a board task bound to its HEAD
 *   still binds the run's result.
 */
export type LandStep =
  | { step: 'commit'; runId: string; workspace: string; subject: { ref: string; version: string }; message: string }
  | { step: 'record'; runId: string; workspace: string; subject: { ref: string; version: string }; message: string }
  | { step: 'merge'; runId: string; workspace: string; head: string; base: { branch: string; sha: string }; message: string }
  | { step: 'rebase'; runId: string; workspace: string; phase: RebasePhase; head: string; base: { branch: string; sha: string }; message: string; stacked?: true }

/** The ref that keeps a workflow run's review history (a {@link LandStep} `record`): never its branch, never checked out. */
export const reviewRef = (runId: string): string => `refs/system/reviews/${runId}`

/** Where a {@link LandStep} `rebase` is (ADR-0068). */
export type RebasePhase = 'start' | 'resolved' | 'abandon'
export const REBASE_PHASES: readonly RebasePhase[] = ['start', 'resolved', 'abandon']

/**
 * A merge's generated files made again (T166): the files (repository-relative) the merge conflicted in
 * or the commands changed, the commands that made them (as configured), and the autonomy decisions
 * they ran on.
 */
export interface Regenerated {
  files: string[]
  commands: string[]
  autonomy: string[]
}

/** Why a landing step changed nothing: everything stays as it was. */
export type LandRefusal = 'moved' | 'gone' | 'busy' | 'base-moved' | 'head-moved' | 'dirty' | 'conflict' | 'failed'

/**
 * What a landing step did (ADR-0060):
 * - `committed`: the branch's `head` holds the accepted change (`committed` false when it already
 *   did, such as after a restart); `base` is the repository's checked-out branch now, `contained`
 *   whether it already holds `head` (nothing to merge), `stat` the change against it (`git diff
 *   --stat`, bounded);
 * - `merged`: `commit` is the base branch's new head, which holds `head` (`already` when it held it
 *   before this step, such as after a restart); `regenerated` when the merge conflicted only in files
 *   the repository declares generated, and they were made again by its commands (T166);
 * - `refused`: nothing changed, and why.
 *
 * `committed` names, optionally, `fork`: where `head` forked from the base branch (their merge base);
 * one that is not `base.sha` means the base moved since the result's work started (ADR-0068). A
 * `rebase` step (ADR-0068) answers:
 * - `rebased`: the branch's `head` is the change made again on top of `base.sha` (from `from`), the
 *   worktree clean there at `subject`; `stat` the change against the base; `regenerated` when the
 *   declared generated files were made again; `already` when it was before this step (a restart);
 * - `conflicted`: the worktree is on its branch at `base.sha`, the replay uncommitted, and `files`
 *   (repository-relative, at most {@link REBASE_FILES_MAX}, `more` past them) hold conflict markers;
 *   `moved`, the base's commits since the fork, one line each (at most {@link REBASE_MOVED_MAX});
 * - `abandoned`: the branch and the worktree are back at `head`; `left`, untracked files the
 *   resolution made, kept where they are.
 *
 * A `record` step answers `recorded`: `commit` holds the tree on `ref`, on top of `parent`;
 * `recorded` false when nothing new was made (the ref's last commit, or the worktree's HEAD, already
 * held that tree; then `commit` is that one).
 */
export type Landed =
  /** `subject`: the tree the worktree holds once committed, where a landing whose base did not move runs its full suite (T299). */
  | { outcome: 'committed'; repository: string; branch: string; head: string; committed: boolean; base: { branch: string; sha: string }; contained: boolean; stat: string; fork?: string; subject?: { ref: string; version: string } }
  | { outcome: 'merged'; repository: string; branch: string; head: string; base: { branch: string; sha: string }; commit: string; already: boolean; regenerated?: Regenerated }
  | { outcome: 'rebased'; repository: string; branch: string; head: string; from: string; base: { branch: string; sha: string }; subject: { ref: string; version: string }; stat: string; already: boolean; regenerated?: Regenerated }
  | { outcome: 'conflicted'; repository: string; branch: string; from: string; base: { branch: string; sha: string }; fork: string; files: string[]; more: number; moved: string[] }
  | { outcome: 'abandoned'; repository: string; branch: string; head: string; left: string[] }
  | { outcome: 'recorded'; repository: string; ref: string; commit: string; parent: string; recorded: boolean }
  | { outcome: 'refused'; cause: LandRefusal; reason: string }

/** Conflicted files a `conflicted` rebase names at most (INV-9). */
export const REBASE_FILES_MAX = 50
/** The base's commits since the fork a `conflicted` rebase names at most (INV-9). */
export const REBASE_MOVED_MAX = 20

/** One file of a run's change (`WorkChange`): its path, how it changed, its lines added and removed, and its diff. */
export interface ChangedFile {
  path: string
  /** `renamed` names the path it came from in `from`. */
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  from?: string
  /** Lines added and removed; undefined for a binary file. */
  added?: number
  removed?: number
  /** Its unified diff, verbatim, within {@link CHANGE_BOUNDS}.fileChars; absent for a binary file or one past the bounds. */
  diff?: string
  /**
   * Its diff was cut at {@link CHANGE_BOUNDS}.fileChars, or left out past {@link CHANGE_BOUNDS}.totalChars
   * (an untracked file past them is not read, so it has no lines either).
   */
  truncated?: boolean
  binary?: true
  /** Why its content is not shown when it is not a binary file: a link, not a regular file under the worktree, or no diff given for it. */
  note?: string
}

/**
 * A workflow run's change in one of its worktrees, read only: what its working tree holds against
 * the commit it forked from on the repository's checked-out branch (its merge base), committed and
 * not yet committed, untracked files included as added, within {@link CHANGE_BOUNDS}.
 */
export interface WorkChange {
  repository: string
  workspace: string
  branch: string
  /**
   * The repository's checked-out branch, and the commit the change is read against: where the run
   * forked from it, or, once the run's branch is in it, the commit its worktree was cut at.
   */
  base: { branch: string; sha: string }
  /** The worktree's HEAD now. */
  head: string
  files: ChangedFile[]
  /** Files past {@link CHANGE_BOUNDS}.files, counted only. */
  more: number
  /** Some diff was cut or left out by the bounds. */
  truncated: boolean
  /** The worktree was removed: the change is read from its branch, committed changes only. */
  fromBranch?: true
}

/** The bounds of a run's change as a source reads it (INV-9). */
export const CHANGE_BOUNDS = { files: 200, fileChars: 64_000, totalChars: 512_000 } as const

/**
 * Start a workflow run's worktree from an earlier run's work (ADR-0061, T271): the next attempt of a
 * board task whose previous attempt's writing step completed, and that ended unaccepted, continues
 * from that tree instead of redoing it. The source that holds `from.workspace` as the worktree of
 * workflow run `from.runId` commits it on that worktree's branch (or finds it committed there, kept as
 * that attempt's result), only while it is still exactly `from.subject` (the tree the writing step
 * left) and no run of it can still write it, with `message`; then it cuts the worktree of `runId` at
 * the repository's HEAD (where a fresh worktree is cut from) holding the change as changes on top,
 * replayed there when HEAD is not `from.subject.ref`; when the replay conflicts, at `from.subject.ref`
 * itself, the conflict named in the answer. Never a force, a reset, or a push.
 */
export interface CarryStep {
  runId: string
  from: { runId: string; workspace: string; subject: { ref: string; version: string } }
  message: string
  /**
   * The commit the task writes now (T271): the carry goes onto it, and only while it is the
   * repository's HEAD; else it is refused as `base-moved`. Absent: onto the HEAD, whatever it is.
   */
  onto?: string
}

/**
 * Why a carry changed nothing that matters: the new worktree, if any is cut later, starts from HEAD as
 * before. `moved`: the earlier tree is no longer the subject its writing step left; `gone`: its worktree
 * was removed; `busy`: a run of it is unfinished or not known to be gone; `base-moved`: the repository's
 * HEAD is no longer the tree's base; `exists`: the new run has a worktree (or its branch) already;
 * `empty`: the earlier tree holds no change; `failed`: anything else, such as a worktree not intact.
 */
export type CarryRefusal = 'moved' | 'gone' | 'busy' | 'base-moved' | 'exists' | 'empty' | 'failed'

/**
 * What a carry did (ADR-0061):
 * - `carried`: the earlier tree is the commit `from.commit` on `from.branch`, on top of `base`, and the
 *   worktree `worktree` of the new run, on `branch` at `base`, holds it (`carried` false when it did
 *   before this step, such as after a restart);
 * - `refused`: nothing more is done, and why (the earlier tree may have been committed on its branch,
 *   as the retention would commit it).
 */
export type Carried =
  | {
    outcome: 'carried'; repository: string; from: { branch: string; commit: string }; base: string; branch: string; worktree: string; carried: boolean
    /**
     * What a move of the repository's HEAD since the tree's base did (T271): `rebased`, the change
     * replays on it without conflict, so `base` is that HEAD and the worktree holds the replayed change;
     * `conflict`, the replay conflicts (`files`), so `base` stays the tree's own base and the Worker
     * resolves the move. Absent: HEAD was still the tree's base.
     */
    rebase?: { outcome: 'rebased' | 'conflict'; from: string; onto: string; files?: string[] }
  }
  | { outcome: 'refused'; cause: CarryRefusal; reason: string }

/**
 * The checks a policy can require that are commands (`autonomy-policy` `requires`): what a run's
 * checks run (T151). The others (`schema`, `review`, `quote-check`) are judged by the run itself.
 */
export type RunCheck = 'tests' | 'typecheck' | 'lint' | 'red-on-base'
export const RUN_CHECKS: readonly RunCheck[] = ['tests', 'typecheck', 'lint', 'red-on-base']

/**
 * Run a workflow run's required checks on its result (T151): the source that holds `workspace` as
 * the worktree of workflow run `runId` runs, for each name in `checks`, the command its operator's
 * configuration gives that check for the worktree's repository, confined, only while the worktree is
 * exactly `subject` (the tree the result is on) and no run of it can still write it. `classification`
 * is the run's: what a check printed is recorded at it.
 */
export interface CheckStep {
  runId: string
  workspace: string
  subject: { ref: string; version: string }
  checks: RunCheck[]
  classification: 'public' | 'operator-shared' | 'local-private'
  /**
   * What the checks are for (T299): `acceptance` (the default), the result's own tree, where a
   * `tests` command runs the tests related to the files the result changed; `landing`, the tree
   * rebased onto its base, where it runs the whole suite, once per landing. A result of one scope is
   * never taken for the other's. `daily` (T305b) is a tip's own, set by {@link TipCheckStep}'s run:
   * the whole suite with every browser test.
   */
  scope?: 'acceptance' | 'landing' | 'daily'
  /**
   * The task's criteria say `refactor: no behaviour change` (T306c): a check that reads it
   * (`red-on-base`) requires that no existing test was changed, instead of that new tests fail on the base.
   */
  refactor?: boolean
}

/**
 * Run a check on the tip of a ref of a repository, with no workflow run's result behind it (T305b: the
 * daily run of every browser spec): the source that holds the repository cuts a worktree of its own at
 * `commit`, sets it up as it does a run's, and runs the `tests` check at the `daily` scope (the whole
 * suite, every browser test with it), confined and read-only, in the host's one queue of checks.
 * `runId` names the worktree and the check's record; it is no workflow run.
 */
export interface TipCheckStep {
  runId: string
  /** The repository's absolute path (the operator's configuration names it). */
  repository: string
  /** The commit the ref named when the day's run started: the tree that is checked. */
  commit: string
  classification: 'public' | 'operator-shared' | 'local-private'
}

/** What a {@link TipCheckStep} came to: the check's result, as a run's check gives it, or why nothing ran. */
export type TipChecked =
  | { outcome: 'checked'; result: CheckResult; evidence?: string }
  | { outcome: 'refused'; cause: CheckRefusal; reason: string }

/**
 * One check of a {@link CheckStep}: `passed` (its command exited 0 on the subject, and left it as it
 * was), `failed` (it exited with another code, on the subject), or `error` (it did not run to an exit
 * code on the subject: no command configured, not allowed by the policy, could not start or be
 * confined, timed out, or changed the tree). An `error` is never passed or failed: the check stays
 * pending (INV-2).
 */
export interface CheckResult {
  check: RunCheck
  outcome: 'passed' | 'failed' | 'error'
  exitCode?: number
  reason: string
  /**
   * What the command itself reported it did not run, though it exited (a `passed` or `failed`
   * check): its browser tests, with why (no usable browser there). Its outcome says nothing of
   * those tests, and a review is told so (T247).
   */
  notRun?: string
  /**
   * A `failed` check's failing lines, read from its output by the source that ran it: the names of
   * its failing tests and their assertion lines, at most 200 lines of 240 characters, so the Worker
   * that must fix it reads them in the task's dossier (T270). Absent for a check that did not fail.
   */
  failures?: string[]
}

/**
 * Why a run's checks did not run at all: the worktree moved off the subject, was removed, may still be
 * written, the result changed its dependencies and the setup run again for them needed a package it
 * cannot get without the network (`dependency_unavailable`, the packages named in the reason, T235),
 * or anything else.
 */
export type CheckRefusal = 'moved' | 'gone' | 'busy' | 'dependency_unavailable' | 'failed'

/**
 * What a run's checks came to (T151):
 * - `checked`: one result per check asked, in its order; `evidence`, the `check-run@1.0` evidence
 *   artifact that records what ran, when any command was started;
 * - `refused`: nothing ran, and why; every check stays pending. `requests`: the approval requests it
 *   waits on (a new lockfile's verification, T333): once each is resolved, asking again runs the checks.
 */
export type Checked =
  | { outcome: 'checked'; results: CheckResult[]; evidence?: string }
  | { outcome: 'refused'; cause: CheckRefusal; reason: string; requests?: string[] }

/**
 * Contributes Workers and runs work on them (the Worker's three questions: can it accept
 * this work now, how is it invoked, what did it produce). `describe` is called on every
 * route, so states are current.
 */
export interface WorkerSource {
  readonly name: string
  describe(): Promise<CapabilityDescriptor[]>
  /** Start work on one admitted Worker; durable at once, idempotent by `key`. */
  start(request: WorkerStart): WorkerExecution
  /**
   * Count an admission routed to this Worker in its `load.pending` until the returned release is
   * called (ADR-0033): the caller releases it once the work is started, or will not be.
   */
  reserve?(worker: string): () => void
  get(executionId: string): WorkerExecution | undefined
  /** Wait until the execution finishes or `timeoutMs` passes; the current state either way. */
  wait(executionId: string, timeoutMs: number): Promise<WorkerExecution>
  /**
   * The confinement a run on this Worker is held to (for the workflow run `runId`, when it belongs to
   * one), for the brief it is started with. A source that declares none runs nothing on this
   * machine: its Workers are briefed as read-only, with no commands, and network only as the egress
   * policy allows (`NO_LOCAL_SANDBOX`).
   */
  sandbox?(worker: string, runId?: string): WorkerSandbox | undefined
  /**
   * The model a run on this Worker at `tier` asks for, as its source's configuration gives it
   * (ADR-0073), for the brief to record beside the served tier; undefined when the source names none.
   * Configuration, shown only: routing never reads it (INV-11).
   */
  model?(worker: string, tier: Tier): string | undefined
  /** The Workers a continued session must stay on, when this source owns the session. */
  affinity?(sessionId: string): string[] | undefined
  /**
   * The Workers on this one's account (the tiers of a website account, every role of an agent
   * account), itself included, when this source owns it: a failover leaves all of them out
   * (ADR-0034), and a team member avoids all of them once another member holds one (REQ-TEAM-4).
   */
  siblings?(worker: string): string[] | undefined
  /** The session's native conversation handle (conversation URL, SDK session or thread id), once known. */
  handle?(sessionId: string): string | undefined
  /**
   * Start the session's next work in a fresh native conversation, on the same Worker (a compaction,
   * REQ-SES-6; a resend, ADR-0062). Called inside a caller's store transaction, anything it does
   * outside the store (closing a kept browser tab) runs after that transaction commits (the store's
   * `afterCommit`), never on a rollback.
   */
  reset?(sessionId: string): boolean
  /**
   * Why the session takes no input now, when this source owns it and it does not (PROP-0013,
   * ADR-0056): its latest run stopped on a tool call whose approval request is still open, or has
   * not finished, or is not known to be gone. Derived when asked, from the source's durable facts;
   * a source that cannot tell says so here, never undefined. Undefined: free, or not this source's.
   */
  held?(sessionId: string): Promise<string | undefined>
  /**
   * The runs of this source whose liveness needs the operator's look (PROP-0013, ADR-0056): stalled,
   * being looked at, or ended without being known to be gone. Read from the source's durable facts
   * when asked. A source that cannot tell throws, and is never read as having none (INV-2).
   */
  liveness?(query?: LivenessQuery): Promise<LivenessReport>
  /**
   * One step of landing an accepted result whose working tree is `step.workspace`, the worktree of
   * workflow run `step.runId` (ADR-0060). Undefined when this source holds no such worktree. A
   * step repeated after a restart finds its own work done and says so (INV-4).
   */
  land?(step: LandStep): Promise<Landed | undefined>
  /**
   * The change of workflow run `runId` in each worktree of it this source holds, read only (no
   * index write, no hook), within {@link CHANGE_BOUNDS}, kept to them as it reads (INV-9: what lies
   * past them is counted or passed over, never held, and reads as cut, never as unreadable);
   * undefined when it holds none. It never
   * reads outside those worktrees and their repository, and throws when a worktree it holds cannot
   * be read, which is never read as no change (INV-2).
   */
  changes?(runId: string): Promise<WorkChange[] | undefined>
  /**
   * Start workflow run `step.runId`'s worktree from the earlier run's tree at `step.from.workspace`
   * (ADR-0061). Undefined when this source holds no such worktree. A step repeated after a restart
   * finds its own work done and says so (INV-4).
   */
  carry?(step: CarryStep): Promise<Carried | undefined>
  /**
   * Run workflow run `step.runId`'s required checks on the worktree `step.workspace` (T151).
   * Undefined when this source holds no such worktree. The commands change nothing a later step reads
   * (a check that changes the tree is an `error`). A step repeated after a restart gets each check's
   * stored outcome on that subject back, never a check run again to replace what it came to; one a
   * crash interrupted is an `error` (INV-4). An infrastructure failure (a command the source's
   * confinement did not start) is an `error`, never `failed`. `signal` stops the commands in flight;
   * the step then throws.
   */
  check?(step: CheckStep, signal?: AbortSignal): Promise<Checked | undefined>
  /**
   * Run the `tests` check on the tip commit of a repository this source holds (T305b), in a worktree
   * it cuts for the step, at the `daily` scope. Undefined when it holds no such repository. The
   * check is confined and read-only like a run's, queued with them, and stored on the step's `runId`.
   */
  checkTip?(step: TipCheckStep, signal?: AbortSignal): Promise<TipChecked | undefined>
  /**
   * The caller is done with these sessions for good (their run was deleted or expired): what the
   * source created for them outside `system` (a website conversation) is deleted. How many of
   * its records became due; zero when it owns none of them.
   */
  release?(sessionIds: readonly string[], reason: string): { due: number }
  /**
   * Cancel an execution (REQ-WRK-4): a queued one never starts, a running one is aborted and
   * fails as `aborted`. False when it had already finished. Work already sent is not undone.
   */
  cancel?(executionId: string): boolean
}

/**
 * How a source answered the router's last read of its Workers (a route or `list`): it `described`
 * them, was `silent` (no answer within the router's bound), or `failed` (its `describe` threw). A
 * route at that moment saw none of a silent source's Workers.
 */
export interface WorkerSourceRead {
  source: string
  state: 'described' | 'silent' | 'failed'
  /** When the read started (ISO 8601). */
  at: string
  /** The Workers it described; 0 unless `described`. */
  workers: number
  /** Why it is not `described`: the bound it missed, or its error's message, bounded. */
  detail?: string
  /**
   * Optional: on a `silent` read, true while no describe of the source has landed since it was
   * registered (its first, a start's first probe, say, is still running), so its Workers are not
   * known yet, never known to be none. A surface says "describing" then, not a count that reads as
   * every Worker. Absent once one of its describes has landed, even after the bound.
   */
  describing?: true
}

/** The admission checks, in the order the router applies them. */
export type AdmissionCheck = 'restricted' | 'excluded' | 'diversity' | 'capability' | 'cooldown' | 'assignment' | 'input' | 'locality' | 'state' | 'tier'
export const ADMISSION_CHECKS: readonly AdmissionCheck[] = ['restricted', 'excluded', 'diversity', 'capability', 'cooldown', 'assignment', 'input', 'locality', 'state', 'tier']

export interface Rejection {
  worker: string
  /** The Worker's state when it was rejected. */
  state: WorkerState
  /** Every check the Worker failed, with why; never empty. */
  failed: Array<{ check: AdmissionCheck; reason: string }>
}

export interface RouteOptions {
  /** Only these Workers may take the work, e.g. a persistent session's own account. */
  restrict?: { workers: readonly string[]; reason: string }
  /** These Workers may not take the work: an earlier attempt failed on them, unsent (ADR-0034). */
  excludeWorkers?: { workers: readonly string[]; reason: string }
  /**
   * No Worker of these provider families may take the work (ADR-0027): the families of the Workers
   * that served the nodes this one must differ from. A Worker with no family cannot prove it differs.
   * `reason` names those nodes, never a family.
   */
  exclude?: { families: readonly string[]; reason: string }
  /**
   * The work's input as it will be sent, measured by whoever rendered it (ADR-0032): a Worker that
   * declares a shorter `maxInputChars` is refused. A source that replays history checks that itself.
   */
  input?: { chars: number }
  /**
   * The work stays on this account within its group (ADR-0052): no Worker of another account of
   * `group` may take it (check `assignment`). Set by a caller after an unsent failure on an
   * assigned account, so the next attempt never moves inside the provider.
   */
  assignment?: { group: string; account: string; reason: string }
  /** Who asked, recorded as the producer of the decisions. */
  producer?: string
}

/** One Worker as admission sees it now, with nothing reserved (`Workers.candidates`). */
export interface Candidate {
  worker: CapabilityDescriptor
  /** The source that describes it. */
  source: string
  /** Every admission check it fails, in the router's order and words; empty when routing admits it. */
  failed: Rejection['failed']
  /** The tier it would serve the work at ({@link servedTier}, ADR-0073), when routing admits it. */
  tier?: Tier
}

/**
 * What admission would say of every Worker for one requirement, with nothing reserved and nothing
 * decided (PROP-0014, ADR-0064): the same checks `route` runs, in the same order, under the same lock.
 */
export interface Candidates {
  /** The stored work requirement (an `objective` artifact), for the caller's own decision to name. */
  requirement: ArtifactRef
  /** Every Worker every source describes now, by id, each with the checks it fails. */
  workers: Candidate[]
  /** Sources that did not describe their Workers within the router's bound: none of theirs is listed, never read as having none. */
  unheard: Array<{ source: string; reason: string }>
  /**
   * The router's own order after tier, for this requirement: its quota classes (`budget.preferQuota`,
   * then the configured preference) and its configured priority list of Worker ids.
   */
  order: { quota: QuotaClass[]; priority: string[] }
}

export interface AdmittedWorker {
  worker: CapabilityDescriptor
  /** Name of the source that describes the Worker, and runs work on it. */
  source: string
  /**
   * The tier it serves this work at (ADR-0073): the lowest tier it offers within the requirement's
   * bounds whose model's pool is open; the `tier` decision's outcome. Optional for a router that
   * predates it: then the Worker's `tier`.
   */
  tier?: Tier
  /** The stored work requirement and the decisions that chose the Worker (INV-13). */
  requirement: ArtifactRef
  decisions: { tier: ArtifactRef; route: ArtifactRef }
  /**
   * Ends the admission's place in the Worker's `load.pending` (ADR-0033). Call it once the work
   * is started, or on any path that will not start it; calling it again does nothing.
   */
  release(): void
}

/** A result as an acceptance contract sees it: the stored artifact. */
export interface AcceptanceSubject {
  id: ArtifactRef
  bodySchema: string
  body: unknown
}

export interface AcceptanceCheck {
  accepted: boolean
  /** Why, in either case; never empty. */
  reasons: string[]
}

/** A deterministic check of a result against a contract id (REQ-WRK-3). */
export type AcceptanceContract = (result: AcceptanceSubject) => AcceptanceCheck

export interface Acceptance extends AcceptanceCheck {
  /** The `acceptance` decision artifact (INV-13). */
  decision: ArtifactRef
}

/**
 * No Worker is admissible; fail closed (INV-2). `decision` is the `admission` artifact.
 * `limitUntil` (ADR-0052): when every Worker refused only for its limit is on an assigned account,
 * the earliest reset among their known limits, so the caller may wait for it instead of failing;
 * absent otherwise, and when no reset is known.
 * `retryAt` (T282): when a Worker that proves the work is refused only for a while that passes by
 * itself (out of quota or at a limit with no reset `limitUntil` names, or unavailable with its
 * source's `expectedBack`), the next time the work is worth routing again, so the caller waits,
 * bounded, instead of failing it; absent otherwise. A caller that knows nothing of it fails as before.
 */
export class AdmissionFailure extends Error {
  constructor(readonly rejections: readonly Rejection[], readonly decision: ArtifactRef, message: string, readonly limitUntil?: string, readonly retryAt?: string) {
    super(message)
    this.name = 'AdmissionFailure'
  }
}

export abstract class Workers extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workers')
  }

  /** Register a Worker source for the calling plugin's lifetime. Names are unique. */
  abstract register(source: WorkerSource): void

  /** Every registered Worker as its source describes it now, ordered by id. */
  abstract list(): Promise<CapabilityDescriptor[]>

  /**
   * Each registered source's last read, by a route or `list`, ordered by name; a source not read
   * since it registered is absent. Optional: a provider that keeps none leaves a caller unable to
   * tell a silent source from one with no Workers.
   */
  abstract sources?(): WorkerSourceRead[]

  /** A registered source by name. */
  abstract source(name: string): WorkerSource | undefined

  /** The Workers a continued session must stay on, from the source that owns it. */
  abstract affinity(sessionId: string): string[] | undefined
  /** The Workers on a Worker's account (itself included), from its source; just itself when none says. */
  abstract siblings(worker: string): string[]

  /** A session's native conversation handle, from the source that owns it. */
  abstract handle(sessionId: string): string | undefined

  /** Start a session's next work in a fresh native conversation; false when no source owns it. */
  abstract reset(sessionId: string): boolean

  /**
   * Why a session takes no input now, from the source that owns it (`WorkerSource.held`); undefined
   * when it is free. Optional: a caller that finds no `held` cannot tell, and gives the session no
   * automated input (PROP-0013, ADR-0056).
   */
  abstract held?(sessionId: string): Promise<string | undefined>

  /**
   * The runs whose liveness needs the operator's look, from every source that tells it
   * (`WorkerSource.liveness`): each with its `source`, the latest first, at most
   * {@link MAX_LIVENESS_RUNS}; the counts in each state across them; and each source that could not
   * tell, with why (INV-2: never read as having none). Optional: a caller that finds no `liveness`
   * cannot tell (PROP-0013).
   */
  abstract liveness?(query?: LivenessQuery): Promise<{ runs: Array<RunLiveness & { source: string }>; counts: Record<LivenessState, number>; unread: Array<{ source: string; detail: string }> }>

  /**
   * One step of landing an accepted result, by the source that holds its worktree
   * (`WorkerSource.land`), with that source's name; undefined when none holds it. A source that
   * throws is a refusal (`failed`), never read as not holding it (ADR-0060). Optional: a caller
   * that finds no `land` lands nothing.
   */
  abstract land?(step: LandStep): Promise<(Landed & { source: string }) | undefined>

  /**
   * A workflow run's change in its worktrees, from every source that holds one
   * (`WorkerSource.changes`), each with its `source`; and each source that could not read its own,
   * with why (INV-2: never read as no change). Optional: a caller that finds no `changes` cannot
   * show a change.
   */
  abstract changes?(runId: string): Promise<{ changes: Array<WorkChange & { source: string }>; unread: Array<{ source: string; detail: string }> }>

  /**
   * Start a workflow run's worktree from an earlier run's tree, by the source that holds that tree
   * (`WorkerSource.carry`), with that source's name; undefined when none holds it. A source that throws
   * is a refusal (`failed`), never read as not holding it (ADR-0061). Optional: a caller that finds no
   * `carry` starts the run's worktree from HEAD, as before.
   */
  abstract carry?(step: CarryStep): Promise<(Carried & { source: string }) | undefined>

  /**
   * Run a workflow run's required checks on its result's worktree, by the source that holds it
   * (`WorkerSource.check`), with that source's name; undefined when none holds it. A source that
   * throws, unless `signal` stopped it, is a refusal (`failed`), never read as not holding it, and
   * never as a check passed (INV-2). Optional: a caller that finds no `check` runs none, and the
   * checks stay pending (T151).
   */
  abstract check?(step: CheckStep, signal?: AbortSignal): Promise<(Checked & { source: string }) | undefined>

  /**
   * Run the tests check on the tip of a repository, by the source that holds it (`WorkerSource.checkTip`),
   * with that source's name; undefined when none does. A source that throws, unless `signal` stopped it,
   * is a refusal (`failed`), never a check passed (INV-2). Optional (T305b).
   */
  abstract checkTip?(step: TipCheckStep, signal?: AbortSignal): Promise<(TipChecked & { source: string }) | undefined>

  /** Release sessions for good, at every source that owns some of them: how many records became due. */
  abstract release(sessionIds: readonly string[], reason: string): { due: number }

  /**
   * Admit and choose exactly one Worker, deterministically for the same configuration,
   * Worker states, and requirement (REQ-WRK-1, REQ-WRK-2). Records a `tier` and a `route`
   * decision, or an `admission` decision and throws {@link AdmissionFailure}.
   */
  abstract route(requirement: WorkRequirement, options?: RouteOptions): Promise<AdmittedWorker>

  /**
   * Every Worker with what admission says of it for this requirement, as `route` would judge it now:
   * the same checks, in the same order, under the same lock, the assigned-account hold included
   * (PROP-0014, ADR-0064). It reserves nothing (no Worker's `load.pending` moves) and records no
   * decision: a caller that acts on it records its own, listing every Worker with its checks
   * (INV-13). Optional: a caller that finds none cannot look before it routes, and starts nothing on
   * a look (INV-2).
   */
  abstract candidates?(requirement: WorkRequirement, options?: RouteOptions): Promise<Candidates>

  /** Register an acceptance contract for the calling plugin's lifetime. Ids are unique. */
  abstract contract(id: string, check: AcceptanceContract): void

  /** Ids of the contracts registered now, so a caller can refuse an unknown one before any work runs. */
  abstract contracts(): string[]

  /**
   * Check a stored result against a contract and record an `acceptance` decision. A
   * provider's terminal state is not acceptance (REQ-WRK-3); an unknown contract or result
   * fails closed with an error, never a silent accept. With `resultSchema`, the result's JSON
   * must first be valid against that schema (REQ-ART-5).
   */
  abstract accept(result: ArtifactRef, contract: string, options?: { producer?: string; runId?: string; nodeId?: string; resultSchema?: string }): Acceptance
}
