// The lead brief (PROP-0019 section 3): an empty project and a busy one (one of each section), a section whose
// source is down reading "could not read" and never an empty list, the 20-entry bound, a lead token never
// reading another project, the one event it writes, every brief a valid lead-brief@1.0, and the default
// sources: each read whole or unreadable (never a list filtered from a truncated read), and nothing of
// another project named.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import EventLog from '@tsuuanmi/system-event-log'
import { McpTools, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSources } from '../src/brief-sources.ts'
import LeadInbox, { BRIEF_EVENT, type Brief, type BriefSources, buildBrief, LIST_MAX, renderBrief, UnknownProject } from '../src/index.ts'

const schemas = new SchemaRegistry()
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const NOW = new Date('2026-10-28T12:00:00.000Z')
const SINCE = '2026-10-27T12:00:00.000Z'
const none = { items: [], total: 0 }

/** Every source read and empty: a quiet project. */
const quiet = (): BriefSources => ({
  project: async (id) => ({ id, title: 'Alpha', state: 'active', objective: 'Build alpha', constraints: [], createdAt: '2026-10-01T00:00:00.000Z' }),
  playbook: async () => ({ version: 'sha256:aaaa', changed: [] }),
  inbox: async () => none,
  requests: async () => ({ operator: none, lead: none, changes: none }),
  reviews: async () => ({ operator: none, lead: none }),
  decisions: async () => none,
  work: async () => ({ running: none, ready: none, waiting: none, blocked: none }),
  runs: async () => none,
  queues: async () => none,
  worktrees: async () => none,
  health: async () => ({ state: 'ok', checks: [] }),
  lastDay: async () => ({ landed: none, decided: none, failed: none }),
})

const one = <T>(item: T) => ({ items: [item], total: 1 })
const read = (over: Partial<BriefSources> = {}): Promise<Brief> => buildBrief({ project: 'alpha', principal: 'lead:alpha', now: NOW, since: SINCE, sources: { ...quiet(), ...over } })

describe('the brief of a quiet project', () => {
  it('reads every section, each list empty and counted, with the later sections shown as not yet available', async () => {
    const brief = await read()
    schemas.assert('lead-brief@1.0', brief)
    const s = brief.sections
    expect(s.you).toMatchObject({ value: { project: { id: 'alpha', title: 'Alpha', state: 'active' }, principal: 'lead:alpha', objective: 'Build alpha', dates: { now: NOW.toISOString() } } })
    expect(s.inbox).toEqual({ value: { unread: { items: [], omitted: 0 } } })
    expect(s.waitingOnOperator).toEqual({ requests: { value: { items: [], omitted: 0 } }, reviews: { value: { items: [], omitted: 0 } } })
    expect(s.heldOnYou).toEqual({ requests: { value: { items: [], omitted: 0 } }, results: { value: { items: [], omitted: 0 } } })
    expect(s.pendingDecisions).toEqual({ asked: { value: { items: [], omitted: 0 } }, changes: { value: { items: [], omitted: 0 } } })
    expect(s.runningWork).toMatchObject({ tasks: { value: { running: { items: [] }, ready: { items: [] } } }, runs: { value: { items: [] } }, landingQueues: { value: { items: [] } }, worktrees: { value: { items: [] } } })
    expect(s.health).toEqual({ value: { state: 'ok', checks: [] } })
    expect(s.lastDay).toEqual({ value: { landed: { items: [], omitted: 0 }, decided: { items: [], omitted: 0 }, failed: { items: [], omitted: 0 } } })
    // Switches and the handover note come with later tasks: shown as such, never empty.
    expect(s.switches).toMatchObject({ status: 'not-yet-available' })
    expect(s.handover).toMatchObject({ status: 'not-yet-available' })
    expect(brief.firstMoves).toHaveLength(3)
    expect(brief.firstMoves.join('\n')).toContain('system lead wait --project alpha')
    // Every source read: section 11 names nothing.
    expect(brief.couldNotRead).toEqual([])
  })

  it('renders as text that names what it could not read, within about a screen', async () => {
    const text = renderBrief(await read())
    expect(text.split('\n').length).toBeLessThan(70)
    for (const title of ['1. You', '2. Inbox', '3. Waiting on the operator', '4. Held on you', '5. Pending decisions', '6. Running work', '7. Health', '8. The last day', '9. Switches', '10. Handover note', '11. What I could not read', '12. First moves']) expect(text).toContain(title)
    expect(text).toContain('every section was read')
    expect(text).toContain('system handbook --role lead')
  })
})

