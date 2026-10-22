/**
 * `ctx.resources`: the resource ledger on `ctx.store` (docs/design/resources.md, ADR-0036). The
 * pools and their windows are the operator's configuration, never a plan named in code (INV-11);
 * the latest limit reading of each window, the reservations held, and the counted usage records
 * are durable, so a restarted provider over the same store answers the same. Readings are
 * `evidence` artifacts, usage records `receipt` artifacts, and every reservation is a `budget`
 * decision (INV-13). It fails closed (INV-2): a window with no reading, or an `unknown` one, makes
 * its pool unavailable unless the pool is configured `unknown: available`.
 * @module @tsuuanmi/system-resources
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@tsuuanmi/system-artifacts'
import type {} from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import {
  type ArtifactRef, type BudgetLine, type LimitState, type PoolConfig, type PoolState, type Reservation, type ReservationRequest, Resources, ResourcesError,
  type TokenUsage, type Unit, type UsageFilter, type UsageRecord, type UsageTotal,
} from '@tsuuanmi/system-resources-core'
import type {} from '@tsuuanmi/system-store'
import { z as zod } from 'zod'

/** An id as `common@1` defines it: what a pool, account, window, run, project, or task id must be. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
/** The bounds `mcp-resources@1` puts on `resources_pools`: pools per answer, readings per pool. */
export const MAX_POOLS = 64
export const MAX_WINDOWS = 8
/** Lines and caps one reservation may name (INV-9). */
export const MAX_LINES = 64
/** A decision candidate's reasons, at most (`decision@1`). */
const MAX_REASONS = 32
const UNITS: readonly Unit[] = ['tokens', 'usd', 'turns', 'runs', 'minutes']
const KINDS = ['interactive', 'programmatic', 'api-key', 'local'] as const
const WINDOW_KINDS = ['rolling', 'calendar', 'credit', 'rate'] as const
const PRODUCER = { type: 'system', ref: 'resources' } as const

export interface Config {
  /** The resource pools and their windows (operator configuration, never a hardcoded plan). */
  pools?: PoolConfig[]
  /** Records per `resources_usage` page unless the caller asks for fewer or more (default 20, at most 100). */
  pageSize?: number
  /** Records `usage()` returns at most; more matching is refused, so a caller narrows the filter or pages (default 10000; INV-9). */
  maxRecords?: number
  /** How long a reservation nobody releases keeps counting against its caps, in seconds (default 4 hours, INV-9). */
  holdSeconds?: number
}

/** A usage page: the records after a cursor, the totals over every match, and the next cursor. */
export interface UsagePage {
  records: UsageRecord[]
  totals: UsageTotal[]
  next?: string
}

/**
 * Check the configured pools: ids as `common@1` defines them, unique pool ids, one to
 * {@link MAX_WINDOWS} windows each with unique ids, at most {@link MAX_POOLS} pools. A pool with no
 * window would have no telemetry to fail closed on, so it is refused too. Throws on the first fault.
 */
export function validatePools(pools: readonly PoolConfig[]): PoolConfig[] {
  if (pools.length > MAX_POOLS) throw new Error(`resources: ${pools.length} pools configured, more than ${MAX_POOLS}`)
  const seen = new Set<string>()
  return pools.map((p) => {
    for (const [name, value] of [['pool', p.pool], ['account', p.account]] as const) {
      if (typeof value !== 'string' || !ID.test(value)) throw new Error(`resources: pool ${String(p.pool)}: ${name} ${JSON.stringify(value)} is not an id`)
    }
    if (seen.has(p.pool)) throw new Error(`resources: duplicate pool ${p.pool}`)
    seen.add(p.pool)
    if (!KINDS.includes(p.kind)) throw new Error(`resources: pool ${p.pool}: kind ${String(p.kind)} is not one of ${KINDS.join(', ')}`)
    if (p.unknown !== undefined && p.unknown !== 'available' && p.unknown !== 'unavailable') throw new Error(`resources: pool ${p.pool}: unknown must be available or unavailable`)
    const windows = p.windows ?? []
    if (windows.length < 1 || windows.length > MAX_WINDOWS) throw new Error(`resources: pool ${p.pool} has ${windows.length} windows; it needs 1 to ${MAX_WINDOWS}`)
    const ids = new Set<string>()
    for (const w of windows) {
      if (typeof w.id !== 'string' || !ID.test(w.id)) throw new Error(`resources: pool ${p.pool}: window id ${JSON.stringify(w.id)} is not an id`)
      if (ids.has(w.id)) throw new Error(`resources: pool ${p.pool}: duplicate window ${w.id}`)
      ids.add(w.id)
      if (!WINDOW_KINDS.includes(w.kind)) throw new Error(`resources: pool ${p.pool}: window ${w.id} kind ${String(w.kind)} is not one of ${WINDOW_KINDS.join(', ')}`)
      if (w.seconds !== undefined && !(Number.isInteger(w.seconds) && w.seconds >= 1 && w.seconds <= 31_622_400)) throw new Error(`resources: pool ${p.pool}: window ${w.id} seconds must be an integer from 1 to 31622400`)
    }
    return {
      pool: p.pool, account: p.account, kind: p.kind, unknown: p.unknown ?? 'unavailable',
      windows: windows.map((w) => ({ id: w.id, kind: w.kind, ...(w.seconds !== undefined ? { seconds: w.seconds } : {}) })),
    }
  })
}

