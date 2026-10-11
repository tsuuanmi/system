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

async function boot(): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'system-events-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(EventLog, {})]
  await Promise.all(fibers)
  cleanups.push(() => fibers[0]!.dispose())
  return ctx
}

describe('ctx.eventLog', () => {
  it('assigns monotonic sequence numbers and announces each entry live', async () => {
    const ctx = await boot()
    const seen: SystemEvent[] = []
    ctx.on('system/event', (event) => void seen.push(event))
    const a = ctx.eventLog.append({ type: 'provider.turn.submitted', runId: 'run-1', data: { account: 'chatgpt-main' } })
    const b = ctx.eventLog.append({ type: 'provider.turn.completed', runId: 'run-1' })
    expect([a.seq, b.seq]).toEqual([1, 2])
    expect(seen.map((event) => event.seq)).toEqual([1, 2])
  })

  it('queries after a cursor with filters', async () => {
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
