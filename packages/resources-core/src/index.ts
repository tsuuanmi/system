/**
 * Resource ledger seam definition: `ctx.resources`, the configured resource pools, their limit
 * readings, reservations before a run, and usage records after it (docs/design/resources.md).
 * The types mirror `usage-record@1.0` and `limit-state@1.0`; the schemas in `schemas/` are
 * canonical. Numbers come from objective sources only. A guarantee seam: it fails closed (INV-2),
 * and its contract changes only by an ADR (ADR-0036).
 * @module @tsuuanmi/system-resources-core
 */
import { type Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    resources: Resources
  }
}

/** The contract version of this seam; its conformance suite names the same. */
export const RESOURCES_CONTRACT = '1.0'

export type ArtifactRef = `sha256:${string}`
export type Unit = 'tokens' | 'usd' | 'turns' | 'runs' | 'minutes'
export interface BudgetLine { pool: string; unit: Unit; amount: number }
export interface TokenUsage { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; reasoningOutputTokens?: number }

/** A pool as the operator configures it: never a hardcoded plan. */
export interface PoolConfig {
  pool: string
  account: string
  kind: 'interactive' | 'programmatic' | 'api-key' | 'local'
  windows: Array<{ id: string; kind: 'rolling' | 'calendar' | 'credit' | 'rate'; seconds?: number }>
  /**
   * Whether a window that is `unknown` (no reading yet, or an `unknown` reading) leaves the pool
   * available, for a pool that never reports (a local model), or not: the default, fail closed.
   */
  unknown?: 'available' | 'unavailable'
}

/** `limit-state@1.0`. */
export interface LimitState {
  schema: 'limit-state@1.0'
  pool: string
  account: string
  window: { id: string; kind: 'rolling' | 'calendar' | 'credit' | 'rate'; seconds?: number }
  state: 'ok' | 'limited' | 'unknown'
  usedPercentage?: number
  used?: BudgetLine
  remaining?: BudgetLine
  resetsAt?: string
  cooldownUntil?: string
  source: 'status-line' | 'limit-notice' | 'response-headers' | 'runtime-result' | 'invoice' | 'history-estimate'
  observedAt: string
  evidence?: ArtifactRef
}

/** `usage-record@1.0`. */
export interface UsageRecord {
  schema: 'usage-record@1.0'
  requestId: string
  source: 'runtime-result' | 'provider-usage' | 'transcript' | 'turn-count' | 'invoice'
  observedAt: string
  account: string
  pool: string
  worker?: string
  runId?: string
  nodeId?: string
  sessionId?: string
  projectId?: string
  taskId?: string
  providerName?: string
  model?: { request?: string; response?: string }
  usage?: TokenUsage
  models?: Array<{ model: string; usage: TokenUsage; costUsd?: number }>
  turns?: number
  durationMs?: number
  cost?: { amount: number; currency: 'USD'; basis: 'runtime-estimate' | 'price-table' | 'invoice'; priceVersion?: string }
  outcome?: 'completed' | 'failed' | 'aborted'
}

/** A pool now: its configuration, the latest reading of each window, and whether new work may draw on it. */
export interface PoolState extends PoolConfig {
  readings: LimitState[]
  available: boolean
  /** When an unavailable pool is expected back: the latest `cooldownUntil` or `resetsAt` of its limited windows. */
  until?: string
}

export interface ReservationRequest {
  runId: string
  projectId?: string
  taskId?: string
  /** What the run is expected to draw, per pool. */
  lines: BudgetLine[]
  /** Budgets the run's scope may not exceed (a task's or project's), counted from the usage recorded and the reservations held for that scope. */
  caps?: BudgetLine[]
  /**
   * How long the hold lasts if nobody releases it (a crashed run), in seconds, 60 to 604800; the
   * provider's default otherwise. An expired hold no longer counts against any cap (INV-9).
   */
  holdSeconds?: number
}

export interface Reservation {
  reservationId: string
  state: 'reserved' | 'refused'
  /** Why it was refused, one reason per line or cap at fault. */
  reasons: string[]
  /** The `budget` decision that records it (INV-13). */
  decision: ArtifactRef
  /** When a reserved hold stops counting, if it is not released first. */
  expiresAt?: string
}

export interface UsageFilter { runId?: string; projectId?: string; taskId?: string; account?: string; pool?: string; since?: string; until?: string }
export interface UsageTotal { pool: string; records: number; usage?: TokenUsage; turns?: number; costUsd?: number }

/** Why a ledger call was refused. Nothing was recorded. */
export type ResourcesFailure = 'unknown-pool' | 'unknown-reservation' | 'invalid'
export class ResourcesError extends Error {
  constructor(readonly failure: ResourcesFailure, message: string) {
    super(message)
    this.name = 'ResourcesError'
  }
}

export abstract class Resources extends Service {
  constructor(ctx: Context) {
    super(ctx, 'resources')
  }

  /** Every configured pool (of one account, when given) and whether it is available at `at`. */
  abstract pools(filter?: { account?: string }, at?: Date): Promise<PoolState[]>

  /** Record one limit reading as an `evidence` artifact. A reading older than the window's latest one does not replace it. */
  abstract observe(reading: LimitState): Promise<ArtifactRef>

  /** Reserve before a run, recording a `budget` decision; refused when a pool is unknown or unavailable, or a cap would be exceeded. */
  abstract reserve(request: ReservationRequest, at?: Date): Promise<Reservation>

  /** Release a reservation once its run's usage is recorded or the run did not start; an expired one releases quietly. */
  abstract release(reservationId: string): Promise<void>

  /** Record one unit's usage as a `receipt` artifact; a second record of the same unit is a duplicate, not counted. */
  abstract record(usage: UsageRecord): Promise<{ ref: ArtifactRef; duplicate: boolean }>

  /** The counted records that match, oldest first, and their totals per pool. */
  abstract usage(filter?: UsageFilter): Promise<{ records: UsageRecord[]; totals: UsageTotal[] }>
}
