/**
 * Conformance suite for `ctx.resources` (ADR-0037; docs/design/resources.md), and a fake provider
 * that passes it. `boot` returns a context that provides `ctx.resources` and `ctx.artifacts`,
 * with the pools in {@link POOLS} configured and nothing recorded.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { expect } from 'vitest'
import { defineSuite, type Scenario } from '../../libs/conformance/runner.ts'
import {
  type ArtifactRef, type BudgetLine, type LimitState, type PoolConfig, type PoolState, type Reservation, type ReservationRequest, Resources, ResourcesError,
  type TokenUsage, type Unit, type UsageFilter, type UsageRecord, type UsageTotal,
} from '../src/index.ts'

export type Boot = () => Promise<{ ctx: Context; dispose: () => Promise<void> }>

/** The pools every provider under test is configured with. */
export const POOLS: readonly PoolConfig[] = [
  { pool: 'max.interactive', account: 'max', kind: 'interactive', windows: [{ id: 'five-hour', kind: 'rolling', seconds: 18000 }, { id: 'seven-day', kind: 'rolling', seconds: 604800 }] },
  { pool: 'max.programmatic', account: 'max', kind: 'programmatic', windows: [{ id: 'monthly', kind: 'credit' }] },
  { pool: 'key', account: 'api', kind: 'api-key', windows: [{ id: 'minute', kind: 'rate', seconds: 60 }], unknown: 'available' },
]

const T0 = new Date('2026-10-22T09:00:00Z')
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000)
const schemas = new SchemaRegistry()

const reading = (pool: string, window: string, extra: Partial<LimitState> = {}): LimitState => {
  const config = POOLS.find((p) => p.pool === pool)!
  return { schema: 'limit-state@1.0', pool, account: config.account, window: config.windows.find((w) => w.id === window)!, state: 'ok', source: 'status-line', observedAt: T0.toISOString(), ...extra }
}
const usage = (requestId: string, extra: Partial<UsageRecord> = {}): UsageRecord => ({
  schema: 'usage-record@1.0', requestId, source: 'runtime-result', observedAt: T0.toISOString(), account: 'max', pool: 'max.programmatic',
  usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 800 }, cost: { amount: 0.5, currency: 'USD', basis: 'runtime-estimate' }, ...extra,
})
const poolOf = async (ctx: Context, pool: string, when: Date): Promise<PoolState> => (await ctx.resources.pools({}, when)).find((p) => p.pool === pool)!

const failureOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call
    return 'resolved'
  } catch (error) {
    return error instanceof ResourcesError ? error.failure : `not a ResourcesError: ${String(error)}`
  }
}
const budgetOf = (ctx: Context, reservation: Reservation) => {
  const body = ctx.artifacts.get(reservation.decision)?.body as { schema: string; decisionType: string; outcome: { option: string } }
  schemas.assertRecord(body)
  return body
}

const scenario = (id: string, title: string, run: (ctx: Context) => Promise<void>): Scenario<Boot> => ({
  id: `resources.${id}`, since: '1.0', title,
  run: async (boot) => {
    const { ctx, dispose } = await boot()
    try {
      await run(ctx)
    } finally {
      await dispose()
    }
  },
})

