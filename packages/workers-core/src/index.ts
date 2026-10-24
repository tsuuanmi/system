/**
 * Routing seam definition: `ctx.workers`, the Worker registry and deterministic router
 * (docs/design/routing.md). Worker sources (the website turn runtime today; agent runtimes
 * later) register for their plugin's lifetime and describe what each Worker proves now;
 * `route` turns a work requirement into one admitted Worker or an {@link AdmissionFailure}.
 * The vocabulary below mirrors `schemas/common.v1.json`, which is canonical.
 * @module @tsuuanmi/system-workers-core
 */
import { type Context, Service } from '@deepseek-ai/cordis'

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

/** What a Worker has proven right now (`capability-descriptor@1.0`; `@1.1` adds `family`). */
export interface CapabilityDescriptor {
  schema: 'capability-descriptor@1.0' | 'capability-descriptor@1.1' | 'capability-descriptor@1.2' | 'capability-descriptor@1.3' | 'capability-descriptor@1.4' | 'capability-descriptor@1.5' | 'capability-descriptor@1.6' | 'capability-descriptor@1.7' | 'capability-descriptor@1.8'
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
  tier: Tier
  quotaClass: QuotaClass
  locality: 'local' | 'remote'
  capabilities: CapabilityOffer[]
  state: WorkerState
  observedAt: string
}

/** The input to routing (`work-requirement@1.0`; `@1.1` adds `scope`, `@1.2` `kind`). */
export interface WorkRequirement {
  schema: 'work-requirement@1.0' | 'work-requirement@1.1' | 'work-requirement@1.2'
  objective: string
  capabilities: string[]
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
export interface WorkerExecution {
  id: string
  status: ExecutionStatus
  /** The input reached the Worker: a caller must never start it again (INV-4). */
  submitted: boolean
  /** The stored result, once completed. */
  result?: ArtifactRef
  error?: { kind: string; disposition: string; message: string }
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
 */
export type LandStep =
  | { step: 'commit'; runId: string; workspace: string; subject: { ref: string; version: string }; message: string }
  | { step: 'merge'; runId: string; workspace: string; head: string; base: { branch: string; sha: string }; message: string }

/** Why a landing step changed nothing: everything stays as it was. */
export type LandRefusal = 'moved' | 'gone' | 'busy' | 'base-moved' | 'head-moved' | 'dirty' | 'conflict' | 'failed'

/**
 * What a landing step did (ADR-0060):
 * - `committed`: the branch's `head` holds the accepted change (`committed` false when it already
 *   did, such as after a restart); `base` is the repository's checked-out branch now, `contained`
 *   whether it already holds `head` (nothing to merge), `stat` the change against it (`git diff
 *   --stat`, bounded);
 * - `merged`: `commit` is the base branch's new head, which holds `head` (`already` when it held it
 *   before this step, such as after a restart);
 * - `refused`: nothing changed, and why.
 */
export type Landed =
  | { outcome: 'committed'; repository: string; branch: string; head: string; committed: boolean; base: { branch: string; sha: string }; contained: boolean; stat: string }
  | { outcome: 'merged'; repository: string; branch: string; head: string; base: { branch: string; sha: string }; commit: string; already: boolean }
  | { outcome: 'refused'; cause: LandRefusal; reason: string }

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
  /** Start the session's next work in a fresh native conversation, on the same Worker (a compaction, REQ-SES-6). */
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

export interface AdmittedWorker {
  worker: CapabilityDescriptor
  /** Name of the source that describes the Worker, and runs work on it. */
  source: string
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
 */
export class AdmissionFailure extends Error {
  constructor(readonly rejections: readonly Rejection[], readonly decision: ArtifactRef, message: string, readonly limitUntil?: string) {
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

  /** Release sessions for good, at every source that owns some of them: how many records became due. */
  abstract release(sessionIds: readonly string[], reason: string): { due: number }

  /**
   * Admit and choose exactly one Worker, deterministically for the same configuration,
   * Worker states, and requirement (REQ-WRK-1, REQ-WRK-2). Records a `tier` and a `route`
   * decision, or an `admission` decision and throws {@link AdmissionFailure}.
   */
  abstract route(requirement: WorkRequirement, options?: RouteOptions): Promise<AdmittedWorker>

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
