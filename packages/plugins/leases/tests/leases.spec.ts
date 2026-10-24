import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'
import Leases, { LeaseLost, StaleGeneration } from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function boot(): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'system-leases-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Leases, {})]
  await Promise.all(fibers)
  cleanups.push(() => fibers[0]!.dispose())
  return ctx
}

const R = 'node:run-1/research:1'

describe('ctx.leases', () => {
  it('grants one holder at a time and returns a schema-valid lease', async () => {
    const ctx = await boot()
    const lease = ctx.leases.acquire(R, 1000, 'a', 0)!
    expect(lease).toMatchObject({ owner: 'a', generation: 1, expiresAt: 1000 })
    expect(() => new SchemaRegistry().assertRecord(lease)).not.toThrow()
    expect(ctx.leases.acquire(R, 1000, 'b', 500)).toBeUndefined()
  })

  it('hands an expired lease to a new holder with a higher generation and fences the old one', async () => {
    const ctx = await boot()
    const old = ctx.leases.acquire(R, 1000, 'a', 0)!
    const next = ctx.leases.acquire(R, 1000, 'b', 1500)!
    expect(next.generation).toBe(2)
    expect(() => ctx.leases.renew(old, 1000, 1600)).toThrow(LeaseLost)
    expect(() => ctx.store.transaction(() => ctx.leases.fence(old, 1600))).toThrow(StaleGeneration)
    expect(() => ctx.store.transaction(() => ctx.leases.fence(next, 1600))).not.toThrow()
  })

  it('renews a live lease and refuses to renew after expiry', async () => {
    const ctx = await boot()
    const lease = ctx.leases.acquire(R, 1000, 'a', 0)!
    expect(ctx.leases.renew(lease, 1000, 900).expiresAt).toBe(1900)
    expect(() => ctx.leases.renew(lease, 1000, 2000)).toThrow(LeaseLost)
  })

  it('invalidation fences every holder without waiting for expiry', async () => {
    const ctx = await boot()
    const lease = ctx.leases.acquire(R, 60_000, 'a', 0)!
    expect(ctx.leases.invalidate(R)).toBe(2)
    expect(() => ctx.leases.renew(lease, 1000, 10)).toThrow(LeaseLost)
    expect(ctx.leases.acquire(R, 1000, 'b', 20)!.generation).toBe(3)
  })

  it('release frees the resource but keeps the generation monotonic', async () => {
    const ctx = await boot()
    const lease = ctx.leases.acquire(R, 1000, 'a', 0)!
    ctx.leases.release(lease)
    expect(ctx.leases.current(R)).toBeUndefined()
    expect(ctx.leases.acquire(R, 1000, 'b', 10)!.generation).toBe(2)
  })

  it('caps TTLs and rejects invalid ones', async () => {
    const ctx = await boot()
    expect(ctx.leases.acquire(R, 10 ** 9, 'a', 0)!.expiresAt).toBe(600_000)
    expect(() => ctx.leases.acquire('other', 0, 'a', 0)).toThrow(RangeError)
  })
})

describe('review fixes (PR #3 kernel review)', () => {
  it('fences by token and generation, inside a transaction, while the lease is live', async () => {
    const ctx = await boot()
    const lease = ctx.leases.acquire(R, 1000, 'a', 0)!
    expect(() => ctx.leases.fence(lease, 10)).toThrow(/transaction/)
    ctx.store.transaction(() => ctx.leases.fence(lease, 10))
    expect(() => ctx.store.transaction(() => ctx.leases.fence({ ...lease, token: 'x'.repeat(24) }, 10))).toThrow(StaleGeneration)
    expect(() => ctx.store.transaction(() => ctx.leases.fence(lease, 2000))).toThrow(LeaseLost)
    ctx.leases.release(lease)
    expect(() => ctx.store.transaction(() => ctx.leases.fence(lease, 10))).toThrow(StaleGeneration)
  })

  it('validates lease records against lease@1.0', async () => {
    const ctx = await boot()
    expect(() => ctx.leases.acquire('bad resource with spaces!', 1000, 'a', 0)).toThrow(/lease@1.0/)
  })
})

