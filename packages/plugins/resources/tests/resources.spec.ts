// What the conformance suite does not cover: restart persistence, configuration checked at load,
// paging bounds and the MCP tools' outputs, the reservation race across processes, and the
// record and reading rules a schema cannot state.
import { fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import { McpTools, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { type LimitState, type PoolConfig, ResourcesError, type UsageRecord } from '@tsuuanmi/system-resources-core'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'
import StoreResources, { type Config, MAX_POOLS, MAX_WINDOWS, validatePools } from '../src/index.ts'

/** A `ctx.mcp` that keeps contributed tools, so a test calls a handler as a scope would. */
class RecordingMcp extends McpTools {
  readonly tools = new Map<string, { spec: ToolSpec; handler: ToolHandler }>()
  tool(name: string, spec: ToolSpec, handler: ToolHandler): void {
    this.tools.set(name, { spec, handler })
  }
}

const POOLS: PoolConfig[] = [
  { pool: 'a.interactive', account: 'a', kind: 'interactive', windows: [{ id: 'five-hour', kind: 'rolling', seconds: 18000 }, { id: 'seven-day', kind: 'rolling', seconds: 604800 }] },
  { pool: 'a.programmatic', account: 'a', kind: 'programmatic', windows: [{ id: 'monthly', kind: 'credit' }] },
  { pool: 'local', account: 'here', kind: 'local', windows: [{ id: 'none', kind: 'rate' }], unknown: 'available' },
]
const T0 = new Date('2026-10-22T09:00:00Z')
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000)
const schemas = new SchemaRegistry()

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'system-resources-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function boot(dir: string = tempDir(), config: Config = { pools: POOLS }) {
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(StoreResources, structuredClone(config))]
  await Promise.all(fibers)
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    await new Promise((resolve) => setImmediate(resolve))
  }
  cleanups.push(stop)
  return Object.assign(ctx, { dir, stop })
}

async function withMcp(ctx: Context) {
  const fiber = ctx.plugin(RecordingMcp)
  await fiber
  cleanups.push(() => fiber.dispose())
  await new Promise((resolve) => setTimeout(resolve, 0))
  return (ctx as unknown as { mcp: RecordingMcp }).mcp
}

const reading = (pool: string, window: string, extra: Partial<LimitState> = {}): LimitState => {
  const config = POOLS.find((p) => p.pool === pool)!
  return { schema: 'limit-state@1.0', pool, account: config.account, window: config.windows.find((w) => w.id === window)!, state: 'ok', source: 'status-line', observedAt: T0.toISOString(), ...extra }
}
const usage = (requestId: string, extra: Partial<UsageRecord> = {}): UsageRecord => ({
  schema: 'usage-record@1.0', requestId, source: 'runtime-result', observedAt: T0.toISOString(), account: 'a', pool: 'a.programmatic',
  usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 800 }, cost: { amount: 0.5, currency: 'USD', basis: 'runtime-estimate' }, ...extra,
})
const failureOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call
    return 'resolved'
  } catch (error) {
    return error instanceof ResourcesError ? error.failure : `not a ResourcesError: ${String(error)}`
  }
}
const ready = async (ctx: Context) => {
  for (const w of ['five-hour', 'seven-day']) await ctx.resources.observe(reading('a.interactive', w))
  await ctx.resources.observe(reading('a.programmatic', 'monthly'))
}
const caps = (amount: number) => [{ pool: 'a.programmatic', unit: 'usd' as const, amount }]
const line = (amount: number) => [{ pool: 'a.programmatic', unit: 'usd' as const, amount }]

