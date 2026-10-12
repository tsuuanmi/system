import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { backupHost, restoreHost } from '../src/index.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'system-backup-'))
  dirs.push(dir)
  return dir
}

/** A harness home with a WAL store holding an uncheckpointed write, and a vault. */
function home(): { home: string; db: DatabaseSync } {
  const dir = temp()
  const state = join(dir, 'system')
  mkdirSync(state, { recursive: true })
  const db = new DatabaseSync(join(state, 'system.db'))
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')")
  writeFileSync(join(state, 'vault.enc'), 'ciphertext')
  writeFileSync(join(state, 'vault.key'), 'k'.repeat(32))
  return { home: dir, db }
}

describe('backup and restore (operations runbook, QA-4)', () => {
  it('snapshots a running store (WAL included) and the vault without its key; restores only after a verified preview', async () => {
    const source = home()
    const target = join(temp(), 'b')
    const manifest = backupHost(target, { home: source.home })
    source.db.close()
    expect(Object.keys(manifest.files).sort()).toEqual(['system.db', 'vault.enc'])
    expect(manifest.includesKey).toBe(false)
    expect(statSync(join(target, 'system.db')).mode & 0o777).toBe(0o600)
    // A host that keeps its own key (the key travels separately).
    const into = temp()
    mkdirSync(join(into, 'system'))
    writeFileSync(join(into, 'system', 'vault.key'), 'k'.repeat(32))
    writeFileSync(join(into, 'system', 'system.db'), 'old store')
    expect(restoreHost(target, { home: into })).toMatchObject({ applied: false })
    expect(readFileSync(join(into, 'system', 'system.db'), 'utf8')).toBe('old store')
    const done = restoreHost(target, { home: into, yes: true })
    expect(done.applied).toBe(true)
    expect(readFileSync(done.keptAside!, 'utf8')).toBe('old store')
    const restored = new DatabaseSync(join(into, 'system', 'system.db'))
    expect(restored.prepare('SELECT v FROM t').all()).toEqual([{ v: 'kept' }])
    restored.close()
  })

  it('refuses a tampered backup, a backup without a key on a host without one, a running profile, and a non-empty target', () => {
    const source = home()
    const target = join(temp(), 'b')
    backupHost(target, { home: source.home })
    source.db.close()
    expect(() => backupHost(target, { home: source.home })).toThrow(/not empty/)
    const keyless = temp()
    expect(() => restoreHost(target, { home: keyless, yes: true })).toThrow(/no vault key/)
    const running = temp()
    mkdirSync(join(running, 'system'))
    writeFileSync(join(running, 'system', 'vault.key'), 'k'.repeat(32))
    writeFileSync(join(running, 'system', 'mcp.json'), JSON.stringify({ url: 'http://127.0.0.1:1/mcp', tokenFile: 'x', pid: process.pid }))
    expect(() => restoreHost(target, { home: running, yes: true })).toThrow(/running/)
    writeFileSync(join(target, 'vault.enc'), 'tampered')
    expect(() => restoreHost(target, { home: running, yes: true })).toThrow(/does not match/)
    expect(existsSync(join(running, 'system', 'system.db'))).toBe(false)
    expect(readdirSync(join(running, 'system')).sort()).toEqual(['mcp.json', 'vault.key'])
  })

  it('includes the key only when asked', () => {
    const source = home()
    const target = join(temp(), 'b')
    expect(backupHost(target, { home: source.home, includeKey: true })).toMatchObject({ includesKey: true })
    source.db.close()
  })
})