export const resourcesSuite = defineSuite<Boot>({
  seam: 'resources',
  contract: '1.0',
  scenarios: [
    scenario('pools-from-configuration', 'lists every configured pool with its windows; a window with no reading is unknown, so the pool fails closed unless configured available (INV-2)', async (ctx) => {
      const pools = await ctx.resources.pools({}, T0)
      expect(pools.map((p) => [p.pool, p.account, p.kind, p.windows.map((w) => w.id), p.readings, p.available])).toEqual([
        ['key', 'api', 'api-key', ['minute'], [], true],
        ['max.interactive', 'max', 'interactive', ['five-hour', 'seven-day'], [], false],
        ['max.programmatic', 'max', 'programmatic', ['monthly'], [], false],
      ])
      await ctx.resources.observe(reading('max.interactive', 'five-hour'))
      expect((await poolOf(ctx, 'max.interactive', at(1))).available, 'one window still has no reading').toBe(false)
      await ctx.resources.observe(reading('max.interactive', 'seven-day'))
      expect((await poolOf(ctx, 'max.interactive', at(1))).available).toBe(true)
      expect((await ctx.resources.pools({ account: 'api' }, T0)).map((p) => p.pool)).toEqual(['key'])
    }),
    scenario('limit-cools-down', 'makes a pool unavailable while a window is limited, until the later of its cooldown and reset (INV-2)', async (ctx) => {
      await ctx.resources.observe(reading('max.interactive', 'five-hour'))
      const ref = await ctx.resources.observe(reading('max.interactive', 'seven-day', { state: 'limited', source: 'limit-notice', cooldownUntil: at(60).toISOString(), resetsAt: at(90).toISOString() }))
      expect(ctx.artifacts.get(ref)).toMatchObject({ kind: 'evidence', bodySchema: 'limit-state@1.0' })
      expect(await poolOf(ctx, 'max.interactive', at(1))).toMatchObject({ available: false, until: at(90).toISOString() })
      expect((await poolOf(ctx, 'max.interactive', at(91))).available).toBe(true)
    }),
    scenario('readings-tolerate-gaps', 'takes a reading without its percentage or reset, and keeps the latest reading of a window (an older one never replaces it)', async (ctx) => {
      await ctx.resources.observe(reading('max.interactive', 'seven-day'))
      await ctx.resources.observe(reading('max.interactive', 'five-hour', { usedPercentage: 20, observedAt: at(10).toISOString() }))
      await ctx.resources.observe(reading('max.interactive', 'five-hour', { usedPercentage: 99, state: 'limited', resetsAt: at(30).toISOString(), observedAt: at(5).toISOString() }))
      const pool = await poolOf(ctx, 'max.interactive', at(11))
      expect(pool.readings.map((r) => [r.window.id, r.usedPercentage])).toEqual([['five-hour', 20], ['seven-day', undefined]])
      expect(pool.available).toBe(true)
      await ctx.resources.observe(reading('key', 'minute'))
      expect((await poolOf(ctx, 'key', at(1))).readings).toHaveLength(1)
    }),
    scenario('unknown-fails-closed', 'leaves a pool unavailable while a window reads unknown, unless its configuration makes unknown available (INV-2)', async (ctx) => {
      await ctx.resources.observe(reading('max.programmatic', 'monthly', { state: 'unknown', source: 'runtime-result' }))
      expect((await poolOf(ctx, 'max.programmatic', at(1))).available).toBe(false)
      await ctx.resources.observe(reading('key', 'minute', { state: 'unknown' }))
      expect((await poolOf(ctx, 'key', at(1))).available).toBe(true)
    }),
    scenario('unknown-pool-refused', 'refuses a reading or a usage record for a pool not in configuration', async (ctx) => {
      expect(await failureOf(ctx.resources.observe({ ...reading('key', 'minute'), pool: 'nope' }))).toBe('unknown-pool')
      expect(await failureOf(ctx.resources.record(usage('u1', { pool: 'nope' })))).toBe('unknown-pool')
      expect(await failureOf(ctx.resources.observe({ ...reading('key', 'minute'), window: { id: 'hour', kind: 'rate' } }))).toBe('unknown-pool')
    }),
    scenario('reserve-records-budget', 'reserves before a run and records the budget decision; refuses an unknown or unavailable pool (INV-2, INV-13)', async (ctx) => {
      await ctx.resources.observe(reading('max.programmatic', 'monthly'))
      const ok = await ctx.resources.reserve({ runId: 'r1', lines: [{ pool: 'max.programmatic', unit: 'usd', amount: 1 }] }, T0)
      expect(ok).toMatchObject({ state: 'reserved', reasons: [] })
      expect(budgetOf(ctx, ok)).toMatchObject({ schema: 'decision@1.4', decisionType: 'budget', outcome: { option: 'reserved' } })
      const unknown = await ctx.resources.reserve({ runId: 'r2', lines: [{ pool: 'nope', unit: 'usd', amount: 1 }] }, T0)
      expect(unknown.state).toBe('refused')
      expect(unknown.reasons.join(' ')).toContain('nope')
      expect(budgetOf(ctx, unknown).outcome.option).toBe('refused')
      await ctx.resources.observe(reading('max.interactive', 'five-hour', { state: 'limited', resetsAt: at(60).toISOString() }))
      expect((await ctx.resources.reserve({ runId: 'r3', lines: [{ pool: 'max.interactive', unit: 'tokens', amount: 10 }] }, at(1))).state).toBe('refused')
    }),
    scenario('caps-count-usage-and-holds', 'refuses a reservation that would exceed a cap, counting recorded usage and held reservations; release frees a hold (INV-9)', async (ctx) => {
      const caps: BudgetLine[] = [{ pool: 'max.programmatic', unit: 'usd', amount: 2 }]
      const line = (amount: number): BudgetLine[] => [{ pool: 'max.programmatic', unit: 'usd', amount }]
      await ctx.resources.observe(reading('max.programmatic', 'monthly'))
      await ctx.resources.record(usage('u1', { taskId: 't1', cost: { amount: 1.2, currency: 'USD', basis: 'runtime-estimate' } }))
      const held = await ctx.resources.reserve({ runId: 'r1', taskId: 't1', lines: line(0.5), caps }, T0)
      expect(held.state).toBe('reserved')
      const over = await ctx.resources.reserve({ runId: 'r2', taskId: 't1', lines: line(0.5), caps }, T0)
      expect(over.state).toBe('refused')
      expect(over.reasons.join(' ')).toContain('max.programmatic')
      expect((await ctx.resources.reserve({ runId: 'r3', taskId: 't2', lines: line(0.5), caps }, T0)).state).toBe('reserved')
      await ctx.resources.release(held.reservationId)
      expect((await ctx.resources.reserve({ runId: 'r4', taskId: 't1', lines: line(0.5), caps }, T0)).state).toBe('reserved')
      expect(await failureOf(ctx.resources.release('res-unknown'))).toBe('unknown-reservation')
    }),
    scenario('holds-expire', 'counts a hold against its caps only until it expires, so a crashed run cannot hold a budget forever, and releases an expired hold quietly (INV-9)', async (ctx) => {
      await ctx.resources.observe(reading('max.programmatic', 'monthly'))
      const request = (runId: string): ReservationRequest => ({ runId, taskId: 't1', lines: [{ pool: 'max.programmatic', unit: 'usd', amount: 1 }], caps: [{ pool: 'max.programmatic', unit: 'usd', amount: 1 }], holdSeconds: 60 })
      const first = await ctx.resources.reserve(request('r1'), T0)
      expect(first).toMatchObject({ state: 'reserved', expiresAt: new Date(T0.getTime() + 60_000).toISOString() })
      expect((await ctx.resources.reserve(request('r2'), new Date(T0.getTime() + 30_000))).state).toBe('refused')
      expect((await ctx.resources.reserve(request('r3'), new Date(T0.getTime() + 61_000))).state).toBe('reserved')
      await ctx.resources.release(first.reservationId)
    }),
    scenario('future-reading-refused', 'refuses a reading from the future, which would stand over every later one and hide a limit (INV-2)', async (ctx) => {
      const future = new Date(Date.now() + 24 * 3600_000).toISOString()
      expect(await failureOf(ctx.resources.observe(reading('key', 'minute', { observedAt: future })))).toBe('invalid')
      expect((await poolOf(ctx, 'key', new Date())).readings).toEqual([])
    }),
    scenario('usage-counts-where-reserved', 'counts a run\'s usage against the scope it was reserved for, even when its record names none, so a cap holds after release (INV-9)', async (ctx) => {
      await ctx.resources.observe(reading('max.programmatic', 'monthly'))
      const cap: BudgetLine[] = [{ pool: 'max.programmatic', unit: 'usd', amount: 1 }]
      const line: BudgetLine[] = [{ pool: 'max.programmatic', unit: 'usd', amount: 0.6 }]
      const first = await ctx.resources.reserve({ runId: 'r1', taskId: 't1', lines: line, caps: cap }, T0)
      expect(first.state).toBe('reserved')
      await ctx.resources.record(usage('u1', { runId: 'r1', cost: { amount: 0.6, currency: 'USD', basis: 'runtime-estimate' } }))
      await ctx.resources.release(first.reservationId)
      expect((await ctx.resources.reserve({ runId: 'r2', taskId: 't1', lines: line, caps: cap }, T0)).state).toBe('refused')
      expect((await ctx.resources.usage({ taskId: 't1' })).records.map((r) => r.requestId)).toEqual(['u1'])
    }),
    scenario('record-dedupes', 'counts a unit once: by source and request id, and a transcript record never doubles a runtime result (INV-4)', async (ctx) => {
      const first = await ctx.resources.record(usage('u1', { runId: 'r1' }))
      expect(first.duplicate).toBe(false)
      expect(ctx.artifacts.get(first.ref)).toMatchObject({ kind: 'receipt', bodySchema: 'usage-record@1.0' })
      expect((await ctx.resources.record(usage('u1', { runId: 'r1' }))).duplicate).toBe(true)
      expect((await ctx.resources.record(usage('t1', { runId: 'r1', source: 'transcript' }))).duplicate).toBe(true)
      expect((await ctx.resources.record(usage('t2', { runId: 'r2', source: 'transcript' }))).duplicate).toBe(false)
      expect((await ctx.resources.usage()).records.map((r) => r.requestId)).toEqual(['u1', 't2'])
    }),
    scenario('record-validates', 'refuses a record whose cached input exceeds its input, or that fails its schema', async (ctx) => {
      expect(await failureOf(ctx.resources.record(usage('u1', { usage: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 8, cacheCreationInputTokens: 5 } })))).toBe('invalid')
      expect(await failureOf(ctx.resources.record({ ...usage('u2'), source: 'model' as unknown as UsageRecord['source'] }))).toBe('invalid')
      expect((await ctx.resources.usage()).records).toEqual([])
    }),
    scenario('usage-totals', 'filters usage and totals it per pool over every match', async (ctx) => {
      await ctx.resources.record(usage('a', { runId: 'r1', taskId: 't1', observedAt: at(1).toISOString() }))
      await ctx.resources.record(usage('b', { runId: 'r2', taskId: 't1', observedAt: at(2).toISOString(), turns: 3 }))
      await ctx.resources.record(usage('c', { runId: 'r3', taskId: 't2', pool: 'key', account: 'api', observedAt: at(3).toISOString() }))
      const t1 = await ctx.resources.usage({ taskId: 't1' })
      expect(t1.records.map((r) => r.requestId)).toEqual(['a', 'b'])
      expect(t1.totals).toEqual([{ pool: 'max.programmatic', records: 2, usage: { inputTokens: 2000, outputTokens: 200, cacheReadInputTokens: 1600 }, turns: 3, costUsd: 1 }] satisfies UsageTotal[])
      expect((await ctx.resources.usage({ since: at(2).toISOString() })).records.map((r) => r.requestId)).toEqual(['b', 'c'])
    }),
  ],
})

