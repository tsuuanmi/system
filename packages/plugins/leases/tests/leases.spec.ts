import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it, onTestFinished } from 'vitest'
import { LeaseLost } from '@tsuuanmi/system-board-core'
import Leases from '../src/index.ts'

async function boot(): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'system-leases-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Leases, {})]
  await Promise.all(fibers)
  onTestFinished(() => fibers[0]!.dispose())
  return ctx
}

const R = 'node:run-1/research:1'

// The seam's contract is held by its conformance suite (conformance.spec.ts); these tests pin what
// only this provider does.
describe('ctx.leases', () => {
  it('caps TTLs and rejects invalid ones', async () => {
    const ctx = await boot()
    expect(ctx.leases.acquire(R, 10 ** 9, 'a', 0)!.expiresAt).toBe(600_000)
    expect(() => ctx.leases.acquire('other', 0, 'a', 0)).toThrow(RangeError)
  })
})

describe('review fixes (PR #3 kernel review)', () => {
  it('validates lease records against lease@1.0', async () => {
    const ctx = await boot()
    expect(() => ctx.leases.acquire('bad resource with spaces!', 1000, 'a', 0)).toThrow(/lease@1.0/)
  })
})

/** One lease loop for every durable runner (turns, agent runs, workflow runs). */
describe('ctx.leases.hold', () => {
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