describe('the brief of a busy project', () => {
  it('holds one entry of each section from its source', async () => {
    const brief = await read({
      project: async (id) => ({ id, title: 'Alpha', state: 'active', objective: 'Build alpha', constraints: ['deadline 2026-11-01T00:00:00Z', 'main is the operator\'s'], createdAt: '2026-10-01T00:00:00.000Z', deadline: '2026-11-01T00:00:00Z' }),
      playbook: async () => ({ version: 'sha256:bbbb', changed: ['LD6'] }),
      inbox: async () => one({ id: 'alpha:task.landed:task-a:7', kind: 'task.landed', subject: 'task-a', at: '2026-10-28T11:00:00.000Z', act: ['system lead wait'] }),
      requests: async () => ({
        operator: one({ requestId: 'apr_op', class: 'deploy', summary: 'deploy it', expiresAt: '2026-10-29T00:00:00.000Z' }),
        lead: one({ requestId: 'apr_lead', class: 'command', summary: 'git status', expiresAt: '2026-10-28T13:00:00.000Z' }),
        changes: one({ requestId: 'apr_pol', class: 'policy-change', summary: 'a rule', expiresAt: '2026-10-30T00:00:00.000Z' }),
      }),
      reviews: async () => ({ operator: one({ taskId: 'task-h', title: 'Heavy', reason: 'operator-review', expiresAt: '2026-10-29T00:00:00.000Z' }), lead: one({ taskId: 'task-r', title: 'Review', reason: 'review' }) }),
      decisions: async () => one({ id: 'dec_1', question: 'Which branch?', at: '2026-10-27T00:00:00.000Z' }),
      work: async () => ({
        running: one({ taskId: 'task-run', title: 'Running', state: 'running', runId: 'run_1' }), ready: one({ taskId: 'task-rdy', title: 'Ready', state: 'ready' }),
        waiting: one({ taskId: 'task-w', title: 'Waits', state: 'waiting-for-input', waitingFor: 'question' }), blocked: one({ taskId: 'task-b', title: 'Blocked', state: 'proposed', blockedBy: ['task-run'] }),
      }),
      runs: async () => one({ runId: 'run_1', taskId: 'task-run', status: 'RUNNING', waitsFor: 'tool-call', steps: { items: [{ nodeId: 'develop:1', state: 'COMPLETED' }, { nodeId: 'review:1', state: 'RUNNING' }], total: 2 } }),
      queues: async () => one({ target: 'dev', depth: 3, ofProject: 1, firstPosition: 1, head: { taskId: 'task-run', state: 'merging' } }),
      worktrees: async () => one({ runId: 'run_1', state: 'in-use', changes: 'clean' }),
      health: async () => ({ state: 'degraded', checks: [{ name: 'dispatch', state: 'degraded', detail: 'one Worker down' }] }),
      lastDay: async () => ({
        landed: one({ taskId: 'task-l', at: '2026-10-28T10:00:00.000Z', commit: 'abcdef0123456789' }), decided: one({ id: 'sha256:dec', what: 'accepted task-l', at: '2026-10-28T09:30:00.000Z' }),
        failed: one({ kind: 'task.retries-spent', subject: 'task-f', at: '2026-10-28T09:00:00.000Z' }),
      }),
    })
    schemas.assert('lead-brief@1.0', brief)
    const s = brief.sections
    expect(s.you).toMatchObject({ value: { constraints: ['deadline 2026-11-01T00:00:00Z', 'main is the operator\'s'], playbook: { value: { version: 'sha256:bbbb', changed: { items: ['LD6'] } } } } })
    expect(s.inbox).toMatchObject({ value: { unread: { items: [{ id: 'alpha:task.landed:task-a:7', kind: 'task.landed', ageSeconds: 3600, act: ['system lead wait'] }] } } })
    expect(s.waitingOnOperator).toMatchObject({ requests: { value: { items: [{ requestId: 'apr_op' }] } }, reviews: { value: { items: [{ taskId: 'task-h' }] } } })
    expect(s.heldOnYou).toMatchObject({ requests: { value: { items: [{ requestId: 'apr_lead' }] } }, results: { value: { items: [{ taskId: 'task-r' }] } } })
    expect(s.pendingDecisions).toMatchObject({ asked: { value: { items: [{ id: 'dec_1' }] } }, changes: { value: { items: [{ requestId: 'apr_pol' }] } } })
    expect(s.runningWork).toMatchObject({
      tasks: { value: { running: { items: [{ taskId: 'task-run' }] }, ready: { items: [{ taskId: 'task-rdy' }] }, waiting: { items: [{ waitingFor: 'question' }] }, blocked: { items: [{ blockedBy: ['task-run'] }] } } },
      runs: { value: { items: [{ runId: 'run_1', status: 'RUNNING', waitsFor: 'tool-call', steps: { items: [{ nodeId: 'develop:1' }, { nodeId: 'review:1', state: 'RUNNING' }], omitted: 0 } }] } },
      landingQueues: { value: { items: [{ target: 'dev', depth: 3, head: { taskId: 'task-run' } }] } }, worktrees: { value: { items: [{ runId: 'run_1' }] } },
    })
    expect(s.health).toMatchObject({ value: { state: 'degraded' } })
    expect(s.lastDay).toMatchObject({ value: { landed: { items: [{ taskId: 'task-l' }] }, decided: { items: [{ what: 'accepted task-l' }] }, failed: { items: [{ kind: 'task.retries-spent' }] } } })
    const text = renderBrief(brief)
    for (const mark of ['apr_op', 'apr_lead', 'apr_pol', 'task-h', 'task-r', 'dec_1', 'task-run', 'review:1 RUNNING', 'waits for tool-call', 'dev  depth 3', 'in-use', 'one Worker down', 'abcdef01', 'accepted task-l', 'task.retries-spent', 'LD6']) expect(text, mark).toContain(mark)
    expect(text.split('\n').length).toBeLessThan(200)
  })
})

