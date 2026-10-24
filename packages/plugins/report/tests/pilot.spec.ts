import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import Artifacts from '@tsuuanmi/system-artifacts'
import StoreBoard from '@tsuuanmi/system-board'
import EventLog from '@tsuuanmi/system-event-log'
import { McpTools, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import Leases from '@tsuuanmi/system-leases'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import StoreResources from '@tsuuanmi/system-resources'
import type { PoolConfig } from '@tsuuanmi/system-resources-core'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { FakeDigests } from '../../../digest-core/conformance/digests.ts'
import { attempt, bootPilot, charter, decide, operatorAccepts, type Pilot, POLICY, propose, queued, reported, until } from '../../profile-software-development/tests/pilot.ts'
import * as Report from '../src/index.ts'

// The report over a pilot in miniature (PROP-0010 B8): the algorithm-development template run on
// the real board, approval queue, ledger, digest provider, and agents source, with only the agent
// runtime scripted; the report then reads what they recorded, through the MCP tool.
vi.setConfig({ testTimeout: 120_000 })

class RecordingMcp extends McpTools {
  readonly tools = new Map<string, { spec: ToolSpec; handler: ToolHandler }>()
  tool(name: string, spec: ToolSpec, handler: ToolHandler): void {
    this.tools.set(name, { spec, handler })
  }
}

const schemas = new SchemaRegistry()
type Called = { isError?: boolean; text: string; report?: Report.Report }
const call = async (ctx: Context, args: Record<string, unknown>): Promise<Called> => {
  const tool = (ctx.get('mcp') as RecordingMcp).tools.get('report')!
  expect(tool.spec.scope).toBe('client')
  const result = await tool.handler(args, { scope: 'client' })
  const text = (result.content as Array<{ text: string }>)[0]!.text
  return { ...(result.isError ? { isError: true } : {}), text, ...(result.structuredContent ? { report: result.structuredContent as unknown as Report.Report } : {}) }
}

/** A project of two tasks: one accepted by the operator after a fix through the queue, its merge asked and left open; one held for the operator. */
async function pilotWeek(): Promise<Pilot> {
  const pilot = await bootPilot({ changes: 1 }, [RecordingMcp, Report])
  onTestFinished(() => pilot.dispose())
  const { ctx } = pilot
  await charter(ctx, 'p1')
  await charter(ctx, 'p2')
  const digested = (taskId: string) => until(async () => (await ctx.board.task(taskId))?.result?.digest, `the digest of ${taskId}'s result`)
  const first = await propose(pilot, 'p1', 'make add() add')
  const one = await attempt(ctx, first.taskId)
  await decide(ctx, (await queued(ctx, one.runId)).approvalRequest)
  await reported(ctx, one.runId)
  await digested(first.taskId)
  expect((await operatorAccepts(ctx, first.taskId)).state).toBe('done')
  // The accepted result is committed on its run's branch and its merge asked in the queue (ADR-0060), left open.
  await until(() => ctx.workflow.get(one.runId)?.task?.landing?.state === 'asked', 'the merge of the accepted result to be asked')
  const second = await propose(pilot, 'p1', 'keep add() fast')
  await reported(ctx, (await attempt(ctx, second.taskId, 'Keep add() fast')).runId)
  await digested(second.taskId)
  return pilot
}

describe('the report tool over a pilot (PROP-0010 B8)', () => {
  it('reports a project from what the board, the queue, the ledger, and the event log recorded, every run of its tasks counted, its digests\' included', async () => {
    const pilot = await pilotWeek()
    const { ctx, agent } = pilot
    const { report, text, isError } = await call(ctx, { projectId: 'p1' })
    expect(isError).toBeUndefined()
    expect(() => schemas.assertDef('mcp-report@1.0', 'report-output', report)).not.toThrow()
    expect(report!.projects.map((p) => [p.projectId, p.state, p.milestones.map((m) => m.id)])).toEqual([['p1', 'active', ['m1']]])
    expect(report!.tasks).toMatchObject({ created: 2, done: 1, doneByOperator: 1, cancelled: 0, now: { done: 1, review: 1 } })
    expect(report!.attempts).toEqual({ reported: 2, accepted: 0, rejected: 0, heldForOperator: 2, reconciled: 0, other: 0, review: { passed: 2, failed: 0, none: 0 } })
    expect(report!.remediation).toEqual({ cycles: 1, fixesOpened: 1, fixesClosed: 0 })
    // The project's own requests: its charter, the fix, and the accepted result's merge, still open; another project's charter is not its.
    expect(report!.approvals).toMatchObject({ asked: 3, approved: 2, rejected: 0, expired: 0, withdrawn: 0, openNow: 1, wait: { answered: 2 } })
    expect(report!.approvals.byClass.map((c) => [c.actionClass, c.asked])).toEqual([['charter', 1], ['merge', 1], ['remediation', 1]])
    expect(report!.attention).toMatchObject({ interruptions: 5, batches: 2, threshold: { maxBatchesPerDay: 4, maxInterruptionsPerDay: 10 }, daysOver: 0 })
    // Every agent run the project's tasks took, the digests of their results included, from the runtime's own numbers.
    expect(agent.runs.filter((r) => r.role === 'digest')).toHaveLength(2)
    expect(report!.usage.total).toEqual({ records: agent.runs.length, inputTokens: 1000 * agent.runs.length, outputTokens: 100 * agent.runs.length, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, turns: 2 * agent.runs.length, costUsd: 0.25 * agent.runs.length })
    expect(report!.usage.pools.map((p) => p.pool)).toEqual(['plan.agents'])
    expect(report!.digests).toEqual({ attached: 2, bypassed: 0, claimsKept: 2, claimsDropped: 0, escalated: 0 })
    expect(report!.baseline).toEqual({
      acceptedResults: 1, interruptions: 5, attempts: 2,
      perAcceptedResult: { tokens: 1100 * agent.runs.length, costUsd: 0.25 * agent.runs.length, turns: 2 * agent.runs.length, interruptions: 5, attempts: 2 },
    })
    expect(report!.notes).toEqual([])
    expect(text).toBe(Report.renderReport(report!))
    expect(text.split('\n')[0]).toBe('# Report: project p1 (project p1)')

    // The studio's report counts every project: both charters.
    const studio = (await call(ctx, {})).report!
    expect(studio.projects.map((p) => p.projectId)).toEqual(['p1', 'p2'])
    expect(studio.approvals.asked).toBe(4)
    expect(studio.usage.total.records).toBe(agent.runs.length)
    expect(studio.attention).not.toHaveProperty('threshold')
  })

  it('gives the same report for the same period every time, and counts nothing outside it', async () => {
    const { ctx } = await pilotWeek()
    const period = { since: new Date(Date.now() - 3_600_000).toISOString(), until: new Date(Date.now() + 1000).toISOString() }
    const a = await call(ctx, { projectId: 'p1', ...period })
    const b = await call(ctx, { projectId: 'p1', ...period })
    const { asOf: _a, ...first } = a.report!
    const { asOf: _b, ...again } = b.report!
    expect(again).toEqual(first)
    const withoutAsOf = (text: string): string => text.split('\n').filter((line) => !line.includes('board and queue as of')).join('\n')
    expect(withoutAsOf(b.text)).toBe(withoutAsOf(a.text))
    const before = (await call(ctx, { projectId: 'p1', until: period.since, days: 30 })).report!
    expect(before).toMatchObject({ tasks: { created: 0, done: 0 }, attempts: { reported: 0 }, approvals: { asked: 0 }, attention: { interruptions: 0 }, usage: { total: { records: 0 } }, digests: { attached: 0 }, baseline: { acceptedResults: 0 } })
  })

  it('refuses an input outside its schema, an unknown project, and a period it cannot name, reading nothing', async () => {
    const { ctx } = await pilotWeek()
    for (const [args, why] of [
      [{ since: '2026-10-01T00:00:00Z', days: 3 }, /^invalid input, nothing read/], [{ days: 400 }, /^invalid input, nothing read/], [{ projectId: 'no such' }, /^invalid input, nothing read/],
      [{ projectId: 'p9' }, /^unknown-project: no project p9/], [{ since: '2026-10-01T00:00:00Z', until: '2026-09-01T00:00:00Z' }, /^invalid: the period is empty/],
    ] as const) {
      const refused = await call(ctx, args)
      expect(refused.isError, JSON.stringify(args)).toBe(true)
      expect(refused.text).toMatch(why)
    }
  })
})

describe('the report tool without its sources', () => {
  /** The kernel, the queue, the ledger, the board, and a digest provider as `rows` says, with the report and an MCP registry. */
  async function boot(rows: { board?: boolean; retainDays?: number; pools?: PoolConfig[]; digests?: boolean } = {}): Promise<Context> {
    const dir = mkdtempSync(join(tmpdir(), 'system-report-'))
    const ctx = new Context()
    const fibers: Fiber[] = [
      ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, { retainDays: rows.retainDays ?? 0 }), ctx.plugin(Leases, {}),
      ctx.plugin(StoreApprovals, { policies: [POLICY], sweepSeconds: 3600 }), ctx.plugin(StoreResources, { pools: rows.pools ?? [] }),
      ...(rows.board === false ? [] : [ctx.plugin(StoreBoard, { sweepSeconds: 0 })]), ...(rows.digests ? [ctx.plugin(FakeDigests, {})] : []), ctx.plugin(RecordingMcp), ctx.plugin(Report),
    ]
    await Promise.all(fibers)
    // A provider's fiber settles before its service is up: wait for the board to be served.
    if (rows.board !== false) await until(() => ctx.get('board'), 'the board')
    onTestFinished(async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    })
    return ctx
  }

  it('refuses to report without the board, rather than report part of it (INV-2)', async () => {
    const refused = await call(await boot({ board: false }), {})
    expect(refused).toMatchObject({ isError: true, text: 'unavailable: the board not loaded: a report reads the board, the approval queue, and the resource ledger, so none is made' })
  })

  it('says what it could not count: an event log trimmed by retention within the period', async () => {
    const ctx = await boot({ retainDays: 1 })
    ctx.eventLog.append({ type: 'test.old' })
    expect(ctx.eventLog.trim(Date.now() + 3 * 86_400_000)).toBe(1)
    ctx.eventLog.append({ type: 'test.new' })
    const { report } = await call(ctx, {})
    expect(report!.notes).toEqual([expect.stringMatching(/^the event log keeps entries from .* on \(retention\): attempts, remediation, batches, and digests before then are not counted$/)])
    expect(report!.projects).toEqual([])
  })

  it('counts the runs whose usage the ledger could not count, and those it has counted a record of since, from the event log and the ledger (D25)', async () => {
    const pool: PoolConfig = { pool: 'max.agents', account: 'max', kind: 'programmatic', unknown: 'available', windows: [{ id: 'five-hour', kind: 'rolling', seconds: 18_000 }] }
    const ctx = await boot({ pools: [pool] })
    const observedAt = new Date().toISOString()
    const fact = (runId: string, kind: string, extra: Record<string, unknown> = {}) => ({ schema: 'usage-unknown@1.0', runId, kind, account: 'max', pool: 'max.agents', observedAt, reason: 'why', ...extra })
    ctx.eventLog.append({ type: 'usage.unknown', runId: 'run_wf', data: fact('arun_1', 'not-reported') })
    ctx.eventLog.append({ type: 'usage.unknown', data: fact('arun_2', 'refused', { failure: 'invalid' }) })
    ctx.eventLog.append({ type: 'usage.unknown', data: { kind: 'not-reported', pool: 'max.agents' } })
    // A transcript record of the second counts it since: reconciled.
    await ctx.resources.record({ schema: 'usage-record@1.0', requestId: 'transcript:arun_2', source: 'transcript', observedAt, account: 'max', pool: 'max.agents', runId: 'arun_2', turns: 2 })
    const { report, text, isError } = await call(ctx, {})
    expect(isError).toBeUndefined()
    expect(report!.usage.unknown).toEqual({ runs: 2, reconciled: 1, notReported: 1, interrupted: 0, refused: 1, failed: 0 })
    expect(report!.usage.pools).toMatchObject([{ pool: 'max.agents', records: 1, turns: 2, unknownRuns: 1, withoutTokens: 1, withoutCost: 1 }])
    expect(report!.notes).toContain('1 usage.unknown entry is not a valid usage-unknown@1.0 record: not counted')
    expect(text).toContain('- Usage the ledger could not count: 2 runs (1 not reported, 1 refused by the ledger), 1 of them counted since; a cap counts the others as 0.')
  })

  it('says when the digest provider loaded does not know a digest attached in the period, which another provider settled before a swap, rather than count it as no claim (Base exit criterion 6)', async () => {
    const ctx = await boot({ digests: true })
    ctx.eventLog.append({ type: 'workflow.task.digest', runId: 'run-1', data: { taskId: 't1', state: 'attached', requestId: 'dig-of-the-other-provider', digest: `sha256:${'5'.repeat(64)}` } })
    const { report } = await call(ctx, {})
    expect(report!.digests).toEqual({ attached: 1, bypassed: 0, claimsKept: 0, claimsDropped: 0, escalated: 0 })
    expect(report!.notes).toEqual(['1 digest(s) attached in the period are unknown to the digest provider loaded (another provider settled them before its row was swapped): their claims are not counted'])
  })
})
