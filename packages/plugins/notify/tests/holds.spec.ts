// The operator's channel for held results (T357): with `holds` off nothing is sent; on, one batched
// message per sweep lists the new holds and the expiring ones, bounded per hour, and a decided hold is forgotten.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import EventLog from '@tsuuanmi/system-event-log'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'
import { type Config, Notifier, type Notice, type Outcome, type Sink } from '../src/index.ts'

const schemas = new SchemaRegistry()
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

class FakeSink implements Sink {
  readonly name = 'webhook' as const
  readonly sent: Notice[] = []
  async send(notice: Notice): Promise<Outcome> {
    this.sent.push(notice)
    return { sent: true }
  }
}

async function boot(config: Config): Promise<{ ctx: Context; sink: FakeSink; notifier: Notifier }> {
  const dir = mkdtempSync(join(tmpdir(), 'system-notify-holds-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {})]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 0))
  cleanups.push(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    await new Promise((resolve) => setImmediate(resolve))
  })
  const sink = new FakeSink()
  const notifier = new Notifier(ctx, config, [sink])
  cleanups.push(() => notifier.dispose())
  return { ctx, sink, notifier }
}

const HOUR = 3_600_000
const NOW = Date.now()
const hold = (ctx: Context, taskId: string, expires: number) => ctx.eventLog.append({ type: 'board.review.held', data: { taskId, projectId: 'alpha', expiresAt: new Date(expires).toISOString(), pendingChecks: [] } })

describe('notify.holds', () => {
  it('off (the default) sends nothing of a hold, new or expiring', async () => {
    const { ctx, sink, notifier } = await boot({ expiryLeadMinutes: 1 })
    hold(ctx, 'task-1', NOW + 6 * HOUR)
    notifier.pass(NOW)
    notifier.pass(NOW + 3 * HOUR)
    await notifier.idle()
    expect(sink.sent).toEqual([])
  })

  it('on, one batched message lists every new hold, and one the expiring ones, none once decided', async () => {
    const { ctx, sink, notifier } = await boot({ holds: 'on', holdsLeadHours: 4 })
    hold(ctx, 'task-1', NOW + 6 * HOUR)
    hold(ctx, 'task-2', NOW + 7 * HOUR)
    notifier.pass(NOW)
    await notifier.idle()
    expect(sink.sent).toHaveLength(1)
    const first = sink.sent[0]!
    expect(first.kind).toBe('review.held')
    expect(first.text).toContain('task-1')
    expect(first.text).toContain('task-2')
    schemas.assert('notification@1.3', first)
    // Not yet within the lead: nothing more.
    notifier.pass(NOW + HOUR)
    await notifier.idle()
    expect(sink.sent).toHaveLength(1)
    // task-2 is decided; task-1 is within 4 hours of its expiry: one message, naming only task-1, once.
    ctx.eventLog.append({ type: 'board.review.ended', data: { taskId: 'task-2', projectId: 'alpha', state: 'done' } })
    notifier.pass(NOW + 3 * HOUR)
    await notifier.idle()
    expect(sink.sent).toHaveLength(2)
    expect(sink.sent[1]!.kind).toBe('review.expiring')
    expect(sink.sent[1]!.text).toContain('task-1')
    expect(sink.sent[1]!.text).not.toContain('task-2')
    notifier.pass(NOW + 3.5 * HOUR)
    await notifier.idle()
    expect(sink.sent).toHaveLength(2)
  })

  it('names every hold whole across its messages, each within the text bound, and tells none it left out', async () => {
    const { ctx, sink, notifier } = await boot({ holds: 'on', holdsPerHour: 60 })
    // Ids as long as an id may be (200 characters): more than one message's text can hold.
    const ids = Array.from({ length: 8 }, (_, i) => `t${i}-${'x'.repeat(197)}`)
    const project = `p-${'y'.repeat(198)}`
    for (const [i, id] of ids.entries()) ctx.eventLog.append({ type: 'board.review.held', data: { taskId: id, projectId: project, expiresAt: new Date(NOW + (48 + i) * HOUR).toISOString(), pendingChecks: [] } })
    for (let i = 0; i < 8 && sink.sent.length < 8; i++) {
      notifier.pass(NOW + i * 60_000)
      await notifier.idle()
    }
    expect(sink.sent.length).toBeGreaterThan(1)
    for (const n of sink.sent) {
      expect(n.text.length).toBeLessThanOrEqual(1000)
      expect(n.text.endsWith('(review-expired).')).toBe(true)
      schemas.assert('notification@1.3', n)
    }
    // The first message counts the ones it could not name; together they name each hold once.
    expect(sink.sent[0]!.text).toMatch(/ \d+ more wait: on \/ui now, and in the next message\./)
    const named = ids.map((id) => sink.sent.filter((n) => n.text.includes(id)).length)
    expect(named).toEqual(ids.map(() => 1))
    // Once all are named, nothing more is sent.
    const sent = sink.sent.length
    notifier.pass(NOW + 30 * 60_000)
    await notifier.idle()
    expect(sink.sent).toHaveLength(sent)
  })

  it('tells, once on, a hold it read while holds was off', async () => {
    const { ctx, sink, notifier } = await boot({})
    hold(ctx, 'task-off', NOW + 6 * HOUR)
    notifier.pass(NOW)
    await notifier.idle()
    expect(sink.sent).toEqual([])
    notifier.dispose()
    // The daemon restarts with holds on: the cursor is past the hold's event.
    const on = new Notifier(ctx, { holds: 'on' }, [sink])
    cleanups.push(() => on.dispose())
    on.pass(NOW + 60_000)
    await on.idle()
    expect(sink.sent).toHaveLength(1)
    expect(sink.sent[0]!.text).toContain('task-off')
    // And its expiry, before it: the per-task reminder is folded into the batch, never lost.
    on.pass(NOW + 3 * HOUR)
    await on.idle()
    expect(sink.sent.map((n) => n.kind)).toEqual(['review.held', 'review.expiring'])
  })

  it('reconciles with the holds the board shows: one held before the upgrade is told, one the board no longer holds is forgotten', async () => {
    const { ctx, sink, notifier } = await boot({ holds: 'on' })
    hold(ctx, 'task-gone', NOW + 6 * HOUR)
    notifier.pass(NOW)
    await notifier.idle()
    expect(sink.sent).toHaveLength(1)
    // The board holds task-old (its event is not in this log) and no longer holds task-gone (its end was missed).
    notifier.use({ holds: async () => [{ taskId: 'task-old', projectId: 'alpha', expiresMs: NOW + 6 * HOUR }] })
    await notifier.sweep(NOW + 60_000)
    notifier.pass(NOW + 60_000)
    await notifier.idle()
    expect(sink.sent).toHaveLength(2)
    expect(sink.sent[1]!.text).toContain('task-old')
    expect(sink.sent[1]!.text).not.toContain('task-gone')
    notifier.pass(NOW + 3 * HOUR)
    await notifier.idle()
    expect(sink.sent).toHaveLength(3)
    expect(sink.sent[2]!.text).toContain('task-old')
    expect(sink.sent[2]!.text).not.toContain('task-gone')
    // A board that cannot be read changes nothing.
    notifier.use({ holds: async () => undefined })
    await notifier.sweep(NOW + 3 * HOUR)
    notifier.pass(NOW + 3 * HOUR + 60_000)
    await notifier.idle()
    expect(sink.sent).toHaveLength(3)
  })

  it('is bounded per hour: more holds wait for the next hour, in one message', async () => {
    const { ctx, sink, notifier } = await boot({ holds: 'on', holdsPerHour: 1 })
    hold(ctx, 'task-1', NOW + 48 * HOUR)
    notifier.pass(NOW)
    hold(ctx, 'task-2', NOW + 48 * HOUR)
    notifier.pass(NOW + 60_000)
    await notifier.idle()
    expect(sink.sent).toHaveLength(1)
    notifier.pass(NOW + HOUR + 120_000)
    await notifier.idle()
    expect(sink.sent).toHaveLength(2)
    expect(sink.sent[1]!.text).toContain('task-2')
    expect(sink.sent[1]!.text).not.toContain('task-1')
  })
})