describe('a section whose source is down', () => {
  it('reads "could not read" with its reason, shows no value, and is named in section 11', async () => {
    const brief = await read({
      inbox: async () => { throw new Error('the lead-inbox store is locked') },
      requests: async () => { throw new Error('the approvals row is not loaded') },
      queues: async () => { throw new Error('the workflow row is not loaded') },
      lastDay: async () => { throw new Error('lead_digest is not built yet') },
    })
    schemas.assert('lead-brief@1.0', brief)
    const s = brief.sections
    expect(s.inbox).toEqual({ unreadable: 'the lead-inbox store is locked' })
    expect(s.waitingOnOperator.requests).toEqual({ unreadable: 'the approvals row is not loaded' })
    expect(s.heldOnYou.requests).toEqual({ unreadable: 'the approvals row is not loaded' })
    expect(s.pendingDecisions.changes).toEqual({ unreadable: 'the approvals row is not loaded' })
    expect(s.runningWork.landingQueues).toEqual({ unreadable: 'the workflow row is not loaded' })
    // Section 8 reads only its named source: with it down, landed, decided, and failed all show no value.
    expect(s.lastDay).toEqual({ unreadable: 'lead_digest is not built yet' })
    // The sources that read are whole beside them.
    expect(s.waitingOnOperator.reviews).toEqual({ value: { items: [], omitted: 0 } })
    expect(s.health).toEqual({ value: { state: 'ok', checks: [] } })
    expect(brief.couldNotRead.map((c) => c.section)).toEqual(expect.arrayContaining(['2 Inbox', '6 Running work (landing queues)', '8 The last day']))
    expect(brief.couldNotRead.find((c) => c.section === '2 Inbox')?.reason).toBe('the lead-inbox store is locked')
    const text = renderBrief(brief)
    expect(text).toContain('COULD NOT READ (the lead-inbox store is locked)')
    expect(text).toContain('2 Inbox: the lead-inbox store is locked')
    // Never "none": an empty list reads as nothing to do.
    expect(text.split('2. Inbox')[1]!.split('3. Waiting')[0]).not.toContain('none')
    expect(text.split('8. The last day')[1]!.split('9. Switches')[0]).not.toContain('none')
  })

  it('refuses a project the board does not know, rather than a page of empty lists', async () => {
    await expect(read({ project: async (id) => { throw new UnknownProject(id) } })).rejects.toThrow(/project alpha is unknown/)
  })
})