describe('restart', () => {
  it('a restarted provider over the same store has the same pools, readings, holds, and totals (INV-4)', async () => {
    const first = await boot()
    await ready(first)
    await first.resources.observe(reading('a.interactive', 'five-hour', { state: 'limited', source: 'limit-notice', resetsAt: at(60).toISOString(), observedAt: at(1).toISOString() }))
    await first.resources.record(usage('u1', { taskId: 't1', runId: 'r1', cost: { amount: 1.2, currency: 'USD', basis: 'runtime-estimate' } }))
    await first.resources.record(usage('u2', { taskId: 't2', turns: 4 }))
    const held = await first.resources.reserve({ runId: 'r2', taskId: 't1', lines: line(0.5), caps: caps(2) }, at(2))
    const other = await first.resources.reserve({ runId: 'r3', taskId: 't2', lines: line(0.1) }, at(2))
    expect([held.state, other.state]).toEqual(['reserved', 'reserved'])
    await first.resources.release(other.reservationId)
    const pools = await first.resources.pools({}, at(2))
    const totals = await first.resources.usage()
    await first.stop()

    const second = await boot(first.dir)
    expect(await second.resources.pools({}, at(2))).toEqual(pools)
    expect((await second.resources.pools({}, at(2))).find((p) => p.pool === 'a.interactive')).toMatchObject({ available: false, until: at(60).toISOString() })
    expect(await second.resources.usage()).toEqual(totals)
    // The hold survived: 1.2 used + 0.5 held + 0.5 wanted exceeds the cap of 2.
    expect((await second.resources.reserve({ runId: 'r4', taskId: 't1', lines: line(0.5), caps: caps(2) }, at(2))).state).toBe('refused')
    // A released reservation stays released; a held one can still be released, once.
    expect(await failureOf(second.resources.release(other.reservationId))).toBe('unknown-reservation')
    await second.resources.release(held.reservationId)
    expect(await failureOf(second.resources.release(held.reservationId))).toBe('unknown-reservation')
    expect((await second.resources.reserve({ runId: 'r5', taskId: 't1', lines: line(0.5), caps: caps(2) }, at(2))).state).toBe('reserved')
    // Dedupe is durable too.
    expect((await second.resources.record(usage('u1', { taskId: 't1', runId: 'r1' }))).duplicate).toBe(true)
  })
})

describe('configuration', () => {
  it('refuses duplicate pool or window ids, a pool without windows, and more pools or windows than the tool outputs hold, at load (INV-2)', async () => {
    const window: PoolConfig['windows'][number] = { id: 'w', kind: 'rolling' }
    const pool = (id: string, windows: PoolConfig['windows'] = [window]): PoolConfig => ({ pool: id, account: 'a', kind: 'api-key', windows })
    expect(() => validatePools([pool('p'), pool('p')])).toThrow(/duplicate pool p/)
    expect(() => validatePools([pool('p', [window, window])])).toThrow(/duplicate window w/)
    expect(() => validatePools([pool('p', [])])).toThrow(/1 to 8/)
    expect(() => validatePools(Array.from({ length: MAX_POOLS + 1 }, (_, i) => pool(`p${i}`)))).toThrow(/more than 64/)
    expect(() => validatePools([pool('p', Array.from({ length: MAX_WINDOWS + 1 }, (_, i) => ({ id: `w${i}`, kind: 'rate' as const })))])).toThrow(/1 to 8/)
    expect(() => validatePools([pool('has space')])).toThrow(/not an id/)
    expect(() => validatePools([pool('p', [{ id: 'w', kind: 'rolling', seconds: 0 }])])).toThrow(/seconds/)
    expect(validatePools([pool('p')])[0]).toMatchObject({ unknown: 'unavailable' })

    // The plugin refuses to start on such a configuration: no `ctx.resources` is provided.
    const ctx = new Context()
    const store = ctx.plugin(Store, { path: join(tempDir(), 'system.db') })
    await store
    cleanups.push(() => store.dispose())
    await ctx.plugin(Artifacts, {})
    for (const pools of [[pool('p'), pool('p')], [pool('p', [window, window])]]) {
      const fiber = ctx.plugin(StoreResources, { pools })
      try {
        await fiber
      } catch {
        // refused at load: the assertion below is what matters
      }
      expect(ctx.get('resources')).toBeUndefined()
      await fiber.dispose()
    }
  })

  it('with no pools configured (the bundle default), lists none and refuses every reading, record, and reservation (INV-2)', async () => {
    const ctx = await boot(undefined, {})
    expect(await ctx.resources.pools()).toEqual([])
    expect(await failureOf(ctx.resources.observe(reading('a.programmatic', 'monthly')))).toBe('unknown-pool')
    expect(await failureOf(ctx.resources.record(usage('u1')))).toBe('unknown-pool')
    expect((await ctx.resources.reserve({ runId: 'r1', lines: line(1) })).state).toBe('refused')
  })
})

