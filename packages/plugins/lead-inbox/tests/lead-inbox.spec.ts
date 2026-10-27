// A project's lead inbox (docs/design/notifications.md#the-leads-inbox): each kind made from its
// recorded event, a lead of one project never seeing another's notices, a decided request closing
// its notice, the long-poll returning on a new notice and timing out otherwise, a command sink given
// each notice once and a failing sink recorded without blocking, a landing pushed as task.landed, and
// duplicates within the window kept as one.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import EventLog, { type SystemEvent } from '@tsuuanmi/system-event-log'
import { McpTools, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LeadInbox, { type Config, configProblems, DELIVERY_EVENT, type LeadNotice, readEvent } from '../src/index.ts'

const schemas = new SchemaRegistry()
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'system-lead-inbox-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A `ctx.mcp` that keeps contributed tools, so a test calls a handler as a lead's token would. */
class RecordingMcp extends McpTools {
  readonly tools = new Map<string, { spec: ToolSpec; handler: ToolHandler }>()
  tool(name: string, spec: ToolSpec, handler: ToolHandler): void {
    this.tools.set(name, { spec, handler })
  }
}

const TASKS: Record<string, string> = { 'task-a': 'alpha', 'task-a2': 'alpha', 'task-b': 'beta' }

async function boot(config: Config = {}): Promise<{ ctx: Context; inbox: LeadInbox; mcp: RecordingMcp; dir: string }> {
  const dir = tempDir()
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(RecordingMcp)]
  await Promise.all(fibers)
  const inboxFiber = ctx.plugin(LeadInbox, config)
  fibers.push(inboxFiber)
  await inboxFiber
  await new Promise((resolve) => setTimeout(resolve, 0))
  const inbox = ctx.leadInbox
  inbox.use({ projectOf: async (taskId) => TASKS[taskId], projects: async () => ['alpha', 'beta'], idle: async () => undefined })
  cleanups.push(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    await new Promise((resolve) => setImmediate(resolve))
  })
  return { ctx, inbox, mcp: ctx.mcp as RecordingMcp, dir }
}

const append = (ctx: Context, type: string, data: Record<string, unknown>) => ctx.eventLog.append({ type, data })
const landed = (ctx: Context, taskId: string, commit = 'abcdef0123456789') => append(ctx, 'workflow.task.landing', { taskId, state: 'merged', commit, changed: '3 files changed, 10 insertions(+)', branch: 'dev' })
const kinds = (notices: LeadNotice[]): string[] => notices.map((n) => n.kind)
const deliveries = (ctx: Context) => ctx.eventLog.query({ type: DELIVERY_EVENT, limit: 1000 }).map((e) => e.data as Record<string, unknown>)

const event = (type: string, data: Record<string, unknown>): SystemEvent => ({ schema: 'event@1.0', seq: 7, at: new Date().toISOString(), type, data }) as SystemEvent