describe('the bound', () => {
  it('holds at most 20 entries of a list and says how many it left out', async () => {
    const notices = Array.from({ length: 45 }, (_, i) => ({ id: `n${i}`, kind: 'task.landed', subject: `task-${i}`, at: '2026-10-28T11:00:00.000Z', act: [] }))
    const tasks = Array.from({ length: 30 }, (_, i) => ({ taskId: `task-${i}`, title: 't', state: 'ready' }))
    const steps = Array.from({ length: 26 }, (_, i) => ({ nodeId: `step:${i}`, state: 'PENDING' }))
    const brief = await read({
      inbox: async () => ({ items: notices, total: 45 }), work: async () => ({ running: none, ready: { items: tasks, total: 250 }, waiting: none, blocked: none }),
      runs: async () => one({ runId: 'run_1', taskId: 'task-0', status: 'RUNNING', steps: { items: steps, total: 26 } }),
    })
    schemas.assert('lead-brief@1.0', brief)
    expect(LIST_MAX).toBe(20)
    const inbox = (brief.sections.inbox as { value: { unread: { items: unknown[]; omitted: number } } }).value.unread
    expect(inbox.items).toHaveLength(20)
    expect(inbox.omitted).toBe(25)
    const ready = (brief.sections.runningWork.tasks as { value: { ready: { items: unknown[]; omitted: number } } }).value.ready
    expect(ready.items).toHaveLength(20)
    expect(ready.omitted).toBe(230)
    const run = (brief.sections.runningWork.runs as { value: { items: Array<{ steps: { items: unknown[]; omitted: number } }> } }).value.items[0]!
    expect(run.steps.items).toHaveLength(20)
    expect(run.steps.omitted).toBe(6)
    expect(renderBrief(brief)).toContain('(25 more not shown)')
  })
})