describe('readings', () => {
  it('refuses a reading of another account or window kind than configured, or one that fails its schema, storing nothing', async () => {
    const ctx = await boot()
    expect(await failureOf(ctx.resources.observe({ ...reading('a.programmatic', 'monthly'), account: 'b' }))).toBe('unknown-pool')
    expect(await failureOf(ctx.resources.observe({ ...reading('a.programmatic', 'monthly'), window: { id: 'monthly', kind: 'rolling' } }))).toBe('unknown-pool')
    expect(await failureOf(ctx.resources.observe({ ...reading('a.programmatic', 'monthly'), state: 'limited' }))).toBe('invalid')
    // A leap second is a valid RFC 3339 time that Date.parse cannot read: a limit ending then would read as already past.
    expect(await failureOf(ctx.resources.observe(reading('a.programmatic', 'monthly', { state: 'limited', resetsAt: '2026-12-31T23:59:60Z' })))).toBe('invalid')
    expect(ctx.artifacts.list({ kind: 'evidence' })).toEqual([])
  })

  it('orders readings by the instant they were observed, whatever the offset, and lets the later of two equal ones stand', async () => {
    const ctx = await boot()
    await ctx.resources.observe(reading('a.programmatic', 'monthly', { usedPercentage: 10, observedAt: '2026-10-22T09:00:00Z' }))
    // 10:30+02:00 is 08:30Z: older, though it sorts later as text.
    await ctx.resources.observe(reading('a.programmatic', 'monthly', { usedPercentage: 90, observedAt: '2026-10-22T10:30:00+02:00' }))
    expect((await ctx.resources.pools({ account: 'a' }, at(1))).find((p) => p.pool === 'a.programmatic')!.readings.map((r) => r.usedPercentage)).toEqual([10])
    await ctx.resources.observe(reading('a.programmatic', 'monthly', { usedPercentage: 20, observedAt: '2026-10-22T09:00:00Z' }))
    expect((await ctx.resources.pools({ account: 'a' }, at(1))).find((p) => p.pool === 'a.programmatic')!.readings.map((r) => r.usedPercentage)).toEqual([20])
  })
})

describe('records', () => {
  it('refuses per-model usage that does not sum to the totals, or comes without them, storing nothing (docs/reference/schemas.md#usage-record)', async () => {
    const ctx = await boot()
    const models = [{ model: 'm1', usage: { inputTokens: 600, outputTokens: 60, cacheReadInputTokens: 500 } }, { model: 'm2', usage: { inputTokens: 400, outputTokens: 40, cacheReadInputTokens: 300 } }]
    expect((await ctx.resources.record(usage('ok', { models }))).duplicate).toBe(false)
    expect(await failureOf(ctx.resources.record(usage('off', { models: [models[0]!] })))).toBe('invalid')
    expect(await failureOf(ctx.resources.record(usage('cached', { usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 800 }, models: [{ model: 'm', usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 800, cacheCreationInputTokens: 300 } }] })))).toBe('invalid')
    const { usage: _dropped, ...noTotals } = usage('bare', { turns: 1, models })
    expect(await failureOf(ctx.resources.record(noTotals))).toBe('invalid')
    expect((await ctx.resources.usage()).records.map((r) => r.requestId)).toEqual(['ok'])
    expect(ctx.artifacts.list({ kind: 'receipt' })).toHaveLength(1)
  })

  it('counts every unit of a cap: tokens as input plus output, turns, runs, and minutes, per task (INV-9)', async () => {
    const ctx = await boot()
    await ready(ctx)
    await ctx.resources.record(usage('u1', { taskId: 't', turns: 3, durationMs: 90_000 }))
    await ctx.resources.record(usage('u2', { taskId: 't', turns: 2, durationMs: 30_000 }))
    const fits = async (unit: 'tokens' | 'turns' | 'runs' | 'minutes', amount: number, wanted: number) =>
      (await ctx.resources.reserve({ runId: `r-${unit}-${amount}`, taskId: 't', lines: [{ pool: 'a.programmatic', unit, amount: wanted }], caps: [{ pool: 'a.programmatic', unit, amount }] }, at(1))).state
    expect(await fits('tokens', 2300, 100)).toBe('reserved')
    expect(await fits('tokens', 2299, 100)).toBe('refused')
    expect(await fits('turns', 6, 1)).toBe('reserved')
    expect(await fits('turns', 5, 1)).toBe('refused')
    expect(await fits('runs', 3, 1)).toBe('reserved')
    expect(await fits('runs', 2, 1)).toBe('refused')
    expect(await fits('minutes', 3, 1)).toBe('reserved')
    expect(await fits('minutes', 2.5, 1)).toBe('refused')
  })
})

