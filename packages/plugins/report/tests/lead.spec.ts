import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { BoardTask } from '@tsuuanmi/system-board-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import EventLog from '@tsuuanmi/system-event-log'
import { McpTools, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import Leases from '@tsuuanmi/system-leases'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import StoreResources from '@tsuuanmi/system-resources'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { charter, POLICY, until } from '../../profile-software-development/tests/pilot.ts'
import * as Report from '../src/index.ts'
import { type DigestSources } from '../src/digest.ts'
import { type HealthSources } from '../src/health.ts'

// The lead's digest and health table (PROP-0019 section 2.10), over a fixture day with known records.
// The tests over the real core boot it and (one) put 1001 reports: under the full parallel suite that
// outlasts vitest's 5 s, so the bound is the one the other real-core specs carry.
vi.setConfig({ testTimeout: 120_000 })
const DAY = '2026-10-26'
const at = (hhmm: string): string => `${DAY}T${hhmm}:00.000Z`
const COMMIT = 'a'.repeat(40)
const MERGE = 'b'.repeat(40)
const HAND = 'c'.repeat(40)
const schemas = new SchemaRegistry()
const GB = 1024 ** 3

const task = (taskId: string, over: Partial<BoardTask> = {}): BoardTask => ({
  schema: 'board-task@1.3', taskId, projectId: 'p1', title: `title of ${taskId}`, goal: 'g', acceptance: [], dependsOn: [], actionClass: 'workspace-write', state: 'done',
  attempts: { count: 1, max: 3 }, createdAt: '2026-10-20T00:00:00.000Z', revision: 1, ...over,
})
let seq = 0
const event = (type: string, when: string, data: Record<string, unknown>, runId?: string) => ({ seq: ++seq, at: when, type, ...(runId ? { runId } : {}), data })

/** One day of project p1: two landings (one recorded twice), a lead verdict, a held review, a rejected attempt, a failed daily check, a hand commit. */
function fixture(over: Partial<DigestSources> = {}): DigestSources {
  return {
    asOf: `${DAY}T23:59:00.000Z`, projectId: 'p1', day: DAY,
    tasks: [
      task('t1'), task('t2', { state: 'review', waiting: { reason: 'operator-review', since: at('10:00'), expiresAt: '2026-10-27T10:00:00.000Z', pendingChecks: ['tests'] } }), task('t3', { state: 'ready' }), task('t4'),
    ],
    events: [
      event('workflow.run.started', at('08:00'), { taskId: 't1', startedBy: 'lead' }, 'run_1'),
      event('workflow.task.landing', at('09:00'), { taskId: 't1', state: 'merged', commit: MERGE }, 'run_1'),
      event('workflow.task.landing', at('09:00'), { taskId: 't1', state: 'merged', commit: MERGE }, 'run_1'),
      event('workflow.run.started', at('10:00'), { taskId: 't3', startedBy: 'dispatch' }, 'run_3a'),
      event('workflow.task.reported', at('11:00'), { taskId: 't3', status: 'rejected', reason: 'a check failed' }, 'run_3a'),
      event('workflow.run.started', at('12:00'), { taskId: 't3', startedBy: 'dispatch' }, 'run_3b'),
      event('workflow.task.landing', at('13:00'), { taskId: 'other', state: 'merged', commit: 'd'.repeat(40) }, 'run_x'),
    ],
    requests: [], decisions: [{ id: `sha256:${'1'.repeat(64)}`, at: at('08:30'), decisionType: 'verdict', option: 'approved', taskId: 't1' }],
    branch: { value: [{ sha: MERGE, at: at('09:00'), subject: 'Merge run_1' }, { sha: HAND, at: at('15:00'), subject: 'fix a typo' }] },
    dailyChecks: { value: [{ checkId: 'daily-1', state: 'failed', at: at('04:00'), commit: COMMIT, taskId: 't4', problem: 'a browser spec failed' }, { checkId: 'daily-0', state: 'passed', at: at('03:00'), commit: COMMIT }] },
    notes: [], ...over,
  }
}

describe('the lead digest (PROP-0019 2.10)', () => {
  it('names each landing, lead decision, held review, and failure once, with the day\'s measures', () => {
    const digest = Report.buildDigest(fixture())
    expect(() => schemas.assert('lead-digest@1.0', digest)).not.toThrow()
    // The merge recorded twice is one landing; another project's landing is not this one's.
    expect(digest.landed).toEqual([{ taskId: 't1', title: 'title of t1', runId: 'run_1', commit: MERGE, at: at('09:00') }])
    expect(digest.decided.map((d) => [d.what, d.option ?? '', d.taskId])).toEqual([['start', '', 't1'], ['verdict', 'approved', 't1']])
    expect(digest.waiting).toEqual([{ kind: 'review', id: 't2', title: 'title of t2', expiresAt: '2026-10-27T10:00:00.000Z', brief: 'board_brief t2', pendingChecks: ['tests'] }])
    expect(digest.failed.map((f) => [f.kind, f.taskId ?? f.filedTask, f.status])).toEqual([['daily-check', 't4', 'failed'], ['attempt', 't3', 'rejected']])
    // A commit on the branch no landing decision names is a landing by hand; the merge commit is System's.
    expect(digest.byHand).toEqual([{ commit: HAND, at: at('15:00'), subject: 'fix a typo' }])
    expect(digest.measures).toEqual({ landedBySystem: 1, landedByHand: { value: 1 }, leadTouches: 2, reruns: 1, redDev: { value: 1 }, incidents: 0 })
    const text = Report.renderDigest(digest)
    for (const once of ['title of t1', 'title of t2', 'board_brief t2', 'a check failed', 'fix a typo']) expect(text.split(once)).toHaveLength(2)
    expect(Report.buildDigest(fixture())).toEqual(digest)
  })

  it('counts nothing outside the day, and an empty day is empty, not unknown', () => {
    const digest = Report.buildDigest(fixture({ day: '2026-10-25', events: [], decisions: [], tasks: [], branch: { value: [] }, dailyChecks: { value: [] } }))
    expect(digest).toMatchObject({ landed: [], decided: [], waiting: [], failed: [], byHand: [], measures: { landedBySystem: 0, landedByHand: { value: 0 }, leadTouches: 0, reruns: 0, redDev: { value: 0 }, incidents: 0 } })
  })

  it('says unknown for a measure whose source could not be read, never 0 (INV-2)', () => {
    const digest = Report.buildDigest(fixture({ branch: { unknown: 'git: not a repository' }, dailyChecks: { unknown: 'the daily check is not enabled' } }))
    expect(digest.measures.landedByHand).toEqual({ unknown: 'git: not a repository' })
    expect(digest.measures.redDev).toEqual({ unknown: 'the daily check is not enabled' })
    expect(digest.byHand).toEqual([])
    expect(digest.failed.map((f) => f.kind)).toEqual(['attempt'])
    expect(() => schemas.assert('lead-digest@1.0', digest)).not.toThrow()
    expect(Report.renderDigest(digest)).toContain('red dev: unknown (the daily check is not enabled)')
  })

  it('counts a stall of the project\'s runs and a failed live update as incidents', () => {
    const base = fixture()
    const digest = Report.buildDigest({ ...base, events: [...base.events, event('agent-workers.run.stalled', at('14:00'), {}, 'run_3b'), event('agent-workers.run.stalled', at('14:00'), {}, 'run_other'), event('host.live-update', at('16:00'), { outcome: 'failed' })] })
    expect(digest.measures.incidents).toBe(2)
  })
})

describe('the health table (PROP-0019 2.10)', () => {
  const ok: HealthSources = {
    projectId: 'p1', asOf: at('12:00'),
    dispatch: { value: { enabled: true, pausedProjects: [], bounds: [{ name: 'running', used: 1, max: 4 }] } },
    workers: { value: [{ worker: 'w1', state: 'ready' }, { worker: 'w2', state: 'busy' }] },
    pools: { value: [{ pool: 'plan', available: true, usedPercentage: 40 }] },
    notifySinks: { value: [{ sink: 'file', at: at('11:00'), outcome: 'sent' }] }, leadSinks: { value: [{ sink: 'wait', at: at('11:00'), outcome: 'sent' }] },
    liveUpdate: { value: undefined }, landingQueue: { value: { depth: 0 } }, worktrees: { value: { total: 3, inUse: 1, held: 0, uncommitted: 0 } },
    disk: { value: { mode: 'on', floorBytes: 10 * GB, worktrees: { path: '/w', freeBytes: 50 * GB, totalBytes: 100 * GB }, store: { path: '/s', freeBytes: 60 * GB, totalBytes: 100 * GB } } },
    enforcement: { value: [{ mechanism: 'evidence-gate', mode: 'on' }] }, policies: { value: [] },
  }
  const state = (h: Report.Health, id: string): string => h.rows.find((r) => r.id === id)!.state

  it('is ok when every source reads well', () => {
    const health = Report.buildHealth(ok)
    expect(health.state).toBe('ok')
    expect(health.rows.map((r) => r.id)).toEqual(['dispatch', 'workers', 'quota', 'notify-sinks', 'lead-sinks', 'live-update', 'landing-queue', 'worktrees', 'disk', 'enforce:evidence-gate', 'policy'])
  })

  it('shows the disk of the worktrees and the store: ok with room, degraded under 20 % free, failed under the floor, unknown when it cannot be read (T345)', () => {
    const disk = (worktrees: number, store = 60): HealthSources['disk'] => ({ value: { mode: 'on', floorBytes: 10 * GB, worktrees: { path: '/w', freeBytes: worktrees * GB, totalBytes: 100 * GB }, store: { path: '/s', freeBytes: store * GB, totalBytes: 100 * GB } } })
    const row = (health: Report.Health) => health.rows.find((r) => r.id === 'disk')!
    expect(row(Report.buildHealth(ok))).toMatchObject({ state: 'ok', reason: 'worktrees 50.0 GB free of 100.0 GB (50 %); store 60.0 GB free of 100.0 GB (60 %); floor 10.0 GB (disk-floor on)' })
    expect(row(Report.buildHealth({ ...ok, disk: disk(19) }))).toMatchObject({ state: 'degraded', reason: expect.stringContaining('the worktrees filesystem has under 20 % free') })
    expect(row(Report.buildHealth({ ...ok, disk: disk(50, 15) }))).toMatchObject({ state: 'degraded', reason: expect.stringContaining('the store filesystem has under 20 % free') })
    const failed = Report.buildHealth({ ...ok, disk: disk(9) })
    expect(row(failed)).toMatchObject({ state: 'failed', reason: expect.stringContaining('the worktrees filesystem is under the floor of 10.0 GB (disk-floor on)') })
    expect(failed.state).toBe('failed')
    // Failed outranks degraded elsewhere; the floor is the configured one, whatever the mode.
    expect(Report.buildHealth({ ...ok, disk: disk(9), workers: { value: [] } }).state).toBe('failed')
    expect(row(Report.buildHealth({ ...ok, disk: { value: { mode: 'off', floorBytes: 10 * GB, worktrees: { path: '/w', freeBytes: 9 * GB, totalBytes: 100 * GB } } } }))).toMatchObject({ state: 'unknown', reason: 'not read: the space of the store filesystem could not be read' })
    expect(row(Report.buildHealth({ ...ok, disk: { unknown: 'the agent Workers are not loaded' } }))).toMatchObject({ state: 'unknown', reason: 'not read: the agent Workers are not loaded' })
  })

  it('makes a Worker the fixture marks unavailable a degraded row, with its reason', () => {
    const health = Report.buildHealth({ ...ok, workers: { value: [{ worker: 'w1', state: 'ready' }, { worker: 'w2', state: 'unavailable', unavailableReason: 'probe failed' }] } })
    expect(health.rows.find((r) => r.id === 'workers')).toMatchObject({ state: 'degraded', reason: '1 of 2 available: w2 unavailable (probe failed)' })
    expect(health.state).toBe('degraded')
  })

  it('makes a Worker in cooldown, a paused dispatch, a spent pool, a held worktree, a stale landing, a failed sink and update, and a switch not on degraded', () => {
    const health = Report.buildHealth({
      ...ok,
      dispatch: { value: { enabled: true, paused: { reason: 'live update' }, pausedProjects: [], bounds: [] } },
      workers: { value: [{ worker: 'w1', state: 'ready', cooldownUntil: at('13:00') }] },
      pools: { value: [{ pool: 'plan', available: true, usedPercentage: 95 }] },
      notifySinks: { value: [{ sink: 'file', at: at('11:00'), outcome: 'failed', reason: 'disk full' }] },
      liveUpdate: { value: { at: at('09:00'), outcome: 'failed' } },
      landingQueue: { value: { depth: 2, oldestAt: '2026-10-25T10:00:00.000Z' } },
      worktrees: { value: { total: 3, inUse: 0, held: 1, uncommitted: 0 } },
      enforcement: { value: [{ mechanism: 'handbook-bound', mode: 'warn' }, { mechanism: 'review-guides', mode: 'off' }] },
    })
    expect(health.rows.map((r) => [r.id, r.state])).toEqual([
      ['dispatch', 'degraded'], ['workers', 'degraded'], ['quota', 'degraded'], ['notify-sinks', 'degraded'], ['lead-sinks', 'ok'], ['live-update', 'degraded'],
      ['landing-queue', 'degraded'], ['worktrees', 'degraded'], ['disk', 'ok'], ['enforce:handbook-bound', 'degraded'], ['enforce:review-guides', 'degraded'], ['policy', 'ok'],
    ])
  })

  it('makes a source that cannot be read unknown, never ok (INV-2), and a project paused alone degraded', () => {
    const health = Report.buildHealth({ ...ok, workers: { unknown: 'the Worker registry is not loaded' }, enforcement: { unknown: 'the plugin host is not loaded' }, notifySinks: { value: [] }, pools: { value: [] } })
    expect(state(health, 'workers')).toBe('unknown')
    expect(health.rows.find((r) => r.id === 'workers')!.reason).toBe('not read: the Worker registry is not loaded')
    expect(state(health, 'enforce')).toBe('unknown')
    expect(state(health, 'notify-sinks')).toBe('unknown')
    expect(state(health, 'quota')).toBe('unknown')
    expect(health.state).toBe('unknown')
    expect(state(Report.buildHealth({ ...ok, dispatch: { value: { enabled: true, pausedProjects: ['p1'], bounds: [] } } }), 'dispatch')).toBe('degraded')
  })
})

class RecordingMcp extends McpTools {
  readonly tools = new Map<string, { spec: ToolSpec; handler: ToolHandler }>()
  tool(name: string, spec: ToolSpec, handler: ToolHandler): void {
    this.tools.set(name, { spec, handler })
  }
}

describe('lead_digest and lead_health over the real core', () => {
  async function boot(): Promise<Context> {
    const dir = mkdtempSync(join(tmpdir(), 'system-lead-report-'))
    const ctx = new Context()
    const fibers: Fiber[] = [
      ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, { retainDays: 0 }), ctx.plugin(Leases, {}),
      ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 }), ctx.plugin(StoreResources, { pools: [] }), ctx.plugin(StoreBoard, { sweepSeconds: 0 }), ctx.plugin(RecordingMcp), ctx.plugin(Report),
    ]
    await Promise.all(fibers)
    await until(() => ctx.get('board'), 'the board')
    onTestFinished(async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    })
    await charter(ctx, 'p1')
    await charter(ctx, 'p2')
    return ctx
  }
  const call = async (ctx: Context, name: string, args: Record<string, unknown>, lead?: string) => {
    const tool = (ctx.get('mcp') as RecordingMcp).tools.get(name)!
    expect(tool.spec.scope).toBe('client')
    const result = await tool.handler(args, { scope: 'client', ...(lead ? { lead } : {}) })
    return { isError: result.isError === true, text: (result.content as Array<{ text: string }>)[0]!.text, structured: result.structuredContent as Record<string, unknown> | undefined }
  }

  it('stores a finished day once and reads it back as it was; a lead reaches its own project only', async () => {
    const ctx = await boot()
    const first = await call(ctx, 'lead_digest', { day: '2020-01-01' }, 'p1')
    expect(first.isError).toBe(false)
    expect(first.structured).toMatchObject({ schema: 'lead-digest@1.0', projectId: 'p1', day: '2020-01-01', landed: [], measures: { landedBySystem: 0 } })
    // No repository is known to read, and no daily check: both are unknown, not 0.
    expect((first.structured!['measures'] as Record<string, unknown>)['landedByHand']).toHaveProperty('unknown')
    expect((first.structured!['measures'] as Record<string, unknown>)['redDev']).toHaveProperty('unknown')
    const stored = /Stored: (sha256:[0-9a-f]{64})/.exec(first.text)?.[1]
    expect(stored).toBeDefined()
    expect(ctx.artifacts.get(stored!)).toMatchObject({ kind: 'report', bodySchema: 'lead-digest@1.0' })
    // More than 1000 newer reports later, the day is still found by its key, and no second record is made.
    for (let i = 0; i < 1001; i++) ctx.artifacts.put({ kind: 'report', bodySchema: 'lead-digest@1.0', body: Report.buildDigest({ ...fixture(), projectId: `other${i}`, tasks: [] }), classification: 'operator-shared', producer: { type: 'system', ref: 'report' } })
    const again = await call(ctx, 'lead_digest', { day: '2020-01-01' }, 'p1')
    expect(again.structured).toEqual(first.structured)
    expect(again.text).toContain(`Stored: ${stored}`)
    expect(await call(ctx, 'lead_digest', { projectId: 'p2' }, 'p1')).toMatchObject({ isError: true, text: expect.stringMatching(/^forbidden: the lead token of project p1 reaches only project p1/) })
    // Today is read now and not stored; a day that has not begun, and a project that is not on the board, are refused.
    expect((await call(ctx, 'lead_digest', {}, 'p1')).text).not.toContain('Stored:')
    expect(await call(ctx, 'lead_digest', { day: '2999-01-01' }, 'p1')).toMatchObject({ isError: true, text: 'invalid: day 2999-01-01 has not begun' })
    expect(await call(ctx, 'lead_digest', { projectId: 'nope' })).toMatchObject({ isError: true, text: expect.stringMatching(/^unknown-project/) })
    expect(await call(ctx, 'lead_digest', {})).toMatchObject({ isError: true, text: expect.stringMatching(/^invalid: name the project/) })
  })

  it('stores one digest for a day read by two calls at once', async () => {
    const ctx = await boot()
    const [a, b] = await Promise.all([call(ctx, 'lead_digest', { day: '2020-01-02' }, 'p1'), call(ctx, 'lead_digest', { day: '2020-01-02' }, 'p1')])
    expect(a.structured).toEqual(b.structured)
    expect(/Stored: (sha256:[0-9a-f]{64})/.exec(a.text)?.[1]).toBe(/Stored: (sha256:[0-9a-f]{64})/.exec(b.text)?.[1])
    const rows = ctx.store.db.prepare('SELECT COUNT(*) AS n FROM report_lead_digests').get() as { n: number }
    expect(rows.n).toBe(1)
    expect(ctx.artifacts.list({ kind: 'report', limit: 100 }).filter((e) => e.bodySchema === 'lead-digest@1.0')).toHaveLength(1)
  })

  it('reads the disk row and the worktrees (beyond 100) from the agent Workers: the table shows the disk, failed under its floor (T345)', async () => {
    const ctx = await boot()
    let freeGb = 50
    await ctx.plugin({ name: 'agent-workers-stub', apply: (c: { provide: (key: string, value: unknown) => void }) => c.provide('agentWorkers', {
      worktreeCounts: async () => ({ total: 150, inUse: 2, held: 0, uncommitted: 0 }),
      diskStatus: () => ({ mode: 'warn', floorBytes: 10 * GB, worktrees: { path: '/w', freeBytes: freeGb * GB, totalBytes: 100 * GB }, store: { path: '/s', freeBytes: 70 * GB, totalBytes: 100 * GB } }),
    }) } as never, {} as never)
    const rows = async () => (await call(ctx, 'lead_health', {}, 'p1')).structured!['rows'] as Array<{ id: string; state: string; reason: string }>
    expect((await rows()).filter((r) => ['worktrees', 'disk'].includes(r.id)).map((r) => [r.id, r.state, r.reason])).toEqual([
      ['worktrees', 'ok', '150 kept, 2 in use, none held'],
      ['disk', 'ok', 'worktrees 50.0 GB free of 100.0 GB (50 %); store 70.0 GB free of 100.0 GB (70 %); floor 10.0 GB (disk-floor warn)'],
    ])
    freeGb = 5
    const low = await call(ctx, 'lead_health', {}, 'p1')
    expect(() => schemas.assertDef('mcp-report@1.8', 'lead-health-output', low.structured)).not.toThrow()
    expect((low.structured!['rows'] as Array<{ id: string; state: string }>).find((r) => r.id === 'disk')).toMatchObject({ state: 'failed' })
    expect(low.structured!['state']).toBe('failed')
    expect(low.text).toContain('# Health: project p1: failed')
  })

  it('reads a health table whose every unmounted source is unknown, so none is ok', async () => {
    const ctx = await boot()
    const health = await call(ctx, 'lead_health', {}, 'p1')
    expect(health.isError).toBe(false)
    expect(() => schemas.assertDef('mcp-report@1.8', 'lead-health-output', health.structured)).not.toThrow()
    const rows = health.structured!['rows'] as Array<{ id: string; state: string; reason: string }>
    // The engine, Workers, plugin host, and agent Workers are not mounted here: each is unknown with its reason; the ledger has no pool.
    expect(rows.filter((r) => ['dispatch', 'workers', 'worktrees', 'disk', 'enforce'].includes(r.id)).map((r) => [r.id, r.state])).toEqual([['dispatch', 'unknown'], ['workers', 'unknown'], ['worktrees', 'unknown'], ['disk', 'unknown'], ['enforce', 'unknown']])
    expect(rows.find((r) => r.id === 'dispatch')!.reason).toBe('not read: the workflow engine is not loaded')
    expect(health.structured!['state']).toBe('unknown')
    expect(health.text).toContain('# Health: project p1: unknown')
    expect(await call(ctx, 'lead_health', { projectId: 'p2' }, 'p1')).toMatchObject({ isError: true })
  })
})