const invalid = (message: string): ResourcesError => new ResourcesError('invalid', message)
/** Milliseconds since the epoch of an RFC 3339 timestamp; refused (`invalid`) when it does not parse. */
const epochMs = (value: string, name: string): number => {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) throw invalid(`${name} ${JSON.stringify(value)} is not a timestamp`)
  return ms
}
/** Money and minutes at a millionth: a sum of decimal amounts never refuses a reservation that fits exactly. */
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6
/** At most {@link MAX_REASONS} reasons, the last one saying how many more there were. */
const bounded = (reasons: string[]): string[] => reasons.length <= MAX_REASONS ? reasons : [...reasons.slice(0, MAX_REASONS - 1), `and ${reasons.length - MAX_REASONS + 1} more`]
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'reasoningOutputTokens'] as const
/** What a schema cannot say of a record's token counts (docs/reference/schemas.md#usage-record). */
function tokenProblem(record: UsageRecord): string | undefined {
  const cached = (u: TokenUsage): boolean => u.inputTokens < (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0)
  if (record.usage && cached(record.usage)) return 'cached input exceeds the input it is part of'
  for (const m of record.models ?? []) if (cached(m.usage)) return `model ${m.model}: cached input exceeds the input it is part of`
  if (record.models?.length) {
    if (!record.usage) return 'per-model usage without the totals it sums to'
    for (const key of TOKEN_KEYS) {
      const sum = record.models.reduce((n, m) => n + (m.usage[key] ?? 0), 0)
      if (sum !== (record.usage[key] ?? 0)) return `usage.${key} ${record.usage[key] ?? 0} is not the sum over models (${sum})`
    }
  }
  return undefined
}

interface ReadingRow { window_id: string; account: string; reading: string }
interface TotalRow { pool: string; records: number; with_usage: number; input: number | null; output: number | null; cache_read: number | null; cache_creation: number | null; reasoning: number | null; turns: number | null; cost: number | null }
interface CursorRow { seq: number; observed_ms: number; record: string }

/** The store-backed provider of `ctx.resources`. */
export class StoreResources extends Resources {
  static inject = ['store', 'artifacts']
  static Config: z<Config> = z.object({
    pools: z.array(z.object({
      pool: z.string().pattern(ID).required().description('Pool id, as usage records and readings name it'),
      account: z.string().pattern(ID).required().description('The account the pool belongs to'),
      kind: z.union([...KINDS]).required().description('What the pool is: a plan\'s interactive window, a programmatic credit, an API key, or a local model'),
      windows: z.array(z.object({
        id: z.string().pattern(ID).required().description('Window id, as readings name it'),
        kind: z.union([...WINDOW_KINDS]).required().description('rolling: resets a fixed time after use starts; calendar: at fixed dates; credit: a balance drawn down; rate: per interval'),
        seconds: z.natural().min(1).max(31_622_400).description('The window\'s length, when it has one'),
      })).required().description(`The pool's limit windows (1 to ${MAX_WINDOWS}, unique ids)`),
      unknown: z.union(['available', 'unavailable']).default('unavailable').description('Whether a window with no reading, or an unknown one, leaves the pool available (a pool that never reports, such as a local model); unavailable fails closed'),
    })).default([]).description(`The resource pools (at most ${MAX_POOLS}, unique ids): operator configuration, never a hardcoded plan`),
    pageSize: z.natural().min(1).max(100).default(20).description('Records per resources_usage page when the caller names no limit'),
    maxRecords: z.natural().min(1).max(1_000_000).default(10_000).description('Records usage() returns at most; more matching is refused (narrow the filter or page)'),
    holdSeconds: z.natural().min(60).max(604_800).default(14_400).description('How long a reservation nobody releases (a crashed run) keeps counting against its caps'),
  }) as unknown as z<Config>