describe('lead_brief', () => {
  class RecordingMcp extends McpTools {
    readonly tools = new Map<string, { spec: ToolSpec; handler: ToolHandler }>()
    tool(name: string, spec: ToolSpec, handler: ToolHandler): void {
      this.tools.set(name, { spec, handler })
    }
  }

  async function boot(): Promise<{ inbox: LeadInbox; ctx: Context; brief: { spec: ToolSpec; handler: ToolHandler }; asked: string[] }> {
    const dir = mkdtempSync(join(tmpdir(), 'system-lead-brief-'))
    const ctx = new Context()
    const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(RecordingMcp)]
    await Promise.all(fibers)
    const inboxFiber = ctx.plugin(LeadInbox, {})
    fibers.push(inboxFiber)
    await inboxFiber
    cleanups.push(async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
      await new Promise((resolve) => setImmediate(resolve))
      rmSync(dir, { recursive: true, force: true })
    })
    const asked: string[] = []
    const sources = quiet()
    ctx.leadInbox.useBrief({ ...sources, project: async (id) => { asked.push(id); if (id === 'ghost') throw new UnknownProject(id); return sources.project(id) } })
    return { inbox: ctx.leadInbox, ctx, brief: (ctx.mcp as RecordingMcp).tools.get('lead_brief')!, asked }
  }

  it('is a client tool of the row; a lead token reads its own project and never another', async () => {
    const { brief, asked, ctx } = await boot()
    expect(brief.spec.scope).toBe('client')
    const refused = await brief.handler({ projectId: 'beta' }, { scope: 'client', lead: 'alpha' })
    expect(refused.isError).toBe(true)
    expect((refused.content[0] as { text: string }).text).toMatch(/reaches only project alpha's brief; beta is another project's, so nothing was read/)
    expect(asked).toEqual([])
    expect(ctx.eventLog.query({ type: BRIEF_EVENT, limit: 10 })).toEqual([])
    // Its own project, named or not.
    for (const args of [{}, { projectId: 'alpha' }]) {
      const ok = await brief.handler(args, { scope: 'client', lead: 'alpha' })
      expect(ok.isError).toBeFalsy()
      expect((ok.structuredContent as unknown as Brief).project).toBe('alpha')
      schemas.assert('lead-brief@1.0', ok.structuredContent)
    }
    expect(asked).toEqual(['alpha', 'alpha'])
  })

  it('refuses a client with no lead token, a project the operator does not name, and a project the board does not know', async () => {
    const { brief } = await boot()
    expect((await brief.handler({ projectId: 'alpha' }, { scope: 'client' })).isError).toBe(true)
    expect((await brief.handler({}, { scope: 'operator' })).isError).toBe(true)
    const ghost = await brief.handler({ projectId: 'ghost' }, { scope: 'operator' })
    expect(ghost.isError).toBe(true)
    expect((ghost.content[0] as { text: string }).text).toMatch(/project ghost is unknown/)
    expect((await brief.handler({ projectId: 'alpha', since: 'yesterday-ish' }, { scope: 'operator' })).isError).toBe(true)
  })

  it('refuses a brief that is not a valid lead-brief@1.0, and records nothing for it', async () => {
    const { brief, inbox, ctx } = await boot()
    inbox.useBrief({ reviews: async () => ({ operator: one({ taskId: 'not an id!', title: 'x', reason: 'operator-review' }), lead: none }) })
    const refused = await brief.handler({ projectId: 'alpha' }, { scope: 'operator' })
    expect(refused.isError).toBe(true)
    expect((refused.content[0] as { text: string }).text).toMatch(/not a valid lead-brief@1\.0, so it was not sent and nothing was recorded/)
    expect(ctx.eventLog.query({ type: BRIEF_EVENT, limit: 10 })).toEqual([])
  })

  it('writes one event, who and which project, and the next brief of that principal starts where the last ended', async () => {
    const { brief, ctx } = await boot()
    const first = (await brief.handler({ projectId: 'alpha' }, { scope: 'operator' })).structuredContent as unknown as Brief
    expect(first.principal).toBe('operator')
    expect(first.lastBrief).toBeUndefined()
    expect(ctx.eventLog.query({ type: BRIEF_EVENT, limit: 10 }).map((e) => e.data)).toEqual([{ principal: 'operator', project: 'alpha' }])
    const second = (await brief.handler({ projectId: 'alpha' }, { scope: 'operator' })).structuredContent as unknown as Brief
    const [latest, earlier] = ctx.eventLog.query({ type: BRIEF_EVENT, order: 'desc', limit: 10 })
    expect(second.lastBrief).toBe(earlier!.at)
    expect(second.since).toBe(earlier!.at)
    expect(latest!.seq).toBeGreaterThan(earlier!.seq)
    // Another principal's brief is its own first one, and `since` is honoured.
    const lead = (await brief.handler({ since: '2026-10-20T00:00:00Z' }, { scope: 'client', lead: 'alpha' })).structuredContent as unknown as Brief
    expect(lead.lastBrief).toBeUndefined()
    expect(lead.principal).toBe('lead:alpha')
    expect(lead.since).toBe('2026-10-20T00:00:00.000Z')
    // Nothing else is written: only brief events, apart from the inbox's own.
    const types = new Set(ctx.eventLog.query({ limit: 1000 }).map((e) => e.type))
    expect([...types].filter((t) => !t.startsWith('lead-inbox.') && t !== BRIEF_EVENT && !t.startsWith('system.') && !t.startsWith('host.') && !t.startsWith('plugin.'))).toEqual([])
  })

  it('on a host without the optional rows, every part that needs one says so and none reads empty', async () => {
    const { inbox, ctx } = await boot()
    const fresh = defaultSources(ctx, inbox)
    const brief = await buildBrief({ project: 'alpha', principal: 'lead:alpha', now: NOW, since: SINCE, sources: fresh })
    schemas.assert('lead-brief@1.0', brief)
    expect(brief.sections.you).toEqual({ unreadable: 'the board row is not loaded' })
    expect(brief.sections.waitingOnOperator.requests).toEqual({ unreadable: 'the approvals row is not loaded' })
    expect(brief.sections.runningWork).toEqual({
      tasks: { unreadable: 'the board row is not loaded' }, runs: { unreadable: 'the workflow row is not loaded' },
      landingQueues: { unreadable: 'the workflow row is not loaded' }, worktrees: { unreadable: 'the workflow row is not loaded' },
    })
    expect(brief.sections.health).toMatchObject({ unreadable: expect.stringContaining('lead_health') })
    expect(brief.sections.pendingDecisions.asked).toMatchObject({ unreadable: expect.stringContaining('decisions') })
    // Section 8 has no source yet: it is unreadable whole, never filled from another source.
    expect(brief.sections.lastDay).toMatchObject({ unreadable: expect.stringContaining('lead_digest') })
    // The inbox is this row's own, and reads.
    expect(brief.sections.inbox).toEqual({ value: { unread: { items: [], omitted: 0 } } })
  })
})

