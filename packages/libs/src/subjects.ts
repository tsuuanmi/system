/**
 * Exact subjects (REQ-WF-5): the identity of a git working tree, for evidence and approvals that
 * must bind to one version of a change. This is a confined, read-only probe, not a command
 * runner: fixed `git` argument lists, no shell, no hooks, no external diff or text conversion,
 * no optional index writes, bounded time and output.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sha256 } from './canonical.ts'

/**
 * A working tree as an exact subject (the common `subject` shape): its commit, and a content hash
 * of every change on top of it, tracked and untracked.
 */
export interface GitSubject {
  type: 'git-head'
  /** The HEAD commit. */
  ref: string
  /** The hash of the changes on top of `ref` (the hash of nothing when clean). */
  version: string
}

/** One string for a subject: `git:<head>:<tree>`, what a reviewer must name back. */
export const subjectId = (subject: GitSubject): string => `git:${subject.ref}:${subject.version}`

export interface CapturedSubject {
  subject: GitSubject
  /** The change relative to `head`, verbatim (tracked diff, then each untracked file), within `maxDiffChars`. */
  diff: string
  truncated: boolean
}

export interface CaptureOptions {
  timeoutMs?: number
  /** Untracked files larger than this are not shown (their size only); every file's content is hashed whatever its size. */
  maxFileBytes?: number
  maxDiffChars?: number
  /**
   * The most bytes of untracked files hashed in all (default 8 GiB): a tree holding more cannot be
   * bound exactly, and its capture throws rather than leave a file's content out (INV-2, INV-5).
   */
  maxHashBytes?: number
}

/** How much of an untracked file is read at a time while it is hashed. */
const HASH_CHUNK = 1024 * 1024

const ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=']

function git(workspace: string, args: string[], timeoutMs: number): Buffer {
  return execFileSync('git', [...SAFE, '-C', workspace, ...args], { env: ENV, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * git's own answer that `workspace` is no repository with a commit: no such directory, not a
 * repository, or no revision HEAD names yet. Only that is "no subject"; any other failure (a
 * timeout, no git, a repository git refuses to read) leaves the subject unknown, which is never
 * taken for none.
 */
const NO_SUBJECT = /^fatal: (not a git repository|Needed a single revision|cannot change to '.*': No such file or directory)/m

function noSubject(error: unknown): boolean {
  const { status, stderr } = error as { status?: unknown; stderr?: unknown }
  return status === 128 && NO_SUBJECT.test(String(stderr ?? ''))
}

/**
 * An untracked file as captured: the SHA-256 of all of its content, whatever its size, its size,
 * and its content when it is at most `maxBytes` (to show); undefined when it is gone or not a
 * regular file. Its type, size, and content are read through one descriptor, so they are of one
 * file even if the path is replaced meanwhile. It is opened non-blocking, so a FIFO is skipped
 * instead of waited on. A file whose length or modification changed while it was read throws: its
 * content cannot be bound exactly (INV-5), and its subject is unknown, never a guess.
 */
function untrackedFile(path: string, maxBytes: number, budget: { left: number }): { size: number; hash: string; content?: Buffer } | undefined {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY)
  } catch (error) {
    // Gone, or not a file to read (a socket cannot be opened): skipped. A regular file that
    // cannot be read fails the capture, which must not leave a change out of the subject.
    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return undefined
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return undefined
    if (stat.size > budget.left) throw new Error(`the untracked file ${path} (${stat.size} bytes) passes the bound on what a subject hashes, so the tree cannot be bound exactly`)
    const hash = createHash('sha256')
    const shown: Buffer[] = []
    const buffer = Buffer.alloc(HASH_CHUNK)
    let read = 0
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null)
      if (!n) break
      read += n
      if (read > stat.size) break
      hash.update(buffer.subarray(0, n))
      if (stat.size <= maxBytes) shown.push(Buffer.from(buffer.subarray(0, n)))
    }
    const after = fstatSync(fd)
    if (read !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new Error(`the untracked file ${path} changed while it was read, so its content cannot be bound exactly`)
    }
    budget.left -= stat.size
    return { size: stat.size, hash: `sha256:${hash.digest('hex')}`, ...(stat.size > maxBytes ? {} : { content: Buffer.concat(shown) }) }
  } finally {
    closeSync(fd)
  }
}

