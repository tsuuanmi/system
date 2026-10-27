import { type Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    leases: Leases
  }
}

/** A held lease (schemas/lease.v1.json). */
export interface Lease {
  schema: 'lease@1.0'
  resource: string
  owner: string
  token: string
  generation: number
  expiresAt: number
}

/** The lease was taken over, expired, or invalidated; the holder must stop and must not commit. */
export class LeaseLost extends Error {
  constructor(readonly resource: string, reason: string) {
    super(`lease ${resource}: ${reason}`)
    this.name = 'LeaseLost'
  }
}

/** A commit presented a generation older than the resource's current one. */
export class StaleGeneration extends Error {
  constructor(readonly resource: string, readonly presented: number, readonly current: number) {
    super(`lease ${resource}: generation ${presented} is stale (current ${current})`)
    this.name = 'StaleGeneration'
  }
}

/** What a body holding a lease sees: the current lease (renewed by the heartbeat) and whether it was lost. */
export interface Holding {
  /** The lease as last renewed; present it to every fenced commit. */
  lease(): Lease
  /**
   * Aborted (with a {@link LeaseLost}) on a positive loss only: a heartbeat finds the lease expired,
   * taken over, or invalidated, or the lease's expiry passes with no renewal. A renewal that merely
   * failed is not a loss (ADR-0056).
   */
  readonly lost: AbortSignal
}

/** A hold's outcome: the body's value, or, while another holder's lease is live, when to look again. */
export type Held<T> = { held: true; value: T } | { held: false; retryInMs: number }

/**
 * `ctx.leases`: token leases with a monotonic generation per resource
 * (docs/design/scheduling-and-leases.md, INV-4, INV-15). Claim/heartbeat/release by token follow
 * `@gm-hz/agent-dag-workflow`; the generation fence is ours: every new holder and every
 * invalidation bumps it, and a commit that presents a stale generation is rejected. A guarantee
 * seam: a provider passes `conformance/leases.ts` (ADR-0036); it keeps its leases in `ctx.store`.
 */
export abstract class Leases extends Service {
  constructor(ctx: Context) {
    super(ctx, 'leases')
  }

  /** Take `resource` when free or expired; returns undefined while another holder's lease is live. */
  abstract acquire(resource: string, ttlMs: number, owner?: string, now?: number): Lease | undefined

  /**
   * Run `body` while holding `resource`: acquire, renew on a heartbeat every third of the TTL the
   * lease was granted (the TTL asked for, capped by the provider's bound), then release (a release
   * that fails, as the store closes, leaves the lease to expire). While another holder's lease is
   * live, nothing runs and the caller learns when to look again: that lease's expiry plus a second,
   * at least a second. The body decides what a lost lease means.
   *
   * `lost` aborts only on a positive loss (ADR-0056): a renewal that finds the lease expired, taken
   * over, or invalidated ({@link LeaseLost}), or the lease's own expiry passing with no renewal. A
   * renewal that fails otherwise (the store busy or failing) is not a loss: it is tried again at the
   * next beat, and at the latest at the lease's expiry, while the lease is still live. Fencing is
   * unchanged, so a holder whose lease lapsed commits nothing whatever it was told.
   */
  abstract hold<T>(resource: string, ttlMs: number, body: (holding: Holding) => Promise<T>): Promise<Held<T>>

  /** Extend a live lease (heartbeat). Throws {@link LeaseLost} when it was expired, taken over, or invalidated. */
  abstract renew(lease: Lease, ttlMs: number, now?: number): Lease

  /** Give the resource up; a no-op when this lease no longer holds it. The generation is kept. */
  abstract release(lease: Lease): void

  /**
   * Commit fence (INV-4): call it inside the committing `ctx.store.transaction`. Passes
   * only if this exact lease (token and generation) still holds the resource and has not
   * expired; otherwise throws {@link StaleGeneration} or {@link LeaseLost}. Because it runs
   * under the transaction's write lock, no successor can take over before the commit.
   */
  abstract fence(lease: Lease, now?: number): void

  /** Fence out every outstanding holder: bump the generation and drop the holder. Returns the new generation. */
  abstract invalidate(resource: string): number

  /** The current holder, if any (expired leases included; compare `expiresAt` yourself). */
  abstract current(resource: string): Lease | undefined
}
