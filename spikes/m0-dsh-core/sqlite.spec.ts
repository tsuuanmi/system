// M0 spike point 3: node:sqlite gives WAL, IMMEDIATE transactions, and revision checks
// that stay consistent across processes (ADR-0003, ADR-0018).
import { fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { bump, openDb } from './sqlite-worker.ts'

const dir = mkdtempSync(join(tmpdir(), 'system-sqlite-'))
const file = join(dir, 'probe.db')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('node:sqlite durability probe', () => {
  it('uses WAL and rejects a stale expected revision', () => {
    const db = openDb(file)
    db.exec('CREATE TABLE node (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL)')
    db.prepare('INSERT INTO node VALUES (?, ?, ?)').run('n1', 0, 'READY')
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    expect(bump(db, 'n1', 5)).toBe(false)
    db.close()
  })

  it('loses no update when four processes race on the same row', async () => {
    const worker = fileURLToPath(new URL('./sqlite-worker.ts', import.meta.url))
    const results = await Promise.all(
      [0, 1, 2, 3].map(
        () =>
          new Promise<{ ok: number; conflict: number }>((resolve, reject) => {
            const child = fork(worker, [file, '100'], { execArgv: ['--import', 'tsx'] })
            child.on('message', (m) => resolve(m as { ok: number; conflict: number }))
            child.on('error', reject)
          }),
      ),
    )
    const ok = results.reduce((sum, r) => sum + r.ok, 0)
    const db = openDb(file)
    const { revision } = db.prepare('SELECT revision FROM node WHERE id = ?').get('n1') as { revision: number }
    db.close()
    expect(ok + results.reduce((sum, r) => sum + r.conflict, 0)).toBe(400)
    expect(revision).toBe(ok)
  }, 60_000)
})
