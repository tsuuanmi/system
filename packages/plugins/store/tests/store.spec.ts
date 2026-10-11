import { mkdtempSync, rmSync, statSync } from 'node:fs'
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

  it('applies each migration once, per owner', async () => {
    const { ctx } = await boot()
    const migrations = [{ version: 1, sql: 'CREATE TABLE t (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, v TEXT)' }]
    expect(ctx.store.migrate('test', migrations)).toBe(1)
    expect(ctx.store.migrate('test', migrations)).toBe(0)
    expect(ctx.store.migrate('other', [{ version: 1, sql: 'CREATE TABLE u (id TEXT)' }])).toBe(1)
  })

  it('rolls back the outer transaction when a nested step fails', async () => {
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
    expect(() => store.db).toThrow('store is closed')
  })
})
