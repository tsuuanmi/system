/**
 * Conformance suite for `ctx.leases` (docs/design/scheduling-and-leases.md, `lease@1.0` in
 * docs/reference/schemas.md, INV-4, INV-15). It holds any provider to the documented contract
 * through `ctx.leases` alone: one holder per resource, a monotonic generation per resource,
 * renewal and release by token, takeover after expiry, a commit fence inside the committing
 * store transaction, and bounded TTLs; from 1.1, a held lease is lost only on a positive loss, never
 * on a renewal that merely failed (ADR-0056). `boot` returns a context that provides `ctx.leases` and
 * `ctx.store`, with `maxTtlMs` set to {@link LEASE_MAX_TTL_MS} and no lease held.
 */
import type { Context } from '@deepseek-ai/cordis'
import { SchemaRegistry, sleep } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-ledger-core'
import { expect, vi } from 'vitest'
import { defineSuite, type Scenario } from '../../../libs/conformance/runner.ts'
import type { Lease } from '../src/index.ts'

export type Boot = () => Promise<{ ctx: Context; dispose: () => Promise<void> }>

/** The TTL bound every provider under test is configured with (`maxTtlMs`). */
export const LEASE_MAX_TTL_MS = 60_000

const schemas = new SchemaRegistry()
const T0 = 1_800_000_000_000
const R = 'node:run-1/research:1'

const valid = (lease: Lease | undefined): Lease => {
  expect(lease, 'a lease was granted').toBeDefined()
  schemas.assertRecord(lease!)
  return lease!
}

/** The error a call throws, by name, so a replacement provider is held to the same failure kinds. */
const failureOf = (call: () => unknown): string => {
  try {
    call()
    return 'passed'
  } catch (error) {
    return error instanceof Error ? error.name : `not an Error: ${String(error)}`
  }
}

/** Commit inside one store transaction: fence, then write a row. Returns the fence's failure, or `passed`. */
const commit = (ctx: Context, lease: Lease, now: number, value: string): string =>
  failureOf(() => ctx.store.transaction((db) => {
    ctx.leases.fence(lease, now)
    db.prepare('INSERT INTO leases_conformance_commits (resource, generation, value) VALUES (?, ?, ?)').run(lease.resource, lease.generation, value)
  }))

const commits = (ctx: Context): string[] =>
  (ctx.store.db.prepare('SELECT value FROM leases_conformance_commits ORDER BY rowid').all() as Array<{ value: string }>).map((r) => r.value)

/**
 * Make every `ctx.store.transaction` throw a plain error (a store that is busy or failing, never a
 * lost lease) while `failing()` says so. A provider keeps its leases in `ctx.store`: its commit fence
 * runs inside the committing store transaction. Returns the restore.
 */
const flaky = (ctx: Context, failing: () => boolean): (() => void) => {
  const store = ctx.store as unknown as { transaction: (fn: never) => unknown }
  const original = store.transaction
  store.transaction = function (this: unknown, fn: never) {
    if (failing()) throw new Error('database is locked')
    return original.call(ctx.store, fn)
  }
  return () => {
    store.transaction = original
  }
}

const scenario = (id: string, title: string, run: (ctx: Context) => Promise<void>, since: Scenario<Boot>['since'] = '1.0'): Scenario<Boot> => ({
  id: `leases.${id}`, since, title,
  run: async (boot) => {
    const { ctx, dispose } = await boot()
    try {
      ctx.store.migrate('leases-conformance', [{ version: 1, sql: 'CREATE TABLE leases_conformance_commits (resource TEXT NOT NULL, generation INTEGER NOT NULL, value TEXT NOT NULL)' }])
      await run(ctx)
    } finally {
      await dispose()
    }
  },
})

