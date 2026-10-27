/**
 * Conformance suite for `ctx.store`, the guarantee seam under the ledger of record (ADR-0036;
 * ADR-0003; the package README). `boot` returns a context that provides `ctx.store` with its
 * default config (`synchronous` FULL), over a fresh database file in a directory the store
 * creates itself, and with no owner migrated yet. `dispose` unloads the store.
 */
import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { expect } from 'vitest'
import { defineSuite, type Scenario } from '../../libs/conformance/runner.ts'
import { RevisionConflict } from '../src/index.ts'

export type Boot = () => Promise<{ ctx: Context; dispose: () => Promise<void> }>

const TABLE = { version: 1, sql: 'CREATE TABLE conformance_t (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, v TEXT)' }

const rows = (ctx: Context): Array<{ id: string; v: string | null }> =>
  ctx.store.db.prepare('SELECT id, v FROM conformance_t ORDER BY id').all() as Array<{ id: string; v: string | null }>
const insert = (ctx: Context, id: string, v = id): void => {
  ctx.store.db.prepare('INSERT INTO conformance_t (id, v) VALUES (?, ?)').run(id, v)
}
const thrown = (fn: () => unknown): unknown => {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}
/** Let the store finish closing: it may close after the current dispose pass. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

type Run = (ctx: Context, dispose: () => Promise<void>) => Promise<void>

const scenario = (id: string, title: string, run: Run): Scenario<Boot> => ({
  id: `store.${id}`, since: '1.0', title,
  run: async (boot) => {
    const booted = await boot()
    let disposed = false
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      await booted.dispose()
    }
    try {
      await run(booted.ctx, dispose)
    } finally {
      await dispose()
    }
  },
})

export const storeSuite = defineSuite<Boot>({
  seam: 'store',
  contract: '1.0',
  scenarios: [
    scenario('transaction-rolls-back', 'commits a transaction\'s writes together or not at all: a callback that throws rolls every write back, surfaces its error, and leaves the store usable (QA-4, INV-2)', async (ctx) => {
      ctx.store.migrate('conformance', [TABLE])
      const boom = new Error('boom')
      expect(thrown(() => ctx.store.transaction(() => {
        insert(ctx, 'a')
        insert(ctx, 'b')
        throw boom
      }))).toBe(boom)
      expect(rows(ctx)).toEqual([])
      expect(ctx.store.db.isTransaction).toBe(false)
      expect(ctx.store.transaction(() => {
        insert(ctx, 'c')
        insert(ctx, 'd')
        return 'committed'
      })).toBe('committed')
      expect(rows(ctx).map((r) => r.id)).toEqual(['c', 'd'])
    }),
    scenario('nested-savepoint', 'rolls back only a failed nested step when the outer transaction recovers, and everything when it does not (QA-4)', async (ctx) => {
      ctx.store.migrate('conformance', [TABLE])
      ctx.store.transaction(() => {
        insert(ctx, 'outer')
        expect(() => ctx.store.transaction(() => {
          insert(ctx, 'inner')
          throw new Error('nested step failed')
        })).toThrow('nested step failed')
        ctx.store.transaction(() => insert(ctx, 'second'))
      })
      expect(rows(ctx).map((r) => r.id)).toEqual(['outer', 'second'])
      expect(() => ctx.store.transaction(() => {
        insert(ctx, 'lost-outer')
        ctx.store.transaction(() => {
          insert(ctx, 'lost-inner')
          throw new Error('not recovered')
        })
      })).toThrow('not recovered')
      expect(rows(ctx).map((r) => r.id)).toEqual(['outer', 'second'])
      expect(ctx.store.db.isTransaction).toBe(false)
    }),
    scenario('failed-commit-rolls-back', 'surfaces a COMMIT that fails, leaves nothing of it behind or locked, and stays usable (QA-4, INV-2)', async (ctx) => {
      ctx.store.migrate('conformance', [{ version: 1, sql: `
        CREATE TABLE conformance_parent (id TEXT PRIMARY KEY);
        CREATE TABLE conformance_child (id TEXT PRIMARY KEY, parent TEXT REFERENCES conformance_parent(id) DEFERRABLE INITIALLY DEFERRED);` }])
      // A deferred foreign key is checked only at COMMIT.
      expect(() => ctx.store.transaction((db) => db.prepare('INSERT INTO conformance_child VALUES (?, ?)').run('c', 'missing'))).toThrow(/FOREIGN KEY/)
      expect(ctx.store.db.isTransaction).toBe(false)
      expect(ctx.store.db.prepare('SELECT count(*) AS n FROM conformance_child').get()).toEqual({ n: 0 })
      ctx.store.transaction((db) => db.prepare('INSERT INTO conformance_parent VALUES (?)').run('p'))
      expect(ctx.store.db.prepare('SELECT count(*) AS n FROM conformance_parent').get()).toEqual({ n: 1 })
    }),
    scenario('async-callback-poisons', 'refuses every later transaction once a callback returned a promise, whose writes could escape the transaction (INV-2)', async (ctx) => {
      ctx.store.migrate('conformance', [TABLE])
      expect(() => ctx.store.transaction((async () => 1) as never)).toThrow(/synchronous/)
      expect(() => ctx.store.transaction(() => insert(ctx, 'after'))).toThrow(/poisoned/)
      expect(rows(ctx)).toEqual([])
    }),
    scenario('after-commit', 'runs afterCommit callbacks once after the outermost commit, drops those of a rolled-back step, and never fails a committed write for a callback that throws (QA-4)', async (ctx) => {
      const ran: string[] = []
      ctx.store.transaction(() => {
        ctx.store.afterCommit(() => ran.push('outer'))
        ctx.store.transaction(() => ctx.store.afterCommit(() => ran.push('nested')))
        expect(() => ctx.store.transaction(() => {
          ctx.store.afterCommit(() => ran.push('rolled-back step'))
          throw new Error('step failed')
        })).toThrow('step failed')
        expect(ran).toEqual([])
      })
      expect(ran).toEqual(['outer', 'nested'])
      expect(() => ctx.store.transaction(() => {
        ctx.store.afterCommit(() => ran.push('rolled-back transaction'))
        throw new Error('boom')
      })).toThrow('boom')
      ctx.store.migrate('conformance', [TABLE])
      expect(() => ctx.store.transaction(() => {
        insert(ctx, 'kept')
        ctx.store.afterCommit(() => {
          throw new Error('observer failed')
        })
      })).not.toThrow()
      expect(rows(ctx).map((r) => r.id)).toEqual(['kept'])
      ctx.store.afterCommit(() => ran.push('outside'))
      expect(ran).toEqual(['outer', 'nested', 'outside'])
    }),
    scenario('migrate-once', 'applies each owner\'s migrations once, in version order whatever order they are given, and independently of other owners (REQ-HOST-2)', async (ctx) => {
      const v1 = { version: 1, sql: 'CREATE TABLE conformance_m (id TEXT PRIMARY KEY)' }
      const v2 = { version: 2, sql: 'ALTER TABLE conformance_m ADD COLUMN v TEXT' }
      expect(ctx.store.migrate('conformance', [v2, v1])).toBe(2)
      expect(ctx.store.migrate('conformance', [v1, v2])).toBe(0)
      ctx.store.transaction((db) => db.prepare('INSERT INTO conformance_m (id, v) VALUES (?, ?)').run('a', 'x'))
      expect(ctx.store.migrate('conformance-other', [{ version: 1, sql: 'CREATE TABLE conformance_o (id TEXT)' }])).toBe(1)
      expect(ctx.store.migrate('conformance-never', [])).toBe(0)
      const v3 = { version: 3, sql: 'ALTER TABLE conformance_m ADD COLUMN w TEXT' }
      expect(ctx.store.migrate('conformance', [v1, v2, v3])).toBe(1)
      expect(ctx.store.db.prepare('SELECT id, v, w FROM conformance_m').all()).toEqual([{ id: 'a', v: 'x', w: null }])
    }),
    scenario('migrate-never-backwards', 'refuses an owner whose store a newer release migrated past every version this code knows, naming the owner and both versions (REQ-HOST-2, INV-2)', async (ctx) => {
      const v1 = { version: 1, sql: 'CREATE TABLE conformance_m (id TEXT PRIMARY KEY)' }
      const v2 = { version: 2, sql: 'ALTER TABLE conformance_m ADD COLUMN v TEXT' }
      expect(ctx.store.migrate('conformance', [v1, v2])).toBe(2)
      expect(() => ctx.store.migrate('conformance', [v1])).toThrow(/conformance.*\b2\b.*\b1\b/)
      expect(() => ctx.store.migrate('conformance', [])).toThrow(/conformance/)
      // The refusal changed nothing: the newer schema is intact.
      expect(ctx.store.migrate('conformance', [v1, v2])).toBe(0)
    }),
    scenario('migration-atomic', 'leaves no trace of a migration that fails part-way and records it as not applied, so a fixed one applies later (QA-4)', async (ctx) => {
      const v1 = { version: 1, sql: 'CREATE TABLE conformance_m (id TEXT PRIMARY KEY)' }
      const broken = { version: 2, sql: 'CREATE TABLE conformance_half (id TEXT); CREATE TABLE conformance_m (id TEXT)' }
      expect(() => ctx.store.migrate('conformance', [v1, broken])).toThrow()
      expect(ctx.store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'conformance_half'").all()).toEqual([])
      const fixed = { version: 2, sql: 'CREATE TABLE conformance_half (id TEXT)' }
      expect(ctx.store.migrate('conformance', [v1, fixed])).toBe(1)
      expect(ctx.store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'conformance_half'").all()).toEqual([{ name: 'conformance_half' }])
    }),
    scenario('revision-guard', 'refuses a revision-guarded write from a stale revision with RevisionConflict and leaves the row as it was (INV-4, QA-4)', async (ctx) => {
      ctx.store.migrate('conformance', [TABLE])
      ctx.store.transaction(() => insert(ctx, 'a', 'x'))
      expect(ctx.store.updateRevision('conformance_t', 'id', 'a', 0, { v: 'y' })).toBe(1)
      const conflict = thrown(() => ctx.store.updateRevision('conformance_t', 'id', 'a', 0, { v: 'stale' }))
      expect(conflict).toBeInstanceOf(RevisionConflict)
      expect(conflict).toMatchObject({ table: 'conformance_t', key: 'a', expected: 0 })
      expect(() => ctx.store.updateRevision('conformance_t', 'id', 'missing', 0, { v: 'z' })).toThrow(RevisionConflict)
      expect(ctx.store.db.prepare('SELECT v, revision FROM conformance_t WHERE id = ?').get('a')).toEqual({ v: 'y', revision: 1 })
      expect(ctx.store.updateRevision('conformance_t', 'id', 'a', 1, { v: 'z' })).toBe(2)
    }),
    scenario('owner-only', 'keeps the database, its -wal and -shm files, and its directory owner-only: they hold prompts and answers (QA-4)', async (ctx) => {
      ctx.store.migrate('conformance', [TABLE])
      ctx.store.transaction(() => insert(ctx, 'a', 'a secret prompt'))
      const path = ctx.store.path
      expect(statSync(dirname(path)).mode & 0o077).toBe(0)
      for (const file of [path, `${path}-wal`, `${path}-shm`]) expect([file, statSync(file).mode & 0o077]).toEqual([file, 0])
    }),
    scenario('durable-by-default', 'writes in WAL mode with synchronous=FULL by default, so a committed write survives a crash or power loss (QA-4)', async (ctx) => {
      expect(ctx.store.db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
      expect(ctx.store.db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 })
    }),
    scenario('text-byte-for-byte', 'reads stored text back byte for byte, an embedded NUL included (QA-4, CON-2)', async (ctx) => {
      ctx.store.migrate('conformance', [TABLE])
      const text = 'prompt\u0000with a NUL\u0000inside, and \u{1F600} beyond the BMP'
      ctx.store.transaction(() => insert(ctx, 'a', text))
      expect(rows(ctx)).toEqual([{ id: 'a', v: text }])
    }),
    scenario('closed-refuses', 'refuses every use once unloaded, never writing to a closed database (INV-2)', async (ctx, dispose) => {
      const store = ctx.store
      store.migrate('conformance', [TABLE])
      await dispose()
      await settle()
      expect(() => store.db).toThrow(/closed/)
      expect(() => store.transaction(() => 1)).toThrow(/closed/)
      expect(() => store.migrate('conformance', [TABLE])).toThrow(/closed/)
    }),
    {
      id: 'store.refuses-bad-runtime', since: '1.0',
      title: 'refuses to start on a runtime outside the supported range, naming it, so stored text is never silently cut (REQ-HOST-2, CON-2, INV-2)',
      run: async (boot) => {
        const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node')!
        // Node 22 cuts text at an embedded NUL (docs/requirements/constraints.md, CON-2).
        Object.defineProperty(process.versions, 'node', { ...descriptor, value: '22.12.0' })
        let booted: Awaited<ReturnType<Boot>> | undefined
        let refusal: unknown
        try {
          booted = await boot()
        } catch (error) {
          refusal = error
        } finally {
          Object.defineProperty(process.versions, 'node', descriptor)
        }
        try {
          expect(booted?.ctx.get('store'), 'no store is provided on a refused runtime').toBeUndefined()
          expect(String(refusal)).toMatch(/22\.12\.0/)
        } finally {
          await booted?.dispose()
        }
      },
    },
  ],
})
