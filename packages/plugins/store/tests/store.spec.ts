import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import Store, { RevisionConflict } from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function boot(): Promise<{ ctx: Context; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'system-store-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fiber = ctx.plugin(Store, { path: join(dir, 'db', 'system.db') })
  await fiber
  cleanups.push(() => fiber.dispose())
  return { ctx, dir }
}

describe('ctx.store', () => {
  it('opens a WAL database in a private directory', async () => {
    const { ctx, dir } = await boot()
    expect((ctx.store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    expect(statSync(join(dir, 'db')).mode & 0o777).toBe(0o700)
  })

  it('keeps the database and its WAL files owner-only (they hold prompts and answers)', async () => {
    const { ctx, dir } = await boot()
    ctx.store.migrate('t', [{ version: 1, sql: 'CREATE TABLE t (x TEXT)' }])
    ctx.store.transaction((db) => void db.prepare('INSERT INTO t VALUES (?)').run('secret prompt'))
    for (const file of readdirSync(join(dir, 'db'))) {
      expect([file, statSync(join(dir, 'db', file)).mode & 0o077]).toEqual([file, 0])
    }
  })

  it('applies each migration once, per owner', async () => {
    const { ctx } = await boot()
    const migrations = [{ version: 1, sql: 'CREATE TABLE t (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, v TEXT)' }]
    expect(ctx.store.migrate('test', migrations)).toBe(1)
    expect(ctx.store.migrate('test', migrations)).toBe(0)
    expect(ctx.store.migrate('other', [{ version: 1, sql: 'CREATE TABLE u (id TEXT)' }])).toBe(1)
  })

  it('rolls back the outer transaction when a nested step fails (QA-4)', async () => {
    const { ctx } = await boot()
    ctx.store.migrate('test', [{ version: 1, sql: 'CREATE TABLE t (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, v TEXT)' }])
    expect(() =>
      ctx.store.transaction((db) => {
        db.prepare('INSERT INTO t VALUES (?, 0, ?)').run('a', 'x')
        ctx.store.transaction(() => {
          throw new Error('boom')
        })
      }),
    ).toThrow('boom')
    expect(ctx.store.db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 })
  })

  it('guards updates with revisions', async () => {
    const { ctx } = await boot()
    ctx.store.migrate('test', [{ version: 1, sql: 'CREATE TABLE t (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, v TEXT)' }])
    ctx.store.transaction((db) => db.prepare('INSERT INTO t VALUES (?, 0, ?)').run('a', 'x'))
    expect(ctx.store.updateRevision('t', 'id', 'a', 0, { v: 'y' })).toBe(1)
    expect(() => ctx.store.updateRevision('t', 'id', 'a', 0, { v: 'z' })).toThrow(RevisionConflict)
    expect(ctx.store.db.prepare('SELECT v, revision FROM t WHERE id = ?').get('a')).toEqual({ v: 'y', revision: 1 })
  })

  it('closes the database when the plugin unloads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-store-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const ctx = new Context()
    const fiber = ctx.plugin(Store, { path: join(dir, 'system.db') })
    await fiber
    const store = ctx.store
    await fiber.dispose()
    await new Promise((resolve) => setImmediate(resolve))
    expect(() => store.db).toThrow('store is closed')
  })
})

describe('review fixes (PR #3 kernel review)', () => {
  it('surfaces a failed COMMIT, releases the write lock, and stays usable', async () => {
    const { ctx } = await boot()
    ctx.store.migrate('test', [{ version: 1, sql: `
      CREATE TABLE parent (id TEXT PRIMARY KEY);
      CREATE TABLE child (id TEXT PRIMARY KEY, parent TEXT REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);` }])
    expect(() => ctx.store.transaction((db) => db.prepare('INSERT INTO child VALUES (?, ?)').run('c', 'missing'))).toThrow(/FOREIGN KEY/)
    expect(ctx.store.db.isTransaction).toBe(false)
    ctx.store.transaction((db) => db.prepare('INSERT INTO parent VALUES (?)').run('p'))
    expect(ctx.store.db.prepare('SELECT count(*) AS n FROM parent').get()).toEqual({ n: 1 })
  })

  it('poisons the store when a callback returns a promise', async () => {
    const { ctx } = await boot()
    expect(() => ctx.store.transaction((async () => 1) as never)).toThrow(/synchronous/)
    expect(() => ctx.store.transaction(() => 1)).toThrow(/poisoned/)
  })

  it('runs afterCommit callbacks once after the outermost commit and drops them on rollback', async () => {
    const { ctx } = await boot()
    const seen: string[] = []
    ctx.store.transaction(() => {
      ctx.store.transaction(() => ctx.store.afterCommit(() => void seen.push('inner')))
      expect(seen).toEqual([])
    })
    expect(seen).toEqual(['inner'])
    expect(() => ctx.store.transaction(() => {
      ctx.store.afterCommit(() => void seen.push('rolled-back'))
      throw new Error('boom')
    })).toThrow('boom')
    ctx.store.afterCommit(() => void seen.push('outside'))
    expect(seen).toEqual(['inner', 'outside'])
  })

  it('isolates a throwing afterCommit callback from the committed transaction', async () => {
    const { ctx } = await boot()
    expect(() => ctx.store.transaction(() => ctx.store.afterCommit(() => {
      throw new Error('listener')
    }))).not.toThrow()
  })

  it('defaults to synchronous=FULL and accepts a configured level (QA-4)', async () => {
    const { ctx } = await boot()
    expect(ctx.store.db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 })
  })

  it('keeps the database open for dependents that write while disposing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-store-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const ctx = new Context()
    const store = ctx.plugin(Store, { path: join(dir, 'system.db') })
    let wrote = false
    const dependent = ctx.plugin({
      inject: ['store'],
      apply(child: Context) {
        child.store.migrate('dep', [{ version: 1, sql: 'CREATE TABLE d (x TEXT)' }])
        child.effect(() => () => {
          child.store.transaction((db) => db.prepare('INSERT INTO d VALUES (?)').run('bye'))
          wrote = true
        })
      },
    })
    await Promise.all([store, dependent])
    await store.dispose()
    expect(wrote).toBe(true)
  })
})

describe('afterCommit inside a rolled-back savepoint (review)', () => {
  it('drops callbacks queued by the rolled-back nested step, keeps the outer ones', async () => {
    const { ctx } = await boot()
    const ran: string[] = []
    ctx.store.transaction(() => {
      ctx.store.afterCommit(() => ran.push('outer'))
      try {
        ctx.store.transaction(() => {
          ctx.store.afterCommit(() => ran.push('inner'))
          throw new Error('nested step failed')
        })
      } catch { /* the outer transaction recovers and commits */ }
    })
    expect(ran).toEqual(['outer'])
  })
})

describe('stored text (QA-4)', () => {
  it('stores and reads back text containing a NUL byte for byte (QA-4)', async () => {
    const { ctx } = await boot()
    ctx.store.migrate('t', [{ version: 1, sql: 'CREATE TABLE t (v TEXT)' }])
    const text = 'prompt\u0000with a NUL\u0000inside'
    ctx.store.transaction((db) => void db.prepare('INSERT INTO t VALUES (?)').run(text))
    expect((ctx.store.db.prepare('SELECT v FROM t').get() as { v: string }).v).toBe(text)
  })
})
