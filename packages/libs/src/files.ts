import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The harness home: `$DSH_HOME`, else `~/.dsh` (same rule as DSH). */
export function dshHome(): string {
  return process.env['DSH_HOME'] || join(homedir(), '.dsh')
}

/** Create `dir` (and parents) owner-only, and refuse a group/world-accessible existing directory. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = statSync(dir)
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`${dir} must not be accessible by group or others (mode ${(stat.mode & 0o777).toString(8)})`)
  }
}

/**
 * Read a secret file, creating it with `bytes` random bytes when absent. The file must be a
 * regular file owned by this user, mode 0600, with one link (hygiene rules from the
 * credentials-keychain review, docs/research/dsh-community-plugins-review.md).
 */
export function readOrCreateSecretFile(path: string, bytes: number): Buffer {
  ensurePrivateDir(dirname(path))
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const created = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeSync(created, randomBytes(bytes))
    } finally {
      closeSync(created)
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`)
    if (process.platform !== 'win32') {
      if ((stat.mode & 0o777) !== 0o600) throw new Error(`${path} must have mode 0600`)
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${path} is not owned by this user`)
      if (stat.nlink !== 1) throw new Error(`${path} must not be hard-linked`)
    }
    if (stat.size !== bytes) throw new Error(`${path} must contain exactly ${bytes} bytes`)
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}
