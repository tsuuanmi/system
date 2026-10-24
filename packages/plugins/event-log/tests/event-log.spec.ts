import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'
import EventLog from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function boot(config: { retainDays?: number } = {}): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'system-events-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(EventLog, config)]
  await Promise.all(fibers)
  cleanups.push(() => fibers[0]!.dispose())
  return ctx
}

// The seam's contract is held by its conformance suite (conformance.spec.ts); these tests pin what
// only this provider does.
describe('review fixes (PR #3 kernel review)', () => {
  it('clamps non-integer limits instead of failing', async () => {
    const ctx = await boot()
    ctx.eventLog.append({ type: 'a.b' })
    expect(ctx.eventLog.query({ limit: Number.NaN })).toHaveLength(1)
    expect(ctx.eventLog.query({ limit: 2.5 })).toHaveLength(1)
  })

  it('keeps every entry by default, and trims those older than retainDays when configured (INV-9)', async () => {
    const day = 24 * 60 * 60_000
    const ctx = await boot({ retainDays: 30 })
    for (const type of ['old.one', 'new.one']) ctx.eventLog.append({ type })
    // Age the first entry by hand: the log assigns `at` itself.
    const old = new Date(Date.now() - 31 * day).toISOString()
    ctx.store.db.prepare("UPDATE events SET at = ? WHERE type = 'old.one'").run(old)
    expect(ctx.eventLog.trim(Date.now(), 1)).toBe(1)
    expect(ctx.eventLog.query().map((e) => e.type)).toEqual(['new.one'])
    const kept = await boot()
    kept.eventLog.append({ type: 'any.one' })
    expect(kept.eventLog.trim(Date.now() + 365 * day)).toBe(0)
  })

})
