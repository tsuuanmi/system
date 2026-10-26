/**
 * A git worktree per workflow run (PROP-0010, B3): a Worker configured with `worktreePerRun`
 * works, for each workflow run, in that run's own worktree of its repository, on the branch
 * `system/run/<runId>`, never in the repository's main working tree (INV-15). One worktree per
 * (repository, run), created from the repository's HEAD on first use and shared by every later
 * agent run of that workflow run on that repository, reviewers included, so a review reads the
 * tree it is bound to. The mapping is stored, so a restart reuses it.
 *
 * Cleanup is bounded (INV-9): once every agent run of a workflow run has finished and the last
 * ended longer ago than the retention, its worktree's changes are committed on its branch and
 * the worktree is removed, by a `retention` decision (INV-13). A branch is never deleted and
 * nothing is forced: a worktree that cannot be committed or removed stays where it is, and the
 * next sweep tries again.
 *
 * Landing (ADR-0060): once a result made in a worktree is accepted, the workflow engine asks for it
 * to be committed on the worktree's branch, only while the worktree is still the accepted tree, and,
 * on the operator's `merge` approval, for that branch to be merged into the repository's checked-out
 * branch, only while both are still where the approval saw them. A conflict is aborted, so the
 * repository is as it was; nothing is ever forced, reset, or pushed.
 *
 * Review history (board T232): on the engine's ask, the tree a review read and each fix's result are
 * kept as commits on the run's own ref `refs/system/reviews/<runId>`, built in an index of their own:
 * the worktree's HEAD, branch, index, and files never move, so the commit a board task writes stays
 * the HEAD its result binds to.
 *
 * Carrying (ADR-0061): a board task's next attempt may start from the work its previous attempt left,
 * when that attempt failed only after its writing step. On the engine's ask, the earlier worktree is
 * committed on its branch, only while it is still exactly the tree its writing step left, and the new
 * run's worktree is cut at that tree's base, only while the base is still the repository's HEAD,
 * holding the committed tree as its change: what a fresh worktree is, plus the earlier work. A worktree
 * cut for that work and never given it (a crash between the two) holds no run's work: no agent runs in
 * it, and the carry asked again, the retention, and the operator's removal put it back to its base
 * before anything else, so nothing of it is ever committed.
 *
 * git runs with fixed argument lists, always with `-C <path>`, no shell, no hooks, no system or
 * global configuration (as the subject capture, `captureGitSubject`), and bounded time. Inside a
 * worktree, git is pointed at the worktree's own administrative directory recorded at creation,
 * never at whatever the worktree's `.git` file says later: an agent can write that file.
 */
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeSync } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import { BRIEF_FILE_PATH, captureGitSubject, ensurePrivateDir, sandboxPlaceholder, subjectId } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-store'
import {
  type Carried, type CarryRefusal, type CarryStep, CHANGE_BOUNDS, type ChangedFile, type Landed, type LandRefusal, type LandStep, REBASE_FILES_MAX, REBASE_MOVED_MAX, type Regenerated, reviewRef, type WorkChange,
} from '@tsuuanmi/system-workers-core'
import type { Regeneration } from './regenerate.ts'

/** A workflow run id as it may name a branch and a directory: letters, digits, `_`, `-`. */
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
/** git 2.17 added `git worktree remove`. */
const WORKTREE_GIT_FLOOR = [2, 17] as const
/** At most this many worktrees are retired by one sweep; the rest wait for the next. */
const SWEEP_BATCH = 50
/** Who commits a worktree's pending changes before it is removed. */
const SYSTEM_AUTHOR ={ name: 'system', email: 'system@localhost' } as const

/** The trailer a landing's commit carries: the exact subject it holds, so a commit repeated after a restart is found done (INV-4). */
export const SUBJECT_TRAILER = 'System-Subject'
/** The trailer the commit of a carried tree carries: the workflow run whose worktree starts from it (ADR-0061). */
const CARRIED_TRAILER = 'System-Carried-To'
/** The first line of the commit by which the retention keeps a worktree's uncommitted work on its branch. */
const keptSubject =(runId: string): string => `system: keep the uncommitted work of workflow run ${runId}`

/**
 * The trailers of a landing's rebase commit (ADR-0068): the head it was made from and the base commit
 * it is on, so a step repeated after a restart finds it done (INV-4). The last of each is the latest.
 */
export const REBASED_TRAILER = 'System-Rebased-From'
export const ONTO_TRAILER = 'System-Rebased-Onto'
/** Rebases of one result a landing follows back to its landing commit, at most. */
const REBASE_DEPTH = 8
/**
 * The ref that keeps a run's head from before its landing rebased it (ADR-0068), one per head: the
 * branch moves, and what it held stays reachable, for the operator and for a restart mid-rebase.
 */
export const rebaseRef = (runId: string, head: string): string => `refs/system/rebase/${runId}/${head}`
/**
 * The ref that says a landing's rebase of `head` was replayed in its worktree (ADR-0068): set to the
 * base once the worktree holds the replay (its generated conflicts already taking a side), never
 * before. A rebase begun without it may have stopped anywhere between moving the branch and the
 * replay, so its worktree is made the base's again and the replay run again; only with it is what the
 * worktree holds the replay, to commit (INV-4).
 */
const replayedRef =(runId: string, head: string): string => `refs/system/rebase-replayed/${runId}/${head}`
/** The head a rebase commit's message says it was made from (its last {@link REBASED_TRAILER}), when it says one. */
const rebasedFrom = (message: readonly string[]): string | undefined => {
  const line = message.findLast((l) => l.startsWith(`${REBASED_TRAILER}: `))
  const from = line?.slice(REBASED_TRAILER.length + 2).trim()
  return from && /^[0-9a-f]{40,64}$/.test(from) ? from : undefined
}
/** A conflict marker line git writes (`<<<<<<< ours`, `>>>>>>> theirs`); `=======` alone is too common a line (a heading's underline) to count. */
const MARKER = /^(?:<{7}|>{7})(?: |$)/m
/** The largest file a resolution's marker check reads; a larger one is taken as holding markers (INV-2, INV-9). */
const MARKER_FILE_BYTES = 8 * 1024 * 1024

/** Whether the file at `path` (never followed through a link) holds a conflict marker; anything but a regular file holds none. */
function hasMarkers(path: string): boolean {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return false
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return false
    if (stat.size > MARKER_FILE_BYTES) return true
    return MARKER.test(readFileSync(fd, 'utf8'))
  } finally {
    closeSync(fd)
  }
}

/**
 * A worktree cut from an earlier run's work (ADR-0061): that workflow run, and the commit on its
 * branch the worktree holds, set once the tree is in it (absent meanwhile: no agent runs there).
 */
export const CARRY_MIGRATION = {
  version: 15,
  sql: `ALTER TABLE agent_worktrees ADD COLUMN carried_from TEXT;
  ALTER TABLE agent_worktrees ADD COLUMN carried_commit TEXT;`,
}
/**
 * The commit a worktree was cut at (T128), so its change is read against it once its branch is merged
 * into the base; absent for a worktree made before it was recorded.
 */
export const FORK_MIGRATION = {
  version: 16,
  sql: 'ALTER TABLE agent_worktrees ADD COLUMN forked_at TEXT;',
}
/** Characters of a change's `git diff --stat` a landing reports at most (INV-9). */
const STAT_CHARS = 1500

const GIT_MS = 60_000
const execFileAsync = promisify(execFile)
const ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  // Every ref the system moves (a new branch, a commit) is the system's, whoever the operator is.
  GIT_AUTHOR_NAME: SYSTEM_AUTHOR.name, GIT_AUTHOR_EMAIL: SYSTEM_AUTHOR.email, GIT_COMMITTER_NAME: SYSTEM_AUTHOR.name, GIT_COMMITTER_EMAIL: SYSTEM_AUTHOR.email,
}
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'submodule.recurse=false']

/**
 * An agent run (of the table aliased `alias`) that ended without being known to be gone: reconciled
 * on a verdict that was not `dead`, and not freed by the operator since. What it ran in stays held
 * (INV-15; PROP-0013).
 */
export const notKnownGone = (alias: string): string => `${alias}liveness_decision IS NOT NULL AND COALESCE(${alias}liveness_verdict, '') != 'dead' AND ${alias}liveness_freed IS NULL`

/**
 * A worktree whose workflow run has no agent run queued or running, and none that ended without being
 * known to be gone (its agent may still write there: the worktree stays, INV-15; PROP-0013) but the
 * one run (`?`, or NULL for none) the operator is freeing.
 */
const FREE = `NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.workflow_run_id = w.workflow_run_id AND r.status IN ('queued', 'running'))
  AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.workflow_run_id = w.workflow_run_id AND ${notKnownGone('r.')} AND r.run_id IS NOT ?)`

/** A worktree that is {@link FREE} (with no run excepted), and whose workflow run's last agent run ended before the cutoff (the second `?`). */
const IDLE = `${FREE}
  AND COALESCE((SELECT MAX(r.updated_at) FROM agent_runs r WHERE r.workflow_run_id = w.workflow_run_id), w.created_at) < ?`

/** A worktree that cannot be prepared, checked, or retired; what git said, if it ran. */
class WorktreeError extends Error {
  override readonly name = 'WorktreeError'
}

/** What a failed git said, as one line: its stderr without hints, else `fallback`. */
const said = (stderr: string, fallback: string): string => stderr.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('hint:')).join(' ') || fallback

/** Paths as a reason names them: the first ten, and how many more. */
const named = (paths: readonly string[]): string => `${paths.slice(0, 10).join(', ')}${paths.length > 10 ? ` and ${paths.length - 10} more` : ''}`

/** NUL-separated paths as git gives them with `-z`. */
const zPaths = (text: string): string[] => text.split('\0').filter(Boolean)

/** What a file is, as far as a change to it shows (never followed through a link): `gone` when it is not there. */
function stamp(path: string): string {
  try {
    const s = lstatSync(path, { bigint: true })
    return `${s.mode}:${s.size}:${s.ino}:${s.mtimeNs}:${s.ctimeNs}`
  } catch {
    return 'gone'
  }
}

/**
 * What a worktree's `.git` control file is: its {@link stamp} and the directory it points to. git
 * reports it neither as changed nor as ignored, so a regeneration checks it on its own.
 */
function controlFile(path: string): string {
  return `${stamp(join(path, '.git'))}|${pointer(path) ?? 'none'}`
}