describe('the default sources', () => {
  type T = { taskId: string; title: string; state: string; projectId: string; dependsOn: string[]; run?: { runId: string }; holder?: { leaseExpiresAt: string }; waiting?: { reason: string; expiresAt: string } }
  const task = (taskId: string, state: string, over: Partial<T> = {}): T => ({ taskId, title: `Title ${taskId}`, state, projectId: 'alpha', dependsOn: [], ...over })
  /** A board whose `taskPage` pages as the real one does: at most `limit`, after an opaque cursor, `next` while more remain. */
  const boardOf = (tasks: T[], pageBound = 100) => ({
    project: async (id: string) => (id === 'alpha' ? { projectId: 'alpha', title: 'Alpha', state: 'active', charter: { intent: 'Build alpha', constraints: { deadline: '2026-11-01T00:00:00Z', notes: ['main is the operator\'s'] } }, createdAt: '2026-10-01T00:00:00.000Z' } : undefined),
    task: async (id: string) => tasks.find((t) => t.taskId === id),
    taskPage: (f: { projectId: string; states: string[]; limit: number; after?: string }) => {
      const all = tasks.filter((t) => t.projectId === f.projectId && f.states.includes(t.state))
      const from = f.after === undefined ? 0 : Number(f.after)
      const size = Math.min(f.limit, pageBound)
      return { items: all.slice(from, from + size), ...(from + size < all.length ? { next: String(from + size) } : {}) }
    },
    counts: (p: string) => { const c: Record<string, number> = {}; for (const t of tasks.filter((x) => x.projectId === p)) c[t.state] = (c[t.state] ?? 0) + 1; return c },
  })
  const tasks = [
    task('task-run', 'running', { run: { runId: 'run_1' } }),
    task('task-rdy', 'ready'),
    task('task-dep', 'proposed', { dependsOn: ['task-run', 'task-done'] }),
    task('task-done', 'done'),
    task('task-rev', 'review', { holder: { leaseExpiresAt: '2026-10-28T13:00:00.000Z' } }),
    task('task-held', 'waiting-for-input', { waiting: { reason: 'operator-review', expiresAt: '2026-10-29T00:00:00.000Z' } }),
    task('task-q', 'waiting-for-input', { waiting: { reason: 'question', expiresAt: '2026-10-29T00:00:00.000Z' } }),
    task('task-other', 'running', { projectId: 'beta', run: { runId: 'run_9' } }),
  ]
  const request = (requestId: string, cls: string, expiresAt: string, project: string | undefined) => ({ requestId, state: 'open', action: { class: cls, summary: `${cls} ${requestId}` }, expiresAt, project })
  const requests = [
    request('apr_late', 'command', '2026-10-30T00:00:00.000Z', 'alpha'), request('apr_soon', 'command', '2026-10-28T13:00:00.000Z', 'alpha'),
    request('apr_dep', 'deploy', '2026-10-29T00:00:00.000Z', 'alpha'), request('apr_pol', 'policy-change', '2026-10-31T00:00:00.000Z', 'alpha'),
    request('apr_studio', 'policy-change', '2026-10-31T00:00:00.000Z', undefined), request('apr_beta', 'command', '2026-10-28T13:00:00.000Z', 'beta'),
  ]
  const approvalsOf = (list: typeof requests) => ({
    list: async () => list,
    projectOfRequest: async (r: { project?: string }) => r.project,
    leadMay: async (_p: string, r: { action: { class: string } }) => ({ ok: r.action.class === 'command' }),
  })
  const RUNS: Record<string, { runId: string; status: string; nodes: Array<{ nodeId: string; state: string }>; blocked?: { kind: string } }> = {
    run_1: { runId: 'run_1', status: 'RUNNING', nodes: [{ nodeId: 'develop:1', state: 'COMPLETED' }, { nodeId: 'review:1', state: 'RUNNING' }], blocked: { kind: 'tool-call' } },
  }
  const workflowOf = (landings: Array<{ key: string; branch: string; taskId: string; state: string; position: number }>, more = false) => ({
    openLandings: () => ({ landings, more }),
    projectOfRun: async (runId: string) => (runId === 'run_1' ? 'alpha' : 'beta'),
    get: (runId: string) => RUNS[runId],
  })
  const landings = [
    { key: '/srv/repo#dev', branch: 'dev', taskId: 'task-other', state: 'merging', position: 1 }, { key: '/srv/repo#dev', branch: 'dev', taskId: 'task-run', state: 'queued', position: 2 },
    { key: '/srv/repo#main', branch: 'main', taskId: 'task-run', state: 'merging', position: 1 },
    { key: '/srv/repo#solo', branch: 'solo', taskId: 'task-other', state: 'queued', position: 1 },
  ]
  const workersOf = (worktrees: Array<{ runId: string; state: string; changes: string }>, total = worktrees.length) => ({ runWorktrees: async () => ({ total, worktrees }) })
  const notices = { unread: () => [], stats: () => ({ unread: 0 }) }
  const sourcesOf = (rows: Record<string, unknown>) => defaultSources({ get: (name: string) => rows[name] } as unknown as Context, notices)
  const sources = sourcesOf({ board: boardOf(tasks), approvals: approvalsOf(requests), workflow: workflowOf(landings), agentWorkers: workersOf([{ runId: 'run_1', state: 'in-use', changes: 'clean' }, { runId: 'run_9', state: 'finished', changes: 'clean' }]) })

  it('splits the project\'s own open requests by the lead\'s rights, by expiry, and names no request of another project or of none', async () => {
    const r = await sources.requests('alpha')
    expect(r.lead.items.map((x) => x.requestId)).toEqual(['apr_soon', 'apr_late'])
    expect(r.operator.items.map((x) => x.requestId)).toEqual(['apr_dep'])
    expect(r.changes.items.map((x) => x.requestId)).toEqual(['apr_pol'])
  })

  it('reads the held reviews, the tasks by state with the ones blocked by a dependency, and the runs with their steps', async () => {
    const reviews = await sources.reviews('alpha')
    expect(reviews.operator.items.map((x) => x.taskId)).toEqual(['task-held'])
    expect(reviews.lead.items).toEqual([{ taskId: 'task-rev', title: 'Title task-rev', reason: 'review', expiresAt: '2026-10-28T13:00:00.000Z' }])
    const work = await sources.work('alpha')
    expect(work.running.items).toEqual([expect.objectContaining({ taskId: 'task-run', runId: 'run_1' })])
    expect(work.waiting.items.map((x) => `${x.taskId}:${x.waitingFor}`)).toEqual(['task-held:operator-review', 'task-q:question'])
    expect(work.blocked.items).toEqual([expect.objectContaining({ taskId: 'task-dep', blockedBy: ['task-run'] })])
    // Runs and their steps, from the workflow: only the project's own.
    expect(await sources.runs('alpha')).toEqual({ items: [{ runId: 'run_1', taskId: 'task-run', status: 'RUNNING', waitsFor: 'tool-call', steps: { items: [{ nodeId: 'develop:1', state: 'COMPLETED' }, { nodeId: 'review:1', state: 'RUNNING' }], total: 2 } }], total: 1 })
    expect(await sources.project('alpha')).toMatchObject({ objective: 'Build alpha', constraints: ['deadline 2026-11-01T00:00:00Z', 'main is the operator\'s'], deadline: '2026-11-01T00:00:00Z' })
    await expect(sources.project('nope')).rejects.toBeInstanceOf(UnknownProject)
  })

  it('shows a shared queue\'s depth and the project\'s place in it, its head only when the head is its own, and never a host path', async () => {
    const queues = await sources.queues('alpha')
    expect(queues.items).toEqual([
      { target: 'dev', depth: 2, ofProject: 1, firstPosition: 2 },
      { target: 'main', depth: 1, ofProject: 1, firstPosition: 1, head: { taskId: 'task-run', state: 'merging' } },
    ])
    expect(JSON.stringify(queues)).not.toMatch(/task-other|\/srv\/repo/)
    expect((await sources.worktrees('alpha')).items).toEqual([{ runId: 'run_1', state: 'in-use', changes: 'clean' }])
    // The brief of a lead token names nothing of beta's anywhere.
    const brief = await buildBrief({ project: 'alpha', principal: 'lead:alpha', now: NOW, since: SINCE, sources })
    schemas.assert('lead-brief@1.0', brief)
    expect(JSON.stringify(brief)).not.toMatch(/task-other|run_9|apr_beta|apr_studio|\/srv\/repo/)
  })

  it('reads every page of the board, so a task past the first page is never left out', async () => {
    // Held reviews and blocked tasks behind 150 other review-state tasks, on a board that pages by 100.
    const filler = Array.from({ length: 150 }, (_, i) => task(`task-f${i}`, 'review', { waiting: { reason: 'landing', expiresAt: '2026-10-29T00:00:00.000Z' } }))
    const late = [task('task-late-held', 'waiting-for-input', { waiting: { reason: 'review-expired', expiresAt: '2026-10-29T00:00:00.000Z' } })]
    const proposed = [...Array.from({ length: 120 }, (_, i) => task(`task-p${i}`, 'proposed')), task('task-late-dep', 'proposed', { dependsOn: ['task-f0'] })]
    const paged = sourcesOf({ board: boardOf([...filler, ...late, ...proposed]) })
    expect((await paged.reviews('alpha')).operator.items.map((x) => x.taskId)).toEqual(['task-late-held'])
    expect((await paged.work('alpha')).blocked.items.map((x) => x.taskId)).toEqual(['task-late-dep'])
  })

  it('is unreadable, never a list cut short, when a source holds more than one brief reads', async () => {
    // The board: more than ten pages.
    const many = Array.from({ length: 1001 }, (_, i) => task(`task-m${i}`, 'review'))
    await expect(sourcesOf({ board: boardOf(many) }).reviews('alpha')).rejects.toThrow(/more review, waiting-for-input, waiting-for-approval tasks than one brief reads/)
    // The worktrees: 100 older ones of another project, then the project's own, past the read.
    const older = Array.from({ length: 100 }, (_, i) => ({ runId: `run_b${i}`, state: 'finished', changes: 'clean' }))
    await expect(sourcesOf({ workflow: workflowOf([]), agentWorkers: workersOf(older, 101) }).worktrees('alpha')).rejects.toThrow(/holds 101 run worktrees, more than one read \(100\)/)
    // The landing queues: more open landings than one read.
    await expect(sourcesOf({ board: boardOf(tasks), workflow: workflowOf(landings, true) }).queues('alpha')).rejects.toThrow(/more open landings than one read/)
    // The approval queue: more open requests than one read.
    const flood = Array.from({ length: 1001 }, (_, i) => request(`apr_${i}`, 'command', '2026-10-30T00:00:00.000Z', 'beta'))
    await expect(sourcesOf({ approvals: approvalsOf(flood) }).requests('alpha')).rejects.toThrow(/1001 open requests, more than one brief reads/)
    // A run the workflow does not know.
    await expect(sourcesOf({ board: boardOf([task('task-x', 'running', { run: { runId: 'run_gone' } })]), workflow: workflowOf([]) }).runs('alpha')).rejects.toThrow(/does not know run run_gone/)
    // And the brief shows each such part as could-not-read, the rest whole.
    const brief = await buildBrief({ project: 'alpha', principal: 'lead:alpha', now: NOW, since: SINCE, sources: sourcesOf({ board: boardOf(tasks), approvals: approvalsOf(requests), workflow: workflowOf(landings), agentWorkers: workersOf(older, 101) }) })
    schemas.assert('lead-brief@1.0', brief)
    expect(brief.sections.runningWork.worktrees).toMatchObject({ unreadable: expect.stringContaining('101 run worktrees') })
    expect(brief.couldNotRead.map((c) => c.section)).toContain('6 Running work (worktrees held)')
    expect(brief.sections.runningWork.landingQueues).toMatchObject({ value: { items: [{ target: 'dev' }, { target: 'main' }] } })
  })
})