  private readonly schemas = new SchemaRegistry()
  private readonly configured: readonly PoolConfig[]
  private readonly pageSize: number
  private readonly maxRecords: number
  private readonly holdSeconds: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    // Validated before anything is written: a bad configuration changes nothing.
    this.configured = validatePools(config.pools ?? []).sort((a, b) => (a.pool < b.pool ? -1 : a.pool > b.pool ? 1 : 0))
    this.pageSize = config.pageSize ?? 20
    this.maxRecords = config.maxRecords ?? 10_000
    this.holdSeconds = config.holdSeconds ?? 14_400
    ctx.store.migrate('resources', [{
      version: 1,
      sql: `CREATE TABLE resource_usage (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, request_id TEXT NOT NULL, observed_ms INTEGER NOT NULL,
        account TEXT NOT NULL, pool TEXT NOT NULL, run_id TEXT, project_id TEXT, task_id TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER, reasoning_tokens INTEGER,
        turns INTEGER, duration_ms INTEGER, cost_usd REAL, record TEXT NOT NULL, artifact TEXT NOT NULL, recorded_at TEXT NOT NULL,
        UNIQUE (source, request_id)
      );
      CREATE INDEX resource_usage_time ON resource_usage (observed_ms, seq);
      CREATE INDEX resource_usage_run ON resource_usage (run_id, source);
      CREATE INDEX resource_usage_project ON resource_usage (project_id, pool);
      CREATE INDEX resource_usage_task ON resource_usage (task_id, pool);
      CREATE INDEX resource_usage_account ON resource_usage (account, observed_ms);
      CREATE INDEX resource_usage_pool ON resource_usage (pool, observed_ms);
      CREATE TABLE resource_readings (
        pool TEXT NOT NULL, window_id TEXT NOT NULL, account TEXT NOT NULL, observed_ms INTEGER NOT NULL,
        reading TEXT NOT NULL, artifact TEXT NOT NULL, PRIMARY KEY (pool, window_id)
      );
      CREATE TABLE resource_reservations (
        reservation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT, task_id TEXT,
        request TEXT NOT NULL, decision TEXT NOT NULL, reserved_at TEXT NOT NULL, expires_at TEXT NOT NULL, released_at TEXT
      );
      CREATE INDEX resource_reservations_run ON resource_reservations (run_id);
      CREATE TABLE resource_holds (
        reservation_id TEXT NOT NULL REFERENCES resource_reservations (reservation_id), pool TEXT NOT NULL, unit TEXT NOT NULL,
        amount REAL NOT NULL, project_id TEXT, task_id TEXT, expires_ms INTEGER NOT NULL
      );
      CREATE INDEX resource_holds_reservation ON resource_holds (reservation_id);
      CREATE INDEX resource_holds_task ON resource_holds (task_id, pool, unit);
      CREATE INDEX resource_holds_project ON resource_holds (project_id, pool, unit);`,
    }])
    ctx.inject(['mcp'], (c) => {
      const json = (value: object) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: { ...value } })
      const failed = (error: unknown) => {
        if (error instanceof ResourcesError) return { isError: true, content: [{ type: 'text' as const, text: `${error.failure}: ${error.message}` }] }
        throw error
      }
      const id = zod.string().regex(ID).max(200)
      const timestamp = zod.iso.datetime({ offset: true })
      c.mcp.tool('resources_pools', {
        scope: 'client',
        description: 'Each configured resource pool with the latest reading of each of its windows, and whether new work may draw on it now (a window with no reading or an unknown one fails the pool closed unless it is configured available).',
        inputSchema: { account: id.optional().describe('Only this account\'s pools') },
      }, async (args) => {
        try {
          return json(this.poolsOutput(await this.pools(args.account === undefined ? {} : { account: String(args.account) })))
        } catch (error) {
          return failed(error)
        }
      })
      c.mcp.tool('resources_usage', {
        scope: 'client',
        description: 'Counted usage records that match the filter, oldest first, a page at a time, with totals per pool over every match (not only the page).',
        inputSchema: {
          runId: id.optional(), projectId: id.optional(), taskId: id.optional(), account: id.optional(), pool: id.optional(),
          since: timestamp.optional().describe('Observed at or after'),
          until: timestamp.optional().describe('Observed before'),
          limit: zod.number().int().min(1).max(100).optional().describe(`Page size (default ${this.pageSize})`),
          after: zod.string().min(1).max(200).optional().describe('The next cursor of the previous page'),
        },
      }, async (args) => {
        const filter: UsageFilter = {}
        for (const key of ['runId', 'projectId', 'taskId', 'account', 'pool', 'since', 'until'] as const) if (args[key] !== undefined) filter[key] = String(args[key])
        try {
          return json(this.page(filter, { ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}), ...(args.after !== undefined ? { after: String(args.after) } : {}) }))
        } catch (error) {
          return failed(error)
        }
      })
    })
  }

  async pools(filter: { account?: string } = {}, at: Date = new Date()): Promise<PoolState[]> {
    return this.poolStates(filter, at)
  }

  async observe(reading: LimitState): Promise<ArtifactRef> {
    this.assertSchema('limit-state@1.0', reading)
    const pool = this.configured.find((p) => p.pool === reading.pool)
    const window = pool?.windows.find((w) => w.id === reading.window.id)
    if (!pool || pool.account !== reading.account) throw new ResourcesError('unknown-pool', `no configured pool ${reading.pool} of account ${reading.account}`)
    if (!window) throw new ResourcesError('unknown-pool', `pool ${reading.pool} has no configured window ${reading.window.id}`)
    if (window.kind !== reading.window.kind) throw new ResourcesError('unknown-pool', `window ${reading.pool}/${window.id} is configured ${window.kind}, not ${reading.window.kind}`)
    const observed = epochMs(reading.observedAt, 'observedAt')
    // A limit's end that does not parse would read as already past: refused, so a limit never fails open.
    for (const key of ['resetsAt', 'cooldownUntil'] as const) if (reading[key] !== undefined) epochMs(reading[key], key)
    return this.ctx.store.transaction((db) => {
      const ref = this.ctx.artifacts.put({ kind: 'evidence', bodySchema: 'limit-state@1.0', body: reading, classification: 'operator-shared', producer: PRODUCER }).id as ArtifactRef
      const latest = db.prepare('SELECT account, observed_ms FROM resource_readings WHERE pool = ? AND window_id = ?').get(reading.pool, window.id) as { account: string; observed_ms: number } | undefined
      // An older reading never replaces a newer one; one of an account the pool no longer has never stands.
      if (!latest || latest.account !== reading.account || latest.observed_ms <= observed) {
        db.prepare(`INSERT INTO resource_readings (pool, window_id, account, observed_ms, reading, artifact) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (pool, window_id) DO UPDATE SET account = excluded.account, observed_ms = excluded.observed_ms, reading = excluded.reading, artifact = excluded.artifact`)
          .run(reading.pool, window.id, reading.account, observed, JSON.stringify(reading), ref)
      }
      return ref
    })
  }

  async reserve(request: ReservationRequest, at: Date = new Date()): Promise<Reservation> {
    this.assertRequest(request)
    if (!Number.isFinite(at.getTime())) throw invalid('at is not a date')
    // One write transaction (BEGIN IMMEDIATE): the availability, the caps, and the hold are one
    // decision, so two reservations racing for the last of a cap cannot both be held.
    return this.ctx.store.transaction((db) => {
      const pools = this.poolStates({}, at)
      const faults: string[] = []
      const fine: string[] = []
      for (const pool of new Set(request.lines.map((l) => l.pool))) {
        const state = pools.find((p) => p.pool === pool)
        if (!state) faults.push(`pool ${pool} is not configured`)
        else if (!state.available) faults.push(`pool ${pool} is unavailable${state.until ? ` until ${state.until}` : `: ${this.unknownWindows(state).join(', ')} without a reading that says ok`}`)
        else fine.push(`pool ${pool} is available`)
      }
      for (const cap of request.caps ?? []) {
        const used = this.used(db, request, cap)
        const held = this.held(db, request, cap, at)
        const wanted = round6(request.lines.filter((l) => l.pool === cap.pool && l.unit === cap.unit).reduce((n, l) => n + l.amount, 0))
        const total = round6(used + held + wanted)
        const sum = `${used} used, ${held} held, ${wanted} wanted`
        if (total > cap.amount) faults.push(`cap ${cap.amount} ${cap.unit} of ${cap.pool} would be exceeded: ${sum}`)
        else fine.push(`cap ${cap.amount} ${cap.unit} of ${cap.pool} holds: ${sum}`)
      }
      const state = faults.length ? 'refused' : 'reserved'
      const reservationId = `res-${randomUUID()}`
      const inputs = [...new Set(request.lines.flatMap((l) => pools.some((p) => p.pool === l.pool) ? this.readingArtifacts(db, l.pool) : []))]
      const decision = this.ctx.artifacts.recordDecision({
        schema: 'decision@1.4', decisionType: 'budget', question: `May run ${request.runId} draw on its pools?`, inputs,
        candidates: [
          { option: 'reserved', selected: state === 'reserved', reasons: state === 'reserved' ? bounded(fine) : ['a run is reserved only when every pool it draws on is available and every cap holds (INV-2, INV-9)'] },
          { option: 'refused', selected: state === 'refused', reasons: state === 'refused' ? bounded(faults) : ['every pool is configured and available, and no cap would be exceeded'] },
        ],
        decider: { type: 'rule', id: 'resources.reserve', version: '1' },
        outcome: {
          option: state,
          detail: {
            ...(state === 'reserved' ? { reservationId } : {}), runId: request.runId, lines: request.lines,
            ...(request.caps ? { caps: request.caps } : {}), ...(request.projectId ? { projectId: request.projectId } : {}), ...(request.taskId ? { taskId: request.taskId } : {}),
          },
        },
        deterministic: true,
      }, { producer: PRODUCER, runId: request.runId })
      const expiresMs = at.getTime() + (request.holdSeconds ?? this.holdSeconds) * 1000
      if (state === 'reserved') {
        db.prepare('INSERT INTO resource_reservations (reservation_id, run_id, project_id, task_id, request, decision, reserved_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(reservationId, request.runId, request.projectId ?? null, request.taskId ?? null, JSON.stringify(request), decision.id, new Date().toISOString(), new Date(expiresMs).toISOString())
        const hold = db.prepare('INSERT INTO resource_holds (reservation_id, pool, unit, amount, project_id, task_id, expires_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
        for (const line of request.lines) hold.run(reservationId, line.pool, line.unit, line.amount, request.projectId ?? null, request.taskId ?? null, expiresMs)
      }
      return { reservationId, state, reasons: faults, decision: decision.id as ArtifactRef, ...(state === 'reserved' ? { expiresAt: new Date(expiresMs).toISOString() } : {}) }
    })
  }

  async release(reservationId: string): Promise<void> {
    this.ctx.store.transaction((db): void => {
      const row = typeof reservationId === 'string'
        ? db.prepare('SELECT released_at FROM resource_reservations WHERE reservation_id = ?').get(reservationId) as { released_at: string | null } | undefined
        : undefined
      if (!row || row.released_at !== null) throw new ResourcesError('unknown-reservation', `no reservation ${String(reservationId)} is held`)
      db.prepare('UPDATE resource_reservations SET released_at = ? WHERE reservation_id = ?').run(new Date().toISOString(), reservationId)
      db.prepare('DELETE FROM resource_holds WHERE reservation_id = ?').run(reservationId)
    })
  }

  async record(usage: UsageRecord): Promise<{ ref: ArtifactRef; duplicate: boolean }> {
    this.assertSchema('usage-record@1.0', usage)
    if (!this.configured.some((p) => p.pool === usage.pool && p.account === usage.account)) throw new ResourcesError('unknown-pool', `no configured pool ${usage.pool} of account ${usage.account}`)
    const problem = tokenProblem(usage)
    if (problem) throw invalid(problem)
    const observed = epochMs(usage.observedAt, 'observedAt')
    return this.ctx.store.transaction((db) => {
      // A duplicate is stored as an artifact too, but not counted.
      const ref = this.ctx.artifacts.put({
        kind: 'receipt', bodySchema: 'usage-record@1.0', body: usage, classification: 'operator-shared', producer: PRODUCER,
        ...(usage.runId !== undefined ? { runId: usage.runId } : {}), ...(usage.runId !== undefined && usage.nodeId !== undefined ? { nodeId: usage.nodeId } : {}),
      }).id as ArtifactRef
      const duplicate = !!db.prepare('SELECT 1 FROM resource_usage WHERE source = ? AND request_id = ?').get(usage.source, usage.requestId)
        // A unit is counted once across sources: a transcript never doubles a run's runtime result.
        || (usage.source === 'transcript' && usage.runId !== undefined && !!db.prepare('SELECT 1 FROM resource_usage WHERE run_id = ? AND source = \'runtime-result\' LIMIT 1').get(usage.runId))
      if (!duplicate) {
        const u = usage.usage
        db.prepare(`INSERT INTO resource_usage (source, request_id, observed_ms, account, pool, run_id, project_id, task_id, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, reasoning_tokens, turns, duration_ms, cost_usd, record, artifact, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          usage.source, usage.requestId, observed, usage.account, usage.pool, usage.runId ?? null, usage.projectId ?? null, usage.taskId ?? null,
          u?.inputTokens ?? null, u?.outputTokens ?? null, u?.cacheReadInputTokens ?? null, u?.cacheCreationInputTokens ?? null, u?.reasoningOutputTokens ?? null,
          usage.turns ?? null, usage.durationMs ?? null, usage.cost?.amount ?? null, JSON.stringify(usage), ref, new Date().toISOString(),
        )
      }
      return { ref, duplicate }
    })
  }

  async usage(filter: UsageFilter = {}): Promise<{ records: UsageRecord[]; totals: UsageTotal[] }> {
    const { where, params } = this.where(filter)
    const db = this.ctx.store.db
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM resource_usage ${where}`).get(...params) as { n: number }).n
    if (count > this.maxRecords) throw invalid(`${count} records match, more than ${this.maxRecords}: narrow the filter, or page through resources_usage`)
    const rows = db.prepare(`SELECT record FROM resource_usage ${where} ORDER BY observed_ms, seq`).all(...params) as Array<{ record: string }>
    return { records: rows.map((r) => JSON.parse(r.record) as UsageRecord), totals: this.totals(where, params) }
  }

  /**
   * One page of {@link usage}, for the `resources_usage` tool: at most `limit` records (default
   * `pageSize`, at most 100) after the opaque cursor `after`, the totals over every match, and the
   * next cursor while more remain.
   */
  page(filter: UsageFilter = {}, options: { limit?: number; after?: string } = {}): UsagePage {
    const limit = options.limit ?? this.pageSize
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('limit must be an integer from 1 to 100')
    const { where, params } = this.where(filter)
    const page = [...params]
    let clause = where
    if (options.after !== undefined) {
      const cursor = /^(-?\d{1,16}):(\d{1,16})$/.exec(Buffer.from(options.after, 'base64url').toString('utf8'))
      if (!cursor) throw invalid('after is not a cursor this ledger gave')
      clause = `${where ? `${where} AND` : 'WHERE'} (observed_ms > ? OR (observed_ms = ? AND seq > ?))`
      page.push(Number(cursor[1]), Number(cursor[1]), Number(cursor[2]))
    }
    const rows = this.ctx.store.db.prepare(`SELECT seq, observed_ms, record FROM resource_usage ${clause} ORDER BY observed_ms, seq LIMIT ${limit + 1}`).all(...page) as unknown as CursorRow[]
    const shown = rows.slice(0, limit)
    const last = shown.at(-1)
    return {
      records: shown.map((r) => JSON.parse(r.record) as UsageRecord),
      totals: this.totals(where, params),
      ...(rows.length > limit && last ? { next: Buffer.from(`${last.observed_ms}:${last.seq}`).toString('base64url') } : {}),
    }
  }

  /** The `resources_pools` output (`mcp-resources@1`): each pool without its configuration's windows. */
  poolsOutput(pools: readonly PoolState[]): { pools: Array<Omit<PoolState, 'windows' | 'unknown'>> } {
    return { pools: pools.map((p) => ({ pool: p.pool, account: p.account, kind: p.kind, readings: p.readings, available: p.available, ...(p.until !== undefined ? { until: p.until } : {}) })) }
  }

  private poolStates(filter: { account?: string }, at: Date): PoolState[] {
    const atMs = at.getTime()
    if (!Number.isFinite(atMs)) throw invalid('at is not a date')
    const select = this.ctx.store.db.prepare('SELECT window_id, account, reading FROM resource_readings WHERE pool = ?')
    return this.configured.filter((p) => filter.account === undefined || p.account === filter.account).map((p) => {
      const rows = select.all(p.pool) as unknown as ReadingRow[]
      // A reading of another account than the pool's (its configuration changed) is no reading.
      const latest = p.windows.map((w) => rows.find((r) => r.window_id === w.id && r.account === p.account)).map((r) => (r ? JSON.parse(r.reading) as LimitState : undefined))
      const readings = latest.filter((r): r is LimitState => r !== undefined)
      let until: { ms: number; text: string } | undefined
      for (const r of readings) {
        if (r.state !== 'limited') continue
        // Limited until the later of its cooldown and its reset.
        const end = [r.cooldownUntil, r.resetsAt].filter((t): t is string => t !== undefined).map((text) => ({ ms: Date.parse(text), text })).sort((a, b) => a.ms - b.ms).at(-1)
        if (end && end.ms > atMs && (!until || end.ms > until.ms)) until = end
      }
      // No reading yet is unknown too: missing telemetry is not capacity (INV-2).
      const unknown = p.unknown !== 'available' && latest.some((r) => r === undefined || r.state === 'unknown')
      return { ...structuredClone(p), readings, available: until === undefined && !unknown, ...(until ? { until: until.text } : {}) }
    })
  }

  private unknownWindows(state: PoolState): string[] {
    return state.windows.filter((w) => !state.readings.some((r) => r.window.id === w.id && r.state !== 'unknown')).map((w) => `window ${w.id}`)
  }

  /** The evidence artifacts of a pool's current readings: the inputs of a budget decision. */
  private readingArtifacts(db: DatabaseSync, pool: string): ArtifactRef[] {
    const config = this.configured.find((p) => p.pool === pool)!
    return (db.prepare('SELECT window_id, account, artifact FROM resource_readings WHERE pool = ? AND account = ?').all(pool, config.account) as Array<{ window_id: string; artifact: ArtifactRef }>)
      .filter((r) => config.windows.some((w) => w.id === r.window_id)).map((r) => r.artifact)
  }

  /** A cap's scope: its task, else its project; with neither, the cap bounds the run's own lines only. */
  private scope(request: ReservationRequest): { column: 'task_id' | 'project_id'; value: string } | undefined {
    if (request.taskId !== undefined) return { column: 'task_id', value: request.taskId }
    if (request.projectId !== undefined) return { column: 'project_id', value: request.projectId }
    return undefined
  }

  private used(db: DatabaseSync, request: ReservationRequest, cap: BudgetLine): number {
    const scope = this.scope(request)
    if (!scope) return 0
    const amount = {
      tokens: 'SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0))', usd: 'SUM(COALESCE(cost_usd, 0))', turns: 'SUM(COALESCE(turns, 0))',
      runs: 'COUNT(*)', minutes: 'SUM(COALESCE(duration_ms, 0)) / 60000.0',
    }[cap.unit]
    const row = db.prepare(`SELECT ${amount} AS n FROM resource_usage WHERE ${scope.column} = ? AND pool = ?`).get(scope.value, cap.pool) as { n: number | null }
    return round6(row.n ?? 0)
  }

  /** What unexpired holds of the request's scope keep of a cap: a hold nobody released stops counting when it expires (INV-9). */
  private held(db: DatabaseSync, request: ReservationRequest, cap: BudgetLine, at: Date): number {
    const scope = this.scope(request)
    if (!scope) return 0
    const row = db.prepare(`SELECT SUM(amount) AS n FROM resource_holds WHERE ${scope.column} = ? AND pool = ? AND unit = ? AND expires_ms > ?`)
      .get(scope.value, cap.pool, cap.unit, at.getTime()) as { n: number | null }
    return round6(row.n ?? 0)
  }

  private where(filter: UsageFilter): { where: string; params: Array<string | number> } {
    if (!isObject(filter)) throw invalid('the filter is not an object')
    const clauses: string[] = []
    const params: Array<string | number> = []
    for (const [key, column] of [['runId', 'run_id'], ['projectId', 'project_id'], ['taskId', 'task_id'], ['account', 'account'], ['pool', 'pool']] as const) {
      const value = filter[key]
      if (value === undefined) continue
      if (typeof value !== 'string') throw invalid(`${key} is not a string`)
      clauses.push(`${column} = ?`)
      params.push(value)
    }
    for (const [key, op] of [['since', '>='], ['until', '<']] as const) {
      const value: unknown = filter[key]
      if (value === undefined) continue
      if (typeof value !== 'string') throw invalid(`${key} is not a timestamp`)
      clauses.push(`observed_ms ${op} ?`)
      params.push(epochMs(value, key))
    }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
  }

  private totals(where: string, params: Array<string | number>): UsageTotal[] {
    const rows = this.ctx.store.db.prepare(`SELECT pool, COUNT(*) AS records, COUNT(input_tokens) AS with_usage, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
      SUM(cache_read_tokens) AS cache_read, SUM(cache_creation_tokens) AS cache_creation, SUM(reasoning_tokens) AS reasoning, SUM(turns) AS turns, SUM(cost_usd) AS cost
      FROM resource_usage ${where} GROUP BY pool ORDER BY pool`).all(...params) as unknown as TotalRow[]
    return rows.map((r) => {
      const total: UsageTotal = { pool: r.pool, records: r.records }
      if (r.with_usage > 0) {
        const usage: TokenUsage = { inputTokens: r.input ?? 0, outputTokens: r.output ?? 0 }
        if (r.cache_read !== null) usage.cacheReadInputTokens = r.cache_read
        if (r.cache_creation !== null) usage.cacheCreationInputTokens = r.cache_creation
        if (r.reasoning !== null) usage.reasoningOutputTokens = r.reasoning
        total.usage = usage
      }
      if (r.turns !== null) total.turns = r.turns
      if (r.cost !== null) total.costUsd = round6(r.cost)
      return total
    })
  }

  private assertSchema(tag: string, value: unknown): void {
    try {
      this.schemas.assert(tag, value)
    } catch (error) {
      throw invalid((error as Error).message)
    }
  }

  /** A reservation request's shape (no schema names it): ids, one to {@link MAX_LINES} lines, budget lines as `common@1` bounds them. */
  private assertRequest(request: ReservationRequest): void {
    if (!isObject(request)) throw invalid('the reservation request is not an object')
    if (typeof request.runId !== 'string' || !ID.test(request.runId)) throw invalid(`runId ${JSON.stringify(request.runId)} is not an id`)
    for (const key of ['projectId', 'taskId'] as const) {
      if (request[key] !== undefined && (typeof request[key] !== 'string' || !ID.test(request[key]))) throw invalid(`${key} ${JSON.stringify(request[key])} is not an id`)
    }
    const lines = (name: string, value: unknown, min: number): void => {
      if (!Array.isArray(value) || value.length < min || value.length > MAX_LINES) throw invalid(`${name} must hold ${min} to ${MAX_LINES} budget lines`)
      for (const line of value as unknown[]) {
        if (!isObject(line) || typeof line.pool !== 'string' || !UNITS.includes(line.unit as Unit) || typeof line.amount !== 'number' || !Number.isFinite(line.amount) || line.amount < 0 || line.amount > 1e12) {
          throw invalid(`${name}: ${JSON.stringify(line)} is not a budget line (pool, unit of ${UNITS.join(', ')}, amount 0 to 1e12)`)
        }
      }
    }
    // A run draws on at least one pool: a reservation of nothing would admit a run no pool accounts for.
    lines('lines', request.lines, 1)
    if (request.caps !== undefined) lines('caps', request.caps, 0)
    if (request.holdSeconds !== undefined && (!Number.isInteger(request.holdSeconds) || request.holdSeconds < 60 || request.holdSeconds > 604_800)) {
      throw invalid(`holdSeconds ${JSON.stringify(request.holdSeconds)} is not a whole number of seconds from 60 to 604800`)
    }
  }
}

export default StoreResources
