import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * The harness home, resolved by DSH's own rule (`resolveDshHome`: `$DSH_HOME` made absolute, a
 * blank one ignored, else `~/.dsh`), so the CLI and the daemon always agree on it.
 */
export function dshHome(): string {
  return resolveDshHome()
}

/** Create `dir` (and parents) owner-only, and refuse a group/world-accessible existing directory. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stat = statSync(dir)
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(`${dir} must not be accessible by group or others (mode ${(stat.mode & 0o777).toString(8)})`)
  }
}

/** fsync a directory so a rename or link inside it survives power loss (no-op where unsupported). */
export function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(dir, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writeTemp(path: string, data: string | Uint8Array, mode: number): string {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
  try {
    if (typeof data === 'string') writeSync(fd, data)
    else writeSync(fd, data)
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    unlinkSync(temp)
    throw error
  }
  closeSync(fd)
  return temp
}

/**
 * Durably replace `path`: exclusive temp file with `mode`, fsync, rename, fsync the
 * directory. The temp file is removed on any failure. (DSH's writeFileAtomic leaves
 * crash durability out of scope, which the vault and the discovery file need.)
 */
export function writeFileDurable(path: string, data: string | Uint8Array, mode = 0o600): void {
  const temp = writeTemp(path, data, mode)
  try {
    renameSync(temp, path)
  } catch (error) {
    unlinkSync(temp)
    throw error
  }
  fsyncDir(dirname(path))
}

function checkSecret(path: string, fd: number, bytes: number): Buffer {
  const stat = fstatSync(fd)
  if (!stat.isFile()) throw new Error(`${path} is not a regular file`)
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0) throw new Error(`${path} must be owner-only (mode 0600 or 0400)`)
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${path} is not owned by this user`)
    if (stat.nlink !== 1) throw new Error(`${path} must not be hard-linked`)
  }
  if (stat.size !== bytes) throw new Error(`${path} must contain exactly ${bytes} bytes`)
  return readFileSync(fd)
}

/**
 * Read a secret file, creating it with `bytes` random bytes when absent. Creation is
 * atomic across processes: a complete, fsynced temp file is hard-linked into place
 * (link never replaces), so a concurrent starter either wins or reads the winner's file,
 * and a crash never leaves a partial secret. The file must be a regular owner-only file
 * (0600, or 0400 such as a systemd credential) with one link.
 */
export function readOrCreateSecretFile(path: string, bytes: number): Buffer {
  ensurePrivateDir(dirname(path))
  // A concurrent creator briefly leaves nlink == 2 between link and temp unlink; retry
  // that transient state for up to ~100 ms before treating it as a real hard link.
  for (let attempt = 0; ; attempt++) {
    let fd: number
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      break
    }
    try {
      return checkSecret(path, fd, bytes)
    } catch (error) {
      if (attempt >= 20 || !/hard-linked/.test((error as Error).message)) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    } finally {
      closeSync(fd)
    }
  }
  const temp = writeTemp(path, randomBytes(bytes), 0o600)
  try {
    linkSync(temp, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      unlinkSync(temp)
      throw error
    }
  }
  unlinkSync(temp)
  fsyncDir(dirname(path))
  return readOrCreateSecretFile(path, bytes)
}
