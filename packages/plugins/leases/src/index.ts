/**
 * `ctx.leases`: token leases with a monotonic generation per resource
 * (docs/design/scheduling-and-leases.md, INV-4). Claim/heartbeat/release by token follow
 * `@gm-hz/agent-dag-workflow`; the generation fence is ours: every new holder and every
 * invalidation bumps it, and a commit that presents a stale generation is rejected.
 * @module @tsuuanmi/system-leases
 */
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-store'

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

interface Row { resource: string; owner: string | null; token: string | null; generation: number; expires_at: number | null }

/** A stable-per-process owner id: `<host>:<pid>:<random>`. */
const processOwner = `${hostname().replace(/[^A-Za-z0-9._-]/g, '-')}:${process.pid}:${randomBytes(3).toString('hex')}`

export interface Config {
  /** Upper bound for any requested TTL, in milliseconds (default 10 minutes). */
  maxTtlMs?: number
}

export class Leases extends Service {
  static inject = ['store']
  static Config: z<Config> = z.object({
    maxTtlMs: z.natural().min(1000).default(600_000).description('Upper bound for any requested TTL'),
  })

  private readonly maxTtlMs: number
  private readonly schemas = new SchemaRegistry()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'leases')
    this.maxTtlMs = config.maxTtlMs ?? 600_000
    ctx.store.migrate('leases', [{
      version: 1,
      sql: `CREATE TABLE leases (
        resource TEXT PRIMARY KEY, owner TEXT, token TEXT, generation INTEGER NOT NULL, expires_at INTEGER,
        CHECK ((owner IS NULL AND token IS NULL AND expires_at IS NULL) OR (owner IS NOT NULL AND token IS NOT NULL AND expires_at IS NOT NULL))
      )`,
    }])
  }

  /** Take `resource` when free or expired; returns undefined while another holder's lease is live. */
  acquire(resource: string, ttlMs: number, owner: string = processOwner, now: number = Date.now()): Lease | undefined {
    const expiresAt = now + this.ttl(ttlMs)
    const token = randomBytes(18).toString('base64url')
    return this.ctx.store.transaction((db): Lease | undefined => {
      const row = db.prepare('SELECT * FROM leases WHERE resource = ?').get(resource) as Row | undefined
      if (row && row.owner !== null && (row.expires_at ?? 0) > now) return undefined
      const generation = (row?.generation ?? 0) + 1
      const lease: Lease = { schema: 'lease@1.0', resource, owner, token, generation, expiresAt }
      this.schemas.assertRecord(lease)
      db.prepare(`INSERT INTO leases (resource, owner, token, generation, expires_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(resource) DO UPDATE SET owner = excluded.owner, token = excluded.token, generation = excluded.generation, expires_at = excluded.expires_at`)
        .run(resource, owner, token, generation, expiresAt)
      return lease
    })
  }

  /**
   * Run `body` while holding `resource`: acquire, renew on a heartbeat every third of the TTL the
   * lease was granted (the TTL asked for, capped at `maxTtlMs`: each grant sets the next beat), then
   * release (a release that fails, as the store closes, leaves the lease to expire). While
   * another holder's lease is live, nothing runs and the caller learns when to look again: that
   * lease's expiry plus a second, at least a second. The body decides what a lost lease means.
   *
   * `lost` aborts only on a positive loss (ADR-0056): a renewal that finds the lease expired, taken
   * over, or invalidated ({@link LeaseLost}), or the lease's own expiry passing with no renewal. A
   * renewal that fails otherwise (the store busy or failing) is not a loss: it is tried again at the
   * next beat, and at the latest at the lease's expiry, while the lease is still live. Fencing is
   * unchanged, so a holder whose lease lapsed commits nothing whatever it was told.
   */
  async hold<T>(resource: string, ttlMs: number, body: (holding: Holding) => Promise<T>): Promise<Held<T>> {
    const acquiredAt = Date.now()
    let lease = this.acquire(resource, ttlMs, processOwner, acquiredAt)
    if (!lease) {
      const holder = this.current(resource)
      return { held: false, retryInMs: Math.max(1000, (holder?.expiresAt ?? Date.now()) - Date.now() + 1000) }
    }
    const lost = new AbortController()
    // A third of the TTL granted, not of the one asked for: under a lower cap, a beat at a third of
    // the asked TTL comes after the lease has expired.
    let period = (lease.expiresAt - acquiredAt) / 3
    let heartbeat: NodeJS.Timeout | undefined
    const beat = (): void => {
      if (lost.signal.aborted) return
      try {
        const renewedAt = Date.now()
        lease = this.renew(lease!, ttlMs, renewedAt)
        period = (lease.expiresAt - renewedAt) / 3
      } catch (error) {
        if (error instanceof LeaseLost) {
          lost.abort(error)
          return
        }
        const why = (error instanceof Error ? error.message : String(error)).slice(0, 200)
        if (Date.now() >= lease!.expiresAt) {
          lost.abort(new LeaseLost(resource, `expired with no renewal (the last one failed: ${why})`))
          return
        }
        this.ctx.logger.warn(`leases: renewing ${resource} failed (${why}); the lease stands until ${new Date(lease!.expiresAt).toISOString()}, and is renewed again before then`)
      }
      // The next beat, and never later than the lease's own expiry, where an unrenewed lease is lost.
      heartbeat = setTimeout(beat, Math.max(1, Math.min(period, lease!.expiresAt - Date.now())))
      heartbeat.unref()
    }
    heartbeat = setTimeout(beat, period)
    heartbeat.unref()
    try {
      return { held: true, value: await body({ lease: () => lease!, lost: lost.signal }) }
    } finally {
      clearTimeout(heartbeat)
      try {
        this.release(lease)
      } catch {
        // the store may already be closing; an unreleased lease simply expires
      }
    }
  }

  /** Extend a live lease (heartbeat). Throws {@link LeaseLost} when it was expired, taken over, or invalidated. */
  renew(lease: Lease, ttlMs: number, now: number = Date.now()): Lease {
    const expiresAt = now + this.ttl(ttlMs)
    const result = this.ctx.store.transaction((db) =>
      db.prepare('UPDATE leases SET expires_at = ? WHERE resource = ? AND token = ? AND generation = ? AND expires_at > ?')
        .run(expiresAt, lease.resource, lease.token, lease.generation, now))
    if (result.changes !== 1) throw new LeaseLost(lease.resource, 'expired, taken over, or invalidated')
    return { ...lease, expiresAt }
  }

  /** Give the resource up; a no-op when this lease no longer holds it. The generation is kept. */
  release(lease: Lease): void {
    this.ctx.store.transaction((db) =>
      db.prepare('UPDATE leases SET owner = NULL, token = NULL, expires_at = NULL WHERE resource = ? AND token = ?').run(lease.resource, lease.token))
  }

  /**
   * Commit fence (INV-4): call it inside the committing `ctx.store.transaction`. Passes
   * only if this exact lease (token and generation) still holds the resource and has not
   * expired; otherwise throws {@link StaleGeneration} or {@link LeaseLost}. Because it runs
   * under the transaction's write lock, no successor can take over before the commit.
   */
  fence(lease: Lease, now: number = Date.now()): void {
    if (!this.ctx.store.db.isTransaction) throw new Error('leases.fence must run inside the committing store transaction')
    const row = this.ctx.store.db.prepare('SELECT * FROM leases WHERE resource = ?').get(lease.resource) as Row | undefined
    if (!row || row.generation !== lease.generation || row.token !== lease.token) {
      throw new StaleGeneration(lease.resource, lease.generation, row?.generation ?? 0)
    }
    if ((row.expires_at ?? 0) <= now) throw new LeaseLost(lease.resource, 'expired before commit')
  }

  /** Fence out every outstanding holder: bump the generation and drop the holder. Returns the new generation. */
  invalidate(resource: string): number {
    return this.ctx.store.transaction((db) => {
      const row = db.prepare('SELECT generation FROM leases WHERE resource = ?').get(resource) as { generation: number } | undefined
      const generation = (row?.generation ?? 0) + 1
      db.prepare(`INSERT INTO leases (resource, owner, token, generation, expires_at) VALUES (?, NULL, NULL, ?, NULL)
        ON CONFLICT(resource) DO UPDATE SET owner = NULL, token = NULL, expires_at = NULL, generation = excluded.generation`).run(resource, generation)
      return generation
    })
  }

  /** The current holder, if any (expired leases included; compare `expiresAt` yourself). */
  current(resource: string): Lease | undefined {
    const row = this.ctx.store.db.prepare('SELECT * FROM leases WHERE resource = ?').get(resource) as Row | undefined
    if (!row || row.owner === null || row.token === null || row.expires_at === null) return undefined
    return { schema: 'lease@1.0', resource, owner: row.owner, token: row.token, generation: row.generation, expiresAt: row.expires_at }
  }

  private ttl(ttlMs: number): number {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new RangeError('lease TTL must be a positive integer')
    return Math.min(ttlMs, this.maxTtlMs)
  }
}

export default Leases