/** The error of a git run in `dir` that failed: its subcommand, and why. */
const failed = (dir: string, args: string[], why: string): WorktreeError => new WorktreeError(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''} in ${dir}: ${why.slice(0, 300)}`)

/** `git -C dir …`, bounded; rejects with what git said. */
async function git(dir: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  try {
    return (await execFileAsync('git', ['-C', dir, ...SAFE, ...args], { env: { ...ENV, ...env }, timeout: GIT_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 })).stdout
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean }
    throw failed(dir, args, e.code === 'ENOENT' ? 'git is not installed' : e.killed ? `it took longer than ${GIT_MS / 1000} s` : said(e.stderr ?? '', e.message))
  }
}

/**
 * `git -C dir …` read as its output comes, never held whole (INV-9): `take` gets each piece, decoded,
 * and returns true once it has what it needs, which stops git there. Bounded in time as {@link git}.
 * Resolves whether it was stopped; rejects with what git said when it failed before, or with what
 * `take` threw.
 */
function gitRead(dir: string, args: string[], take: (text: string) => boolean): Promise<{ stopped: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', dir, ...SAFE, ...args], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    const decoder = new StringDecoder('utf8')
    let stopped = false
    let late = false
    let thrown: unknown
    let stderr = ''
    const stop = (): void => {
      stopped = true
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => {
      late = true
      child.kill('SIGKILL')
    }, GIT_MS)
    const offer = (text: string): void => {
      if (stopped || !text) return
      try {
        if (take(text)) stop()
      } catch (error) {
        thrown = error
        stop()
      }
    }
    child.stdout.on('data', (chunk: Buffer) => offer(decoder.write(chunk)))
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(failed(dir, args, error.code === 'ENOENT' ? 'git is not installed' : error.message))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (thrown !== undefined) return reject(thrown)
      if (stopped) return resolve({ stopped: true })
      if (late) return reject(failed(dir, args, `it took longer than ${GIT_MS / 1000} s`))
      if (code !== 0) return reject(failed(dir, args, said(stderr, `it exited with ${code}`)))
      offer(decoder.end())
      return thrown !== undefined ? reject(thrown) : resolve({ stopped })
    })
  })
}

/**
 * The text of `path` (relative to the repository's top level) as the repository at `dir` has it
 * committed at HEAD, never as its working tree has it, so an uncommitted edit is never read; at most
 * `maxChars` characters, read no further (INV-9), `cut` when there was more. Undefined when `dir` is
 * in no repository, it has no commit, or no file is committed at that path; git runs as every git
 * here does (no hooks, no configuration of the machine's, bounded time).
 */
export async function committedText(dir: string, path: string, maxChars: number): Promise<{ text: string; cut: boolean } | undefined> {
  const object = `HEAD:${path}`
  const type = await git(dir, ['cat-file', '-t', object]).then((out) => out.trim(), () => undefined)
  if (type !== 'blob') return undefined
  let text = ''
  const { stopped } = await gitRead(dir, ['cat-file', 'blob', object], (piece) => {
    text += piece
    return text.length > maxChars
  })
  const cut = stopped || text.length > maxChars
  return { text: text.slice(0, maxChars), cut }
}

/** The git blob id of `path` as committed at `dir`'s HEAD, or undefined when HEAD holds no such blob. */
export async function committedBlob(dir: string, path: string): Promise<string | undefined> {
  const id = await git(dir, ['rev-parse', '--verify', '--quiet', `HEAD:${path}`]).then((out) => out.trim(), () => undefined)
  return id && /^[0-9a-f]{40,64}$/.test(id) ? id : undefined
}

/** Characters one NUL-separated field of git's output may have (a path, a status): longer is not git's listing. */
const FIELD_CHARS = 64 * 1024

/** A {@link gitRead} taker of NUL-separated output: each whole field goes to `field`, which returns true to stop. */
function fields(field: (value: string) => boolean): (text: string) => boolean {
  let rest = ''
  return (text) => {
    const parts = (rest + text).split('\0')
    rest = parts.pop()!
    if (rest.length > FIELD_CHARS) throw new WorktreeError(`git gave a field longer than ${FIELD_CHARS} characters, which is no path`)
    for (const part of parts) if (field(part)) return true
    return false
  }
}

/** Dependency files {@link dependencyPaths} lists at most: past it, the listing is refused, never cut (INV-2, INV-9). */
const DEPENDENCY_PATHS_MAX = 2000

/**
 * The paths of the worktree at `path` whose file name is one of `names` (a dependency manifest, the
 * lockfile), at any depth: tracked (in its index, there or not) or untracked and not ignored, as git
 * lists them with the worktree's own administrative directory `gitdir`, never through what its `.git`
 * file says. Sorted. Throws past {@link DEPENDENCY_PATHS_MAX}, or when git fails.
 */
export async function dependencyPaths(path: string, gitdir: string, names: readonly string[]): Promise<string[]> {
  const wanted = new Set(names)
  const found = new Set<string>()
  const { stopped } = await gitRead(path, [`--git-dir=${gitdir}`, `--work-tree=${path}`, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], fields((p) => {
    if (wanted.has(basename(p))) found.add(p)
    return found.size > DEPENDENCY_PATHS_MAX
  }))
  if (stopped) throw new WorktreeError(`${path} holds more than ${DEPENDENCY_PATHS_MAX} dependency files (${names.join(', ')})`)
  return [...found].sort()
}

const DIFF_HEADER = 'diff --git '

/**
 * A {@link gitRead} taker of a patch: its `diff --git` blocks in order, each kept to `cap` characters
 * and the rest of it passed over unkept, so a file of any size costs at most `cap`. Stops once `enough`
 * says so (given the blocks complete so far). `end()` closes the last block.
 */
function patchBlocks(cap: number, enough: (blocks: readonly string[]) => boolean): { take: (text: string) => boolean; end: () => string[] } {
  const blocks: string[] = []
  let current: string | undefined
  // The last characters seen, held back: a header may begin in them. And the character before them.
  let held = ''
  let before = '\n'
  const keep = (text: string): void => {
    if (current !== undefined && current.length < cap) current += text.slice(0, cap - current.length)
  }
  return {
    take: (piece) => {
      const text = held + piece
      const end = Math.max(0, text.length - (DIFF_HEADER.length - 1))
      let from = 0
      for (let at = text.indexOf(DIFF_HEADER); at !== -1 && at < end; at = text.indexOf(DIFF_HEADER, at + 1)) {
        if ((at ? text[at - 1] : before) !== '\n') continue
        keep(text.slice(from, at))
        from = at
        if (current !== undefined) {
          blocks.push(current)
          if (enough(blocks)) return true
        }
        current = ''
      }
      keep(text.slice(from, end))
      if (end) before = text[end - 1]!
      held = text.slice(end)
      return false
    },
    end: () => {
      keep(held)
      held = ''
      if (current !== undefined) blocks.push(current)
      current = undefined
      return blocks
    },
  }
}

/**
 * A path as git's diff header names it (`core.quotePath` on): in double quotes, C-escaped, when it
 * holds a double quote, a backslash, a control character, or a byte past ASCII; else as it is.
 */
export function quotedPath(name: string): string {
  const ESCAPES: Record<number, string> = { 7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r', 34: '"', 92: '\\' }
  let out = ''
  let special = false
  for (const byte of Buffer.from(name, 'utf8')) {
    const escape = ESCAPES[byte]
    if (escape) out += `\\${escape}`
    else if (byte < 0x20 || byte >= 0x7f) out += `\\${byte.toString(8).padStart(3, '0')}`
    else {
      out += String.fromCharCode(byte)
      continue
    }
    special = true
  }
  return special ? `"${out}"` : name
}

const real = (path: string): string | undefined => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

const under = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)

const branchOf =(runId: string): string => `system/run/${runId}`

/** The directory of a repository's worktrees: its name, then a short hash of its real path. */
export function repositoryKey(repository: string): string {
  const name = basename(repository).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\./, '_').slice(0, 64) || 'repository'
  return `${name}-${createHash('sha256').update(repository).digest('hex').slice(0, 12)}`
}

/**
 * The administrative directory a worktree's `.git` file points to (real path), or undefined when
 * `.git` is not a small regular file of that form. Never follows a link, and never waits on a pipe.
 */
function pointer(path: string): string | undefined {
  let text: string
  try {
    const fd = openSync(join(path, '.git'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 4096) return undefined
      text = readFileSync(fd, 'utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
  const match = /^gitdir: (.+?)\r?\n?$/.exec(text)
  return match ? real(resolve(path, match[1]!)) : undefined
}

/**
 * Whether something other than a plain file is at `path`: a link (which fails to open, never
 * followed), or what an opened descriptor shows is not a file; a pipe is never waited on. Nothing
 * there, or an entry that cannot be opened, is not taken for one: a rename over it never follows a
 * link and fails on a directory.
 */
function notPlainFile(path: string): boolean {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ELOOP' || code === 'EMLINK'
  }
  try {
    return !fstatSync(fd).isFile()
  } finally {
    closeSync(fd)
  }
}

/** Whether anything is at `path`, never following a link at it. */
function lexists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** A directory opened as itself, and the path that reaches it through its descriptor. The caller closes `fd`. */
export interface OpenedDirectory { fd: number; at: string }

/**
 * Open the directory at `path` as itself, never through a link (O_DIRECTORY | O_NOFOLLOW), with
 * the path that reaches it through the descriptor, `/proc/self/fd/<fd>` (Linux): every step after
 * the open works relative to the directory opened, so nothing swapped in at `path` meanwhile (a
 * link out of the workspace, say) is ever used. `absent` when nothing is at `path`; `other` when
 * something that is not a plain directory is (a link, a file). Throws a {@link WorktreeError} when
 * that path does not reach the directory opened (no `/proc`): nothing is done in it then.
 */
export function openDirectory(path: string): OpenedDirectory | 'absent' | 'other' {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'absent'
    if (code === 'ENOTDIR' || code === 'ELOOP') return 'other'
    throw error
  }
  const at = `/proc/self/fd/${fd}`
  try {
    const [opened, reached] = [fstatSync(fd), statSync(at)]
    if (opened.dev === reached.dev && opened.ino === reached.ino) return { fd, at }
  } catch {
    // Not reached: refused below.
  }
  closeSync(fd)
  throw new WorktreeError(`${path} cannot be reached through its descriptor (${at}); nothing is done in it`)
}

interface WorktreeRow {
  repository: string
  workflow_run_id: string
  path: string
  branch: string
  /** The worktree's administrative directory, recorded when it was added (real path). */
  gitdir: string
  created_at: string
  removed_at: string | null
  /** The `retention` decision that retires it, once the rule has decided. */
  decision: string | null
  /** Why the last attempt to retire it failed. */
  failure: string | null
  failed_at: string | null
  /** The workflow run whose work it was cut from (ADR-0061), and the commit it holds once that work is in it. */
  carried_from: string | null
  carried_commit: string | null
  /** The commit its branch was made at, or its carry cut at; null for one made before it was recorded. */
  forked_at: string | null
}

/**
 * A worktree cut to hold an earlier run's work that never got into it (ADR-0061): a crash between its
 * cut and the reading of the tree leaves its index empty, every file of its base shown as deleted, or
 * part of that tree written. What it holds is no run's work, so nothing of it is ever committed, and
 * no agent runs in it.
 */
const halfCarried = (row: WorktreeRow): boolean => row.carried_from !== null && row.carried_commit === null

export type RepositoryCheck = { repository: string } | { problem: string }

/**
 * A worktree as freeing its workflow run's agent run leaves it: planned for removal (`remove`), then
 * `removed` (with the commit that kept its changes, if any), or `kept` in place; and why.
 */
export interface WorktreeRelease {
  path: string
  branch: string
  outcome: 'remove' | 'removed' | 'kept'
  why: string
  commit?: string
}

export interface SweepOutcome {
  removed: string[]
  /** Worktrees left in place: their commit or removal failed, and the next sweep tries again. */
  kept: string[]
}

/**
 * A workflow run's worktree as the operator's listing shows it (`agent_worktrees`, `system
 * worktrees`): where it is, whether an agent run still holds it, what it holds, and when the
 * retention removes it.
 */
export interface RunWorktree {
  runId: string
  repository: string
  path: string
  branch: string
  createdAt: string
  /** When its workflow run's last agent run ended, or when it was made while none has. */
  lastActivityAt: string
  /**
   * `in-use`: an agent run of its workflow run is queued or running; `held`: one ended without being
   * known to be gone (free it: `system free`); `finished`: neither, so it may be removed.
   */
  state: 'in-use' | 'held' | 'finished'
  /**
   * `clean`: nothing uncommitted, its work is on its branch; `uncommitted`: changes not committed;
   * `gone`: no longer on disk (only its record is left); `not-intact`: its `.git` file or branch is
   * not what it was made with, so git is not run there and it is left for the operator.
   */
  changes: 'clean' | 'uncommitted' | 'gone' | 'not-intact'
  /** When the retention removes it, once finished; absent while it is in use or held, or with a retention of 0. */
  retiresAt?: string
  /** Why the last attempt to retire it failed, when one did. */
  failure?: string
}

/** A worktree as the operator's removal plans or leaves it, with its workflow run. */
export type RunWorktreeRelease = WorktreeRelease & { runId: string }

export class Worktrees {
  private readonly queues = new Map<string, Promise<unknown>>()
  private version: [number, number] | undefined

  /**
   * `root` is where worktrees go: `<root>/<repository key>/<runId>`. `regeneration` names, for a
   * repository (real path) and a worktree's stored setup hash, the files a landing may regenerate on a
   * conflict and how (./regenerate.ts, T166); none, and every conflict refuses the merge.
   */
  constructor(
    private readonly ctx: Pick<Context, 'store' | 'artifacts' | 'logger'>,
    private readonly root: string,
    private readonly regeneration?: (repository: string, setupHash: string | null) => Regeneration | undefined,
  ) {}

  /**
   * Whether `workspace` can hold a worktree per run: the top level of a git working tree with a
   * commit, outside the worktree root, with a git that can remove a worktree. Returns the
   * repository's real path, or what is wrong.
   */
  async check(workspace: string): Promise<RepositoryCheck> {
    if (!this.version) {
      const m = /(\d+)\.(\d+)/.exec(await git('/', ['--version']).catch(() => ''))
      if (!m) return { problem: 'git cannot be run' }
      this.version = [Number(m[1]), Number(m[2])]
    }
    const [major, minor] = this.version
    if (major < WORKTREE_GIT_FLOOR[0] || (major === WORKTREE_GIT_FLOOR[0] && minor < WORKTREE_GIT_FLOOR[1])) {
      return { problem: `git ${major}.${minor} cannot remove a worktree; ${WORKTREE_GIT_FLOOR.join('.')} or later is needed` }
    }
    const repository = real(workspace)
    if (!repository) return { problem: `${workspace} does not exist` }
    let top: string | undefined
    try {
      top = real((await git(repository, ['rev-parse', '--show-toplevel'])).trim())
    } catch {
      return { problem: `${workspace} is not a git working tree` }
    }
    if (top !== repository) return { problem: `${workspace} is not the top level of its git repository${top ? ` (${top} is)` : ''}` }
    try {
      await git(repository, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
    } catch {
      return { problem: `${workspace} has no commit yet` }
    }
    const root = real(this.root) ?? resolve(this.root)
    if (under(root, repository)) return { problem: `the worktree root ${this.root} lies inside ${workspace}: its worktrees would be files of the main working tree` }
    return { repository }
  }

  /**
   * Where the worktree of `runId` on the repository at `workspace` is, or where {@link acquire} adds
   * it: the stored path, else the planned one. Reads only: a run's brief names it before it exists.
   */
  pathOf(workspace: string, runId: string): string {
    const repository = real(workspace) ?? resolve(workspace)
    return this.row(repository, runId)?.path ?? join(real(this.root) ?? resolve(this.root), repositoryKey(repository), runId)
  }

  /**
   * The worktree of `runId` on `repository` (a real path from {@link check}): the stored one,
   * after checking it is still this run's, or a new one. A new one is added from the run's branch
   * when that exists (a run continued after its worktree was removed), else on a new branch from
   * the repository's HEAD. One change at a time per repository. Throws {@link WorktreeError}.
   */
  acquire(repository: string, runId: string): Promise<string> {
    if (!RUN_ID.test(runId)) return Promise.reject(new WorktreeError(`${runId} cannot name a worktree`))
    return this.exclusive(repository, async () => {
      const row = this.row(repository, runId)
      const branch = branchOf(runId)
      if (row && row.removed_at === null && existsSync(row.path)) {
        // Cut to hold an earlier run's work that never got into it (ADR-0061): no agent runs in a tree half made.
        if (halfCarried(row)) throw new WorktreeError(`${row.path} was cut to start from the work of run ${row.carried_from}, and that work is not in it; nothing runs there, and it is left for the operator`)
        await this.verify(row)
        return row.path
      }
      let path = row?.path
      if (!path) {
        mkdirSync(this.root, { recursive: true, mode: 0o700 })
        path = join(realpathSync(this.root), repositoryKey(repository), runId)
      }
      // The repository's directory is owner-only: its worktrees hold the repository's files.
      ensurePrivateDir(dirname(path))
      // Something else is there: it is never taken over.
      if (lstatSync(path, { throwIfNoEntry: false })) throw new WorktreeError(`${path} exists and is not the worktree of run ${runId}; nothing was changed`)
      const exists = await git(repository, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false)
      if (exists && row && halfCarried(row)) {
        // Retired while cut for work it never got: a retention before the put-back committed what such a tree
        // held (every file of its base deleted) on its branch, and that commit is no run's work (INV-2).
        const [tip, author, subject] = (await git(repository, ['log', '-1', '--format=%H%n%an <%ae>%n%s', `refs/heads/${branch}`])).split('\n')
        if (author === `${SYSTEM_AUTHOR.name} <${SYSTEM_AUTHOR.email}>` && subject === keptSubject(runId)) {
          throw new WorktreeError(`${branch} ends in ${tip}, the retention's commit of the worktree cut to start from the work of run ${row.carried_from}, which never got into it: that commit holds no run's work (the files it did not get are deleted), so no worktree is added from it; the branch is left for the operator`)
        }
      }
      await git(repository, exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, 'HEAD'])
      const common = real(resolve(repository, (await git(repository, ['rev-parse', '--git-common-dir'])).trim()))
      const gitdir = pointer(path)
      if (!common || !gitdir || !under(gitdir, join(common, 'worktrees'))) throw new WorktreeError(`${path} was added, and its .git file does not point into the worktrees of ${repository}; it is left for the operator`)
      // A new branch was made at the HEAD just now (one change at a time per repository); one added again keeps where it forked.
      const forkedAt = exists ? row?.forked_at ?? null : (await git(repository, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])).trim()
      // Added again, it starts over: a later retirement is a decision of its own, and its setup runs again.
      // Its branch holds what it held (the retention committed it), so it is no longer a carried tree.
      this.ctx.store.transaction((db) => {
        db.prepare(`INSERT INTO agent_worktrees (repository, workflow_run_id, path, branch, gitdir, created_at, removed_at, decision, failure, failed_at, forked_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
          ON CONFLICT (repository, workflow_run_id) DO UPDATE SET path = excluded.path, branch = excluded.branch, gitdir = excluded.gitdir, created_at = excluded.created_at,
          removed_at = NULL, decision = NULL, failure = NULL, failed_at = NULL, setup_hash = NULL, setup_decision = NULL, carried_from = NULL, carried_commit = NULL, forked_at = excluded.forked_at`).run(repository, runId, path, branch, gitdir, new Date().toISOString(), forkedAt)
      })
      this.ctx.logger.info(`agent Workers: run ${runId} works in ${path} on ${branch}, ${exists ? 'added again from that branch' : `branched from the HEAD of ${repository}`}`)
      return path
    })
  }

  /**
   * Write a brief's files into a run's worktree before its agent starts (`brief@1.2` `files`, such
   * as the board's `TASKS.md`): each under `.system/`, whose own `.gitignore` (`*`) makes git ignore
   * the directory, so no file of it is ever part of the worktree's subject, a review's diff, or the
   * retention commit. Each file is written read-only (0444) and replaced whole on the next write;
   * edits are never read back. Refused, with nothing reaching the agent, when the worktree is not
   * intact, the repository tracks anything under `.system/`, or `.system` (or a file in it) is not
   * a plain directory (or file) of the worktree: a link is never followed out of the workspace.
   * `.system` is opened once, as itself, and every file is written relative to that descriptor
   * ({@link openDirectory}), so nothing is checked by name before it is used.
   *
   * The directory then holds exactly this brief's files (T267): a file an earlier run's brief placed
   * there and this one's does not name (the dossier an author's step was given, say) is removed before
   * the agent starts, so a step whose brief places none (an author's fresh-context self-review) finds
   * none. Called for every run in a worktree of its own, with no files too.
   */
  async place(workspace: string, files: ReadonlyArray<{ path: string; text: string }>): Promise<void> {
    const dir = join(workspace, '.system')
    // With no file to place and no `.system` there, nothing is to be done (lstat never follows a link).
    if (!files.length && !lexists(dir)) return
    const row = this.ctx.store.db.prepare('SELECT gitdir FROM agent_worktrees WHERE path = ? AND removed_at IS NULL').get(workspace) as { gitdir: string } | undefined
    if (!row || pointer(workspace) !== row.gitdir) throw new WorktreeError(`${workspace} is not an intact worktree of a run; no file is written there`)
    for (const file of files) if (!BRIEF_FILE_PATH.test(file.path)) throw new WorktreeError(`${JSON.stringify(file.path)} is not a file under .system/; nothing is written`)
    const tracked = await git(workspace, [`--git-dir=${row.gitdir}`, `--work-tree=${workspace}`, 'ls-files', '-z', '--', '.system'])
    // A `.system` the repository tracks is its own, never system's: with nothing to place, nothing of system's is there to remove.
    if (tracked.length && !files.length) return
    if (tracked.length) throw new WorktreeError(`the repository tracks files under .system/ (${tracked.split('\0')[0]}); system's workspace files would change them, so none is written`)
    // Made when absent (mkdir never follows a link at its name), then opened as itself.
    try {
      mkdirSync(dir, { mode: 0o755 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const opened = openDirectory(dir)
    if (typeof opened === 'string') throw new WorktreeError(`${dir} is not a directory of the worktree; nothing is written`)
    try {
      // What an earlier brief left and this one does not name goes first: only this run's files stay.
      const keep = new Set(['.gitignore', ...files.map((f) => f.path.slice('.system/'.length))])
      for (const name of readdirSync(opened.at)) {
        if (keep.has(name)) continue
        const path = join(opened.at, name)
        if (lstatSync(path).isDirectory()) throw new WorktreeError(`${join(dir, name)} is a directory, never one system placed; nothing is written`)
        rmSync(path, { force: true })
      }
      for (const [name, text] of [['.gitignore', '# Written by system: this directory is never part of the work.\n*\n'], ...files.map((f) => [f.path.slice('.system/'.length), f.text])] as const) {
        const path = join(opened.at, name)
        if (notPlainFile(path)) throw new WorktreeError(`${join(dir, name)} is not a plain file; nothing more is written`)
        // Written whole beside it, never through a link (O_NOFOLLOW, O_EXCL), read-only to the agent,
        // then renamed over it: a rename replaces whatever is there by then (a link included) and
        // never follows it.
        const temporary = join(opened.at, `.${name}.${randomUUID()}.tmp`)
        const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o444)
        try {
          try {
            writeSync(fd, text)
          } finally {
            closeSync(fd)
          }
          renameSync(temporary, path)
        } catch (error) {
          rmSync(temporary, { force: true })
          throw error
        }
      }
    } finally {
      closeSync(opened.fd)
    }
  }

  /**
   * Whether `workspace` is still the worktree it was created as: its `.git` file points to the
   * administrative directory recorded for it. An agent can write that file; when it points
   * elsewhere, git must not run in the worktree (another configuration could run commands).
   */
  intact(workspace: string): boolean {
    const row = this.ctx.store.db.prepare('SELECT gitdir FROM agent_worktrees WHERE path = ? AND removed_at IS NULL').get(workspace) as { gitdir: string } | undefined
    return !!row && pointer(workspace) === row.gitdir
  }

  /**
   * Retire the worktrees whose workflow run has no agent run left to finish and whose last agent
   * run ended more than `retentionHours` before `at`: commit their changes on their branch, then
   * remove them. At most {@link SWEEP_BATCH} a sweep; one whose last attempt failed comes after
   * the others.
   */
  async sweep(retentionHours: number, at: number, stopped: AbortSignal): Promise<SweepOutcome> {
    const outcome: SweepOutcome = { removed: [], kept: [] }
    const cutoff = new Date(at - retentionHours * 60 * 60_000).toISOString()
    const due = this.ctx.store.db.prepare(`SELECT * FROM agent_worktrees w WHERE removed_at IS NULL AND ${IDLE}
      ORDER BY failed_at IS NOT NULL, failed_at, created_at LIMIT ?`).all(null, cutoff, SWEEP_BATCH) as unknown as WorktreeRow[]
    for (const candidate of due) {
      if (stopped.aborted) break
      await this.exclusive(candidate.repository, async () => {
        // Looked at again alone: a run of the workflow run may have taken the worktree meanwhile.
        const row = this.ctx.store.db.prepare(`SELECT * FROM agent_worktrees w WHERE repository = ? AND workflow_run_id = ? AND removed_at IS NULL AND ${IDLE}`)
          .get(candidate.repository, candidate.workflow_run_id, null, cutoff) as WorktreeRow | undefined
        if (!row) return
        try {
          // Decided once: a worktree that stays in place is retried under the same decision.
          const decision = row.decision ?? this.decide(row, retentionHours)
          const commit = await this.retire(row)
          this.ctx.store.transaction((db) => {
            db.prepare('UPDATE agent_worktrees SET removed_at = ?, failure = NULL, failed_at = NULL WHERE repository = ? AND workflow_run_id = ?').run(new Date().toISOString(), row.repository, row.workflow_run_id)
          })
          outcome.removed.push(row.path)
          this.ctx.logger.info(`agent Workers: removed the worktree ${row.path} of run ${row.workflow_run_id} (decision ${decision})${commit ? `, its changes committed on ${row.branch} as ${commit}` : ''}; the branch stays`)
        } catch (error) {
          const failure = (error as Error).message.slice(0, 500)
          this.ctx.store.transaction((db) => {
            db.prepare('UPDATE agent_worktrees SET failure = ?, failed_at = ? WHERE repository = ? AND workflow_run_id = ?').run(failure, new Date().toISOString(), row.repository, row.workflow_run_id)
          })
          outcome.kept.push(row.path)
          // Said once per reason: the next sweep tries again, quietly while nothing changed.
          if (failure !== row.failure) this.ctx.logger.warn(`agent Workers: the worktree ${row.path} of run ${row.workflow_run_id} stays in place: ${failure}`)
        }
      })
    }
    return outcome
  }

  /**
   * The worktrees of a workflow run, not removed: what an agent run of it holds, by path and branch.
   */
  of(workflowRunId: string): Array<{ path: string; branch: string }> {
    return this.ctx.store.db.prepare('SELECT path, branch FROM agent_worktrees WHERE workflow_run_id = ? AND removed_at IS NULL ORDER BY path').all(workflowRunId) as Array<{ path: string; branch: string }>
  }

  /**
   * What freeing a workflow run's worktrees would do now, before the operator's decision is recorded
   * (INV-13): each one is removed only while its workflow run has no agent run left to finish and none
   * not known to be gone, and only when it holds nothing uncommitted, or `commit` says its changes are
   * committed on its branch first (as the retention does). Otherwise it stays, and why.
   */
  async plan(workflowRunId: string, commit: boolean, freeing: string): Promise<WorktreeRelease[]> {
    const plans: WorktreeRelease[] = []
    for (const row of this.ctx.store.db.prepare('SELECT * FROM agent_worktrees WHERE workflow_run_id = ? AND removed_at IS NULL ORDER BY path').all(workflowRunId) as unknown as WorktreeRow[]) {
      plans.push(await this.exclusive(row.repository, () => this.planSafely(row, commit, freeing)))
    }
    return plans
  }

  /**
   * The worktrees not removed, oldest first, at most `limit`, each with its state, what it holds, and
   * when the retention removes it (`retentionHours`, 0: never); and how many there are in all. Reads
   * only: git runs in a worktree only while it is intact, one repository at a time.
   */
  async list(retentionHours: number, limit: number): Promise<{ worktrees: RunWorktree[]; total: number }> {
    const total = Number((this.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM agent_worktrees WHERE removed_at IS NULL').get() as { n: number }).n)
    const rows = this.ctx.store.db.prepare(`SELECT w.*,
      EXISTS (SELECT 1 FROM agent_runs r WHERE r.workflow_run_id = w.workflow_run_id AND r.status IN ('queued', 'running')) AS busy,
      EXISTS (SELECT 1 FROM agent_runs r WHERE r.workflow_run_id = w.workflow_run_id AND r.status NOT IN ('queued', 'running') AND ${notKnownGone('r.')}) AS held,
      COALESCE((SELECT MAX(r.updated_at) FROM agent_runs r WHERE r.workflow_run_id = w.workflow_run_id), w.created_at) AS last
      FROM agent_worktrees w WHERE removed_at IS NULL ORDER BY created_at, workflow_run_id LIMIT ?`).all(limit) as unknown as Array<WorktreeRow & { busy: number; held: number; last: string }>
    const worktrees: RunWorktree[] = []
    for (const row of rows) {
      const state = row.busy ? 'in-use' : row.held ? 'held' : 'finished'
      worktrees.push({
        runId: row.workflow_run_id, repository: row.repository, path: row.path, branch: row.branch, createdAt: row.created_at, lastActivityAt: row.last, state,
        changes: await this.exclusive(row.repository, () => this.changesOf(row)),
        ...(state === 'finished' && retentionHours > 0 ? { retiresAt: new Date(Date.parse(row.last) + retentionHours * 60 * 60_000).toISOString() } : {}),
        ...(row.failure ? { failure: row.failure } : {}),
      })
    }
    return { worktrees, total }
  }

  /**
   * What the operator's removal of finished worktrees would do now (`agent_worktrees_remove`), before
   * their decision is recorded (INV-13): every worktree not removed, or those of workflow run `runId`,
   * oldest first, at most {@link SWEEP_BATCH}, each planned as {@link plan} plans it with no run
   * excepted, so one in use or held stays; and how many were left for a later call.
   */
  async planRemoval(runId: string | undefined, commit: boolean): Promise<{ plans: RunWorktreeRelease[]; more: number }> {
    const where = runId === undefined ? 'removed_at IS NULL' : 'removed_at IS NULL AND workflow_run_id = ?'
    const args = runId === undefined ? [] : [runId]
    const total = Number((this.ctx.store.db.prepare(`SELECT COUNT(*) AS n FROM agent_worktrees WHERE ${where}`).get(...args) as { n: number }).n)
    const rows = this.ctx.store.db.prepare(`SELECT * FROM agent_worktrees WHERE ${where} ORDER BY created_at, workflow_run_id LIMIT ?`).all(...args, SWEEP_BATCH) as unknown as WorktreeRow[]
    const plans: RunWorktreeRelease[] = []
    for (const row of rows) plans.push({ runId: row.workflow_run_id, ...await this.exclusive(row.repository, () => this.planSafely(row, commit, null)) })
    return { plans, more: total - rows.length }
  }

  /** {@link planOne}, one that git cannot look at kept with why: it never fails the others (T250). */
  private async planSafely(row: WorktreeRow, commit: boolean, freeing: string | null): Promise<WorktreeRelease> {
    try {
      return await this.planOne(row, commit, freeing)
    } catch (error) {
      return { path: row.path, branch: row.branch, outcome: 'kept', why: `git could not look at it, so it stays: ${(error as Error).message.slice(0, 300)}` }
    }
  }

  /** What a worktree holds, as {@link RunWorktree.changes} says it; git runs only in an intact one. */
  private async changesOf(row: WorktreeRow): Promise<RunWorktree['changes']> {
    if (!existsSync(row.path)) return 'gone'
    try {
      await this.verify(row)
    } catch {
      return 'not-intact'
    }
    const pending = await git(row.path, [`--git-dir=${row.gitdir}`, `--work-tree=${row.path}`, 'status', '--porcelain', '--untracked-files=all']).catch(() => undefined)
    return pending === undefined ? 'not-intact' : pending.trim() ? 'uncommitted' : 'clean'
  }

  /** {@link plan} of one worktree, `freeing` the agent run the operator frees (not counted as holding it), or none. */
  private async planOne(row: WorktreeRow, commit: boolean, freeing: string | null): Promise<WorktreeRelease> {
    const base = { path: row.path, branch: row.branch }
    if (!this.ctx.store.db.prepare(`SELECT 1 FROM agent_worktrees w WHERE repository = ? AND workflow_run_id = ? AND ${FREE}`).get(row.repository, row.workflow_run_id, freeing)) {
      return {
        ...base, outcome: 'kept',
        why: freeing === null
          ? `an agent run of workflow run ${row.workflow_run_id} is unfinished, or ended without being known to be gone (free it first: system free), so its worktree stays`
          : `another agent run of workflow run ${row.workflow_run_id} is unfinished or not known to be gone, so its worktree stays`,
      }
    }
    if (!existsSync(row.path)) return { ...base, outcome: 'remove', why: 'it is gone from disk already: only its record is closed' }
    try {
      await this.verify(row)
    } catch (error) {
      return { ...base, outcome: 'kept', why: (error as Error).message }
    }
    // What it holds is no run's work: never committed, with or without the commit flag (ADR-0061).
    if (halfCarried(row)) return { ...base, outcome: 'remove', why: `it was cut to start from the work of run ${row.carried_from}, which never got into it, so it holds no run's work: it is put back to its base, nothing of it is committed, and it is removed; its branch stays` }
    const pending = (await git(row.path, [`--git-dir=${row.gitdir}`, `--work-tree=${row.path}`, 'status', '--porcelain', '--untracked-files=all'])).trim()
    if (!pending) return { ...base, outcome: 'remove', why: 'it holds nothing uncommitted: it is removed, and its branch stays' }
    if (commit) return { ...base, outcome: 'remove', why: `its uncommitted changes are committed on ${row.branch}, which stays, then it is removed` }
    return { ...base, outcome: 'kept', why: `it holds uncommitted changes, so it stays (the retention commits them on ${row.branch} and removes it; or ${freeing === null ? 'remove it again with the commit flag' : 'free again with the commit flag'})` }
  }

  /**
   * Carry out a plan the operator's `decision` recorded: each worktree planned for removal is looked
   * at again alone, then committed (when `commit`) and removed as the retention does, the decision
   * stored on its row; one whose state changed since, or that git cannot remove, stays, and why.
   */
  async release(workflowRunId: string, decision: string, commit: boolean, plans: readonly WorktreeRelease[], freeing: string | null): Promise<WorktreeRelease[]> {
    const done: WorktreeRelease[] = []
    for (const plan of plans) {
      const row = this.ctx.store.db.prepare('SELECT * FROM agent_worktrees WHERE workflow_run_id = ? AND path = ? AND removed_at IS NULL').get(workflowRunId, plan.path) as WorktreeRow | undefined
      if (plan.outcome !== 'remove' || !row) {
        done.push(plan.outcome === 'remove' ? { ...plan, outcome: 'kept', why: 'it was removed or replaced meanwhile' } : plan)
        continue
      }
      done.push(await this.exclusive(row.repository, async (): Promise<WorktreeRelease> => {
        const again = await this.planSafely(row, commit, freeing)
        if (again.outcome !== 'remove') return again
        try {
          const committed = await this.retire(row)
          this.ctx.store.transaction((db) => {
            db.prepare('UPDATE agent_worktrees SET removed_at = ?, decision = ?, failure = NULL, failed_at = NULL WHERE repository = ? AND workflow_run_id = ?').run(new Date().toISOString(), decision, row.repository, row.workflow_run_id)
          })
          this.ctx.logger.info(`agent Workers: removed the worktree ${row.path} of run ${row.workflow_run_id} (the operator's decision ${decision})${committed ? `, its changes committed on ${row.branch} as ${committed}` : ''}; the branch stays`)
          return { path: row.path, branch: row.branch, outcome: 'removed', why: again.why, ...(committed ? { commit: committed } : {}) }
        } catch (error) {
          return { path: row.path, branch: row.branch, outcome: 'kept', why: `git could not remove it, so it stays for the retention: ${(error as Error).message.slice(0, 300)}` }
        }
      }))
    }
    return done
  }

  /**
   * One step of landing an accepted result made in the worktree `step.workspace` of workflow run
   * `step.runId` (ADR-0060); undefined when no worktree of this source is that one. One change at a
   * time per repository, as every worktree change. Each step checks first that its own work is not
   * done already, so a step repeated after a restart says so instead of doing it twice (INV-4).
   */
  async land(step: LandStep): Promise<Landed | undefined> {
    const row = this.ctx.store.db.prepare('SELECT * FROM agent_worktrees WHERE workflow_run_id = ? AND path = ?').get(step.runId, step.workspace) as WorktreeRow | undefined
    if (!row) return undefined
    return this.exclusive(row.repository, () => (step.step === 'commit' ? this.commitAccepted(row, step) : step.step === 'record' ? this.record(row, step)
      : step.step === 'merge' ? this.merge(row, step) : this.rebase(row, step)))
  }

  /**
   * Keep the worktree's tree, while it is exactly `step.subject`, as a commit on the run's review
   * history ref (board T232, {@link reviewRef}): on top of the last commit there, else the worktree's
   * HEAD. Built in an index of its own, so the worktree's HEAD, branch, index, and files stay as they
   * are, and a board task bound to the HEAD still binds the run's result. The tree is read again after
   * the commit is made: a tree that moved meanwhile moves no ref. The system's `.system/` files are
   * left out, as a landing's commit leaves them. No commit when the last one recorded, or the HEAD
   * with nothing on top, already holds the tree (INV-4).
   */
  private async record(row: WorktreeRow, step: Extract<LandStep, { step: 'record' }>): Promise<Landed> {
    const wanted = subjectId({ type: 'git-head', ...step.subject })
    if (row.removed_at !== null || !existsSync(row.path)) return { outcome: 'refused', cause: 'gone', reason: `the worktree ${row.path} was removed, so the tree ${wanted} can no longer be recorded` }
    try {
      await this.verify(row)
    } catch (error) {
      return { outcome: 'refused', cause: 'failed', reason: (error as Error).message }
    }
    const still = (): boolean => {
      const now = captureGitSubject(row.path)?.subject
      return now?.ref === step.subject.ref && now.version === step.subject.version
    }
    if (!still()) return { outcome: 'refused', cause: 'moved', reason: `the worktree ${row.path} is no longer ${wanted}, so it is not recorded` }
    const ref = reviewRef(step.runId)
    const scratch = mkdtempSync(join(tmpdir(), 'system-record-'))
    try {
      const inside = (args: string[], env: Record<string, string> = {}): Promise<string> => git(row.path, [`--git-dir=${row.gitdir}`, `--work-tree=${row.path}`, ...args], env)
      const index = { GIT_INDEX_FILE: join(scratch, 'index') }
      const tip = (await inside(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => '')).trim()
      const head = (await inside(['rev-parse', 'HEAD'])).trim()
      await inside(['read-tree', 'HEAD'], index)
      const own = !(await inside(['ls-files', '-z', '--', '.system'], index)).length
      await inside(['add', '--all', '--', '.', ...(own ? [':(exclude).system'] : [])], index)
      const tree = (await inside(['write-tree'], index)).trim()
      const parent = tip || head
      if ((await inside(['rev-parse', `${parent}^{tree}`])).trim() === tree) {
        return { outcome: 'recorded', repository: row.repository, ref, commit: parent, parent, recorded: false }
      }
      const commit = (await inside(['commit-tree', tree, '-p', parent, '-m', `${step.message.trimEnd()}\n\n${SUBJECT_TRAILER}: ${wanted}`])).trim()
      if (!still()) return { outcome: 'refused', cause: 'moved', reason: `the worktree ${row.path} changed while ${wanted} was recorded, so no ref moved` }
      // Only from the tip read above: a ref another step moved meanwhile is not overwritten.
      await inside(['update-ref', '-m', `system: record ${wanted}`, ref, commit, ...(tip ? [tip] : [])])
      return { outcome: 'recorded', repository: row.repository, ref, commit, parent, recorded: true }
    } catch (error) {
      return { outcome: 'refused', cause: 'failed', reason: (error as Error).message }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  /**
   * The worktree `workspace` of workflow run `runId` as a run's checks find it (T151): undefined
   * when no worktree of this source is that one; else its repository and its setup's hash, when it
   * is intact, no agent run of its workflow run is unfinished or not known to be gone (INV-15), and
   * it is exactly `subject` now (INV-5); else why not. Read only.
   */
  async checkable(runId: string, workspace: string, subject: { ref: string; version: string }): Promise<undefined | { repository: string; path: string; setupHash: string | null } | { cause: 'moved' | 'gone' | 'busy' | 'failed'; reason: string }> {
    const row = this.ctx.store.db.prepare('SELECT * FROM agent_worktrees WHERE workflow_run_id = ? AND path = ?').get(runId, workspace) as (WorktreeRow & { setup_hash?: string | null }) | undefined
    if (!row) return undefined
    const tree = subjectId({ type: 'git-head', ...subject })
    if (row.removed_at !== null || !existsSync(row.path)) return { cause: 'gone', reason: `the worktree ${row.path} was removed, so the tree ${tree} can no longer be checked` }
    if (!this.ctx.store.db.prepare(`SELECT 1 FROM agent_worktrees w WHERE repository = ? AND workflow_run_id = ? AND ${FREE}`).get(row.repository, row.workflow_run_id, null)) {
      return { cause: 'busy', reason: `an agent run of workflow run ${row.workflow_run_id} is unfinished or not known to be gone, so it may still write ${row.path} (INV-15)` }
    }
    try {
      await this.verify(row)
    } catch (error) {
      return { cause: 'failed', reason: (error as Error).message }
    }
    const current = captureGitSubject(row.path)
    if (!current) return { cause: 'failed', reason: `${row.path} is no longer a git working tree` }
    if (current.subject.ref !== subject.ref || current.subject.version !== subject.version) return { cause: 'moved', reason: `the worktree ${row.path} is now ${subjectId(current.subject)}, not ${tree}, the tree the result is on` }
    return { repository: row.repository, path: row.path, setupHash: row.setup_hash ?? null }
  }

  /**
   * The change of workflow run `runId` in each of its worktrees (T122), read only: what the worktree
   * holds against the commit it forked from on the repository's checked-out branch, committed or
   * not, untracked files as added; a removed worktree's from its branch. Once its branch is merged
   * into the base, against the commit it was cut at, as recorded. git reads through the worktree's
   * own administrative directory, with no optional lock, hook, or external diff. Bounded as it reads
   * (INV-9): git's output is read as it comes and only what {@link CHANGE_BOUNDS} shows is kept, the
   * rest counted or passed over, and an untracked file is read only while the bounds leave room for
   * it, asynchronously, through descriptors opened one directory at a time from the worktree's own,
   * never through a link. Undefined when this source holds no worktree of the run; a worktree that
   * cannot be read throws.
   */
  async changes(runId: string): Promise<WorkChange[] | undefined> {
    const rows = this.ctx.store.db.prepare('SELECT * FROM agent_worktrees WHERE workflow_run_id = ? ORDER BY repository').all(runId) as unknown as WorktreeRow[]
    if (!rows.length) return undefined
    const changes: WorkChange[] = []
    for (const row of rows) changes.push(await this.changeOf(row))
    return changes
  }

  private async changeOf(row: WorktreeRow): Promise<WorkChange> {
    const base = await this.baseOf(row.repository)
    if ('problem' in base) throw new WorktreeError(`the change of ${row.path} cannot be read: ${base.problem}`)
    const READ = ['--no-optional-locks']
    const DIFF = ['-M', '--no-color', '--no-ext-diff', '--no-textconv']
    const live = row.removed_at === null && existsSync(row.path)
    let head: string
    let inside: string[]
    let dir: string
    if (live) {
      await this.verify(row)
      dir = row.path
      inside = [...READ, `--git-dir=${row.gitdir}`, `--work-tree=${row.path}`]
      head = (await git(dir, [...inside, 'rev-parse', 'HEAD'])).trim()
    } else {
      dir = row.repository
      inside = READ
      head = (await git(dir, [...inside, 'rev-parse', '--verify', `refs/heads/${row.branch}^{commit}`])).trim()
    }
    const fork = await this.forkOf(row, base, head)
    const against = live ? [fork] : [fork, head]
    // Paths named as the diff headers are matched against (quoted), whatever the repository's own configuration says.
    const run = (args: string[], take: (text: string) => boolean): Promise<{ stopped: boolean }> => gitRead(dir, [...inside, '-c', 'core.quotePath=true', ...args], take)

    // One diff queue, read three ways: name and status (every file counted, the first ones kept),
    // lines (of the files kept), and the patch (the blocks of the files kept, each to its bound).
    const tracked: Array<{ code: string; from?: string; path: string }> = []
    let trackedCount = 0
    let entry: string[] = []
    await run(['diff', ...DIFF, '--name-status', '-z', ...against], fields((value) => {
      if (!entry.length && !value) return false
      entry.push(value)
      if (entry.length === (/^[RC]/.test(entry[0]!) ? 3 : 2)) {
        const [code, a, b] = entry as [string, string, string | undefined]
        if (tracked.length < CHANGE_BOUNDS.files) tracked.push(b === undefined ? { code, path: a } : { code, from: a, path: b })
        trackedCount++
        entry = []
      }
      return false
    }))
    const key = (from: string | undefined, path: string): string => `${from ?? ''}\0${path}`
    // numstat -z: "added\tremoved\tpath", or, for a rename, "added\tremoved\t" then from and to.
    const counts = new Map<string, [string, string]>()
    let pending: { counts: [string, string]; names: string[] } | undefined
    if (tracked.length) {
      await run(['diff', ...DIFF, '--numstat', '-z', ...against], fields((value) => {
        if (pending) {
          pending.names.push(value)
          if (pending.names.length === 2) {
            counts.set(key(pending.names[0], pending.names[1]!), pending.counts)
            pending = undefined
          }
        } else if (value) {
          const [added = '', removed = '', ...rest] = value.split('\t')
          const path = rest.join('\t')
          if (path) counts.set(key(undefined, path), [added, removed])
          else pending = { counts: [added, removed], names: [] }
        }
        return counts.size >= tracked.length
      }))
    }
    // Enough of the patch once every kept file's block is in, or once the blocks kept fill what a page
    // shows (`full`: the blocks after them lie past the bounds, and are not read).
    let full = false
    const blocks = patchBlocks(CHANGE_BOUNDS.fileChars + 1, (done) => done.length >= tracked.length
      || (full = done.reduce((n, b) => n + Math.min(b.length, CHANGE_BOUNDS.fileChars), 0) >= CHANGE_BOUNDS.totalChars))
    if (tracked.length) await run(['diff', ...DIFF, '--src-prefix=a/', '--dst-prefix=b/', ...against], blocks.take)
    // Each block is its file's by its own `diff --git` line, never by its place in the patch.
    const byHeader = new Map<string, string>()
    for (const block of blocks.end()) {
      const header = block.slice(0, block.indexOf('\n') === -1 ? block.length : block.indexOf('\n'))
      if (!byHeader.has(header)) byHeader.set(header, block)
    }

    const untracked: string[] = []
    let untrackedCount = 0
    if (live) {
      await run(['ls-files', '--others', '--exclude-standard', '-z'], fields((path) => {
        if (!path) return false
        if (tracked.length + untracked.length < CHANGE_BOUNDS.files) untracked.push(path)
        untrackedCount++
        return false
      }))
    }

    let total = 0
    let truncated = false
    const room = (): number => Math.min(CHANGE_BOUNDS.fileChars, CHANGE_BOUNDS.totalChars - total)
    // A diff within what is left: cut at it, and counted.
    const fit = (file: ChangedFile, diff: string): ChangedFile => {
      const left = room()
      if (left <= 0) {
        truncated = true
        const { diff: _, ...rest } = file
        return { ...rest, truncated: true }
      }
      const cut = diff.length > left
      total += Math.min(diff.length, left)
      if (cut || file.truncated) truncated = true
      return { ...file, diff: cut ? diff.slice(0, left) : diff, ...(cut ? { truncated: true } : {}) }
    }
    const files: ChangedFile[] = []
    for (const { code, from, path } of tracked) {
      const numbers = counts.get(key(from, path))
      const binary = numbers?.[0] === '-'
      const file: ChangedFile = {
        path, status: code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : from !== undefined ? 'renamed' : 'modified', ...(from !== undefined ? { from } : {}),
        ...(binary ? { binary: true as const } : numbers ? { added: Number(numbers[0]) || 0, removed: Number(numbers[1]) || 0 } : {}),
      }
      if (binary) {
        files.push(file)
        continue
      }
      const block = byHeader.get(`${DIFF_HEADER}${quotedPath(`a/${from ?? path}`)} ${quotedPath(`b/${path}`)}`)
      // A block kept to its cap stays longer than a file's bound, so it reads as cut.
      if (block !== undefined) files.push(fit(file, block.length > CHANGE_BOUNDS.fileChars ? block : block.trimEnd()))
      // The patch was read only up to the bounds: this file's block lies past them.
      else if (full) {
        truncated = true
        files.push({ ...file, truncated: true })
      } else files.push({ ...file, note: 'git gave no diff for it' })
    }
    if (untracked.length) {
      const root = openDirectory(row.path)
      if (typeof root === 'string') throw new WorktreeError(`${row.path} is no longer a directory of its own; its untracked files are not read`)
      try {
        for (const path of untracked) {
          if (room() <= 0) {
            truncated = true
            files.push({ path, status: 'added', truncated: true })
            continue
          }
          const file = await this.untracked(root, path, room())
          files.push(file.diff === undefined ? file : fit(file, file.diff))
        }
      } finally {
        closeSync(root.fd)
      }
    }
    const more = trackedCount + untrackedCount - files.length
    return { repository: row.repository, workspace: row.path, branch: row.branch, base: { branch: base.branch, sha: fork }, head, files, more, truncated: truncated || more > 0, ...(live ? {} : { fromBranch: true as const }) }
  }

  /**
   * The commit a run's change is read against: where its head meets the base branch, while its head is
   * not in the base (so a base merged into the branch is not the run's change); once it is (its branch
   * was merged), the commit the worktree was cut at, as recorded. A worktree made before that was
   * recorded, whose head the base has moved past, cannot tell its change from what was merged: it throws,
   * never reads as no change (INV-2).
   */
  private async forkOf(row: WorktreeRow, base: { branch: string; sha: string }, head: string): Promise<string> {
    const meets = (await git(row.repository, ['--no-optional-locks', 'merge-base', base.sha, head])).trim()
    if (meets !== head) return meets
    if (row.forked_at) return row.forked_at
    if (head === base.sha) return head
    throw new WorktreeError(`${row.branch} is already in ${base.branch}, and the commit its worktree was cut at was not recorded (it was made before that was), so the change of run ${row.workflow_run_id} cannot be told from what ${base.branch} holds`)
  }

  /**
   * An untracked file of a worktree as an added file, its first `room` characters at most: read
   * asynchronously, through a descriptor opened relative to its directory's, each directory opened as
   * itself relative to the one before it from the worktree's own (`root`), so nothing on its path is
   * ever a link followed (O_NOFOLLOW at each step) or a name looked up again. A link, or anything that
   * is not a regular file, is named and not read.
   */
  private async untracked(root: OpenedDirectory, path: string, room: number): Promise<ChangedFile> {
    const names = path.split('/')
    if (names.some((name) => !name || name === '.' || name === '..')) return { path, status: 'added', note: 'outside the worktree, not read' }
    const opened: FileHandle[] = []
    try {
      let at = root.at
      for (const name of names.slice(0, -1)) {
        try {
          opened.push(await open(join(at, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW))
        } catch {
          return { path, status: 'added', note: 'in a directory that is a link or cannot be opened, not read' }
        }
        at = `/proc/self/fd/${opened.at(-1)!.fd}`
      }
      let file: FileHandle
      try {
        file = await open(join(at, names.at(-1)!), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY)
      } catch {
        return { path, status: 'added', note: 'a link or a file that cannot be opened, not read' }
      }
      opened.push(file)
      const stat = await file.stat()
      if (!stat.isFile()) return { path, status: 'added', note: 'not a regular file, not read' }
      const size = Math.min(stat.size, Math.min(room, CHANGE_BOUNDS.fileChars) + 1)
      const buffer = Buffer.alloc(size)
      const read = size ? (await file.read(buffer, 0, size, 0)).bytesRead : 0
      const bytes = buffer.subarray(0, read)
      if (bytes.includes(0)) return { path, status: 'added', binary: true }
      const lines = bytes.toString('utf8').split('\n')
      if (lines.at(-1) === '') lines.pop()
      return { path, status: 'added', added: lines.length, removed: 0,
        diff: `new file ${path} (untracked)\n${lines.map((l) => `+${l}`).join('\n')}`, ...(stat.size > read ? { truncated: true } : {}) }
    } finally {
      await Promise.all(opened.map((handle) => handle.close()))
    }
  }

  /**
   * Start the worktree of workflow run `step.runId` from the earlier run's tree at `step.from.workspace`
   * (ADR-0061); undefined when no worktree of this source is that one. One change at a time per
   * repository, as every worktree change:
   *
   * - the earlier worktree is committed on its branch, as the retention commits it, only while no
   *   agent run of its workflow run is unfinished or not known to be gone (INV-15), while it is intact,
   *   and while it is still exactly `step.from.subject`, the tree its writing step left (INV-5);
   *   A commit the system made of exactly that subject (a carry's before a restart, or the commit that
   *   kept it as its attempt's result, T271) is taken as it is;
   * - only while the commit the task writes now (`step.onto`) is the repository's HEAD, where a fresh
   *   worktree is cut from;
   * - the new worktree is added on the run's branch at the HEAD and given the change replayed there
   *   (a three-way merge of the trees), staged, so its subject is the HEAD with the earlier change on
   *   top; when the replay conflicts, at the change's own base, the conflicting files named (T271).
   *
   * Each step checks first that its work is not done already, so a carry repeated after a restart says
   * so instead of doing it twice (INV-4). Nothing is forced, reset, deleted, or pushed.
   */
  async carry(step: CarryStep): Promise<Carried | undefined> {
    const from = this.ctx.store.db.prepare('SELECT * FROM agent_worktrees WHERE workflow_run_id = ? AND path = ?').get(step.from.runId, step.from.workspace) as WorktreeRow | undefined
    if (!from) return undefined
    return this.exclusive(from.repository, () => this.carryFrom(from, step))
  }

  private async carryFrom(from: WorktreeRow, step: CarryStep): Promise<Carried> {
    const { repository } = from
    const base = step.from.subject.ref
    if (!RUN_ID.test(step.runId)) return { outcome: 'refused', cause: 'failed', reason: `${step.runId} cannot name a worktree` }
    const earlier = this.row(repository, step.runId)
    if (earlier && earlier.removed_at === null) {
      if (earlier.carried_from !== from.workflow_run_id) return { outcome: 'refused', cause: 'exists', reason: `run ${step.runId} already has the worktree ${earlier.path}, cut from the HEAD of ${repository}: it is not cut again` }
      // Carried before a restart: done.
      if (earlier.carried_commit) {
        try {
          await this.verify(earlier)
        } catch (error) {
          return { outcome: 'refused', cause: 'failed', reason: (error as Error).message }
        }
        // What the move of HEAD did is said again as the carry first said it (INV-4): derived from where the worktree was cut.
        const rebase = await this.movedAt(repository, base, earlier.forked_at ?? base, step, earlier.carried_commit)
        return { outcome: 'carried', repository, from: { branch: from.branch, commit: earlier.carried_commit }, base: earlier.forked_at ?? base, branch: earlier.branch, worktree: earlier.path, carried: false, ...(rebase ? { rebase } : {}) }
      }
    }
    let carried: Carried | undefined
    try {
      carried = await this.carryInto(from, step)
    } finally {
      // Cut for the work and never given it (a failure, or a restart that finds the work can no longer be given): made fresh again.
      const cut = this.row(repository, step.runId)
      if (carried?.outcome !== 'carried' && cut && cut.removed_at === null && cut.carried_from === from.workflow_run_id && !cut.carried_commit) {
        await this.putBack(cut).catch((error: unknown) => this.ctx.logger.warn(`agent Workers: ${(error as Error).message}`))
      }
    }
    return carried
  }

  /** {@link carryFrom}'s work: the earlier tree checked and committed, the run's worktree cut (unless a restart finds it cut) and given the tree. */
  private async carryInto(from: WorktreeRow, step: CarryStep): Promise<Carried> {
    const refuse = (cause: CarryRefusal, reason: string): Carried => ({ outcome: 'refused', cause, reason })
    const { repository } = from
    const base = step.from.subject.ref
    const subject = subjectId({ type: 'git-head', ...step.from.subject })
    // Cut before a restart and not yet given the tree: no agent has run there, so it is given it now.
    let cut = this.row(repository, step.runId)
    if (!cut || cut.removed_at !== null) cut = undefined
    if (from.removed_at !== null || !existsSync(from.path)) return refuse('gone', `the worktree ${from.path} of run ${from.workflow_run_id} was removed (its branch ${from.branch} keeps what the retention committed), so the tree ${subject} can no longer be checked`)
    if (!this.ctx.store.db.prepare(`SELECT 1 FROM agent_worktrees w WHERE repository = ? AND workflow_run_id = ? AND ${FREE}`).get(repository, from.workflow_run_id, null)) {
      return refuse('busy', `an agent run of workflow run ${from.workflow_run_id} is unfinished or not known to be gone, so it may still write ${from.path} (INV-15)`)
    }
    try {
      await this.verify(from)
    } catch (error) {
      return refuse('failed', (error as Error).message)
    }
    // A fresh worktree is cut from the repository's HEAD: the earlier work is carried onto that commit, replayed there when HEAD moved
    // since the tree's base (T271), and only while it is the commit the task writes now.
    const head = (await git(repository, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '')).trim()
    if (!cut && !head) return refuse('base-moved', `the HEAD of ${repository} is unreadable now: a fresh worktree starts from the HEAD, so the earlier work is not carried`)
    if (!cut && step.onto !== undefined && step.onto !== head) return refuse('base-moved', `the HEAD of ${repository} is ${head} now, not ${step.onto}, the commit the task writes: a fresh worktree starts from the HEAD, so the earlier work is not carried onto another base`)
    // Where the run's worktree goes, checked before anything changes: nothing there is ever taken over.
    const branch = branchOf(step.runId)
    let path = cut?.path
    if (!path) {
      if (await git(repository, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false)) return refuse('exists', `the branch ${branch} exists already, and a branch is never taken over`)
      mkdirSync(this.root, { recursive: true, mode: 0o700 })
      path = join(realpathSync(this.root), repositoryKey(repository), step.runId)
      ensurePrivateDir(dirname(path))
      if (lstatSync(path, { throwIfNoEntry: false })) return refuse('exists', `${path} exists and is not the worktree of run ${step.runId}; nothing was changed`)
    }
    const inside = (args: string[]): Promise<string> => git(from.path, [`--git-dir=${from.gitdir}`, `--work-tree=${from.path}`, ...args])
    await this.clearSystem(from, inside)
    const current = captureGitSubject(from.path)
    if (!current) return refuse('failed', `${from.path} is no longer a git working tree`)
    if (current.subject.ref === base && current.subject.version === step.from.subject.version) {
      if (!(await inside(['status', '--porcelain', '--untracked-files=all'])).trim()) return refuse('empty', `the worktree ${from.path} holds no change on ${base}: there is no work to carry`)
      await inside(['add', '--all'])
      await inside(['commit', '--quiet', '--no-verify', '-m', `${step.message.trimEnd()}\n${SUBJECT_TRAILER}: ${subject}\n${CARRIED_TRAILER}: ${step.runId}`])
      // Nothing moves the tree while the commit is made (no run of it is left, one change at a time per repository).
      if ((await inside(['status', '--porcelain', '--untracked-files=all'])).trim()) return refuse('failed', `${from.path} still holds changes after the commit on ${from.branch}; it is left for the operator`)
    } else if (!(await this.carriedCommit(inside, base, subject, step.runId))) {
      return refuse('moved', `the worktree ${from.path} is now ${subjectId(current.subject)}, not ${subject} as its writing step left it: it changed since, so its work is not carried`)
    }
    const commit = (await inside(['rev-parse', 'HEAD'])).trim()
    // Where the run's worktree is cut, and the tree it is given (T271): the commit itself on its own base; its replay on the HEAD
    // that moved since; or, when the replay conflicts, the commit on its own base, the conflict named for the Worker to resolve.
    let onto = cut?.forked_at ?? base
    let tree = commit
    let rebase: Extract<Carried, { outcome: 'carried' }>['rebase']
    if (cut ? onto !== base : head !== base) {
      // A worktree cut before a restart was cut at the commit its replay went onto: the same replay gives it the same tree.
      const target = cut ? onto : head
      const replayed = await this.replayOnto(repository, base, target, commit)
      if ('tree' in replayed) {
        onto = target
        tree = replayed.tree
        rebase = { outcome: 'rebased', from: base, onto: target }
      } else if (cut) return refuse('failed', `the work of ${from.branch} at ${commit} no longer replays on ${target}, where ${cut.path} was cut for it`)
      else rebase = { outcome: 'conflict', from: base, onto: head, files: replayed.files }
    } else if (cut) {
      // Cut at its own base before a restart: a conflict then, said again now (INV-4).
      rebase = await this.movedAt(repository, base, onto, step, commit)
    }
    if (!cut) {
      // Added on its own branch at its base, its files not checked out: the tree is read in next.
      await git(repository, ['worktree', 'add', '--no-checkout', '-b', branch, path, onto])
      const common = real(resolve(repository, (await git(repository, ['rev-parse', '--git-common-dir'])).trim()))
      const gitdir = pointer(path)
      if (!common || !gitdir || !under(gitdir, join(common, 'worktrees'))) throw new WorktreeError(`${path} was added, and its .git file does not point into the worktrees of ${repository}; it is left for the operator`)
      this.ctx.store.transaction((db) => {
        db.prepare(`INSERT INTO agent_worktrees (repository, workflow_run_id, path, branch, gitdir, created_at, removed_at, decision, failure, failed_at, carried_from, carried_commit, forked_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, ?)
          ON CONFLICT (repository, workflow_run_id) DO UPDATE SET path = excluded.path, branch = excluded.branch, gitdir = excluded.gitdir, created_at = excluded.created_at,
          removed_at = NULL, decision = NULL, failure = NULL, failed_at = NULL, setup_hash = NULL, setup_decision = NULL, carried_from = excluded.carried_from, carried_commit = NULL, forked_at = excluded.forked_at`).run(repository, step.runId, path, branch, gitdir, new Date().toISOString(), from.workflow_run_id, onto)
      })
      cut = this.row(repository, step.runId)!
    }
    if (pointer(cut.path) !== cut.gitdir) return refuse('failed', `the .git file of ${cut.path} no longer points to the worktree's own directory ${cut.gitdir}; it is left for the operator`)
    try {
      // Index and files become the tree; HEAD stays at the base, so the earlier change is the worktree's own change.
      await git(cut.path, [`--git-dir=${cut.gitdir}`, `--work-tree=${cut.path}`, 'read-tree', '-u', '--reset', tree])
    } catch (error) {
      return refuse('failed', `the work of ${from.branch} at ${commit} could not be read into ${cut.path}: ${(error as Error).message}`)
    }
    this.ctx.store.transaction((db) => void db.prepare('UPDATE agent_worktrees SET carried_commit = ? WHERE repository = ? AND workflow_run_id = ?').run(commit, repository, step.runId))
    this.ctx.logger.info(`agent Workers: run ${step.runId} works in ${cut.path} on ${cut.branch}, starting from the work of run ${from.workflow_run_id} (${commit} on ${from.branch}, on top of ${base}${rebase ? `; ${rebase.outcome === 'rebased' ? `replayed on ${rebase.onto}` : `${rebase.onto} moved and the replay conflicts, so it stays on ${base}`}` : ''})`)
    return { outcome: 'carried', repository, from: { branch: from.branch, commit }, base: onto, branch: cut.branch, worktree: cut.path, carried: true, ...(rebase ? { rebase } : {}) }
  }

  /**
   * What a move of the repository's HEAD did to a carry made before a restart (T271, INV-4), derived
   * from where its worktree was cut, as nothing else of it is stored: cut at another commit than the
   * tree's base, it was replayed there (`rebased`); cut at the base while the commit the task writes
   * (`step.onto`, else the HEAD) is another, the replay conflicted (`conflict`, the files found by the
   * same replay again). Undefined when nothing moved.
   */
  private async movedAt(repository: string, base: string, forkedAt: string, step: CarryStep, commit: string): Promise<Extract<Carried, { outcome: 'carried' }>['rebase']> {
    if (forkedAt !== base) return { outcome: 'rebased', from: base, onto: forkedAt }
    const target = step.onto ?? (await git(repository, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '')).trim()
    if (!target || target === base) return undefined
    const replayed = await this.replayOnto(repository, base, target, commit)
    return { outcome: 'conflict', from: base, onto: target, files: 'files' in replayed ? replayed.files : [] }
  }

  /**
   * The change `commit` made on `base`, replayed on `onto` (T271): a three-way merge of the trees in a
   * scratch index of its own (`git read-tree -m -i --aggressive`, plumbing every git has; no working
   * tree, no ref, nothing of the repository's own index touched), then its tree written. Only the
   * merges git resolves at the level of whole files are taken: a file both sides changed is a conflict,
   * named, and the change then stays on its own base for the Worker to resolve. Fail closed: a replay
   * git cannot do at all is a conflict with no file named.
   */
  private async replayOnto(repository: string, base: string, onto: string, commit: string): Promise<{ tree: string } | { files: string[] }> {
    const scratch = mkdtempSync(join(tmpdir(), 'system-replay-'))
    const index = { GIT_INDEX_FILE: join(scratch, 'index') }
    try {
      await git(repository, ['read-tree', '-m', '-i', '--aggressive', base, onto, commit], index)
      const unmerged = (await git(repository, ['ls-files', '--unmerged', '-z'], index)).split('\0').filter(Boolean)
      if (unmerged.length) return { files: [...new Set(unmerged.map((l) => l.slice(l.indexOf('\t') + 1)))].slice(0, 50) }
      const tree = (await git(repository, ['write-tree'], index)).trim()
      return /^[0-9a-f]{40,64}$/.test(tree) ? { tree } : { files: [] }
    } catch {
      return { files: [] }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  /**
   * The earlier worktree is clean, and its HEAD is the system's commit of exactly `subject` on top of
   * `base`: committed by a carry to run `runId` before a restart, or kept as its attempt's result when
   * that attempt ended (T271); never a carry's commit to another run.
   */
  private async carriedCommit(inside: (args: string[]) => Promise<string>, base: string, subject: string, runId: string): Promise<boolean> {
    if ((await inside(['status', '--porcelain', '--untracked-files=all'])).trim()) return false
    const [parent, author, ...message] = (await inside(['log', '-1', '--format=%P%n%an <%ae>%n%B', 'HEAD'])).split('\n')
    return parent === base && author === `${SYSTEM_AUTHOR.name} <${SYSTEM_AUTHOR.email}>` && message.includes(`${SUBJECT_TRAILER}: ${subject}`)
      && !message.some((l) => l.startsWith(`${CARRIED_TRAILER}: `) && l !== `${CARRIED_TRAILER}: ${runId}`)
  }

  /**
   * A worktree cut to hold an earlier run's work that it was never given ({@link halfCarried}): its index
   * and files are put back to its HEAD, the base it was cut at (its branch was made there, and nothing
   * commits on it while it is so marked), and, once it then holds nothing else, it is a fresh worktree
   * a run may work in, unmarked. No agent has run in it ({@link acquire} refuses one so marked). One that
   * is not intact, cannot be put back, or still holds files that are not its base's (what a reading cut
   * short wrote) stays marked, nothing of it committed, and nothing runs in it: throws a
   * {@link WorktreeError} saying so, for the operator.
   */
  private async putBack(cut: WorktreeRow): Promise<void> {
    const fail = (why: string): never => {
      throw new WorktreeError(`the worktree ${cut.path} of run ${cut.workflow_run_id} was cut to start from the work of run ${cut.carried_from}, which never got into it, and ${why}: nothing of it is committed, nothing runs in it, and it is left for the operator`)
    }
    await this.verify(cut).catch((error: unknown) => fail(`is not intact (${(error as Error).message})`))
    const inside = (args: string[]): Promise<string> => git(cut.path, [`--git-dir=${cut.gitdir}`, `--work-tree=${cut.path}`, ...args])
    await inside(['read-tree', '-u', '--reset', 'HEAD']).catch((error: unknown) => fail(`could not be put back to its base (${(error as Error).message})`))
    const left = (await inside(['status', '--porcelain', '--untracked-files=all'])).trim()
    if (left) fail(`still holds files its base does not after it was put back (${left.split('\n').slice(0, 5).map((l) => l.slice(3)).join(', ')})`)
    this.ctx.store.transaction((db) => void db.prepare('UPDATE agent_worktrees SET carried_from = NULL WHERE repository = ? AND workflow_run_id = ?').run(cut.repository, cut.workflow_run_id))
    this.ctx.logger.info(`agent Workers: the worktree ${cut.path} of run ${cut.workflow_run_id}, cut for the work of run ${cut.carried_from} and never given it, is put back to its base: a fresh worktree`)
  }

  /** Commit the worktree's changes on its branch, while it is still exactly the accepted subject. */
  private async commitAccepted(row: WorktreeRow, step: Extract<LandStep, { step: 'commit' }>): Promise<Landed> {
    const accepted = subjectId({ type: 'git-head', ...step.subject })
    if (row.removed_at !== null || !existsSync(row.path)) return { outcome: 'refused', cause: 'gone', reason: `the worktree ${row.path} was removed (its branch ${row.branch} keeps what the retention committed), so the accepted tree ${accepted} can no longer be checked` }
    if (!this.ctx.store.db.prepare(`SELECT 1 FROM agent_worktrees w WHERE repository = ? AND workflow_run_id = ? AND ${FREE}`).get(row.repository, row.workflow_run_id, null)) {
      return { outcome: 'refused', cause: 'busy', reason: `an agent run of workflow run ${row.workflow_run_id} is unfinished or not known to be gone, so it may still write ${row.path} (INV-15)` }
    }
    try {
      await this.verify(row)
    } catch (error) {
      return { outcome: 'refused', cause: 'failed', reason: (error as Error).message }
    }
    const inside = (args: string[]): Promise<string> => git(row.path, [`--git-dir=${row.gitdir}`, `--work-tree=${row.path}`, ...args])
    await this.clearSystem(row, inside)
    const current = captureGitSubject(row.path)
    if (!current) return { outcome: 'refused', cause: 'failed', reason: `${row.path} is no longer a git working tree` }
    let committed = false
    if (current.subject.ref === step.subject.ref && current.subject.version === step.subject.version) {
      if ((await inside(['status', '--porcelain', '--untracked-files=all'])).trim()) {
        await inside(['add', '--all'])
        await inside(['commit', '--quiet', '--no-verify', '-m', `${step.message.trimEnd()}\n${SUBJECT_TRAILER}: ${accepted}`])
        committed = true
        // Nothing moves the tree while the commit is made (no run of it is left, and one change at a time per repository): what is left over is not the accepted change.
        if ((await inside(['status', '--porcelain', '--untracked-files=all'])).trim()) return { outcome: 'refused', cause: 'failed', reason: `${row.path} still holds changes after the commit on ${row.branch}; it is left for the operator` }
      }
    } else if (!(await this.landedCommit(row, inside, step.subject.ref, accepted)) && !(await this.rebasedLanding(inside, step.subject.ref, accepted))) {
      return { outcome: 'refused', cause: 'moved', reason: `the worktree ${row.path} is now ${subjectId(current.subject)}, not the accepted ${accepted}: it changed after the acceptance, so nothing is committed` }
    }
    const head = (await inside(['rev-parse', 'HEAD'])).trim()
    const base = await this.baseOf(row.repository)
    if ('problem' in base) return { outcome: 'refused', cause: 'base-moved', reason: base.problem }
    const contained = await this.contains(row.repository, base.sha, head)
    const stat = contained ? '' : await this.statOf(row.repository, base.sha, head)
    // Where the result forked from the base: the base moved since its work started when that is not the base's head (ADR-0068).
    const fork = contained ? '' : (await git(row.repository, ['merge-base', head, base.sha]).catch(() => '')).trim()
    return { outcome: 'committed', repository: row.repository, branch: row.branch, head, committed, base, contained, stat, ...(fork ? { fork } : {}) }
  }

  /** The change of `head` against `base` (`git diff --stat`, from where they forked), bounded. */
  private async statOf(repository: string, base: string, head: string): Promise<string> {
    const stat = (await git(repository, ['diff', '--stat=100', '--no-color', '--no-ext-diff', '--no-textconv', `${base}...${head}`])).trimEnd()
    return stat.length > STAT_CHARS ? `${stat.slice(0, STAT_CHARS)}\n…` : stat
  }

  /**
   * The worktree is clean, and its HEAD is the system's rebase (ADR-0068) of its landing commit of
   * `accepted` on top of `parent`, through at most {@link REBASE_DEPTH} rebases: committed and rebased
   * before a restart, or before a base that moved again asked for the commit once more (INV-4).
   */
  private async rebasedLanding(inside: (args: string[]) => Promise<string>, parent: string, accepted: string): Promise<boolean> {
    if ((await inside(['status', '--porcelain', '--untracked-files=all'])).trim()) return false
    let commit = (await inside(['rev-parse', 'HEAD'])).trim()
    for (let depth = 0; depth <= REBASE_DEPTH; depth++) {
      const [parents, author, ...message] = (await inside(['log', '-1', '--format=%P%n%an <%ae>%n%B', commit])).split('\n')
      if (author !== `${SYSTEM_AUTHOR.name} <${SYSTEM_AUTHOR.email}>` || !message.includes(`${SUBJECT_TRAILER}: ${accepted}`)) return false
      if (depth > 0 && parents === parent) return true
      const from = rebasedFrom(message)
      if (!from) return false
      commit = from
    }
    return false
  }

  /** The worktree is clean, and its HEAD is the system's landing commit of `accepted` on top of `parent`: committed before a restart. */
  private async landedCommit(row: WorktreeRow, inside: (args: string[]) => Promise<string>, parent: string, accepted: string): Promise<boolean> {
    if ((await inside(['status', '--porcelain', '--untracked-files=all'])).trim()) return false
    const [first, author, ...message] = (await inside(['log', '-1', '--format=%P%n%an <%ae>%n%B', 'HEAD'])).split('\n')
    return first === parent && author === `${SYSTEM_AUTHOR.name} <${SYSTEM_AUTHOR.email}>` && message.some((line) => line === `${SUBJECT_TRAILER}: ${accepted}`)
  }

  /** Merge the run's branch into the repository's checked-out branch, while both are still where the approval saw them. */
  private async merge(row: WorktreeRow, step: Extract<LandStep, { step: 'merge' }>): Promise<Landed> {
    const repository = row.repository
    const tip = (await git(repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${row.branch}^{commit}`]).catch(() => '')).trim()
    if (tip !== step.head) return { outcome: 'refused', cause: 'head-moved', reason: `${row.branch} is ${tip ? `at ${tip}` : 'gone'}, not at ${step.head} as approved` }
    const base = await this.baseOf(repository)
    if ('problem' in base) return { outcome: 'refused', cause: 'base-moved', reason: base.problem }
    if (base.branch !== step.base.branch) return { outcome: 'refused', cause: 'base-moved', reason: `${repository} has ${base.branch} checked out now, not ${step.base.branch} as approved` }
    // Done before a restart: the base already holds the head (INV-4).
    if (await this.contains(repository, base.sha, step.head)) return { outcome: 'merged', repository, branch: row.branch, head: step.head, base: step.base, commit: base.sha, already: true }
    if (base.sha !== step.base.sha) return { outcome: 'refused', cause: 'base-moved', reason: `${base.branch} is at ${base.sha} now, not at ${step.base.sha} as approved` }
    const dirty = (await git(repository, ['status', '--porcelain', '--untracked-files=no'])).trim()
    if (dirty) return { outcome: 'refused', cause: 'dirty', reason: `the working tree of ${repository} has uncommitted changes (${dirty.split('\n').slice(0, 5).map((l) => l.slice(3)).join(', ')}): commit or stash them, and nothing of yours is touched` }
    try {
      await git(repository, ['merge', '--no-ff', '--no-edit', '--quiet', '-m', step.message.trimEnd(), `refs/heads/${row.branch}`])
    } catch (error) {
      const merging = await git(repository, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).then(() => true, () => false)
      if (!merging) return { outcome: 'refused', cause: 'failed', reason: `git refused the merge, and changed nothing: ${(error as Error).message}` }
      const conflicts = (await git(repository, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim().split('\n').filter(Boolean)
      try {
        await git(repository, ['merge', '--abort'])
      } catch (abort) {
        return { outcome: 'refused', cause: 'failed', reason: `the merge of ${row.branch} conflicted, and git could not abort it: ${repository} is left mid-merge (\`git -C ${repository} merge --abort\`): ${(abort as Error).message}` }
      }
      const after = (await git(repository, ['rev-parse', 'HEAD'])).trim()
      const left = (await git(repository, ['status', '--porcelain', '--untracked-files=no'])).trim()
      const restored = after === step.base.sha && !left
      const asWas = restored ? 'the merge was aborted, and the repository is as it was' : `the merge was aborted, and ${repository} is not as it was (HEAD ${after}${left ? ', with changes' : ''}): look at it`
      const conflict = `${row.branch} conflicts with ${base.branch} at ${base.sha}${conflicts.length ? ` in ${named(conflicts)}` : ''}`
      // Conflicts only in files the repository declares generated: made again by its own commands, in the run's worktree (T166).
      const regeneration = this.regeneration?.(repository, (row as WorktreeRow & { setup_hash?: string | null }).setup_hash ?? null)
      if (restored && regeneration && conflicts.length) {
        const other = conflicts.filter((path) => !regeneration.generated(path))
        if (!other.length) return this.regenerate(row, step, regeneration, conflict)
        return { outcome: 'refused', cause: 'conflict', reason: `${conflict}, of which ${named(other)} ${other.length === 1 ? 'is' : 'are'} not declared generated: ${asWas}` }
      }
      return { outcome: 'refused', cause: 'conflict', reason: `${conflict}: ${asWas}` }
    }
    const commit = (await git(repository, ['rev-parse', 'HEAD'])).trim()
    if (!(await this.contains(repository, commit, step.head))) return { outcome: 'refused', cause: 'failed', reason: `${base.branch} is at ${commit} after the merge, which does not hold ${step.head}; look at ${repository}` }
    return { outcome: 'merged', repository, branch: row.branch, head: step.head, base: step.base, commit, already: false }
  }

  /**
   * The merge of `step`, whose only conflicts in the repository are in files it declares generated
   * (T166), made in the run's worktree instead, where the setup installed what the repository's
   * commands need; the repository was put back as it was before this is tried. In the worktree,
   * intact, free of agent runs (INV-15), clean, on its branch at the approved head: detached at the
   * approved base, the branch merged without a commit, each conflicted file (each one generated, or
   * refused) taken from either side, then the commands run (./regenerate.ts). Only when they exit 0
   * and change no file but generated ones (nor any file git ignores, nor the worktree's .git file) is the merge committed, as one merge commit of the base and
   * the head by the system with the engine's message; then the commands run again on it and must
   * change nothing (the same tree on a repeat). The base branch, still at the approved base and clean,
   * is then fast-forwarded to that commit, so it gets exactly one merge commit, as without a conflict.
   * The worktree is put back on its branch in every case (its work is committed there, so nothing of
   * the run is lost); a file a refused command made outside the generated ones stays there, named.
   * A worktree that cannot be put back refuses the landing, the base not moved.
   * Anything else refuses, the repository as it was (INV-2). A restart that finds the worktree off its
   * branch puts it back first, only when that is this landing's own merge and forcing it back loses
   * nothing uncommitted ({@link unrecoverable}); else it refuses, the worktree left as it is. The base
   * not yet moved, the merge is made again.
   */
  private async regenerate(row: WorktreeRow, step: Extract<LandStep, { step: 'merge' }>, regeneration: Regeneration, conflict: string): Promise<Landed> {
    const refuse = (why: string): Landed => ({ outcome: 'refused', cause: 'conflict', reason: `${conflict}, only in files the repository declares generated, and they were not regenerated: ${why}; the repository is as it was` })
    if (row.removed_at !== null || !existsSync(row.path)) return refuse(`the worktree ${row.path} of run ${row.workflow_run_id}, where they are made, was removed`)
    if (!this.ctx.store.db.prepare(`SELECT 1 FROM agent_worktrees w WHERE repository = ? AND workflow_run_id = ? AND ${FREE}`).get(row.repository, row.workflow_run_id, null)) {
      return refuse(`an agent run of workflow run ${row.workflow_run_id} is unfinished or not known to be gone, so it may still write ${row.path} (INV-15)`)
    }
    if (pointer(row.path) !== row.gitdir) return refuse(`the .git file of ${row.path} no longer points to the worktree's own directory ${row.gitdir}`)
    const inside = (args: string[]): Promise<string> => git(row.path, [`--git-dir=${row.gitdir}`, `--work-tree=${row.path}`, ...args])
    const onBranch = async (): Promise<boolean> => (await inside(['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim() === `refs/heads/${row.branch}`
    if (!(await onBranch())) {
      // Put back (a forced checkout) only from this landing's own merge, and only when that loses nothing uncommitted.
      const unsafe = await this.unrecoverable(row, step, regeneration, inside).catch((error: unknown) => `its state could not be read: ${(error as Error).message}`)
      if (unsafe) return refuse(`${row.path} is not on ${row.branch}, and it is left as it is: ${unsafe}`)
      await this.backOnBranch(row, inside).catch(() => undefined)
    }
    if (!(await onBranch())) return refuse(`${row.path} is not on ${row.branch}`)
    const at = (await inside(['rev-parse', 'HEAD'])).trim()
    if (at !== step.head) return refuse(`${row.path} is at ${at}, not at ${step.head} as approved`)
    const pending = (await inside(['status', '--porcelain', '--untracked-files=all'])).trim()
    if (pending) return refuse(`${row.path} holds uncommitted changes (${pending.split('\n').slice(0, 5).map((l) => l.slice(3)).join(', ')})`)
    let made: { commit: string; files: string[]; autonomy: string[] } | string
    try {
      made = await this.mergeIn(row, step, regeneration, inside)
    } catch (error) {
      made = (error as Error).message
    }
    // A worktree that cannot be put back (its .git file changed, say) refuses the landing: nothing is merged from it.
    const back = await this.backOnBranch(row, inside).then(() => undefined, (error: unknown) => (error as Error).message)
    if (back !== undefined) {
      this.ctx.logger.warn(`agent Workers: the worktree ${row.path} could not be put back on ${row.branch} after its landing's regeneration: ${back}`)
      return refuse(`${typeof made === 'string' ? `${made}; and ` : ''}the worktree ${row.path} could not be put back on ${row.branch} after the regeneration: ${back}`)
    }
    if (typeof made === 'string') return refuse(made)
    // The base is checked again (the operator may have moved it), then moved only forward, to exactly that commit.
    const base = await this.baseOf(row.repository)
    if ('problem' in base) return { outcome: 'refused', cause: 'base-moved', reason: base.problem }
    if (base.branch !== step.base.branch || base.sha !== step.base.sha) return { outcome: 'refused', cause: 'base-moved', reason: `${row.repository} has ${base.branch} at ${base.sha} now, not ${step.base.branch} at ${step.base.sha} as approved` }
    const dirty = (await git(row.repository, ['status', '--porcelain', '--untracked-files=no'])).trim()
    if (dirty) return { outcome: 'refused', cause: 'dirty', reason: `the working tree of ${row.repository} has uncommitted changes (${dirty.split('\n').slice(0, 5).map((l) => l.slice(3)).join(', ')}): commit or stash them, and nothing of yours is touched` }
    try {
      await git(row.repository, ['merge', '--ff-only', '--quiet', made.commit])
    } catch (error) {
      return { outcome: 'refused', cause: 'failed', reason: `${base.branch} could not be moved to the merge commit ${made.commit}, made with the generated files regenerated: ${(error as Error).message}` }
    }
    const commit = (await git(row.repository, ['rev-parse', 'HEAD'])).trim()
    if (commit !== made.commit) return { outcome: 'refused', cause: 'failed', reason: `${base.branch} is at ${commit} after the merge, not at the merge commit ${made.commit}; look at ${row.repository}` }
    this.ctx.logger.info(`agent Workers: ${row.branch} is merged into ${base.branch} as ${commit}, its conflicts only in generated files, regenerated (${named(made.files)})`)
    return { outcome: 'merged', repository: row.repository, branch: row.branch, head: step.head, base: step.base, commit, already: false, regenerated: { files: made.files, commands: [...regeneration.lines], autonomy: made.autonomy } }
  }

  /** {@link regenerate}'s merge in the worktree: the merge commit, the files regenerated, and the policy's decisions; or why not. */
  private async mergeIn(row: WorktreeRow, step: Extract<LandStep, { step: 'merge' }>, regeneration: Regeneration, inside: (args: string[]) => Promise<string>): Promise<{ commit: string; files: string[]; autonomy: string[] } | string> {
    await inside(['checkout', '--quiet', '--detach', step.base.sha])
    // Never committed by git itself: only once the generated files are made.
    await inside(['merge', '--no-ff', '--no-commit', '--quiet', `refs/heads/${row.branch}`]).catch(() => undefined)
    if (!(await inside(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).then(() => true, () => false))) return `git did not start the merge of ${row.branch} into ${step.base.sha} in ${row.path}`
    const conflicts = zPaths(await inside(['diff', '--name-only', '-z', '--diff-filter=U']))
    const other = conflicts.filter((path) => !regeneration.generated(path))
    if (other.length) return `in the worktree the merge also conflicts in ${named(other)}`
    for (const path of conflicts) {
      // Either side will do: the commands make the file again from the merged sources. A side that deleted it has none to take.
      const taken = await inside(['checkout', '--theirs', '--', path]).then(() => true, () => inside(['checkout', '--ours', '--', path]).then(() => true, () => false))
      if (!taken) return `neither side of ${path} could be taken`
      await inside(['add', '--', path])
    }
    if (zPaths(await inside(['diff', '--name-only', '-z', '--diff-filter=U'])).length) return 'conflicts were left after a side of each was taken'
    const index = (await inside(['write-tree'])).trim()
    // The commands never install: the setup runs again first when the merge changed what it installs.
    const ready = await regeneration.prepare(row.path, row.workflow_run_id, `landing:merge:${step.base.sha}:${step.head}`)
    if (!ready.ok) return ready.reason
    // The files git ignores, as they are before the commands: a command must not change them either.
    const ignored = await this.ignoredFiles(row)
    // The worktree's .git file, which git lists neither as changed nor as ignored: a command must not change it either.
    const control = controlFile(row.path)
    const ran = await regeneration.run(row.path)
    if (!ran.ok) return ran.reason
    if (controlFile(row.path) !== control) return `the commands (${regeneration.lines.join('; ')}) changed ${join(row.path, '.git')}, the worktree's git control file, which is not among the generated files of the merge`
    const touched = await this.touched(inside)
    const stray = touched.filter((path) => !regeneration.generated(path))
    if (stray.length) return `the commands (${regeneration.lines.join('; ')}) changed ${named(stray)}, which ${stray.length === 1 ? 'is' : 'are'} not declared generated`
    const strayIgnored = await this.ignoredChanged(row, ignored)
    if (strayIgnored.length) return `the commands (${regeneration.lines.join('; ')}) changed ${named(strayIgnored)}, which git ignores, so ${strayIgnored.length === 1 ? 'it is' : 'they are'} not among the generated files of the merge`
    if ((await inside(['write-tree'])).trim() !== index) return 'the commands changed the merge\'s index'
    if (touched.length) await inside(['add', '--all', '--', ...touched])
    await inside(['commit', '--quiet', '--no-verify', '-m', step.message.trimEnd()])
    const commit = (await inside(['rev-parse', 'HEAD'])).trim()
    const parents = (await inside(['log', '-1', '--format=%P', commit])).trim()
    if (parents !== `${step.base.sha} ${step.head}`) return `the commit ${commit} made in ${row.path} has the parents ${parents || 'none'}, not ${step.base.sha} and ${step.head}`
    // The same tree on a repeat: the commands make the files from what the commit holds, nothing else.
    const again = await regeneration.run(row.path)
    if (!again.ok) return `on a repeat, ${again.reason}`
    if (controlFile(row.path) !== control) return `a repeat of the commands changed ${join(row.path, '.git')}, the worktree's git control file, which is not among the generated files of the merge`
    const changed = await this.touched(inside)
    if (changed.length) return `a repeat of the commands changed ${named(changed)} again, so they do not build the same tree`
    const changedIgnored = await this.ignoredChanged(row, ignored)
    if (changedIgnored.length) return `a repeat of the commands changed ${named(changedIgnored)}, which git ignores, so ${changedIgnored.length === 1 ? 'it is' : 'they are'} not among the generated files of the merge`
    return { commit, files: [...new Set([...conflicts, ...touched])].sort(), autonomy: [...new Set([...ready.autonomy, ...ran.autonomy, ...again.autonomy])] }
  }

  /** The files of a worktree that differ from its index, and the untracked ones it does not ignore. */
  private async touched(inside: (args: string[]) => Promise<string>): Promise<string[]> {
    const changed = zPaths(await inside(['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv']))
    const untracked = zPaths(await inside(['ls-files', '--others', '--exclude-standard', '-z']))
    return [...new Set([...changed, ...untracked])].sort()
  }

  /**
   * The untracked files of a worktree that git ignores, each with a stamp of what it is (its type and
   * mode, size, inode, and change and modification times, never followed through a link): read as git
   * lists them, never held whole as one output, since a worktree's ignored files (its dependencies) are many.
   */
  private async ignoredFiles(row: WorktreeRow): Promise<Map<string, string>> {
    const files = new Map<string, string>()
    await gitRead(row.path, [`--git-dir=${row.gitdir}`, `--work-tree=${row.path}`, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z'], fields((path) => {
      if (path) files.set(path, stamp(join(row.path, path)))
      return false
    }))
    return files
  }

  /** The ignored files of a worktree made, removed, or changed since `before` ({@link ignoredFiles}), sorted. */
  private async ignoredChanged(row: WorktreeRow, before: ReadonlyMap<string, string>): Promise<string[]> {
    const now = await this.ignoredFiles(row)
    const changed = new Set<string>()
    for (const [path, was] of before) if (now.get(path) !== was) changed.add(path)
    for (const path of now.keys()) if (!before.has(path)) changed.add(path)
    return [...changed].sort()
  }

  /**
   * Why a worktree off its branch is not left by {@link regenerate}'s own merge, or would lose
   * uncommitted work when forced back on its branch; undefined when putting it back is safe. Its own
   * merge leaves it detached at the approved base (the merge maybe begun, of the approved head), or at
   * the merge commit of the two the system made; and only the generated files and the files the merge
   * took whole from the head may differ from that commit, nothing else, untracked included. Anything
   * else (another branch, another commit, a change of a source file) is someone's, and kept.
   */
  private async unrecoverable(row: WorktreeRow, step: Extract<LandStep, { step: 'merge' }>, regeneration: Regeneration, inside: (args: string[]) => Promise<string>): Promise<string | undefined> {
    if (pointer(row.path) !== row.gitdir) return `its .git file no longer points to the worktree's own directory ${row.gitdir}`
    const ref = (await inside(['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim()
    if (ref) return `it has ${ref} checked out`
    const head = (await inside(['rev-parse', 'HEAD'])).trim()
    const merging = (await inside(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).catch(() => '')).trim()
    const ours = async (): Promise<boolean> => {
      if (head === step.base.sha) return !merging || merging === step.head
      if (merging) return false
      const [parents, author] = (await inside(['log', '-1', '--format=%P%n%an <%ae>', head])).split('\n')
      return parents === `${step.base.sha} ${step.head}` && author === `${SYSTEM_AUTHOR.name} <${SYSTEM_AUTHOR.email}>`
    }
    if (!(await ours())) return `it is detached at ${head}${merging ? `, merging ${merging}` : ''}, which is not this landing's merge of ${step.head} into ${step.base.sha}`
    const own = (paths: string[]): string[] => paths.filter((path) => !regeneration.generated(path))
    const unstaged = own(zPaths(await inside(['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv'])))
    const untracked = own(zPaths(await inside(['ls-files', '--others', '--exclude-standard', '-z'])))
    let staged = own(zPaths(await inside(['diff', '--cached', '--name-only', '-z', '--no-ext-diff', '--no-textconv', 'HEAD'])))
    if (staged.length && merging) {
      // A file the merge took whole from the head is the head's, and is there again on the branch.
      const fromHead = new Set(own(zPaths(await inside(['diff', '--cached', '--name-only', '-z', '--no-ext-diff', '--no-textconv', step.head]))))
      staged = staged.filter((path) => fromHead.has(path))
    }
    const lost = [...new Set([...unstaged, ...untracked, ...staged])].sort()
    return lost.length ? `it holds uncommitted changes outside the generated files (${named(lost)}), which a checkout of ${row.branch} would lose` : undefined
  }

  /** Put a worktree back on its branch after a regeneration: any merge in it aborted, its tracked files the branch's (its work is committed there). */
  private async backOnBranch(row: WorktreeRow, inside: (args: string[]) => Promise<string>): Promise<void> {
    if (pointer(row.path) !== row.gitdir) throw new WorktreeError(`the .git file of ${row.path} no longer points to the worktree's own directory ${row.gitdir}`)
    if (await inside(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).then(() => true, () => false)) await inside(['merge', '--abort']).catch(() => undefined)
    await inside(['checkout', '--quiet', '--force', row.branch, '--'])
  }

  /**
   * A landing's rebase (ADR-0068): the result's change, the run's branch at `step.head` against where
   * it forked from the base, made again on top of `step.base.sha` in the run's worktree, which stays
   * on its branch. Only while the worktree is intact and free of agent runs (INV-15).
   * - `start`: with the worktree clean on its branch at the head, and the base where the step says,
   *   the head is kept under {@link rebaseRef}, the branch moved to the base (only from the head), the
   *   worktree's tracked files made the base's, and the change replayed there uncommitted (a squash
   *   merge of the kept head); conflicts only in declared generated files take a side; then
   *   {@link finishRebase}. Conflicts in any other file leave it so, marked, for a writing step:
   *   `conflicted`.
   * - `resolved`: once no file the replay changed holds a conflict marker, {@link finishRebase}.
   * - `abandon`: the branch moved back to the head (only from the base, or from its own rebase
   *   commit), the worktree's tracked files the head's; untracked files are left, named.
   * Each phase finds its own work done after a restart (INV-4), from what git keeps, never from the
   * worktree's files alone: a branch at the base with the head kept is a rebase begun; with
   * {@link replayedRef} at the base too, one replayed (only then is the worktree the replay, to
   * commit); a branch at the system's rebase commit of the head is one done, taken as it is only on a
   * clean worktree, its subject that committed tree ({@link rebasedAnswer}). A rebase begun and not
   * replayed may have stopped between moving the branch and making the worktree the base's (its files
   * still the head's), or mid-replay: its worktree is made the base's again and the replay run again,
   * so the head's tree is never committed on the base as if it were the replay.
   */
  private async rebase(row: WorktreeRow, step: Extract<LandStep, { step: 'rebase' }>): Promise<Landed> {
    const refuse = (cause: LandRefusal, reason: string): Landed => ({ outcome: 'refused', cause, reason })
    if (row.removed_at !== null || !existsSync(row.path)) return refuse('gone', `the worktree ${row.path} was removed, so the result cannot be rebased there`)
    if (!this.ctx.store.db.prepare(`SELECT 1 FROM agent_worktrees w WHERE repository = ? AND workflow_run_id = ? AND ${FREE}`).get(row.repository, row.workflow_run_id, null)) {
      return refuse('busy', `an agent run of workflow run ${row.workflow_run_id} is unfinished or not known to be gone, so it may still write ${row.path} (INV-15)`)
    }
    try {
      await this.verify(row)
    } catch (error) {
      return refuse('failed', (error as Error).message)
    }
    const repository = row.repository
    const inside = (args: string[]): Promise<string> => git(row.path, [`--git-dir=${row.gitdir}`, `--work-tree=${row.path}`, ...args])
    const at = async (ref: string): Promise<string> => (await git(repository, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => '')).trim()
    const tip = await at(`refs/heads/${row.branch}`)
    const kept = rebaseRef(row.workflow_run_id, step.head)
    const begun = tip === step.base.sha && (await at(kept)) === step.head
    const replayed = begun && (await at(replayedRef(row.workflow_run_id, step.head))) === step.base.sha
    const regeneration = this.regeneration?.(repository, (row as WorktreeRow & { setup_hash?: string | null }).setup_hash ?? null)
    await this.clearSystem(row, inside)
    const done = tip !== step.head && !begun && await this.isRebaseOf(inside, tip, step.head, step.base.sha)
    if (step.phase === 'abandon') {
      if (!begun && !done && tip !== step.head) return refuse('head-moved', `${row.branch} is at ${tip || '(gone)'}: neither ${step.head}, nor ${step.base.sha} with ${step.head} kept, nor its rebase; nothing is put back`)
      // At the head, and no rebase of it ever begun: nothing of a rebase is there to put back, and nothing else is touched.
      if (tip === step.head && (await at(kept)) !== step.head) return { outcome: 'abandoned', repository, branch: row.branch, head: step.head, left: [] }
      if (tip !== step.head) await git(repository, ['update-ref', `refs/heads/${row.branch}`, step.head, tip])
      await inside(['read-tree', '-u', '--reset', 'HEAD'])
      // Last: until the worktree is the head's again, a restart finds the abandon to finish.
      await this.forgetReplay(row, step)
      const left = zPaths(await inside(['ls-files', '--others', '--exclude-standard', '-z']))
      this.ctx.logger.info(`agent Workers: the rebase of ${row.branch} onto ${step.base.sha} is abandoned; the branch is back at ${step.head}${left.length ? `, ${named(left)} left untracked` : ''}`)
      return { outcome: 'abandoned', repository, branch: row.branch, head: step.head, left }
    }
    if (done) return this.rebasedAnswer(row, step, inside, true)
    if (step.phase === 'resolved') {
      if (!begun) return refuse('head-moved', `${row.branch} is at ${tip || '(gone)'}, not at ${step.base.sha} with ${step.head} kept, where its rebase was left to resolve`)
      if (!replayed) return refuse('failed', `the rebase of ${row.branch} onto ${step.base.sha} was begun but never replayed in ${row.path}, so there is no resolution of it to commit`)
      // What the replay and its resolution changed against the base, untracked included: none may hold a marker.
      const changed = [...new Set([
        ...zPaths(await inside(['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', 'HEAD'])),
        ...zPaths(await inside(['diff', '--name-only', '-z', '--diff-filter=U'])),
        ...zPaths(await inside(['ls-files', '--others', '--exclude-standard', '-z'])),
      ])].sort()
      const marked = changed.filter((path) => hasMarkers(join(row.path, path)))
      if (marked.length) return refuse('conflict', `conflict markers are left in ${named(marked)}: the rebase of ${row.branch} onto ${step.base.branch} at ${step.base.sha} is not resolved; the worktree is left as it is`)
      return this.finishRebase(row, step, inside, regeneration, [])
    }
    if (begun && replayed) {
      // A restart after the replay: its conflicts are still there (the generated ones already took a side), or it was not committed yet.
      const unmerged = zPaths(await inside(['diff', '--name-only', '-z', '--diff-filter=U'])).filter((path) => !regeneration?.generated(path))
      if (unmerged.length) return this.conflictedAnswer(row, step, unmerged)
      return this.finishRebase(row, step, inside, regeneration, [])
    }
    if (begun) {
      // A restart after the branch moved and before the replay was whole: the worktree may still hold the head's files, or part of a
      // replay; none of it is anyone's work (the worktree was clean at the head, and no writing step has had it). Made the base's again, and replayed.
      await inside(['read-tree', '-u', '--reset', 'HEAD'])
      return this.replay(row, step, inside, regeneration)
    }
    if (tip !== step.head) return refuse('head-moved', `${row.branch} is at ${tip || '(gone)'}, not at ${step.head} as accepted, nor its rebase onto ${step.base.sha}`)
    const pending = (await inside(['status', '--porcelain', '--untracked-files=all'])).trimEnd()
    if (pending) return refuse('moved', `${row.path} holds uncommitted changes (${pending.split('\n').slice(0, 5).map((l) => l.slice(3)).join(', ')}), so its branch is not rebased`)
    const base = await this.baseOf(repository)
    if ('problem' in base) return refuse('base-moved', base.problem)
    if (base.branch !== step.base.branch || base.sha !== step.base.sha) return refuse('base-moved', `${repository} has ${base.branch} at ${base.sha} now, not ${step.base.branch} at ${step.base.sha}`)
    // Already on top of the base: nothing to rebase.
    if (await this.contains(repository, step.head, step.base.sha)) return this.rebasedAnswer(row, step, inside, true)
    // A replay mark left by an earlier rebase of this head is not this one's: gone before the branch moves.
    await this.forgetReplay(row, step)
    await git(repository, ['update-ref', kept, step.head])
    // Only from the head: a branch moved meanwhile is not moved again.
    await git(repository, ['update-ref', `refs/heads/${row.branch}`, step.base.sha, step.head])
    await inside(['read-tree', '-u', '--reset', 'HEAD'])
    return this.replay(row, step, inside, regeneration)
  }

  /** {@link rebase}'s replay of the kept head on the base the worktree is at: committed by {@link finishRebase}, or left `conflicted`. */
  private async replay(row: WorktreeRow, step: Extract<LandStep, { step: 'rebase' }>, inside: (args: string[]) => Promise<string>, regeneration: Regeneration | undefined): Promise<Landed> {
    const ran = await inside(['merge', '--squash', '--quiet', rebaseRef(row.workflow_run_id, step.head)]).then(() => undefined, (error: unknown) => (error as Error).message)
    const unmerged = zPaths(await inside(['diff', '--name-only', '-z', '--diff-filter=U']))
    if (ran !== undefined && !unmerged.length) return this.giveUp(row, step, inside, `git did not replay ${step.head} on ${step.base.sha}: ${ran}`)
    const generated = unmerged.filter((path) => regeneration?.generated(path))
    for (const path of generated) {
      // A generated file is made again from the replayed sources once the rest is resolved: either side will do, as for a merge (T166).
      const taken = await inside(['checkout', '--theirs', '--', path]).then(() => true, () => inside(['checkout', '--ours', '--', path]).then(() => true, () => false))
      if (!taken) return this.giveUp(row, step, inside, `neither side of the generated file ${path} could be taken`)
      await inside(['add', '--', path])
    }
    // The worktree is the replay now: marked so, before its conflicts are anyone's or it is committed (INV-4).
    await git(row.repository, ['update-ref', replayedRef(row.workflow_run_id, step.head), step.base.sha])
    // Conflicts in other files are the writing step's: only those are left marked, and named.
    const other = unmerged.filter((path) => !generated.includes(path))
    if (other.length) return this.conflictedAnswer(row, step, other)
    return this.finishRebase(row, step, inside, regeneration, generated)
  }

  /**
   * The replay, its conflicts resolved, committed on the branch at the base: every change staged, the
   * declared generated files made again by the repository's commands (./regenerate.ts), which may
   * change no other file, nor any file git ignores, nor the worktree's .git file; then one commit by the
   * system, the head's message with the step's line and the rebase trailers. Anything else gives up,
   * the branch back at the head.
   */
  private async finishRebase(row: WorktreeRow, step: Extract<LandStep, { step: 'rebase' }>, inside: (args: string[]) => Promise<string>, regeneration: Regeneration | undefined, generatedConflicts: string[]): Promise<Landed> {
    await inside(['add', '--all'])
    let regenerated: Regenerated | undefined
    if (regeneration) {
      // The commands never install: the setup runs again first when the rebase changed what it installs.
      const ready = await regeneration.prepare(row.path, row.workflow_run_id, `landing:rebase:${step.base.sha}:${step.head}`)
      if (!ready.ok) return this.giveUp(row, step, inside, `the declared generated files were not made again: ${ready.reason}`)
      const ignored = await this.ignoredFiles(row)
      const control = controlFile(row.path)
      const ran = await regeneration.run(row.path)
      if (!ran.ok) return this.giveUp(row, step, inside, `the declared generated files were not made again: ${ran.reason}`)
      if (controlFile(row.path) !== control) return this.giveUp(row, step, inside, `the generated files' commands (${regeneration.lines.join('; ')}) changed ${join(row.path, '.git')}, the worktree's git control file`)
      const touched = await this.touched(inside)
      const stray = touched.filter((path) => !regeneration.generated(path))
      if (stray.length) return this.giveUp(row, step, inside, `the generated files' commands (${regeneration.lines.join('; ')}) changed ${named(stray)}, which ${stray.length === 1 ? 'is' : 'are'} not declared generated`)
      const strayIgnored = await this.ignoredChanged(row, ignored)
      if (strayIgnored.length) return this.giveUp(row, step, inside, `the generated files' commands (${regeneration.lines.join('; ')}) changed ${named(strayIgnored)}, which git ignores`)
      if (touched.length) await inside(['add', '--all', '--', ...touched])
      regenerated = { files: [...new Set([...generatedConflicts, ...touched])].sort(), commands: [...regeneration.lines], autonomy: [...new Set([...ready.autonomy, ...ran.autonomy])] }
    }
    const message = (await inside(['log', '-1', '--format=%B', step.head])).trimEnd().split('\n')
    // The head's trailers stay last, the rebase's after them; the step's line goes before them.
    const cut = message.lastIndexOf('')
    const body = cut < 0 ? [...message, '', step.message.trimEnd()] : [...message.slice(0, cut), '', step.message.trimEnd(), ...message.slice(cut)]
    await inside(['commit', '--quiet', '--no-verify', '--allow-empty', '-m', [...body, `${REBASED_TRAILER}: ${step.head}`, `${ONTO_TRAILER}: ${step.base.sha}`].join('\n')])
    if ((await inside(['status', '--porcelain', '--untracked-files=all'])).trim()) return this.giveUp(row, step, inside, `${row.path} still holds changes after the rebase was committed`)
    // Committed: the branch at the rebase commit says it is done from now on.
    await this.forgetReplay(row, step)
    return this.rebasedAnswer(row, step, inside, false, regenerated)
  }

  /** Whether `tip` is the system's rebase commit of `from` onto `onto`. */
  private async isRebaseOf(inside: (args: string[]) => Promise<string>, tip: string, from: string, onto: string): Promise<boolean> {
    if (!tip) return false
    const [parents, author, ...message] = (await inside(['log', '-1', '--format=%P%n%an <%ae>%n%B', tip]).catch(() => '')).split('\n')
    return parents === onto && author === `${SYSTEM_AUTHOR.name} <${SYSTEM_AUTHOR.email}>` && rebasedFrom(message) === from
  }

  /**
   * The rebase as it is committed: its head, and the subject its required checks run on again, which
   * is that committed tree and nothing else. A worktree that holds anything beside the commit (an edit
   * after a restart found the rebase done) is refused, left as it is: the checks would run on a tree
   * other than the one that lands (INV-5).
   */
  private async rebasedAnswer(row: WorktreeRow, step: Extract<LandStep, { step: 'rebase' }>, inside: (args: string[]) => Promise<string>, already: boolean, regenerated?: Regenerated): Promise<Landed> {
    const head = (await inside(['rev-parse', 'HEAD'])).trim()
    const pending = (await inside(['status', '--porcelain', '--untracked-files=all'])).trimEnd()
    if (pending) {
      return {
        outcome: 'refused', cause: 'moved',
        reason: `${row.path} holds uncommitted changes (${pending.split('\n').slice(0, 5).map((l) => l.slice(3)).join(', ')}) beside ${row.branch}'s rebase commit ${head}, so the rebase is not taken as it is: its checks run again only on the committed tree that lands; the worktree is left as it is`,
      }
    }
    const current = captureGitSubject(row.path)
    if (!current) return { outcome: 'refused', cause: 'failed', reason: `${row.path} is no longer a git working tree` }
    if (current.subject.ref !== head) return { outcome: 'refused', cause: 'moved', reason: `${row.path} moved from ${head} to ${current.subject.ref} while its rebase was read, so it is not taken as it is` }
    if (!already) this.ctx.logger.info(`agent Workers: ${row.branch} is rebased onto ${step.base.branch} at ${step.base.sha} as ${head} (from ${step.head})${regenerated ? `, its generated files made again (${named(regenerated.files)})` : ''}`)
    return {
      outcome: 'rebased', repository: row.repository, branch: row.branch, head, from: step.head, base: step.base,
      subject: { ref: current.subject.ref, version: current.subject.version! }, stat: await this.statOf(row.repository, step.base.sha, head), already, ...(regenerated ? { regenerated } : {}),
    }
  }

  private async conflictedAnswer(row: WorktreeRow, step: Extract<LandStep, { step: 'rebase' }>, files: string[]): Promise<Landed> {
    const fork = (await git(row.repository, ['merge-base', step.head, step.base.sha]).catch(() => '')).trim()
    const moved = fork ? (await git(row.repository, ['log', '--no-color', '--format=%h %s', `--max-count=${REBASE_MOVED_MAX}`, `${fork}..${step.base.sha}`]).catch(() => '')).split('\n').filter(Boolean) : []
    return { outcome: 'conflicted', repository: row.repository, branch: row.branch, from: step.head, base: step.base, fork, files: files.slice(0, REBASE_FILES_MAX), more: Math.max(0, files.length - REBASE_FILES_MAX), moved }
  }

  /** A rebase that cannot go on: the branch put back at the head, the worktree its tracked files, and why (INV-2). */
  private async giveUp(row: WorktreeRow, step: Extract<LandStep, { step: 'rebase' }>, inside: (args: string[]) => Promise<string>, why: string): Promise<Landed> {
    const back = await (async () => {
      const tip = (await git(row.repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${row.branch}^{commit}`]).catch(() => '')).trim()
      if (tip !== step.head) await git(row.repository, ['update-ref', `refs/heads/${row.branch}`, step.head, tip])
      await inside(['read-tree', '-u', '--reset', 'HEAD'])
      await this.forgetReplay(row, step)
    })().then(() => `${row.branch} is back at ${step.head}`, (error: unknown) => `and ${row.branch} could not be put back at ${step.head} (${(error as Error).message}): look at ${row.path}`)
    return { outcome: 'refused', cause: 'failed', reason: `${why}; ${back}` }
  }

  /** Drop the mark that a rebase of `step.head` was replayed ({@link replayedRef}), if there is one. */
  private async forgetReplay(row: WorktreeRow, step: Extract<LandStep, { step: 'rebase' }>): Promise<void> {
    const ref = replayedRef(row.workflow_run_id, step.head)
    if ((await git(row.repository, ['rev-parse', '--verify', '--quiet', ref]).catch(() => '')).trim()) await git(row.repository, ['update-ref', '-d', ref])
  }

  /** The repository's checked-out branch and its head: where a landing merges into. */
  private async baseOf(repository: string): Promise<{ branch: string; sha: string } | { problem: string }> {
    const ref = (await git(repository, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim()
    if (!ref.startsWith('refs/heads/')) return { problem: `${repository} has no branch checked out (a detached HEAD), so there is no base to merge into` }
    const branch = ref.slice('refs/heads/'.length)
    if (branch.startsWith('system/run/')) return { problem: `${repository} has the run branch ${branch} checked out, not a base branch` }
    return { branch, sha: (await git(repository, ['rev-parse', 'HEAD'])).trim() }
  }

  /** Whether `commit` holds `ancestor`. */
  private contains(repository: string, commit: string, ancestor: string): Promise<boolean> {
    return git(repository, ['merge-base', '--is-ancestor', ancestor, commit]).then(() => true, () => false)
  }

  /**
   * Remove system's own workspace files (`.system/`, see {@link place}) from a worktree: they are never
   * part of the work, even if the agent changed their .gitignore. A `.system` the repository tracks is
   * the repository's, and one that is not a plain directory is left to the commit. Emptied through its
   * descriptor, as place writes it, then removed by name: rmdir takes only an empty directory, never a link.
   */
  private async clearSystem(row: WorktreeRow, inside: (args: string[]) => Promise<string>): Promise<void> {
    // A command sandbox's empty placeholders left in the worktree (T265) are not the work either:
    // never in its subject, and so never committed with it. Only an untracked one that holds nothing.
    for (const path of (await inside(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0')) {
      if (path && sandboxPlaceholder(row.path, path)) rmSync(join(row.path, path), { recursive: true, force: true })
    }
    const system = join(row.path, '.system')
    const own = openDirectory(system)
    if (typeof own !== 'object') return
    try {
      if (!(await inside(['ls-files', '-z', '--', '.system'])).length) {
        for (const entry of readdirSync(own.at)) rmSync(join(own.at, entry), { recursive: true, force: true })
        rmdirSync(system)
      }
    } finally {
      closeSync(own.fd)
    }
  }

  /** The `retention` decision that retires a worktree (INV-13), recorded on its row. */
  private decide(row: WorktreeRow, retentionHours: number): string {
    const last = (this.ctx.store.db.prepare('SELECT MAX(updated_at) AS last FROM agent_runs WHERE workflow_run_id = ?').get(row.workflow_run_id) as { last: string | null }).last ?? row.created_at
    const decision = this.ctx.artifacts.recordDecision({
      schema: 'decision@1.3', decisionType: 'retention', question: `Is the worktree ${row.path} of workflow run ${row.workflow_run_id} removed?`, inputs: [],
      candidates: [
        { option: 'remove', selected: true, reasons: [`every agent run of ${row.workflow_run_id} has finished, the last at ${last}, more than ${retentionHours} hour(s) ago: any change it holds is committed on ${row.branch}, which stays, then the worktree is removed`] },
        { option: 'keep', selected: false, reasons: [`not keep: a worktree is kept only while its workflow run has an agent run to finish, or for ${retentionHours} hour(s) after the last one ended`] },
      ],
      decider: { type: 'rule', id: 'agent-workers.worktree-retention', version: '1' },
      outcome: { option: 'remove', detail: { runId: row.workflow_run_id, repository: row.repository, path: row.path, branch: row.branch, lastRunEndedAt: last, retentionHours } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'agent-workers' }, runId: row.workflow_run_id }).id
    this.ctx.store.transaction((db) => {
      db.prepare('UPDATE agent_worktrees SET decision = ? WHERE repository = ? AND workflow_run_id = ?').run(decision, row.repository, row.workflow_run_id)
    })
    return decision
  }

  /**
   * Commit what the worktree holds on its branch, then remove it (never forced). Returns the new commit,
   * if any. A worktree cut for an earlier run's work it never got ({@link halfCarried}) is put back to its
   * base first, so nothing of it is committed, or stays when it cannot be ({@link putBack} throws).
   */
  private async retire(row: WorktreeRow): Promise<string | undefined> {
    if (!existsSync(row.path)) {
      // Removed by hand: nothing is left to keep, once git no longer lists it either.
      const listed = (await git(row.repository, ['worktree', 'list', '--porcelain'])).split('\n').includes(`worktree ${row.path}`)
      if (listed) throw new WorktreeError(`${row.path} is gone, and ${row.repository} still lists it; \`git -C ${row.repository} worktree prune\` clears it`)
      return undefined
    }
    await this.verify(row)
    const inside = (args: string[]): Promise<string> => git(row.path, [`--git-dir=${row.gitdir}`, `--work-tree=${row.path}`, ...args])
    // system's own workspace files are never part of the work: gone before the commit.
    await this.clearSystem(row, inside)
    if (halfCarried(row)) await this.putBack(row)
    // A landing's rebase left to resolve (ADR-0068): its conflict markers are no one's work to keep.
    if (zPaths(await inside(['diff', '--name-only', '-z', '--diff-filter=U'])).length) {
      throw new WorktreeError(`${row.path} holds a landing's rebase whose conflicts are not resolved (ADR-0068): nothing of it is committed, and it is left for its landing or the operator`)
    }
    let commit: string | undefined
    if ((await inside(['status', '--porcelain', '--untracked-files=all'])).trim()) {
      await inside(['add', '--all'])
      const staged = await inside(['diff', '--cached', '--quiet']).then(() => false, () => true)
      if (staged) {
        await inside(['commit', '--quiet', '--no-verify', '-m', `${keptSubject(row.workflow_run_id)}\n\nCommitted by system before the run's worktree was removed.`])
        commit = (await inside(['rev-parse', 'HEAD'])).trim()
      }
    }
    // Refused while anything is left uncommitted, or while the worktree is locked: it then stays.
    await git(row.repository, ['worktree', 'remove', row.path])
    try {
      rmdirSync(dirname(row.path))
    } catch {
      // Other runs' worktrees of the repository are still there.
    }
    return commit
  }

  /** The stored worktree is still this run's: its `.git` file points to its own directory, and it is on its branch. */
  private async verify(row: WorktreeRow): Promise<void> {
    if (pointer(row.path) !== row.gitdir) throw new WorktreeError(`the .git file of ${row.path} no longer points to the worktree's own directory ${row.gitdir}; it is left for the operator`)
    const head = (await git(row.path, [`--git-dir=${row.gitdir}`, `--work-tree=${row.path}`, 'symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim()
    if (head !== `refs/heads/${row.branch}`) throw new WorktreeError(`${row.path} is ${head ? `on ${head}` : 'detached'}, not on ${row.branch}; it is left for the operator`)
  }

  private row(repository: string, runId: string): WorktreeRow | undefined {
    return this.ctx.store.db.prepare('SELECT * FROM agent_worktrees WHERE repository = ? AND workflow_run_id = ?').get(repository, runId) as WorktreeRow | undefined
  }

  /** Run `task` after every earlier one for `repository`: one worktree change at a time per repository. */
  private exclusive<T>(repository: string, task: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(repository) ?? Promise.resolve()).then(task)
    const settled = result.then(() => undefined, () => undefined)
    this.queues.set(repository, settled)
    void settled.then(() => {
      if (this.queues.get(repository) === settled) this.queues.delete(repository)
    })
    return result
  }
}
