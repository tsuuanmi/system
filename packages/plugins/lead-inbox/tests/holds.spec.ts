// A result held for the operator is told to the lead (T357): one review.held as it is held, one
// review.expiring N hours before its hold expires, and none once it is decided.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import EventLog from '@tsuuanmi/system-event-log'
import { McpTools } from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'
import LeadInbox, { type Config, configProblems, KINDS } from '../src/index.ts'

const schemas = new SchemaRegistry()
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

class RecordingMcp extends McpTools {
  tool(): void {}
}

async function boot(config: Config = {}): Promise<{ ctx: Context; inbox: LeadInbox }> {
  const dir = mkdtempSync(join(tmpdir(), 'system-lead-holds-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(RecordingMcp)]
  await Promise.all(fibers)
  const inboxFiber = ctx.plugin(LeadInbox, config)
  fibers.push(inboxFiber)
  await inboxFiber
  await new Promise((resolve) => setTimeout(resolve, 0))
  const inbox = ctx.leadInbox
  inbox.use({ projectOf: async () => 'alpha', projects: async () => ['alpha'], idle: async () => undefined })
  cleanups.push(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    await new Promise((resolve) => setImmediate(resolve))
  })
  return { ctx, inbox }
}

const HOUR = 3_600_000
const hold = (ctx: Context, taskId: string, expires: number) => ctx.eventLog.append({ type: 'board.review.held', data: { taskId, projectId: 'alpha', expiresAt: new Date(expires).toISOString(), pendingChecks: ['tests'] } })
const of = (inbox: LeadInbox, kind: string) => inbox.unread('alpha').filter((n) => n.kind === kind)

describe('held and expiring notices', () => {
  it('names both kinds, on by default', () => {
    expect(KINDS).toContain('review.held')
    expect(KINDS).toContain('review.expiring')
  })

  it('a fixture hold yields exactly one review.held and one review.expiring, before the expiry', async () => {
    const { ctx, inbox } = await boot()
    const now = Date.now()
    const expires = now + 6 * HOUR
    hold(ctx, 'task-h', expires)
    await inbox.pass(now)
    await inbox.sweep(now + HOUR)
    const held = of(inbox, 'review.held')
    expect(held).toHaveLength(1)
    expect(held[0]!.text).toContain(new Date(expires).toISOString())
    expect(held[0]!.text).toContain('tests')
    expect(held[0]!.text).toContain('/ui')
    expect(of(inbox, 'review.expiring')).toHaveLength(0)
    await inbox.sweep(now + 2.5 * HOUR)
    await inbox.sweep(now + 3 * HOUR)
    await inbox.pass(now + 3 * HOUR)
    expect(of(inbox, 'review.expiring')).toHaveLength(1)
    expect(of(inbox, 'review.held')).toHaveLength(1)
    for (const n of [...of(inbox, 'review.held'), ...of(inbox, 'review.expiring')]) {
      schemas.assert('lead-notice@1.1', n)
      expect(n.taskId).toBe('task-h')
    }
  })

  it('deciding the hold stops further notices and closes the open ones', async () => {
    const { ctx, inbox } = await boot()
    const now = Date.now()
    hold(ctx, 'task-d', now + 6 * HOUR)
    await inbox.pass(now)
    ctx.eventLog.append({ type: 'board.review.ended', data: { taskId: 'task-d', projectId: 'alpha', state: 'done' } })
    await inbox.pass(now + 1000)
    await inbox.sweep(now + 3 * HOUR)
    expect(of(inbox, 'review.held')).toHaveLength(0)
    expect(of(inbox, 'review.expiring')).toHaveLength(0)
  })

  it('reconciles with the board: a hold held before the upgrade is told once and expires on time; one the board no longer holds closes', async () => {
    const { ctx, inbox } = await boot()
    const now = Date.now()
    hold(ctx, 'task-gone', now + 6 * HOUR)
    await inbox.pass(now)
    expect(of(inbox, 'review.held').map((n) => n.taskId)).toEqual(['task-gone'])
    // The board holds task-old, whose event this inbox never read, and no longer holds task-gone (its end was missed).
    inbox.use({ holds: async () => [{ taskId: 'task-old', projectId: 'alpha', expiresMs: now + 6 * HOUR, checks: ['lint'] }] })
    await inbox.sweep(now + 60_000)
    expect(of(inbox, 'review.held').map((n) => n.taskId)).toEqual(['task-old'])
    expect(of(inbox, 'review.held')[0]!.text).toContain('lint')
    await inbox.sweep(now + 2 * 60_000)
    expect(of(inbox, 'review.held')).toHaveLength(1)
    await inbox.sweep(now + 2.5 * HOUR)
    expect(of(inbox, 'review.expiring').map((n) => n.taskId)).toEqual(['task-old'])
    // A board that cannot be read changes nothing.
    inbox.use({ holds: async () => undefined })
    await inbox.sweep(now + 3 * HOUR)
    expect(of(inbox, 'review.expiring').map((n) => n.taskId)).toEqual(['task-old'])
  })

  it('keeps the task, expiry, and link of a hold whole in its text, however long its ids and checks', async () => {
    const link = `https://ui.example/${'u'.repeat(270)}`
    const { ctx, inbox } = await boot({ link })
    const now = Date.now()
    const taskId = `t-${'x'.repeat(198)}`
    const expires = now + 6 * HOUR
    ctx.eventLog.append({ type: 'board.review.held', data: { taskId, projectId: 'alpha', expiresAt: new Date(expires).toISOString(), pendingChecks: Array.from({ length: 8 }, (_, i) => `c${i}${'k'.repeat(60)}`) } })
    await inbox.pass(now)
    const [held] = of(inbox, 'review.held')
    expect(held!.text.length).toBeLessThanOrEqual(1000)
    for (const part of [taskId, new Date(expires).toISOString(), link]) expect(held!.text).toContain(part)
  })

  it('refuses a link that is not an http or https URL', () => {
    expect(configProblems({ link: 'not a url' })).toEqual([expect.stringMatching(/^link is not a URL/)])
    expect(configProblems({ link: 'http://127.0.0.1:47317/ui/#token' })).toEqual([expect.stringMatching(/no fragment/)])
    expect(configProblems({})).toEqual([])
  })

  it('a hold already past its expiry is not announced as expiring', async () => {
    const { ctx, inbox } = await boot({ expiringHours: 4 })
    const now = Date.now()
    hold(ctx, 'task-e', now + HOUR)
    await inbox.pass(now)
    await inbox.sweep(now + 2 * HOUR)
    expect(of(inbox, 'review.expiring')).toHaveLength(0)
  })
})