/** One lease loop for every durable runner (turns, agent runs, workflow runs). */
describe('ctx.leases.hold', () => {
  it('runs the body under a held lease, then releases it, also when the body throws', async () => {
    const ctx = await boot()
    const seen = await ctx.leases.hold('run:a', 60_000, async (h) => ({ generation: h.lease().generation, lost: h.lost.aborted, holder: ctx.leases.current('run:a')?.token }))
    expect(seen).toMatchObject({ held: true, value: { generation: 1, lost: false } })
    expect((seen as { value: { holder?: string } }).value.holder).toBeTruthy()
    expect(ctx.leases.current('run:a')).toBeUndefined()
    await expect(ctx.leases.hold('run:a', 60_000, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(ctx.leases.current('run:a')).toBeUndefined()
  })

  it('says when to look again while another holder\'s lease is live: its expiry plus a second, at least a second', async () => {
    const ctx = await boot()
    ctx.leases.acquire('run:b', 30_000, 'other-host')
    let ran = false
    const outcome = await ctx.leases.hold('run:b', 60_000, async () => { ran = true })
    expect(ran).toBe(false)
    expect(outcome.held).toBe(false)
    const wait = (outcome as { retryInMs: number }).retryInMs
    expect(wait).toBeGreaterThan(30_000)
    expect(wait).toBeLessThanOrEqual(31_000)
  })

  it('renews the lease on a heartbeat, and aborts `lost` when the lease is taken from it', async () => {
    const ctx = await boot()
    const outcome = await ctx.leases.hold('run:c', 1500, async (h) => {
      const first = h.lease().expiresAt
      await new Promise((resolve) => setTimeout(resolve, 700))
      const renewed = h.lease().expiresAt > first
      ctx.leases.invalidate('run:c')
      await new Promise((resolve) => setTimeout(resolve, 700))
      return { renewed, lost: h.lost.aborted, reason: h.lost.reason }
    })
    expect(outcome).toMatchObject({ held: true, value: { renewed: true, lost: true } })
    expect((outcome as { value: { reason: unknown } }).value.reason).toBeInstanceOf(LeaseLost)
  })

  // The failure mode PROP-0013 found: a transient store error during one heartbeat aborted `lost`, which stops a live agent run.
  it('does not abort `lost` when a renewal throws something other than LeaseLost, and renews at the next beat (ADR-0056, REQ-WRK-16)', async () => {
    const ctx = await boot()
    const renew = ctx.leases.renew.bind(ctx.leases)
    let failures = 0
    ctx.leases.renew = (lease, ttlMs, now) => {
      if (failures++ === 0) throw new Error('database is locked')
      return renew(lease, ttlMs, now)
    }
    const outcome = await ctx.leases.hold('run:d', 1500, async (h) => {
      const first = h.lease().expiresAt
      await new Promise((resolve) => setTimeout(resolve, 1200))
      return { lost: h.lost.aborted, renewed: h.lease().expiresAt > first, failures }
    })
    expect(outcome).toEqual({ held: true, value: { lost: false, renewed: true, failures: expect.any(Number) } })
    expect((outcome as { value: { failures: number } }).value.failures).toBeGreaterThanOrEqual(2)
  })

  it('aborts `lost` with LeaseLost at the lease\'s own expiry when every renewal fails, never earlier', async () => {
    const ctx = await boot()
    ctx.leases.renew = () => {
      throw new Error('disk I/O error')
    }
    const outcome = await ctx.leases.hold('run:e', 1200, async (h) => {
      const expiresAt = h.lease().expiresAt
      await new Promise((resolve) => setTimeout(resolve, 900))
      const early = h.lost.aborted
      await new Promise((resolve) => h.lost.addEventListener('abort', resolve, { once: true }))
      return { early, late: Date.now() >= expiresAt, reason: h.lost.reason }
    })
    expect(outcome).toMatchObject({ held: true, value: { early: false, late: true } })
    const reason = (outcome as { value: { reason: unknown } }).value.reason
    expect(reason).toBeInstanceOf(LeaseLost)
    expect((reason as Error).message).toContain('expired with no renewal (the last one failed: disk I/O error)')
  })
})
