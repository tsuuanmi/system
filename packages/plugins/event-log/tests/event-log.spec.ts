import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'
import EventLog, { type SystemEvent } from '../src/index.ts'

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

describe('ctx.eventLog', () => {
  it('assigns monotonic sequence numbers and announces each entry live (QA-7)', async () => {
    const ctx = await boot()
    const seen: SystemEvent[] = []
    ctx.on('system/event', (event) => void seen.push(event))
    const a = ctx.eventLog.append({ type: 'provider.turn.submitted', runId: 'run-1', data: { account: 'chatgpt-main' } })
    const b = ctx.eventLog.append({ type: 'provider.turn.completed', runId: 'run-1' })
    expect([a.seq, b.seq]).toEqual([1, 2])
    expect(seen.map((event) => event.seq)).toEqual([1, 2])
  })

  it('queries after a cursor with filters (QA-7)', async () => {
    const ctx = await boot()
    ctx.eventLog.append({ type: 'node.started', runId: 'run-1' })
    ctx.eventLog.append({ type: 'node.started', runId: 'run-2' })
    ctx.eventLog.append({ type: 'node.completed', runId: 'run-1' })
    expect(ctx.eventLog.query({ runId: 'run-1' }).map((event) => event.type)).toEqual(['node.started', 'node.completed'])
    expect(ctx.eventLog.query({ afterSeq: 2 }).map((event) => event.seq)).toEqual([3])
  })

  it('rejects malformed types and oversized data', async () => {
    const ctx = await boot()
    expect(() => ctx.eventLog.append({ type: 'NoDots' })).toThrow(/event@1.0/)
    expect(() => ctx.eventLog.append({ type: 'a.b', data: { blob: 'x'.repeat(20_000) } })).toThrow(RangeError)
    expect(ctx.eventLog.query()).toEqual([])
  })
})

describe('review fixes (PR #3 kernel review)', () => {
  it('announces only committed entries and never lets a listener veto or fail the append', async () => {
    const ctx = await boot()
    const seen: string[] = []
    ctx.on('system/event', (event) => {
      seen.push(`${event.seq}:${event.type}`)
      throw new Error('listener failure')
    })
    expect(() => ctx.store.transaction(() => {
      ctx.eventLog.append({ type: 'a.phantom' })
      throw new Error('outer rollback')
    })).toThrow('outer rollback')
    expect(() => ctx.eventLog.append({ type: 'b.real' })).not.toThrow()
    expect(seen).toEqual(['1:b.real'])
    expect(ctx.eventLog.query().map((event) => `${event.seq}:${event.type}`)).toEqual(['1:b.real'])
  })

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
    expect(ctx.eventLog.trim()).toBe(1)
    expect(ctx.eventLog.query().map((e) => e.type)).toEqual(['new.one'])
    const kept = await boot()
    kept.eventLog.append({ type: 'any.one' })
    expect(kept.eventLog.trim(Date.now() + 365 * day)).toBe(0)
  })

  it('reads what happened since a time, newest included, whatever came before (QA-7)', async () => {
    const ctx = await boot()
    for (let i = 0; i < 3; i++) ctx.eventLog.append({ type: 'ui.drift', data: { i } })
    ctx.store.db.prepare("UPDATE events SET at = '2026-01-01T00:00:00.000Z' WHERE seq < 3").run()
    expect(ctx.eventLog.query({ type: 'ui.drift', since: '2026-06-01T00:00:00.000Z' }).map((e) => e.data)).toEqual([{ i: 2 }])
  })
})
