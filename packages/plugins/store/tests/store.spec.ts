import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import Store from '../src/index.ts'

async function boot(): Promise<{ ctx: Context; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'system-store-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fiber = ctx.plugin(Store, { path: join(dir, 'db', 'system.db') })
  await fiber
  onTestFinished(() => fiber.dispose())
  return { ctx, dir }
}

// The seam's contract is held by its conformance suite (conformance.spec.ts); these tests pin what
// only this provider does.
describe('ctx.store', () => {
  it('refuses a store that newer code migrated further, naming the owner and both versions (REQ-HOST-2)', async () => {
    const { ctx } = await boot()
    const v1 = { version: 1, sql: 'CREATE TABLE t (id TEXT PRIMARY KEY)' }
    const v2 = { version: 2, sql: 'ALTER TABLE t ADD COLUMN v TEXT' }
    expect(ctx.store.migrate('test', [v1, v2])).toBe(2)
    expect(() => ctx.store.migrate('test', [v1])).toThrow(/test is at schema version 2, newer than this release knows \(1\)/)
    expect(ctx.store.migrate('test', [v1, v2])).toBe(0)
    expect(ctx.store.migrate('other', [])).toBe(0)
  })

})

describe('review fixes (PR #3 kernel review)', () => {
  it('keeps the database open for dependents that write while disposing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-store-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
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