/** A hold nobody releases lasts this long by default (a crashed run's). */
export const DEFAULT_HOLD_SECONDS = 4 * 3600

const add = (a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined => {
  if (!b) return a
  if (!a) return { ...b }
  const sum: TokenUsage = { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens }
  for (const key of ['cacheReadInputTokens', 'cacheCreationInputTokens', 'reasoningOutputTokens'] as const) {
    if (a[key] !== undefined || b[key] !== undefined) sum[key] = (a[key] ?? 0) + (b[key] ?? 0)
  }
  return sum
}
/** The amount of one unit a record counts for. */
const amountOf = (record: UsageRecord, unit: Unit): number => {
  switch (unit) {
    case 'tokens': return (record.usage?.inputTokens ?? 0) + (record.usage?.outputTokens ?? 0)
    case 'usd': return record.cost?.amount ?? 0
    case 'turns': return record.turns ?? 0
    case 'runs': return 1
    case 'minutes': return (record.durationMs ?? 0) / 60_000
  }
}

/** A fake provider of `ctx.resources`: the protocol in memory, with records and decisions in `ctx.artifacts`. */
export class FakeResources extends Resources {
  static inject = ['artifacts']
  private readonly readings = new Map<string, LimitState>()
  private readonly records: UsageRecord[] = []
  private readonly holds = new Map<string, { request: ReservationRequest; expiresAt: number }>()
  /** The scope each run was reserved for, kept after release, so its usage counts there. */
  private readonly scopes = new Map<string, { projectId?: string; taskId?: string }>()

  constructor(ctx: Context, private readonly config: { pools?: readonly PoolConfig[] } = {}) {
    super(ctx)
  }

  private get configured(): readonly PoolConfig[] {
    return this.config.pools ?? POOLS
  }

  async pools(filter: { account?: string } = {}, at: Date = new Date()): Promise<PoolState[]> {
    return [...this.configured].filter((p) => filter.account === undefined || p.account === filter.account).sort((a, b) => a.pool.localeCompare(b.pool)).map((p) => {
      const latest = p.windows.map((w) => this.readings.get(`${p.pool}/${w.id}`))
      const readings = latest.filter((r): r is LimitState => r !== undefined)
      const limits = readings.filter((r) => r.state === 'limited').map((r) => [r.cooldownUntil, r.resetsAt].filter((t): t is string => t !== undefined).sort().at(-1)!)
      const until = limits.filter((t) => Date.parse(t) > at.getTime()).sort().at(-1)
      // No reading yet is unknown too: missing telemetry is not capacity.
      const unknown = p.unknown !== 'available' && latest.some((r) => r === undefined || r.state === 'unknown')
      return { ...p, readings: readings.map((r) => structuredClone(r)), available: until === undefined && !unknown, ...(until ? { until } : {}) }
    })
  }

  async observe(reading: LimitState): Promise<ArtifactRef> {
    const pool = this.configured.find((p) => p.pool === reading.pool && p.account === reading.account)
    if (!pool?.windows.some((w) => w.id === reading.window.id)) throw new ResourcesError('unknown-pool', `no configured window ${reading.pool}/${reading.window.id}`)
    if (Date.parse(reading.observedAt) > Date.now() + 5 * 60_000) throw new ResourcesError('invalid', `observedAt ${reading.observedAt} is in the future`)
    const ref = this.ctx.artifacts.put({ kind: 'evidence', bodySchema: 'limit-state@1.0', body: reading, classification: 'operator-shared', producer: { type: 'system', ref: 'resources' } }).id as ArtifactRef
    const key = `${reading.pool}/${reading.window.id}`
    const latest = this.readings.get(key)
    if (!latest || Date.parse(latest.observedAt) <= Date.parse(reading.observedAt)) this.readings.set(key, structuredClone(reading))
    return ref
  }

  async reserve(request: ReservationRequest, at: Date = new Date()): Promise<Reservation> {
    const pools = await this.pools({}, at)
    const reasons: string[] = []
    for (const line of request.lines) {
      const pool = pools.find((p) => p.pool === line.pool)
      if (!pool) reasons.push(`pool ${line.pool} is not configured`)
      else if (!pool.available) reasons.push(`pool ${line.pool} is unavailable${pool.until ? ` until ${pool.until}` : ''}`)
    }
    const inScope = (r: { projectId?: string; taskId?: string }) => (request.taskId !== undefined ? r.taskId === request.taskId : request.projectId !== undefined ? r.projectId === request.projectId : false)
    for (const cap of request.caps ?? []) {
      const used = this.records.filter((r) => inScope(r) && r.pool === cap.pool).reduce((n, r) => n + amountOf(r, cap.unit), 0)
      const held = [...this.holds.values()].filter((h) => h.expiresAt > at.getTime() && inScope(h.request)).flatMap((h) => h.request.lines)
        .filter((l) => l.pool === cap.pool && l.unit === cap.unit).reduce((n, l) => n + l.amount, 0)
      const wanted = request.lines.filter((l) => l.pool === cap.pool && l.unit === cap.unit).reduce((n, l) => n + l.amount, 0)
      if (used + held + wanted > cap.amount) reasons.push(`cap ${cap.amount} ${cap.unit} of ${cap.pool} would be exceeded: ${used} used, ${held} held, ${wanted} wanted`)
    }
    const state = reasons.length ? 'refused' : 'reserved'
    const decision = this.ctx.artifacts.recordDecision({
      schema: 'decision@1.4', decisionType: 'budget', question: `May run ${request.runId} draw on its pools?`, inputs: [],
      candidates: [
        { option: 'reserved', selected: state === 'reserved', reasons: reasons.length ? reasons.map((r) => `not reserved: ${r}`) : ['every pool available and within its caps'] },
        { option: 'refused', selected: state === 'refused', reasons: reasons.length ? reasons : ['not refused: no pool is missing or unavailable, and no cap would be exceeded'] },
      ],
      decider: { type: 'rule', id: 'resources.reserve', version: '1' }, outcome: { option: state, detail: { runId: request.runId, lines: request.lines } }, deterministic: true,
    }, { producer: { type: 'system', ref: 'resources' }, runId: request.runId })
    const reservationId = `res-${randomUUID().slice(0, 8)}`
    const expiresAt = at.getTime() + (request.holdSeconds ?? DEFAULT_HOLD_SECONDS) * 1000
    if (state === 'reserved') {
      this.holds.set(reservationId, { request: structuredClone(request), expiresAt })
      this.scopes.set(request.runId, { ...(request.projectId ? { projectId: request.projectId } : {}), ...(request.taskId ? { taskId: request.taskId } : {}) })
    }
    return { reservationId, state, reasons, decision: decision.id as ArtifactRef, ...(state === 'reserved' ? { expiresAt: new Date(expiresAt).toISOString() } : {}) }
  }

  async release(reservationId: string): Promise<void> {
    if (!this.holds.delete(reservationId)) throw new ResourcesError('unknown-reservation', `no reservation ${reservationId}`)
  }

  async record(usage: UsageRecord): Promise<{ ref: ArtifactRef; duplicate: boolean }> {
    if (!this.configured.some((p) => p.pool === usage.pool && p.account === usage.account)) throw new ResourcesError('unknown-pool', `no configured pool ${usage.pool} of ${usage.account}`)
    try {
      schemas.assert('usage-record@1.0', usage)
    } catch (error) {
      throw new ResourcesError('invalid', (error as Error).message)
    }
    const u = usage.usage
    if (u && u.inputTokens < (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0)) throw new ResourcesError('invalid', 'cached input exceeds the input it is part of')
    const ref = this.ctx.artifacts.put({ kind: 'receipt', bodySchema: 'usage-record@1.0', body: usage, classification: 'operator-shared', producer: { type: 'system', ref: 'resources' }, ...(usage.runId ? { runId: usage.runId } : {}) }).id as ArtifactRef
    const duplicate = this.records.some((r) => (r.source === usage.source && r.requestId === usage.requestId)
      || (usage.source === 'transcript' && usage.runId !== undefined && r.runId === usage.runId && r.source === 'runtime-result'))
    if (!duplicate) this.records.push({ ...(usage.runId ? this.scopes.get(usage.runId) : {}), ...structuredClone(usage) })
    return { ref, duplicate }
  }

  async usage(filter: UsageFilter = {}) {
    const records = this.records.filter((r) => (['runId', 'projectId', 'taskId', 'account', 'pool'] as const).every((k) => filter[k] === undefined || r[k] === filter[k])
      && (filter.since === undefined || r.observedAt >= filter.since) && (filter.until === undefined || r.observedAt < filter.until))
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
    const totals = new Map<string, UsageTotal>()
    for (const r of records) {
      const t = totals.get(r.pool) ?? { pool: r.pool, records: 0 }
      t.records += 1
      const sum = add(t.usage, r.usage)
      if (sum) t.usage = sum
      if (r.turns !== undefined) t.turns = (t.turns ?? 0) + r.turns
      if (r.cost) t.costUsd = Math.round(((t.costUsd ?? 0) + r.cost.amount) * 1e6) / 1e6
      totals.set(r.pool, t)
    }
    return { records: records.map((r) => structuredClone(r)), totals: [...totals.values()].sort((a, b) => a.pool.localeCompare(b.pool)) }
  }
}
