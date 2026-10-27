import type { DatabaseSync } from 'node:sqlite'
import { type Context, Service } from '@deepseek-ai/cordis'

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

/** A transaction callback must be synchronous; a Promise-returning callback does not compile. */
export type TransactionCallback<T> = (db: DatabaseSync) => T extends PromiseLike<unknown> ? never : T

/**
 * `ctx.store`: system-owned durable records on `node:sqlite` (ADR-0003, ADR-0018 follow-up). One
 * database file, writes serialized by `BEGIN IMMEDIATE`, optimistic revisions. A guarantee seam: a
 * provider passes `conformance/store.ts` (ADR-0036).
 */
export abstract class Store extends Service {
  constructor(ctx: Context) {
    super(ctx, 'store')
  }

  /** The database file. */
  abstract readonly path: string

  /** The open database. Prefer {@link transaction} for writes. Throws when the store is closed. */
  abstract get db(): DatabaseSync

  /**
   * Run `fn` atomically. The outermost call holds a write lock, so revision checks inside it are
   * safe across processes; nested calls use savepoints.
   */
  abstract transaction<T>(fn: TransactionCallback<T>): T

  /**
   * Run `cb` after the outermost transaction commits (immediately when none is open); dropped if it
   * rolls back. Callback errors are logged, never propagated.
   */
  abstract afterCommit(cb: () => void): void

  /**
   * Apply `owner`'s migrations newer than its recorded version, each in one transaction; the number
   * applied. A store already migrated past the versions this code knows is refused (REQ-HOST-2).
   */
  abstract migrate(owner: string, migrations: readonly Migration[]): number

  /**
   * Revision-guarded update: sets `revision = expected + 1` plus `values` where the row's revision
   * equals `expected`; throws {@link RevisionConflict} otherwise. Table and column names are
   * code-owned identifiers, never user input.
   */
  abstract updateRevision(table: string, keyColumn: string, key: string, expected: number, values: Record<string, string | number | null>): number
}
