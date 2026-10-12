/**
 * Exact subjects (REQ-WF-5): the identity of a git working tree, for evidence and approvals that
 * must bind to one version of a change. This is a confined, read-only probe, not a command
 * runner: fixed `git` argument lists, no shell, no hooks, no external diff or text conversion,
 * no optional index writes, bounded time and output.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
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
  return execFileSync('git', [...SAFE, '-C', workspace, ...args], { env: ENV, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
}

/**
 * The subject of a git working tree, or undefined when the workspace is not a repository with a
 * commit. Two captures are equal exactly when HEAD and every change on top of it are.
 */
export function captureGitSubject(workspace: string, options: CaptureOptions = {}): CapturedSubject | undefined {
  const timeoutMs = options.timeoutMs ?? 10_000
  let head: string
  try {
    head = git(workspace, ['rev-parse', '--verify', 'HEAD'], timeoutMs).toString('utf8').trim()
  } catch {
    return undefined
  }
  const tracked = git(workspace, ['diff', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD'], timeoutMs).toString('utf8')
  const untracked = git(workspace, ['ls-files', '--others', '--exclude-standard', '-z'], timeoutMs).toString('utf8').split('\0').filter(Boolean).sort()
  const maxFileBytes = options.maxFileBytes ?? 1024 * 1024
  const parts: string[] = []
  const shown: string[] = []
  for (const path of untracked) {
    const full = join(workspace, path)
    const stat = statSync(full, { throwIfNoEntry: false })
    if (!stat?.isFile()) continue
    if (stat.size > maxFileBytes) {
      parts.push(`${path}\0${stat.size}\0${stat.mtimeMs}`)
      shown.push(`new file ${path} (${stat.size} bytes, not shown)`)
      continue
    }
    const content = readFileSync(full)
    parts.push(`${path}\0${sha256(content)}`)
    shown.push(`new file ${path}\n${content.toString('utf8')}`)
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