/**
 * A name `git check-ignore` could read as more than itself: pathspec magic (a leading `:`) or a
 * glob character. check-ignore takes no `--literal-pathspecs`, so such a name is never judged.
 */
const NOT_LITERAL = /^:|[*?[\\]/

/**
 * Whether git leaves `path` (relative to the working tree `workspace`, taken literally) out of every
 * subject: it holds no tracked file and git's ignore rules ignore it as it is, or, when nothing is
 * there yet, as the directory it will be made, so nothing under it is in {@link captureGitSubject}'s
 * hash. False, never a guess, for a name git could read as a pattern or pathspec magic (INV-2).
 * Throws when git cannot answer.
 */
export function ignoredPath(workspace: string, path: string, timeoutMs = 10_000): boolean {
  if (NOT_LITERAL.test(path)) return false
  if (git(workspace, ['--literal-pathspecs', 'ls-files', '-z', '--', path], timeoutMs).length) return false
  // git judges a path that is not there as a file, so one not made yet is asked as the directory
  // it will be (the trailing `/`): a rule for directories only (`node_modules/`) holds for it.
  const there = lstatSync(join(workspace, path), { throwIfNoEntry: false })
  try {
    git(workspace, ['check-ignore', '-q', '--', there ? path : `${path}/`], timeoutMs)
    return true
  } catch (error) {
    // git check-ignore exits 1 when the path is not ignored.
    if ((error as { status?: unknown }).status === 1) return false
    throw error
  }
}

/**
 * The subject of a git working tree, or undefined when git answers that the workspace is not a
 * repository with a commit. Any other failure of git throws: a subject that cannot be read is
 * unknown, never absent. Two captures are equal exactly when HEAD and every change on top of it are.
 */
export function captureGitSubject(workspace: string, options: CaptureOptions = {}): CapturedSubject | undefined {
  const timeoutMs = options.timeoutMs ?? 10_000
  let head: string
  try {
    head = git(workspace, ['rev-parse', '--verify', 'HEAD'], timeoutMs).toString('utf8').trim()
  } catch (error) {
    if (noSubject(error)) return undefined
    const said = String((error as { stderr?: unknown }).stderr ?? '').trim().split('\n').at(-1) || (error as Error).message.split('\n')[0]
    throw new Error(`the subject of ${workspace} cannot be read: git rev-parse failed (${said!.slice(0, 200)})`, { cause: error })
  }
  const tracked = git(workspace, ['diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD'], timeoutMs).toString('utf8')
  const untracked = git(workspace, ['ls-files', '--others', '--exclude-standard', '-z'], timeoutMs).toString('utf8').split('\0').filter(Boolean).sort()
  const maxFileBytes = options.maxFileBytes ?? 1024 * 1024
  const budget = { left: options.maxHashBytes ?? 8 * 1024 ** 3 }
  const parts: string[] = []
  const shown: string[] = []
  for (const path of untracked) {
    const file = untrackedFile(join(workspace, path), maxFileBytes, budget)
    if (!file) continue
    // INV-5: every file's whole content is in the subject; the display bound decides only what is shown.
    parts.push(`${path}\0${file.hash}`)
    shown.push(file.content === undefined ? `new file ${path} (${file.size} bytes, not shown)` : `new file ${path}\n${file.content.toString('utf8')}`)
  }
  const tree = sha256(`${tracked}\0${parts.join('\0')}`).replace(/^sha256:/, '')
  const full = [tracked.trimEnd(), ...shown].filter(Boolean).join('\n\n')
  const maxDiffChars = options.maxDiffChars ?? 200_000
  const truncated = full.length > maxDiffChars
  return {
    subject: { type: 'git-head', ref: head, version: tree },
    diff: truncated ? `${full.slice(0, maxDiffChars)}\n…(truncated; ${full.length} chars in all)` : full,
    truncated,
  }
}
