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
export function clampLimit(limit: number | undefined): number {
  const n = Number.isFinite(limit) ? Math.floor(limit as number) : 100
  return Math.min(Math.max(n, 1), 1000)
}

export interface Config {
  /** Largest serialized `data` accepted, in bytes (default 16 KiB). */
  maxDataBytes?: number
}

export class EventLog extends Service {
  static inject = ['store']
  static Config: z<Config> = z.object({
    maxDataBytes: z.natural().min(256).default(16_384).description('Largest serialized data accepted'),
  })

  private readonly schemas = new SchemaRegistry()
  private readonly maxDataBytes: number

  constructor(ctx: Context, config: Config) {
    super(ctx, 'eventLog')
    this.maxDataBytes = config.maxDataBytes ?? 16_384
    ctx.store.migrate('event-log', [{
      version: 1,
      sql: `CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL,
        run_id TEXT, node_id TEXT, session_id TEXT, turn_id TEXT, entry TEXT NOT NULL
      );
      CREATE INDEX events_run ON events (run_id, seq);
      CREATE INDEX events_session ON events (session_id, seq);
      CREATE INDEX events_type ON events (type, seq);`,
    }])
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
  query(filter: { afterSeq?: number; type?: string; runId?: string; sessionId?: string; limit?: number } = {}): SystemEvent[] {
    const clauses = ['seq > ?']
    const params: (string | number)[] = [filter.afterSeq ?? 0]
    for (const [column, value] of [['type', filter.type], ['run_id', filter.runId], ['session_id', filter.sessionId]] as const) {
      if (value !== undefined) {
        clauses.push(`${column} = ?`)
        params.push(value)
      }
    }
    const limit = clampLimit(filter.limit)
    const rows = this.ctx.store.db.prepare(`SELECT entry FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq LIMIT ${limit}`).all(...params) as { entry: string }[]
    return rows.map((row) => JSON.parse(row.entry) as SystemEvent)
  }
}

export default EventLog
