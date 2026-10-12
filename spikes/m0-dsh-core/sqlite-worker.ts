import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON')
  return db
}

/** Optimistic revision bump inside an IMMEDIATE transaction; false on a stale revision. */
export function bump(db: DatabaseSync, id: string, expected: number): boolean {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = db
      .prepare('UPDATE node SET revision = revision + 1, state = ? WHERE id = ? AND revision = ?')
      .run('RUNNING', id, expected)
    db.exec(result.changes === 1 ? 'COMMIT' : 'ROLLBACK')
    return result.changes === 1
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file = '', count = '0'] = process.argv.slice(2)
  const db = openDb(file)
  let ok = 0
  let conflict = 0
  for (let i = 0; i < Number(count); i++) {
    const { revision } = db.prepare('SELECT revision FROM node WHERE id = ?').get('n1') as { revision: number }
    if (bump(db, 'n1', revision)) ok++
    else conflict++
  }
  db.close()
  process.send({ ok, conflict }, () => process.exit(0))
}
