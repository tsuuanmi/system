/**
 * `ctx.store`: system-owned durable records on `node:sqlite` (ADR-0003, ADR-0018 follow-up).
 * One database file, WAL mode, writes serialized by `BEGIN IMMEDIATE`, optimistic revisions.
 * @module @tsuuanmi/system-store
 */
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHome, ensurePrivateDir } from '@tsuuanmi/system-libs'

declare module '@deepseek-ai/cordis' {
  interface Context {
    store: Store
  }
}

/** One schema step owned by a plugin; applied once, in version order, inside a transaction. */
export interface Migration {
  version: number
  sql: string
}

/** Thrown when a revision-guarded write finds a newer revision (docs/design/scheduling-and-leases.md). */
export class RevisionConflict extends Error {
  constructor(readonly table: string, readonly key: string, readonly expected: number) {
    super(`${table}/${key}: expected revision ${expected} is stale`)
    this.name = 'RevisionConflict'
  }
}

export interface Config {
  /** Database file; defaults to `<DSH_HOME>/system/system.db`. */
  path?: string
  /** How long a writer waits for the database lock, in milliseconds (default 5000). */
  busyTimeoutMs?: number
}

export class Store extends Service {
  static Config: z<Config> = z.object({
    path: z.string().description('Database file; defaults to <DSH_HOME>/system/system.db'),
    busyTimeoutMs: z.natural().default(5000).description('Writer lock wait in milliseconds'),
  })

  readonly path: string
  private _db: DatabaseSync | undefined
  private _depth = 0

  constructor(ctx: Context, config: Config) {
    super(ctx, 'store')
    this.path = config.path ?? join(dshHome(), 'system', 'system.db')
    ctx.effect(() => {
      ensurePrivateDir(dirname(this.path))
      const db = new DatabaseSync(this.path)
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=${config.busyTimeoutMs ?? 5000}; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL`)
      db.exec('CREATE TABLE IF NOT EXISTS system_migrations (owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (owner, version))')
      this._db = db
      return () => {
        this._db = undefined
        db.close()
      }
    })
  }

  /** The open database. Prefer {@link transaction} for writes. */
  get db(): DatabaseSync {
    if (!this._db) throw new Error('store is closed')
    return this._db
  }

  /**
   * Run `fn` atomically. The outermost call holds a `BEGIN IMMEDIATE` write lock, so
   * revision checks inside it are safe across processes; nested calls use savepoints.
   */
  transaction<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.db
    const savepoint = `sp_${this._depth}`
    db.exec(this._depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
    this._depth++
    try {
      const result = fn(db)
      if (result instanceof Promise) throw new TypeError('store.transaction callbacks must be synchronous')
      this._depth--
      db.exec(this._depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`)
      return result
    } catch (error) {
      this._depth--
      db.exec(this._depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
      throw error
    }
  }

  /** Apply `owner`'s migrations newer than its recorded version, each in one transaction. */
  migrate(owner: string, migrations: readonly Migration[]): number {
    const sorted = [...migrations].sort((a, b) => a.version - b.version)
    let applied = 0
    for (const migration of sorted) {
      this.transaction((db) => {
        const done = db.prepare('SELECT 1 FROM system_migrations WHERE owner = ? AND version = ?').get(owner, migration.version)
        if (done) return
        db.exec(migration.sql)
        db.prepare('INSERT INTO system_migrations (owner, version, applied_at) VALUES (?, ?, ?)').run(owner, migration.version, new Date().toISOString())
        applied++
      })
    }
    return applied
  }

  /**
   * Revision-guarded update: sets `revision = expected + 1` plus `values` where the row's
   * revision equals `expected`; throws {@link RevisionConflict} otherwise. Table and column
   * names are code-owned identifiers, never user input.
   */
  updateRevision(table: string, keyColumn: string, key: string, expected: number, values: Record<string, string | number | null>): number {
    const columns = Object.keys(values)
    const assignments = [...columns.map((column) => `${column} = ?`), 'revision = revision + 1'].join(', ')
    const result = this.transaction((db) =>
      db.prepare(`UPDATE ${table} SET ${assignments} WHERE ${keyColumn} = ? AND revision = ?`).run(...columns.map((c) => values[c] ?? null), key, expected),
    )
    if (result.changes !== 1) throw new RevisionConflict(table, key, expected)
    return expected + 1
  }
}

export default Store
