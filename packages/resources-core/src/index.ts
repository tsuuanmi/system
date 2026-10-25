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

/**
 * The contract version of this seam; its conformance suite names the same. 1.1: pool templates and the
 * optional `declare` (ADR-0052). 1.2: the optional `quota` (ADR-0064): the operator's quota settings.
 */
export const RESOURCES_CONTRACT = '1.2'

/**
 * The operator's quota settings (contract 1.2, ADR-0064), read by the quota score (`quota-score@2` in
 * `@tsuuanmi/system-libs`): the share of every window kept free of work System starts by itself, and
 * how the score reads windows. Each is a whole number in its range, validated when the provider loads.
 */
export interface QuotaSettings {
  /** Share of every window, in percent, kept for the operator's own use: dispatched work never starts into it (0 to 90; default 20, D63). */
  reservePercent: number
  /** A window that resets within this many minutes is used first (0 to 1440; default 90; 0: never). */
  useSoonMinutes: number
  /** The least headroom, in percent, a window about to reset needs to be used first (1 to 100; default 10). */
  minHeadroomPercent: number
  /** Headroom is compared in buckets this many points wide (1 to 25; default 5). */
  headroomBucketPercent: number
  /** A reading older than this is stale, and its window is not known (60 to 86400 seconds; default 1800). */
  staleReadingSeconds: number
}

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

/**
 * A pool template as the operator configures it (contract 1.1, ADR-0052): a pool's kind and windows,
 * and the account group it applies to (an agent runtime, a website's provider). The ledger makes one
 * pool of it per account a Worker source declares in that group ({@link Resources.declare}), so a
 * limit on one account never closes another's.
 */
export interface PoolTemplate {
  template: string
  group: string
  kind: PoolConfig['kind']
  windows: PoolConfig['windows']
  unknown?: PoolConfig['unknown']
}

/** An account a Worker source declares to the ledger: its id, and the group a template names. */
export interface DeclaredAccount {
  account: string
  group: string
}

/** The id of the pool a template makes for one account: `<template>/<account>`. */
export const templatePool = (template: string, account: string): string => `${template}/${account}`

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

  /**
   * Optional (contract 1.1, ADR-0052): a Worker source's accounts, replacing what that source
   * declared before. Each configured template whose `group` is an account's makes one pool,
   * {@link templatePool}`(template, account)` of that `account`, listed, reserved, read, and recorded
   * as a configured pool is. Returns the ids of the pools the source's accounts now have. Refused
   * (`invalid`), changing nothing, when an id is not an id, a made pool would be a configured one
   * or another source's, or the pools would be more than the ledger lists. An empty list withdraws
   * them; their readings and records stay, under their ids.
   */
  declare?(source: string, accounts: readonly DeclaredAccount[]): Promise<string[]>

  /**
   * Optional (contract 1.2, ADR-0064): the operator's quota settings, as configured and validated
   * when the provider loaded. A caller that finds none cannot keep the operator's reserve, so it
   * starts no work on a quota reading (INV-2).
   */
  quota?(): QuotaSettings
}