describe('each kind is made from its recorded event', () => {
  it('reads every event into the drafts, closings, and open request it means', () => {
    const held = readEvent(event('board.review.held', { taskId: 'task-a', projectId: 'alpha', expiresAt: new Date().toISOString(), pendingChecks: ['tests'] }))
    expect(held.drafts).toMatchObject([{ kind: 'result.held', subject: 'task-a', project: 'alpha' }])
    expect(readEvent(event('board.review.ended', { taskId: 'task-a' })).closes).toEqual([{ kinds: ['result.held'], subject: 'task-a' }])
    expect(readEvent(event('workflow.task.landing', { taskId: 'task-a', state: 'asked', requestId: 'apr_1' })).drafts).toMatchObject([{ kind: 'merge.held', subject: 'apr_1', taskId: 'task-a' }])
    expect(readEvent(event('workflow.task.question', { taskId: 'task-a', questions: 2 })).drafts).toMatchObject([{ kind: 'worker.question', subject: 'task-a' }])
    expect(readEvent(event('board.waiting', { taskId: 'task-a', projectId: 'alpha', reason: 'retries-spent' })).drafts).toMatchObject([{ kind: 'task.retries-spent', project: 'alpha' }])
    expect(readEvent(event('board.waiting', { taskId: 'task-a', projectId: 'alpha', reason: 'question' })).drafts).toEqual([])
    const gaveUp = readEvent(event('workflow.task.landing', { taskId: 'task-a', state: 'refused', cause: 'moving', reason: 'dev moved again after 3 rebase(s) of this result (now at abc)' }))
    expect(gaveUp.drafts).toMatchObject([{ kind: 'task.landing-gave-up', subject: 'task-a' }])
    expect(gaveUp.drafts[0]!.text).toContain('moved again after 3 rebase(s)')
    expect(readEvent(event('approvals.lead-refused', { projectId: 'alpha', requestId: 'apr_2', actionClass: 'deploy' })).drafts).toMatchObject([{ kind: 'request.outside-rights', subject: 'apr_2', project: 'alpha' }])
    expect(readEvent(event('host.live-update', { outcome: 'done', from: 'e218ae7', to: 'f00dbab' })).drafts).toMatchObject([{ kind: 'live-update.done', everyProject: true }])
    expect(readEvent(event('host.live-update', { outcome: 'failed', reason: 'rolled-back' })).drafts).toMatchObject([{ kind: 'live-update.failed' }])
    const done = readEvent(event('workflow.task.landing', { taskId: 'task-a', state: 'merged', commit: 'abcdef0123', changed: '1 file changed, 2 insertions(+)', branch: 'dev' }))
    expect(done.drafts).toMatchObject([{ kind: 'task.landed', subject: 'task-a', commit: 'abcdef0123', changed: '1 file changed, 2 insertions(+)' }])
    expect(readEvent(event('approvals.requested', { requestId: 'apr_3', projectId: 'alpha' })).opened).toEqual({ requestId: 'apr_3', project: 'alpha' })
    // What it cannot read whole means nothing.
    expect(readEvent(event('board.review.held', { taskId: 'not an id', projectId: 'alpha' })).drafts).toEqual([])
    expect(readEvent(event('workflow.task.landing', { taskId: 'task-a', state: 'merged', commit: 'not a sha; rm -rf' })).drafts[0]).not.toHaveProperty('commit')
  })

  it('keeps each as a valid lead-notice@1.0 addressed to lead:<project>, from the event log', async () => {
    const { ctx, inbox, mcp } = await boot()
    // The live update's end is recorded the way scripts/live-update.sh records it: the operator's MCP live_update_record.
    const record = mcp.tools.get('live_update_record')!
    expect(record.spec.scope).toBe('operator')
    const recorded = await record.handler({ outcome: 'done', from: 'e218ae7', to: 'f00dbab' }, { scope: 'operator' })
    expect(recorded.isError).toBeFalsy()
    expect(ctx.eventLog.query({ type: 'host.live-update', limit: 10 }).map((e) => e.data)).toEqual([{ outcome: 'done', from: 'e218ae7', to: 'f00dbab' }])
    expect((await record.handler({ outcome: 'maybe' }, { scope: 'operator' })).isError).toBe(true)
    append(ctx, 'board.review.held', { taskId: 'task-a', projectId: 'alpha', expiresAt: new Date(Date.now() + 3600_000).toISOString(), pendingChecks: [] })
    append(ctx, 'workflow.task.question', { taskId: 'task-a2', questions: 1 })
    append(ctx, 'board.waiting', { taskId: 'task-a', projectId: 'alpha', reason: 'retries-spent' })
    append(ctx, 'workflow.task.landing', { taskId: 'task-a', state: 'asked', requestId: 'apr_1' })
    append(ctx, 'workflow.task.landing', { taskId: 'task-a2', state: 'refused', cause: 'moving', reason: 'dev moved again after 3 rebase(s)' })
    append(ctx, 'approvals.lead-refused', { projectId: 'alpha', requestId: 'apr_2', actionClass: 'deploy' })
    await inbox.pass()
    const alpha = inbox.unread('alpha')
    expect(new Set(kinds(alpha))).toEqual(new Set(['result.held', 'worker.question', 'task.retries-spent', 'merge.held', 'task.landing-gave-up', 'request.outside-rights', 'live-update.done']))
    for (const n of alpha) {
      schemas.assert('lead-notice@1.0', n)
      expect(n.to).toBe('lead:alpha')
      expect(n.act.length).toBeGreaterThan(0)
    }
    // A live update tells every project.
    expect(kinds(inbox.unread('beta'))).toEqual(['live-update.done'])
  })

  it('makes request.stale for an open request older than the configured minutes, once, and none once it is decided', async () => {
    const { ctx, inbox } = await boot({ staleMinutes: 10 })
    append(ctx, 'approvals.requested', { requestId: 'apr_old', projectId: 'alpha', actionClass: 'merge', expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
    append(ctx, 'approvals.requested', { requestId: 'apr_done', projectId: 'alpha', actionClass: 'merge', expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
    append(ctx, 'approvals.requested', { requestId: 'apr_task', taskId: 'task-b', actionClass: 'command', expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
    append(ctx, 'approvals.resolved', { requestId: 'apr_done', state: 'approved' })
    await inbox.pass()
    await inbox.sweep(Date.now() + 5 * 60_000)
    expect(inbox.unread()).toEqual([])
    await inbox.sweep(Date.now() + 11 * 60_000)
    expect(inbox.unread().map((n) => `${n.project}:${n.subject}`).sort()).toEqual(['alpha:apr_old', 'beta:apr_task'])
    await inbox.sweep(Date.now() + 40 * 60_000)
    expect(inbox.unread()).toHaveLength(2)
  })

  it('makes quota.idle for a ready task a free Worker could take, past the configured minutes', async () => {
    const { inbox } = await boot({ idleMinutes: 10 })
    inbox.use({ idle: async () => [{ projectId: 'alpha', taskId: 'task-a' }] })
    const start = Date.now()
    await inbox.sweep(start)
    await inbox.sweep(start + 5 * 60_000)
    expect(inbox.unread()).toEqual([])
    await inbox.sweep(start + 11 * 60_000)
    expect(inbox.unread()).toMatchObject([{ kind: 'quota.idle', project: 'alpha', subject: 'task-a' }])
    // A task no longer ready or free forgets its clock.
    inbox.use({ idle: async () => [] })
    await inbox.sweep(start + 12 * 60_000)
    inbox.use({ idle: async () => [{ projectId: 'alpha', taskId: 'task-a2' }] })
    await inbox.sweep(start + 13 * 60_000)
    expect(inbox.unread()).toHaveLength(1)
  })

  it('batches the landings of an interval into one digest notice, beside the notice of each landing', async () => {
    const { ctx, inbox } = await boot({ digestMinutes: 60 })
    const start = Date.now()
    await inbox.sweep(start)
    landed(ctx, 'task-a', 'aaaa1111')
    landed(ctx, 'task-a2', 'bbbb2222')
    await inbox.pass()
    await inbox.sweep(start + 30 * 60_000)
    expect(inbox.digests('alpha')).toEqual([])
    await inbox.sweep(start + 61 * 60_000)
    const [digest] = inbox.digests('alpha')
    expect(digest).toMatchObject({ kind: 'task.digest', project: 'alpha', landed: [{ taskId: 'task-a', commit: 'aaaa1111' }, { taskId: 'task-a2', commit: 'bbbb2222' }] })
    schemas.assert('lead-notice@1.0', digest)
    expect(inbox.unread('alpha').filter((n) => n.kind === 'task.landed')).toHaveLength(2)
  })
})

describe('a project\'s lead sees only its own inbox', () => {
  it('MCP lead_inbox answers a lead token with its project\'s notices only, and refuses another project', async () => {
    const { ctx, inbox, mcp } = await boot()
    landed(ctx, 'task-a')
    landed(ctx, 'task-b')
    await inbox.pass()
    const tool = mcp.tools.get('lead_inbox')!
    expect(tool.spec.scope).toBe('client')
    const alpha = await tool.handler({}, { scope: 'client', lead: 'alpha' })
    expect((alpha.structuredContent as { notices: LeadNotice[] }).notices.map((n) => n.project)).toEqual(['alpha'])
    const beta = await tool.handler({}, { scope: 'client', lead: 'beta' })
    expect((beta.structuredContent as { notices: LeadNotice[] }).notices.map((n) => n.subject)).toEqual(['task-b'])
    const other = await tool.handler({ projectId: 'beta' }, { scope: 'client', lead: 'alpha' })
    expect(other.isError).toBe(true)
    // A client token that is no lead's reads none; the operator names the project.
    expect((await tool.handler({}, { scope: 'client' })).isError).toBe(true)
    const operator = await tool.handler({ projectId: 'beta' }, { scope: 'operator' })
    expect((operator.structuredContent as { notices: LeadNotice[] }).notices.map((n) => n.project)).toEqual(['beta'])
  })

  it('ack marks a lead\'s own notices handled, and another project\'s id stays unknown and unread', async () => {
    const { ctx, inbox, mcp } = await boot()
    landed(ctx, 'task-a')
    landed(ctx, 'task-b')
    await inbox.pass()
    const [a] = inbox.unread('alpha')
    const [b] = inbox.unread('beta')
    const tool = mcp.tools.get('lead_inbox')!
    const result = await tool.handler({ ack: [a!.id, b!.id] }, { scope: 'client', lead: 'alpha' })
    expect(result.structuredContent).toMatchObject({ acked: [a!.id], unknown: [b!.id], notices: [] })
    expect(inbox.unread('beta')).toHaveLength(1)
    expect(inbox.stats('alpha')).toMatchObject({ unread: 0, handled: 1, waitMs: { n: 1 }, touches: { tasks: 1, median: 1 } })
  })
})

describe('a notice handled through its subject closes by itself', () => {
  it('a decided request closes its merge.held, outside-rights, and stale notices', async () => {
    const { ctx, inbox } = await boot({ staleMinutes: 1 })
    append(ctx, 'approvals.requested', { requestId: 'apr_1', projectId: 'alpha', actionClass: 'merge', expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
    append(ctx, 'workflow.task.landing', { taskId: 'task-a', state: 'asked', requestId: 'apr_1' })
    append(ctx, 'approvals.lead-refused', { projectId: 'alpha', requestId: 'apr_1', actionClass: 'merge' })
    await inbox.pass()
    await inbox.sweep(Date.now() + 2 * 60_000)
    expect(new Set(kinds(inbox.unread('alpha')))).toEqual(new Set(['merge.held', 'request.outside-rights', 'request.stale']))
    append(ctx, 'approvals.resolved', { requestId: 'apr_1', state: 'approved' })
    await inbox.pass()
    expect(inbox.unread('alpha')).toEqual([])
    expect(inbox.stats('alpha').handled).toBe(3)
  })

  it('a task that moves closes its held result, its question, and its spent retries', async () => {
    const { ctx, inbox } = await boot()
    append(ctx, 'board.review.held', { taskId: 'task-a', projectId: 'alpha', expiresAt: new Date(Date.now() + 3600_000).toISOString(), pendingChecks: [] })
    append(ctx, 'workflow.task.question', { taskId: 'task-a2', questions: 1 })
    append(ctx, 'board.waiting', { taskId: 'task-a2', projectId: 'alpha', reason: 'retries-spent' })
    await inbox.pass()
    expect(inbox.unread('alpha')).toHaveLength(3)
    append(ctx, 'board.review.ended', { taskId: 'task-a', projectId: 'alpha', state: 'done' })
    append(ctx, 'board.waiting.ended', { taskId: 'task-a2', projectId: 'alpha', state: 'ready' })
    await inbox.pass()
    expect(inbox.unread('alpha')).toEqual([])
  })

  it('a later landing step closes a give-up told before it', async () => {
    const { ctx, inbox } = await boot()
    append(ctx, 'workflow.task.landing', { taskId: 'task-a', state: 'refused', cause: 'moving', reason: 'dev moved again after 3 rebase(s)' })
    await inbox.pass()
    expect(kinds(inbox.unread('alpha'))).toEqual(['task.landing-gave-up'])
    append(ctx, 'workflow.task.landing', { taskId: 'task-a', state: 'asked', requestId: 'apr_9' })
    await inbox.pass()
    expect(kinds(inbox.unread('alpha'))).toEqual(['merge.held'])
  })
})

describe('lead wait', () => {
  it('returns at once on a notice unread already, on a new notice while it waits, and times out otherwise', async () => {
    const { ctx, inbox } = await boot()
    // Nothing unread: it times out with nothing.
    expect(await inbox.wait('alpha', 30)).toEqual([])
    // It returns as a notice of its project commits, not on another project's.
    const waiting = inbox.wait('alpha', 5000)
    landed(ctx, 'task-b')
    await inbox.pass()
    landed(ctx, 'task-a')
    await inbox.pass()
    expect(kinds(await waiting)).toEqual(['task.landed'])
    expect((await waiting)[0]!.project).toBe('alpha')
    // Unread already: at once.
    expect(await inbox.wait('alpha', 5000)).toHaveLength(1)
    const [n] = inbox.unread('alpha')
    inbox.ack([n!.id], 'alpha')
    expect(await inbox.wait('alpha', 30)).toEqual([])
  })

  it('MCP waitSeconds blocks for a notice, and a stopped inbox releases its waiters', async () => {
    const { ctx, inbox, mcp } = await boot()
    const tool = mcp.tools.get('lead_inbox')!
    const pending = tool.handler({ waitSeconds: 5 }, { scope: 'client', lead: 'beta' })
    landed(ctx, 'task-b')
    await inbox.pass()
    expect(((await pending).structuredContent as { notices: LeadNotice[] }).notices).toHaveLength(1)
    const stopped = inbox.wait('alpha', 60_000)
    inbox.stop()
    expect(await stopped).toEqual([])
  })
})

describe('push delivery', () => {
  const script = (dir: string): string => {
    const file = join(dir, 'sink.mjs')
    writeFileSync(file, "import { appendFileSync } from 'node:fs'\nlet s = ''\nprocess.stdin.on('data', (d) => { s += d }).on('end', () => appendFileSync(process.argv[2], s))\n")
    return file
  }

  it('a command sink receives each notice once as JSON on stdin, and a landing is pushed as task.landed', async () => {
    const dir = tempDir()
    const out = join(dir, 'received.jsonl')
    const { ctx, inbox } = await boot({ projects: { alpha: { sinks: [{ type: 'command', argv: [process.execPath, script(dir), out] }, { type: 'wait' }] } } })
    landed(ctx, 'task-a', 'abcdef0123456789')
    landed(ctx, 'task-b')
    await inbox.pass()
    await inbox.idle()
    const lines = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LeadNotice)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ kind: 'task.landed', project: 'alpha', to: 'lead:alpha', taskId: 'task-a', commit: 'abcdef0123456789', changed: '3 files changed, 10 insertions(+)' })
    // Read again: the same event pushes nothing more.
    await inbox.pass()
    await inbox.idle()
    expect(readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(1)
    expect(deliveries(ctx).filter((d) => d.project === 'alpha')).toMatchObject([{ outcome: 'sent', sink: 'command' }, { outcome: 'sent', sink: 'wait' }])
    // Beta configures no sink row: nothing is pushed for it, though its notice is kept.
    expect(deliveries(ctx).filter((d) => d.project === 'beta')).toEqual([])
    expect(inbox.unread('beta')).toHaveLength(1)
  })

  it('a failing or hanging sink is recorded, never blocks the next sink or the inbox, and is not retried', async () => {
    const dir = tempDir()
    const out = join(dir, 'received.jsonl')
    const { ctx, inbox } = await boot({
      projects: { alpha: { sinks: [
        { type: 'command', argv: [process.execPath, '-e', 'process.stderr.write("boom"); process.exit(3)'] },
        { type: 'command', argv: ['/nonexistent/program'] },
        { type: 'command', argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'], timeoutSeconds: 1 },
        { type: 'command', argv: [process.execPath, script(dir), out] },
      ] } },
    })
    landed(ctx, 'task-a')
    await inbox.pass()
    await inbox.idle()
    const d = deliveries(ctx)
    expect(d.map((x) => x.outcome)).toEqual(['failed', 'failed', 'failed', 'sent'])
    expect(String(d[0]!.reason)).toContain('boom')
    expect(String(d[2]!.reason)).toContain('did not end within')
    expect(readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(1)
    // The notice is in the inbox whatever the sinks did.
    expect(inbox.unread('alpha')).toHaveLength(1)
  }, 20_000)

  it('a file sink appends one JSON line per notice under the coordination directory', async () => {
    const dir = tempDir()
    const { ctx, inbox } = await boot({ coordinationDir: dir, projects: { alpha: { sinks: [{ type: 'file', path: 'inbox/alpha.jsonl' }] } } })
    landed(ctx, 'task-a')
    append(ctx, 'workflow.task.question', { taskId: 'task-a2', questions: 1 })
    await inbox.pass()
    await inbox.idle()
    const lines = readFileSync(join(dir, 'inbox', 'alpha.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LeadNotice)
    expect(kinds(lines).sort()).toEqual(['task.landed', 'worker.question'])
  })

  it('refuses a configuration that names no program, or a file outside the coordination directory', () => {
    expect(configProblems({ projects: { alpha: { sinks: [{ type: 'command' }] } } })).toHaveLength(1)
    expect(configProblems({ projects: { alpha: { sinks: [{ type: 'file', path: 'a.jsonl' }] } } })).toHaveLength(1)
    expect(configProblems({ coordinationDir: '/srv/coordination', projects: { alpha: { sinks: [{ type: 'file', path: '../escape.jsonl' }] } } })).toHaveLength(1)
    expect(configProblems({ coordinationDir: '/srv/coordination', projects: { alpha: { sinks: [{ type: 'file', path: 'a.jsonl' }, { type: 'command', argv: ['notify-lead'] }, { type: 'wait' }] } } })).toEqual([])
  })
})

describe('deduplication and bounds', () => {
  it('duplicates within the window are one notice, and the same event read twice makes one', async () => {
    const { ctx, inbox } = await boot({ dedupMinutes: 10 })
    for (let i = 0; i < 3; i++) append(ctx, 'workflow.task.question', { taskId: 'task-a', questions: 1 })
    await inbox.pass()
    expect(inbox.unread('alpha')).toHaveLength(1)
    // Handled, then again within the window: still one notice, not a second.
    inbox.ack([inbox.unread('alpha')[0]!.id], 'alpha')
    append(ctx, 'workflow.task.question', { taskId: 'task-a', questions: 1 })
    await inbox.pass()
    expect(inbox.unread('alpha')).toEqual([])
    // The cursor is kept: a pass over no new event changes nothing.
    await inbox.pass()
    expect(inbox.stats('alpha')).toMatchObject({ unread: 0, handled: 1 })
  })

  it('keeps at most maxNotices per project, the oldest handled first, and an event older than maxAge makes none', async () => {
    const { ctx, inbox } = await boot({ maxNotices: 10 })
    for (let i = 0; i < 15; i++) {
      TASKS[`task-n${i}`] = 'alpha'
      landed(ctx, `task-n${i}`)
    }
    await inbox.pass()
    expect(inbox.unread('alpha', 100)).toHaveLength(10)
    expect(inbox.unread('alpha', 100)[0]!.subject).toBe('task-n5')
    for (let i = 0; i < 15; i++) delete TASKS[`task-n${i}`]
    // Read a long time after it happened (a host that was off): no notice.
    append(ctx, 'workflow.task.question', { taskId: 'task-b', questions: 1 })
    await inbox.pass(Date.now() + 3 * 3600_000)
    expect(inbox.unread('beta')).toEqual([])
  })

  it('never notices its own delivery events, and a pass that fails changes nothing and is read again', async () => {
    const { ctx, inbox } = await boot()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    inbox.use({ projectOf: async () => { throw new Error('the board is down') } })
    append(ctx, 'workflow.task.question', { taskId: 'task-a', questions: 1 })
    await inbox.pass()
    expect(inbox.unread()).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the board is down'))
    inbox.use({ projectOf: async (taskId) => TASKS[taskId] })
    await inbox.pass()
    expect(kinds(inbox.unread('alpha'))).toEqual(['worker.question'])
  })
})
