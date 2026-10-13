/**
 * `ctx.store`: system-owned durable records on `node:sqlite` (ADR-0003, ADR-0018 follow-up).
 * One database file, WAL mode, writes serialized by `BEGIN IMMEDIATE`, optimistic revisions.
 * @module @tsuuanmi/system-store
 */
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { chmodSync, closeSync, existsSync, openSync } from 'node:fs'
import { dshHome, ensurePrivateDir, sqliteRuntimeProblem } from '@tsuuanmi/system-libs'

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
  /** SQLite `synchronous` level (default FULL: a committed lease generation or event seq survives power loss). */
  synchronous?: 'FULL' | 'NORMAL'
}

/** A transaction callback must be synchronous; a Promise-returning callback does not compile. */
export type TransactionCallback<T> = (db: DatabaseSync) => T extends PromiseLike<unknown> ? never : T

export class Store extends Service {
  static Config: z<Config> = z.object({
    path: z.string().description('Database file; defaults to <DSH_HOME>/system/system.db'),
    busyTimeoutMs: z.natural().default(5000).description('Writer lock wait in milliseconds'),
    synchronous: z.union(['FULL', 'NORMAL']).default('FULL').description('SQLite synchronous level'),
  })

  readonly path: string
  private _db: DatabaseSync | undefined
  private _depth = 0
  private poisoned: Error | undefined
  private pending: Array<() => void> = []

  constructor(ctx: Context, config: Config) {
    super(ctx, 'store')
    this.path = config.path ?? join(dshHome(), 'system', 'system.db')
    ctx.effect(() => {
      // Refuse a runtime that would silently corrupt stored text (REQ-HOST-2); the CLI checks
      // the same before it starts the host.
      const problem = sqliteRuntimeProblem()
      if (problem) throw new Error(problem)
      ensurePrivateDir(dirname(this.path))
      // The database holds prompts and answers: owner-only. SQLite gives the -wal and -shm
      // files the database file's mode, so create it 0600 first and tighten older files.
      closeSync(openSync(this.path, 'a', 0o600))
      for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
        if (existsSync(file)) chmodSync(file, 0o600)
      }
      const db = new DatabaseSync(this.path)
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=${config.busyTimeoutMs ?? 5000}; PRAGMA foreign_keys=ON; PRAGMA synchronous=${config.synchronous === 'NORMAL' ? 'NORMAL' : 'FULL'}`)
      db.exec('CREATE TABLE IF NOT EXISTS system_migrations (owner TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (owner, version))')
      this._db = db
      return () => {
        // Close after the current dispose pass, so dependents that write from their own
        // disposers (release a lease, flush an event) still reach an open database.
        setImmediate(() => {
          if (this._db === db) this._db = undefined
          if (db.isOpen) db.close()
        })
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
   * The depth is only unwound after COMMIT/RELEASE succeeds; a failed COMMIT rolls back
   * (if SQLite has not already) and surfaces the original error.
   */
  transaction<T>(fn: TransactionCallback<T>): T {
    if (this.poisoned) throw this.poisoned
    const db = this.db
    const outermost = this._depth === 0
    const savepoint = `sp_${this._depth}`
    db.exec(outermost ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
    // Callbacks queued inside a step that rolls back must not run when the outer commits.
    const pendingAtStart = this.pending.length
    this._depth++
    let result: T
    try {
      result = (fn as (db: DatabaseSync) => T)(db)
      if (result instanceof Promise) {
        this.poisoned = new Error('store poisoned: a transaction callback returned a promise (callbacks must be synchronous); restart the plugin')
        throw new TypeError('store.transaction callbacks must be synchronous')
      }
      db.exec(outermost ? 'COMMIT' : `RELEASE ${savepoint}`)
    } catch (error) {
      if (db.isTransaction) db.exec(outermost ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
      this._depth--
      this.pending.length = outermost ? 0 : pendingAtStart
      throw error
    }
    this._depth--
    if (outermost) this.flushAfterCommit()
    return result
  }

  /**
   * Run `cb` after the outermost transaction commits (immediately when none is open);
   * dropped if it rolls back. Callback errors are logged, never propagated: a committed
   * write must not look failed because an observer threw.
   */
  afterCommit(cb: () => void): void {
    if (this._depth === 0) return this.runSafely(cb)
    this.pending.push(cb)
  }

  private flushAfterCommit(): void {
    const callbacks = this.pending
    this.pending = []
    for (const cb of callbacks) this.runSafely(cb)
  }

  private runSafely(cb: () => void): void {
    try {
      cb()
    } catch (error) {
      this.ctx.logger.warn('store: an afterCommit callback failed')
      this.ctx.logger.warn(error)
    }
  }

  /**
   * Apply `owner`'s migrations newer than its recorded version, each in one transaction.
   * A store that newer code already migrated past the versions this code knows is refused
   * (REQ-HOST-2): older code would misread a schema it has never seen. Recover by running
   * the newer release, or with `system restore` of a backup made before the upgrade. The
   * store's own `system_migrations` table is not versioned this way; the first change to it
   * must version it (a `store` owner, or `PRAGMA user_version`).
   */
  migrate(owner: string, migrations: readonly Migration[]): number {
    const sorted = [...migrations].sort((a, b) => a.version - b.version)
    const known = sorted.at(-1)?.version ?? 0
    const recorded = (this.db.prepare('SELECT MAX(version) AS version FROM system_migrations WHERE owner = ?').get(owner) as { version: number | null }).version ?? 0
    if (recorded > known) {
      throw new Error(`store ${this.path}: ${owner} is at schema version ${recorded}, newer than this release knows (${known}); `
        + 'run the release that migrated it, or `system restore` a backup made before the upgrade')
    }
    let applied = 0
    for (const migration of sorted) {
      this.transaction((db): void => {
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