export const leasesSuite = defineSuite<Boot>({
  seam: 'leases',
  contract: '1.1',
  scenarios: [
    scenario('one-holder', 'grants a resource to one holder at a time, as a lease@1.0 record, and refuses a second holder while the lease is live (INV-15)', async (ctx) => {
      const lease = valid(ctx.leases.acquire(R, 1000, 'host-a:1:aaa', T0))
      expect(lease).toMatchObject({ resource: R, owner: 'host-a:1:aaa', generation: 1, expiresAt: T0 + 1000 })
      expect(ctx.leases.acquire(R, 1000, 'host-b:2:bbb', T0 + 999)).toBeUndefined()
      expect(ctx.leases.acquire(R, 1000, 'host-a:1:aaa', T0 + 500), 'not even the same owner gets a second lease').toBeUndefined()
      expect(ctx.leases.current(R)).toEqual(lease)
      expect(valid(ctx.leases.acquire('node:run-1/other:1', 1000, 'host-b:2:bbb', T0)).generation, 'another resource is independent').toBe(1)
    }),
    scenario('generation-monotonic', 'raises the resource generation on every new holder and on every invalidation, and never lowers it on release (INV-4)', async (ctx) => {
      const seen: number[] = []
      const first = valid(ctx.leases.acquire(R, 1000, 'host-a:1:aaa', T0))
      seen.push(first.generation)
      ctx.leases.release(first)
      const second = valid(ctx.leases.acquire(R, 1000, 'host-a:1:aaa', T0 + 10))
      seen.push(second.generation)
      const third = valid(ctx.leases.acquire(R, 1000, 'host-b:2:bbb', T0 + 2000))
      seen.push(third.generation)
      seen.push(ctx.leases.invalidate(R))
      seen.push(ctx.leases.invalidate(R))
      seen.push(valid(ctx.leases.acquire(R, 1000, 'host-c:3:ccc', T0 + 2010)).generation)
      for (let i = 1; i < seen.length; i++) expect(seen[i], `generation after step ${i}`).toBeGreaterThan(seen[i - 1]!)
    }),
    scenario('token-required', 'renews and releases only with the holder\'s token: a forged token loses, and a release by another lease leaves the holder in place (INV-15)', async (ctx) => {
      const lease = valid(ctx.leases.acquire(R, 1000, 'host-a:1:aaa', T0))
      const forged: Lease = { ...lease, token: 'x'.repeat(24) }
      expect(failureOf(() => ctx.leases.renew(forged, 1000, T0 + 100))).toBe('LeaseLost')
      ctx.leases.release(forged)
      expect(ctx.leases.current(R)).toEqual(lease)
      const renewed = ctx.leases.renew(lease, 1000, T0 + 500)
      expect(renewed).toMatchObject({ token: lease.token, generation: lease.generation, expiresAt: T0 + 1500 })
      expect(ctx.leases.acquire(R, 1000, 'host-b:2:bbb', T0 + 1200), 'the renewed lease is still live').toBeUndefined()
      ctx.leases.release(renewed)
      expect(ctx.leases.current(R)).toBeUndefined()
    }),
    scenario('expired-takeover', 'lets a new holder take an expired lease with a higher generation, after which the old holder can neither renew nor commit (INV-4)', async (ctx) => {
      const old = valid(ctx.leases.acquire(R, 1000, 'host-a:1:aaa', T0))
      expect(failureOf(() => ctx.leases.renew(old, 1000, T0 + 1000)), 'renewing at expiry').toBe('LeaseLost')
      const next = valid(ctx.leases.acquire(R, 1000, 'host-b:2:bbb', T0 + 1000))
      expect(next.generation).toBeGreaterThan(old.generation)
      expect(failureOf(() => ctx.leases.renew(old, 1000, T0 + 1100))).toBe('LeaseLost')
      expect(commit(ctx, old, T0 + 1100, 'old')).toBe('StaleGeneration')
      expect(commit(ctx, next, T0 + 1100, 'next')).toBe('passed')
      expect(commits(ctx)).toEqual(['next'])
    }),
    scenario('stale-commit-refused', 'refuses a commit fenced by a stale generation or a foreign token, and rolls back the commit\'s writes with it (INV-4, INV-15)', async (ctx) => {
      const old = valid(ctx.leases.acquire(R, 10_000, 'host-a:1:aaa', T0))
      ctx.leases.release(old)
      const lease = valid(ctx.leases.acquire(R, 10_000, 'host-a:1:aaa', T0 + 10))
      expect(commit(ctx, lease, T0 + 20, 'current')).toBe('passed')
      expect(commit(ctx, old, T0 + 30, 'old-lease')).toBe('StaleGeneration')
      expect(commit(ctx, { ...lease, generation: old.generation }, T0 + 40, 'stale-generation')).toBe('StaleGeneration')
      expect(commit(ctx, { ...lease, token: 'y'.repeat(24) }, T0 + 50, 'foreign-token')).toBe('StaleGeneration')
      ctx.leases.release(lease)
      expect(commit(ctx, lease, T0 + 60, 'after-release')).toBe('StaleGeneration')
      expect(commits(ctx)).toEqual(['current'])
    }),
    scenario('invalidate-fences', 'fences every holder at once on invalidation, without waiting for expiry, and frees the resource for a holder of a newer generation (INV-4)', async (ctx) => {
      const lease = valid(ctx.leases.acquire(R, 60_000, 'host-a:1:aaa', T0))
      const generation = ctx.leases.invalidate(R)
      expect(generation).toBeGreaterThan(lease.generation)
      expect(ctx.leases.current(R)).toBeUndefined()
      expect(failureOf(() => ctx.leases.renew(lease, 1000, T0 + 10))).toBe('LeaseLost')
      expect(commit(ctx, lease, T0 + 10, 'fenced')).toBe('StaleGeneration')
      const next = valid(ctx.leases.acquire(R, 1000, 'host-b:2:bbb', T0 + 20))
      expect(next.generation).toBeGreaterThan(generation)
      expect(commits(ctx)).toEqual([])
      expect(ctx.leases.invalidate('node:never-held:1'), 'a resource never held can be fenced too').toBeGreaterThanOrEqual(1)
    }),
    scenario('expired-commit-refused', 'refuses a commit from a lease past its expiry, even with no successor (INV-4)', async (ctx) => {
      const lease = valid(ctx.leases.acquire(R, 1000, 'host-a:1:aaa', T0))
      expect(commit(ctx, lease, T0 + 999, 'live')).toBe('passed')
      expect(commit(ctx, lease, T0 + 1000, 'expired')).toBe('LeaseLost')
      expect(commits(ctx)).toEqual(['live'])
    }),
    scenario('fence-in-transaction', 'checks the fence only inside the committing store transaction, so no successor can take over between the check and the commit (INV-4)', async (ctx) => {
      const lease = valid(ctx.leases.acquire(R, 1000, 'host-a:1:aaa', T0))
      expect(failureOf(() => ctx.leases.fence(lease, T0 + 10))).not.toBe('passed')
      expect(commit(ctx, lease, T0 + 10, 'in-transaction')).toBe('passed')
    }),
    scenario('ttl-bounded', 'caps every requested TTL at the configured maximum, also on renewal, and rejects a TTL that is not a positive integer (INV-9)', async (ctx) => {
      const lease = valid(ctx.leases.acquire(R, LEASE_MAX_TTL_MS * 1000, 'host-a:1:aaa', T0))
      expect(lease.expiresAt).toBe(T0 + LEASE_MAX_TTL_MS)
      expect(ctx.leases.renew(lease, LEASE_MAX_TTL_MS * 1000, T0 + 10).expiresAt).toBe(T0 + 10 + LEASE_MAX_TTL_MS)
      for (const ttl of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(failureOf(() => ctx.leases.acquire('node:run-2/x:1', ttl, 'host-a:1:aaa', T0)), `TTL ${ttl}`).not.toBe('passed')
      }
      expect(ctx.leases.current('node:run-2/x:1')).toBeUndefined()
    }),
    scenario('hold-releases', 'runs a held body under one lease and releases it when the body ends, also when it throws; while another holder\'s lease is live, runs nothing and says when to look again (INV-15, INV-9)', async (ctx) => {
      const seen = await ctx.leases.hold(R, 30_000, async (holding) => {
        const lease = holding.lease()
        expect(ctx.leases.current(R)).toEqual(lease)
        expect(holding.lost.aborted).toBe(false)
        return lease.generation
      })
      expect(seen).toMatchObject({ held: true, value: 1 })
      expect(ctx.leases.current(R)).toBeUndefined()
      await expect(ctx.leases.hold(R, 30_000, async () => { throw new Error('boom') })).rejects.toThrow('boom')
      expect(ctx.leases.current(R)).toBeUndefined()
      const other = valid(ctx.leases.acquire(R, 20_000, 'host-b:2:bbb'))
      let ran = false
      const asked = Date.now()
      const busy = await ctx.leases.hold(R, 30_000, async () => { ran = true })
      expect(ran).toBe(false)
      expect(busy.held).toBe(false)
      const retry = (busy as { retryInMs: number }).retryInMs
      expect(retry).toBeGreaterThan(0)
      expect(retry, 'at most the holder\'s expiry plus a second').toBeLessThanOrEqual(other.expiresAt - asked + 1000)
      expect(ctx.leases.current(R)).toEqual(other)
    }),
    scenario('hold-heartbeat-lost', 'renews a held lease on a heartbeat, and aborts the holder\'s lost signal with LeaseLost once the lease is invalidated (INV-4)', async (ctx) => {
      const outcome = await ctx.leases.hold(R, 1200, async (holding) => {
        const first = holding.lease().expiresAt
        await new Promise((resolve) => setTimeout(resolve, 700))
        const renewed = holding.lease().expiresAt > first
        ctx.leases.invalidate(R)
        await new Promise((resolve) => setTimeout(resolve, 700))
        const reason = holding.lost.reason as unknown
        return { renewed, lost: holding.lost.aborted, reason: reason instanceof Error ? reason.name : String(reason) }
      })
      expect(outcome).toEqual({ held: true, value: { renewed: true, lost: true, reason: 'LeaseLost' } })
    }),
    scenario('hold-renews-granted-ttl', 'renews a held lease within the TTL it was granted, not the one its holder asked for: a holder asking for more than maxTtlMs keeps its lease across three granted TTLs, no one else takes it, and its commit passes (INV-4, INV-9)', async (ctx) => {
      // Fake time: the hold outlasts the cap three times over, which real time cannot afford here.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      try {
        const outcome = await ctx.leases.hold(R, LEASE_MAX_TTL_MS * 6, async (holding) => {
          const first = holding.lease()
          const granted = first.expiresAt - Date.now()
          await vi.advanceTimersByTimeAsync(LEASE_MAX_TTL_MS * 3)
          const lease = holding.lease()
          return {
            granted, lost: holding.lost.aborted, live: lease.expiresAt > Date.now(), same: lease.token === first.token && lease.generation === first.generation,
            other: ctx.leases.acquire(R, 1000, 'host-b:2:bbb') === undefined ? 'refused' : 'granted', commit: commit(ctx, lease, Date.now(), 'held'),
          }
        })
        expect(outcome).toEqual({ held: true, value: { granted: LEASE_MAX_TTL_MS, lost: false, live: true, same: true, other: 'refused', commit: 'passed' } })
        expect(commits(ctx)).toEqual(['held'])
      } finally {
        vi.useRealTimers()
      }
    }),
    scenario('hold-renewal-error', 'keeps holding through a renewal that fails with an error other than a loss: lost stays unaborted, the lease is renewed once the store answers again, and no one else takes it meanwhile (ADR-0056)', async (ctx) => {
      const started = Date.now()
      // The store fails from the first beat (at a third of the TTL) until before the lease expires.
      const restore = flaky(ctx, () => Date.now() - started > 250 && Date.now() - started < 650)
      try {
        const outcome = await ctx.leases.hold(R, 1200, async (holding) => {
          const first = holding.lease().expiresAt
          await sleep(1500)
          return { lost: holding.lost.aborted, renewed: holding.lease().expiresAt > first, other: ctx.leases.acquire(R, 1000, 'host-b:2:bbb') === undefined ? 'refused' : 'granted' }
        })
        expect(outcome).toEqual({ held: true, value: { lost: false, renewed: true, other: 'refused' } })
      } finally {
        restore()
      }
    }, '1.1'),
    scenario('hold-lapsed-on-error', 'aborts lost with LeaseLost once the lease\'s own expiry passes with every renewal failing; a new holder then takes the resource, and the old holder\'s commit is refused (ADR-0056, INV-4)', async (ctx) => {
      let failing = false
      const restore = flaky(ctx, () => failing)
      try {
        const outcome = await ctx.leases.hold(R, 1200, async (holding) => {
          // Held: from now on, every renewal fails.
          failing = true
          const old = holding.lease()
          await sleep(900)
          const early = holding.lost.aborted
          await sleep(700)
          const reason = holding.lost.reason as unknown
          failing = false
          const next = valid(ctx.leases.acquire(R, 1000, 'host-b:2:bbb'))
          return { early, lost: holding.lost.aborted, reason: reason instanceof Error ? reason.name : String(reason), higher: next.generation > old.generation, commit: commit(ctx, old, Date.now(), 'old') }
        })
        expect(outcome).toEqual({ held: true, value: { early: false, lost: true, reason: 'LeaseLost', higher: true, commit: 'StaleGeneration' } })
        expect(commits(ctx)).toEqual([])
      } finally {
        restore()
      }
    }, '1.1'),
  ],
})
