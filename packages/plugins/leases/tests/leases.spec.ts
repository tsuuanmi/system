import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it, onTestFinished } from 'vitest'
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

})
