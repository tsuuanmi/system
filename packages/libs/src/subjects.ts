/**
 * Exact subjects (REQ-WF-5): the identity of a git working tree, for evidence and approvals that
 * must bind to one version of a change. This is a confined, read-only probe, not a command
 * runner: fixed `git` argument lists, no shell, no hooks, no external diff or text conversion,
 * no optional index writes, bounded time and output.
 */
import { execFileSync } from 'node:child_process'
import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from 'node:fs'
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
  /** Untracked files larger than this are hashed by size and mtime only, and not shown. */
  maxFileBytes?: number
  maxDiffChars?: number
}

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
 * An untracked file as captured: its size and mtime, and its content when it is at most
 * `maxBytes`; undefined when it is gone or not a regular file. Its type, size, and content are
 * read through one descriptor, so they are of one file even if the path is replaced meanwhile.
 * It is opened non-blocking, so a FIFO is skipped instead of waited on.
 */
function untrackedFile(path: string, maxBytes: number): { size: number; mtimeMs: number; content?: Buffer } | undefined {
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
    return { size: stat.size, mtimeMs: stat.mtimeMs, ...(stat.size > maxBytes ? {} : { content: readFileSync(fd) }) }
  } finally {
    closeSync(fd)
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
  const parts: string[] = []
  const shown: string[] = []
  for (const path of untracked) {
    const file = untrackedFile(join(workspace, path), maxFileBytes)
    if (!file) continue
    if (file.content === undefined) {
      parts.push(`${path}\0${file.size}\0${file.mtimeMs}`)
      shown.push(`new file ${path} (${file.size} bytes, not shown)`)
      continue
    }
    parts.push(`${path}\0${sha256(file.content)}`)
    shown.push(`new file ${path}\n${file.content.toString('utf8')}`)
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
