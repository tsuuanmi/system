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
    expect(() => ctx.leases.fence(R, old.generation)).toThrow(StaleGeneration)
    expect(() => ctx.leases.fence(R, next.generation)).not.toThrow()
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
