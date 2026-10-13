/**
 * `ctx.eventLog`: the append-only observability trail (QA-7). Named `eventLog` because
 * Cordis itself owns `ctx.events`. Entries are validated against `event@1.0`, carry
 * references instead of private content, and are announced live as `system/event`.
 * @module @tsuuanmi/system-event-log
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-store'

/** A stored entry (schemas/event.v1.json). */
export interface SystemEvent {
  schema: 'event@1.0'
  seq: number
  at: string
  type: string
  runId?: string
  nodeId?: string
  sessionId?: string
  turnId?: string
  decision?: string
  data?: Record<string, unknown>
}

export type NewEvent = Omit<SystemEvent, 'schema' | 'seq' | 'at'>

declare module '@deepseek-ai/cordis' {
  interface Context {
    eventLog: EventLog
  }
  interface Events {
    /**
     * An entry was committed to the event log. Listeners observe; they cannot veto.
     * @mode emit
     */
    'system/event'(event: SystemEvent): void
  }
}

/** An integer page size in [1, 1000]; NaN or fractional input never reaches SQL. */
function clampLimit(limit: number | undefined): number {
  const n = Number.isFinite(limit) ? Math.floor(limit as number) : 100
  return Math.min(Math.max(n, 1), 1000)
}

export interface Config {
  /** Largest serialized `data` accepted, in bytes (default 16 KiB). */
  maxDataBytes?: number
  /** Days an entry is kept; 0 keeps every entry (default 0). */
  retainDays?: number
}

export class EventLog extends Service {
  static inject = ['store']
  static Config: z<Config> = z.object({
    maxDataBytes: z.natural().min(256).default(16_384).description('Largest serialized data accepted'),
    retainDays: z.natural().default(0).description('Days an entry is kept (0: every entry is kept); trimmed at start and daily'),
  })

  private readonly schemas = new SchemaRegistry()
  private readonly maxDataBytes: number
  private readonly retainDays: number

  constructor(ctx: Context, config: Config) {
    super(ctx, 'eventLog')
    this.maxDataBytes = config.maxDataBytes ?? 16_384
    this.retainDays = config.retainDays ?? 0
    ctx.store.migrate('event-log', [{
      version: 1,
      sql: `CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL,
        run_id TEXT, node_id TEXT, session_id TEXT, turn_id TEXT, entry TEXT NOT NULL
      );
      CREATE INDEX events_run ON events (run_id, seq);
      CREATE INDEX events_session ON events (session_id, seq);
      CREATE INDEX events_type ON events (type, seq);`,
    }, {
      // Trimming by age, and reading what happened since a time.
      version: 2,
      sql: 'CREATE INDEX events_at ON events (at);',
    }])
    // Bounded (INV-9): entries older than retainDays go, at start and then daily. Entries carry
    // no content that anything else references (decisions are artifacts), and cursors stay valid.
    ctx.effect(() => {
      // A failed trim (a busy store) is logged and retried on the next pass; it never stops the host.
      const trim = (): void => {
        try {
          this.trim()
        } catch (error) {
          ctx.logger.warn('event-log: trimming old entries failed; the next daily pass retries')
          ctx.logger.warn(error)
        }
      }
      queueMicrotask(trim)
      const daily = setInterval(trim, 24 * 60 * 60_000)
      daily.unref()
      return () => clearInterval(daily)
    })
  }

  /**
   * Delete entries older than `retainDays` before `now`, in batches of `batch` so a first trim of
   * a large log never holds the store's write lock for long; the count deleted. Freed pages are
   * reused by SQLite, not returned to the file system.
   */
  trim(now: number = Date.now(), batch = 10_000): number {
    if (!this.retainDays) return 0
    const cutoff = new Date(now - this.retainDays * 24 * 60 * 60_000).toISOString()
    let deleted = 0
    for (;;) {
      const changes = Number(this.ctx.store.transaction((db) => db.prepare('DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE at < ? ORDER BY seq LIMIT ?)').run(cutoff, batch)).changes)
      deleted += changes
      if (changes < batch) return deleted
    }
  }

  /** Validate and append one entry; the log assigns `seq` and `at`. */
  append(input: NewEvent): SystemEvent {
    if (input.data !== undefined && Buffer.byteLength(JSON.stringify(input.data)) > this.maxDataBytes) {
      throw new RangeError(`event data exceeds ${this.maxDataBytes} bytes; store large detail as an artifact`)
    }
    const event = this.ctx.store.transaction((db) => {
      const at = new Date().toISOString()
      const next = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as { seq: number } | undefined)?.seq ?? 0
      const entry: SystemEvent = { schema: 'event@1.0', seq: next + 1, at, ...input }
      this.schemas.assertRecord(entry)
      const { lastInsertRowid } = db.prepare('INSERT INTO events (at, type, run_id, node_id, session_id, turn_id, entry) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(at, entry.type, entry.runId ?? null, entry.nodeId ?? null, entry.sessionId ?? null, entry.turnId ?? null, JSON.stringify(entry))
      if (Number(lastInsertRowid) !== entry.seq) throw new Error('event log sequence drifted')
      return entry
    })
    // Announce only after the outermost commit; a listener cannot veto or fail the append.
    this.ctx.store.afterCommit(() => this.ctx.emit('system/event', event))
    return event
  }

  /** Read entries after `afterSeq` in order, optionally filtered; at most 1000 per call. */
  query(filter: { afterSeq?: number; type?: string; runId?: string; nodeId?: string; sessionId?: string; turnId?: string; since?: string; limit?: number } = {}): SystemEvent[] {
    const clauses = ['seq > ?']
    const params: (string | number)[] = [filter.afterSeq ?? 0]
    for (const [column, value] of [['type', filter.type], ['run_id', filter.runId], ['node_id', filter.nodeId], ['session_id', filter.sessionId], ['turn_id', filter.turnId]] as const) {
      if (value !== undefined) {
        clauses.push(`${column} = ?`)
        params.push(value)
      }
    }
    if (filter.since !== undefined) {
      // Entries carry UTC ISO times; any time is normalized to that, and an invalid one refused.
      const since = new Date(filter.since)
      if (Number.isNaN(since.getTime())) throw new RangeError(`since is not a time: ${filter.since}`)
      clauses.push('at >= ?')
      params.push(since.toISOString())
    }
    const limit = clampLimit(filter.limit)
    const rows = this.ctx.store.db.prepare(`SELECT entry FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq LIMIT ${limit}`).all(...params) as { entry: string }[]
    return rows.map((row) => JSON.parse(row.entry) as SystemEvent)
  }
}

export default EventLog