describe('reservations', () => {
  it('records a budget decision whose every candidate has a reason, with the readings it rested on as inputs (INV-13)', async () => {
    const ctx = await boot()
    await ready(ctx)
    const monthly = await ctx.resources.observe(reading('a.programmatic', 'monthly', { observedAt: at(1).toISOString() }))
    for (const request of [{ runId: 'ok', lines: line(1) }, { runId: 'no', lines: [...line(1), { pool: 'nope', unit: 'usd' as const, amount: 1 }] }]) {
      const reservation = await ctx.resources.reserve(request, at(2))
      const envelope = ctx.artifacts.get(reservation.decision)!
      const body = envelope.body as { candidates: Array<{ option: string; reasons: string[] }>; inputs: string[]; outcome: { option: string; detail: Record<string, unknown> } }
      expect(body.candidates.map((c) => c.option)).toEqual(['reserved', 'refused'])
      for (const candidate of body.candidates) expect(candidate.reasons.length, candidate.option).toBeGreaterThan(0)
      expect(body.inputs).toEqual([monthly])
      expect(envelope.runId).toBe(request.runId)
      expect(body.outcome.option).toBe(reservation.state)
    }
  })

  it('names the windows that keep a pool closed, and bounds a refusal\'s reasons in its decision', async () => {
    const ctx = await boot()
    await ctx.resources.observe(reading('a.interactive', 'five-hour'))
    const closed = await ctx.resources.reserve({ runId: 'r1', lines: [{ pool: 'a.interactive', unit: 'tokens', amount: 1 }] }, at(1))
    expect(closed.reasons).toEqual(['pool a.interactive is unavailable: window seven-day without a reading that says ok'])
    const many = await ctx.resources.reserve({ runId: 'r2', lines: Array.from({ length: 40 }, (_, i) => ({ pool: `nope-${i}`, unit: 'usd' as const, amount: 1 })) }, at(1))
    expect(many.reasons).toHaveLength(40)
    const refused = (ctx.artifacts.get(many.decision)!.body as { candidates: Array<{ option: string; reasons: string[] }> }).candidates.find((c) => c.option === 'refused')!
    expect(refused.reasons).toHaveLength(32)
    expect(refused.reasons.at(-1)).toBe('and 9 more')
  })

  it('refuses a malformed request without recording anything, and a cap with no task or project bounds the run alone', async () => {
    const ctx = await boot()
    await ready(ctx)
    for (const request of [
      { runId: '', lines: line(1) }, { runId: 'r', lines: [] }, { runId: 'r', lines: line(-1) }, { runId: 'r', lines: [{ pool: 'a.programmatic', unit: 'eur', amount: 1 }] },
      { runId: 'r', lines: line(Number.NaN) }, { runId: 'r', lines: Array.from({ length: 65 }, () => line(1)[0]!) }, { runId: 'r', taskId: 'has space', lines: line(1) },
    ]) {
      expect(await failureOf(ctx.resources.reserve(request as never, at(1))), JSON.stringify(request)).toBe('invalid')
    }
    expect(ctx.artifacts.list({ kind: 'decision' })).toEqual([])
    await ctx.resources.record(usage('u1', { cost: { amount: 5, currency: 'USD', basis: 'runtime-estimate' } }))
    expect((await ctx.resources.reserve({ runId: 'r1', lines: line(1), caps: caps(1) }, at(1))).state).toBe('reserved')
    expect((await ctx.resources.reserve({ runId: 'r2', lines: line(1.5), caps: caps(1) }, at(1))).state).toBe('refused')
  })

  it('lets exactly one of several processes racing for the last of a cap hold it (BEGIN IMMEDIATE)', async () => {
    const dir = tempDir()
    const pools: PoolConfig[] = [{ pool: 'p', account: 'a', kind: 'api-key', windows: [{ id: 'w', kind: 'rate' }] }]
    const ctx = await boot(dir, { pools })
    await ctx.resources.observe({ schema: 'limit-state@1.0', pool: 'p', account: 'a', window: { id: 'w', kind: 'rate' }, state: 'ok', source: 'response-headers', observedAt: T0.toISOString() })
    const worker = fileURLToPath(new URL('./race-worker.ts', import.meta.url))
    const children = Array.from({ length: 4 }, (_, i) => fork(worker, [join(dir, 'system.db'), `race-${i}`, JSON.stringify(pools)], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }))
    const results = children.map((child) => new Promise<string>((resolve, reject) => {
      child.on('message', (m) => m !== 'ready' && resolve(String(m)))
      child.on('exit', (code) => code !== 0 && reject(new Error(`race worker exited ${code}`)))
    }))
    await Promise.all(children.map((child) => new Promise<void>((resolve) => child.on('message', (m) => m === 'ready' && resolve()))))
    for (const child of children) child.send('go')
    expect((await Promise.all(results)).sort()).toEqual(['refused', 'refused', 'refused', 'reserved'])
    expect(ctx.artifacts.list({ kind: 'decision', decisionType: 'budget' })).toHaveLength(4)
    expect((await ctx.resources.reserve({ runId: 'late', taskId: 'race', lines: [{ pool: 'p', unit: 'usd', amount: 0.4 }], caps: [{ pool: 'p', unit: 'usd', amount: 1 }] }, at(1))).state).toBe('reserved')
  }, 120_000)
})

