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
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeSync } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import { BRIEF_FILE_PATH, captureGitSubject, ensurePrivateDir, subjectId } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-store'
import { type Carried, type CarryRefusal, type CarryStep, CHANGE_BOUNDS, type ChangedFile, type Landed, type LandStep, type WorkChange } from '@tsuuanmi/system-workers-core'

/** A workflow run id as it may name a branch and a directory: letters, digits, `_`, `-`. */
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
/** git 2.17 added `git worktree remove`. */
export const WORKTREE_GIT_FLOOR = [2, 17] as const
/** At most this many worktrees are retired by one sweep; the rest wait for the next. */
export const SWEEP_BATCH = 50
/** Who commits a worktree's pending changes before it is removed. */
export const SYSTEM_AUTHOR = { name: 'system', email: 'system@localhost' } as const

/** The trailer a landing's commit carries: the exact subject it holds, so a commit repeated after a restart is found done (INV-4). */
export const SUBJECT_TRAILER = 'System-Subject'
/** The trailer the commit of a carried tree carries: the workflow run whose worktree starts from it (ADR-0061). */
export const CARRIED_TRAILER = 'System-Carried-To'
/** The first line of the commit by which the retention keeps a worktree's uncommitted work on its branch. */
export const keptSubject = (runId: string): string => `system: keep the uncommitted work of workflow run ${runId}`

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
export class WorktreeError extends Error {
  override readonly name = 'WorktreeError'
}

/** What a failed git said, as one line: its stderr without hints, else `fallback`. */
const said = (stderr: string, fallback: string): string => stderr.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('hint:')).join(' ') || fallback

