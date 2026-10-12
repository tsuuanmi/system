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

/** What a Worker has proven right now (`capability-descriptor@1.0`). */
export interface CapabilityDescriptor {
  schema: 'capability-descriptor@1.0'
  worker: string
  /** Informational only; routing never branches on it (INV-11). */
  provider: string
  tier: Tier
  quotaClass: QuotaClass
  locality: 'local' | 'remote'
  capabilities: Array<{ capability: string; evidence: { kind: 'probe' | 'conformance' | 'plan' | 'sandbox-policy'; ref?: ArtifactRef; at: string } }>
  state: WorkerState
  observedAt: string
}

/** The input to routing (`work-requirement@1.0`). */
export interface WorkRequirement {
  schema: 'work-requirement@1.0'
  objective: string
  capabilities: string[]
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
  /** The input, already rendered. */
  prompt: string
  /** Continue (or open, on first use) this persistent session. */
  sessionId?: string | undefined
  /** The requirement the Worker was admitted for, and the decisions that admitted it. */
  requirement: WorkRequirement
  decisions: { tier: ArtifactRef; route: ArtifactRef }
}

export type ExecutionStatus = 'queued' | 'running' | 'completed' | 'failed'

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
  get(executionId: string): WorkerExecution | undefined
  /** Wait until the execution finishes or `timeoutMs` passes; the current state either way. */
  wait(executionId: string, timeoutMs: number): Promise<WorkerExecution>
  /** The Workers a continued session must stay on, when this source owns the session. */
  affinity?(sessionId: string): string[] | undefined
  /**
   * Cancel an execution (REQ-WRK-4): a queued one never starts, a running one is aborted and
   * fails as `aborted`. False when it had already finished. Work already sent is not undone.
   */
  cancel?(executionId: string): boolean
}

/** The admission checks, in the order the router applies them. */
export type AdmissionCheck = 'restricted' | 'capability' | 'locality' | 'state' | 'tier'

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

/** No Worker is admissible; fail closed (INV-2). `decision` is the `admission` artifact. */
export class AdmissionFailure extends Error {
  constructor(readonly rejections: readonly Rejection[], readonly decision: ArtifactRef, message: string) {
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
   * fails closed with an error, never a silent accept.
   */
  abstract accept(result: ArtifactRef, contract: string, options?: { producer?: string; runId?: string; nodeId?: string }): Acceptance
}