describe('paging and the MCP tools', () => {
  it('serves resources_pools and resources_usage to client callers, outputs valid against mcp-resources@1', async () => {
    const ctx = await boot()
    await ready(ctx)
    await ctx.resources.observe(reading('a.interactive', 'five-hour', { state: 'limited', resetsAt: '2999-01-01T00:00:00Z', observedAt: at(1).toISOString() }))
    const mcp = await withMcp(ctx)
    const pools = mcp.tools.get('resources_pools')!
    const page = mcp.tools.get('resources_usage')!
    expect([pools.spec.scope, page.spec.scope]).toEqual(['client', 'client'])
    const all = await pools.handler({}, { scope: 'client' })
    schemas.assertDef('mcp-resources@1.0', 'resources-pools-output', all.structuredContent)
    expect((all.structuredContent as { pools: Array<{ pool: string; available: boolean; until?: string }> }).pools.map((p) => [p.pool, p.available, p.until])).toEqual([
      ['a.interactive', false, '2999-01-01T00:00:00Z'], ['a.programmatic', true, undefined], ['local', true, undefined],
    ])
    const mine = await pools.handler({ account: 'here' }, { scope: 'client' })
    expect((mine.structuredContent as { pools: unknown[] }).pools).toHaveLength(1)

    for (let i = 0; i < 25; i++) await ctx.resources.record(usage(`u${String(i).padStart(2, '0')}`, { taskId: i % 2 ? 'odd' : 'even', observedAt: at(i).toISOString(), turns: 1 }))
    const first = (await page.handler({}, { scope: 'client' })).structuredContent as { records: UsageRecord[]; totals: Array<{ records: number; turns: number }>; next?: string }
    schemas.assertDef('mcp-resources@1.0', 'resources-usage-output', first)
    expect(first.records).toHaveLength(20)
    expect(first.totals).toMatchObject([{ pool: 'a.programmatic', records: 25, turns: 25 }])
    const second = (await page.handler({ after: first.next }, { scope: 'client' })).structuredContent as typeof first
    schemas.assertDef('mcp-resources@1.0', 'resources-usage-output', second)
    expect(second.records.map((r) => r.requestId)).toEqual(['u20', 'u21', 'u22', 'u23', 'u24'])
    expect(second.next).toBeUndefined()
    expect(second.totals).toEqual(first.totals)
    const odd = (await page.handler({ taskId: 'odd', limit: 5, since: at(3).toISOString() }, { scope: 'client' })).structuredContent as typeof first
    expect(odd.records.map((r) => r.requestId)).toEqual(['u03', 'u05', 'u07', 'u09', 'u11'])
    expect(odd.totals).toMatchObject([{ records: 11 }])
    expect((await page.handler({ after: 'not-a-cursor' }, { scope: 'client' })).isError).toBe(true)
  })

  it('bounds a page to 100 records and usage() to maxRecords, refusing more than either (INV-9)', async () => {
    const ctx = await boot(undefined, { pools: POOLS, maxRecords: 3, pageSize: 2 })
    for (let i = 0; i < 4; i++) await ctx.resources.record(usage(`u${i}`, { runId: i < 2 ? 'r1' : 'r2', observedAt: at(i).toISOString() }))
    const provider = ctx.resources as StoreResources
    expect(provider.page().records).toHaveLength(2)
    expect(provider.page({}, { limit: 100 }).records).toHaveLength(4)
    for (const limit of [0, 101, 1.5]) expect(() => provider.page({}, { limit })).toThrow(ResourcesError)
    expect(await failureOf(ctx.resources.usage())).toBe('invalid')
    expect((await ctx.resources.usage({ runId: 'r1' })).records.map((r) => r.requestId)).toEqual(['u0', 'u1'])
    expect(await failureOf(ctx.resources.usage({ since: 'yesterday' }))).toBe('invalid')
  })
})