/** The error of a git run in `dir` that failed: its subcommand, and why. */
const failed = (dir: string, args: string[], why: string): WorktreeError => new WorktreeError(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''} in ${dir}: ${why.slice(0, 300)}`)

/** `git -C dir …`, bounded; rejects with what git said. */
async function git(dir: string, args: string[]): Promise<string> {
  try {
    return (await execFileAsync('git', ['-C', dir, ...SAFE, ...args], { env: ENV, timeout: GIT_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 })).stdout
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

export const branchOf = (runId: string): string => `system/run/${runId}`

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

  /** `root` is where worktrees go: `<root>/<repository key>/<runId>`. */
  constructor(private readonly ctx: Pick<Context, 'store' | 'artifacts' | 'logger'>, private readonly root: string) {}

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
   */
  async place(workspace: string, files: ReadonlyArray<{ path: string; text: string }>): Promise<void> {
    if (!files.length) return
    const row = this.ctx.store.db.prepare('SELECT gitdir FROM agent_worktrees WHERE path = ? AND removed_at IS NULL').get(workspace) as { gitdir: string } | undefined
    if (!row || pointer(workspace) !== row.gitdir) throw new WorktreeError(`${workspace} is not an intact worktree of a run; no file is written there`)
    for (const file of files) if (!BRIEF_FILE_PATH.test(file.path)) throw new WorktreeError(`${JSON.stringify(file.path)} is not a file under .system/; nothing is written`)
    const tracked = await git(workspace, [`--git-dir=${row.gitdir}`, `--work-tree=${workspace}`, 'ls-files', '-z', '--', '.system'])
    if (tracked.length) throw new WorktreeError(`the repository tracks files under .system/ (${tracked.split('\0')[0]}); system's workspace files would change them, so none is written`)
    const dir = join(workspace, '.system')
    // Made when absent (mkdir never follows a link at its name), then opened as itself.
    try {
      mkdirSync(dir, { mode: 0o755 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const opened = openDirectory(dir)
    if (typeof opened === 'string') throw new WorktreeError(`${dir} is not a directory of the worktree; nothing is written`)
    try {
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
      plans.push(await this.exclusive(row.repository, () => this.planOne(row, commit, freeing)))
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
    for (const row of rows) plans.push({ runId: row.workflow_run_id, ...await this.exclusive(row.repository, () => this.planOne(row, commit, null)) })
    return { plans, more: total - rows.length }
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
        const again = await this.planOne(row, commit, freeing)
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
    return this.exclusive(row.repository, () => (step.step === 'commit' ? this.commitAccepted(row, step) : this.merge(row, step)))
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
   * - only while that subject's commit is still the repository's HEAD, where a fresh worktree is cut
   *   from: the carry never moves a run onto another base;
   * - the new worktree is added on the run's branch at that commit and given the committed tree, staged,
   *   so its subject is the base with the earlier change on top, as if the change had been made in it.
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
        return { outcome: 'carried', repository, from: { branch: from.branch, commit: earlier.carried_commit }, base, branch: earlier.branch, worktree: earlier.path, carried: false }
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
    // A fresh worktree is cut from the repository's HEAD: the earlier work is carried only onto that same commit.
    const head = (await git(repository, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(() => '')).trim()
    if (!cut && head !== base) return refuse('base-moved', `the HEAD of ${repository} is ${head || 'unreadable'} now, not ${base}, the commit the tree ${subject} is on: a fresh worktree starts from the HEAD, so the earlier work is not carried onto another base`)
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
    if (!cut) {
      // Added on its own branch at the base, its files not checked out: the commit's tree is read in next.
      await git(repository, ['worktree', 'add', '--no-checkout', '-b', branch, path, base])
      const common = real(resolve(repository, (await git(repository, ['rev-parse', '--git-common-dir'])).trim()))
      const gitdir = pointer(path)
      if (!common || !gitdir || !under(gitdir, join(common, 'worktrees'))) throw new WorktreeError(`${path} was added, and its .git file does not point into the worktrees of ${repository}; it is left for the operator`)
      this.ctx.store.transaction((db) => {
        db.prepare(`INSERT INTO agent_worktrees (repository, workflow_run_id, path, branch, gitdir, created_at, removed_at, decision, failure, failed_at, carried_from, carried_commit, forked_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, ?)
          ON CONFLICT (repository, workflow_run_id) DO UPDATE SET path = excluded.path, branch = excluded.branch, gitdir = excluded.gitdir, created_at = excluded.created_at,
          removed_at = NULL, decision = NULL, failure = NULL, failed_at = NULL, setup_hash = NULL, setup_decision = NULL, carried_from = excluded.carried_from, carried_commit = NULL, forked_at = excluded.forked_at`).run(repository, step.runId, path, branch, gitdir, new Date().toISOString(), from.workflow_run_id, base)
      })
      cut = this.row(repository, step.runId)!
    }
    if (pointer(cut.path) !== cut.gitdir) return refuse('failed', `the .git file of ${cut.path} no longer points to the worktree's own directory ${cut.gitdir}; it is left for the operator`)
    try {
      // Index and files become the commit's tree; HEAD stays at the base, so the earlier change is the worktree's own change.
      await git(cut.path, [`--git-dir=${cut.gitdir}`, `--work-tree=${cut.path}`, 'read-tree', '-u', '--reset', commit])
    } catch (error) {
      return refuse('failed', `the work of ${from.branch} at ${commit} could not be read into ${cut.path}: ${(error as Error).message}`)
    }
    this.ctx.store.transaction((db) => void db.prepare('UPDATE agent_worktrees SET carried_commit = ? WHERE repository = ? AND workflow_run_id = ?').run(commit, repository, step.runId))
    this.ctx.logger.info(`agent Workers: run ${step.runId} works in ${cut.path} on ${cut.branch}, starting from the work of run ${from.workflow_run_id} (${commit} on ${from.branch}, on top of ${base})`)
    return { outcome: 'carried', repository, from: { branch: from.branch, commit }, base, branch: cut.branch, worktree: cut.path, carried: true }
  }

  /** The earlier worktree is clean, and its HEAD is the system's commit of `subject` for `runId` on top of `base`: committed before a restart. */
  private async carriedCommit(inside: (args: string[]) => Promise<string>, base: string, subject: string, runId: string): Promise<boolean> {
    if ((await inside(['status', '--porcelain', '--untracked-files=all'])).trim()) return false
    const [parent, author, ...message] = (await inside(['log', '-1', '--format=%P%n%an <%ae>%n%B', 'HEAD'])).split('\n')
    return parent === base && author === `${SYSTEM_AUTHOR.name} <${SYSTEM_AUTHOR.email}>` && message.includes(`${SUBJECT_TRAILER}: ${subject}`) && message.includes(`${CARRIED_TRAILER}: ${runId}`)
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
    } else if (!(await this.landedCommit(row, inside, step.subject.ref, accepted))) {
      return { outcome: 'refused', cause: 'moved', reason: `the worktree ${row.path} is now ${subjectId(current.subject)}, not the accepted ${accepted}: it changed after the acceptance, so nothing is committed` }
    }
    const head = (await inside(['rev-parse', 'HEAD'])).trim()
    const base = await this.baseOf(row.repository)
    if ('problem' in base) return { outcome: 'refused', cause: 'base-moved', reason: base.problem }
    const contained = await this.contains(row.repository, base.sha, head)
    const stat = contained ? '' : (await git(row.repository, ['diff', '--stat=100', '--no-color', '--no-ext-diff', '--no-textconv', `${base.sha}...${head}`])).trimEnd()
    return { outcome: 'committed', repository: row.repository, branch: row.branch, head, committed, base, contained, stat: stat.length > STAT_CHARS ? `${stat.slice(0, STAT_CHARS)}\n…` : stat }
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
      const asWas = after === step.base.sha && !left ? 'the merge was aborted, and the repository is as it was' : `the merge was aborted, and ${repository} is not as it was (HEAD ${after}${left ? ', with changes' : ''}): look at it`
      return { outcome: 'refused', cause: 'conflict', reason: `${row.branch} conflicts with ${base.branch} at ${base.sha}${conflicts.length ? ` in ${conflicts.slice(0, 10).join(', ')}${conflicts.length > 10 ? ` and ${conflicts.length - 10} more` : ''}` : ''}: ${asWas}` }
    }
    const commit = (await git(repository, ['rev-parse', 'HEAD'])).trim()
    if (!(await this.contains(repository, commit, step.head))) return { outcome: 'refused', cause: 'failed', reason: `${base.branch} is at ${commit} after the merge, which does not hold ${step.head}; look at ${repository}` }
    return { outcome: 'merged', repository, branch: row.branch, head: step.head, base: step.base, commit, already: false }
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
