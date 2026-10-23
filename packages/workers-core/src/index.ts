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
 * How a provider's accounts are used (ADR-0052): `assigned` (the default, and the only one for
 * personal subscriptions), each account serving its own work, a limit never moving that work to
 * another account of the provider; or `pooled`, only on the operator's recorded confirmation of
 * that provider's terms.
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
  schema: 'capability-descriptor@1.0' | 'capability-descriptor@1.1' | 'capability-descriptor@1.2' | 'capability-descriptor@1.3' | 'capability-descriptor@1.4' | 'capability-descriptor@1.5'
  worker: string
  /** Informational only; routing never branches on it (INV-11). */
  provider: string
  /**
   * Who ultimately serves the work, as an opaque string its Worker source sets (ADR-0027).
   * Routing only compares it for inequality (`RouteOptions.exclude`), and never names or ranks one.
   */
  family?: string
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
  tier: Tier
  quotaClass: QuotaClass
  locality: 'local' | 'remote'
  capabilities: CapabilityOffer[]
  state: WorkerState
  observedAt: string
}

/** The input to routing (`work-requirement@1.0`; `@1.1` adds `scope`). */
export interface WorkRequirement {
  schema: 'work-requirement@1.0' | 'work-requirement@1.1'
  objective: string
  capabilities: string[]
  /**
   * The kind of work this is (`@1.1`; ADR-0049), so offers scoped to it count: set by the workflow
   * engine from the admitted spec (a review team member's step), never from a template or model text.
   */
  scope?: WorkScope
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
   * The Workers that share this one's runtime (the tiers of one account), itself included, when
   * this source owns it: a failover leaves all of them out (ADR-0034).
   */
  siblings?(worker: string): string[] | undefined
  /** The session's native conversation handle (conversation URL, SDK session or thread id), once known. */
  handle?(sessionId: string): string | undefined
  /** Start the session's next work in a fresh native conversation, on the same Worker (a compaction, REQ-SES-6). */
  reset?(sessionId: string): boolean
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

  /** A registered source by name. */
  abstract source(name: string): WorkerSource | undefined

  /** The Workers a continued session must stay on, from the source that owns it. */
  abstract affinity(sessionId: string): string[] | undefined
  /** The Workers that share a Worker's runtime (the tiers of one account), from its source; just itself when none says. */
  abstract siblings(worker: string): string[]

  /** A session's native conversation handle, from the source that owns it. */
  abstract handle(sessionId: string): string | undefined

  /** Start a session's next work in a fresh native conversation; false when no source owns it. */
  abstract reset(sessionId: string): boolean

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
