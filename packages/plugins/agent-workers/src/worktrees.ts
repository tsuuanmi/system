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
 * holding the committed tree as its change: what a fresh worktree is, plus the earlier work.
 *
 * git runs with fixed argument lists, always with `-C <path>`, no shell, no hooks, no system or
 * global configuration (as the subject capture, `captureGitSubject`), and bounded time. Inside a
 * worktree, git is pointed at the worktree's own administrative directory recorded at creation,
 * never at whatever the worktree's `.git` file says later: an agent can write that file.
 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
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

/**
 * A worktree cut from an earlier run's work (ADR-0061): that workflow run, and the commit on its
 * branch the worktree holds, set once the tree is in it (absent meanwhile: no agent runs there).
 */
export const CARRY_MIGRATION = {
  version: 15,
  sql: `ALTER TABLE agent_worktrees ADD COLUMN carried_from TEXT;
  ALTER TABLE agent_worktrees ADD COLUMN carried_commit TEXT;`,
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

/** `git -C dir …`, bounded; rejects with what git said. */
async function git(dir: string, args: string[]): Promise<string> {
  try {
    return (await execFileAsync('git', ['-C', dir, ...SAFE, ...args], { env: ENV, timeout: GIT_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 })).stdout
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean }
    const said = e.code === 'ENOENT' ? 'git is not installed'
      : e.killed ? `it took longer than ${GIT_MS / 1000} s`
        : (e.stderr ?? '').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('hint:')).join(' ') || e.message
    throw new WorktreeError(`git ${args.find((a) => !a.startsWith('-')) ?? ''} in ${dir}: ${said.slice(0, 300)}`)
  }
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
}

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
        if (row.carried_from !== null && row.carried_commit === null) throw new WorktreeError(`${row.path} was cut to start from the work of run ${row.carried_from}, and that work is not in it; nothing runs there, and it is left for the operator`)
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
      await git(repository, exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, 'HEAD'])
      const common = real(resolve(repository, (await git(repository, ['rev-parse', '--git-common-dir'])).trim()))
      const gitdir = pointer(path)
      if (!common || !gitdir || !under(gitdir, join(common, 'worktrees'))) throw new WorktreeError(`${path} was added, and its .git file does not point into the worktrees of ${repository}; it is left for the operator`)
      // Added again, it starts over: a later retirement is a decision of its own, and its setup runs again.
      // Its branch holds what it held (the retention committed it), so it is no longer a carried tree.
      this.ctx.store.transaction((db) => {
        db.prepare(`INSERT INTO agent_worktrees (repository, workflow_run_id, path, branch, gitdir, created_at, removed_at, decision, failure, failed_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
          ON CONFLICT (repository, workflow_run_id) DO UPDATE SET path = excluded.path, branch = excluded.branch, gitdir = excluded.gitdir, created_at = excluded.created_at,
          removed_at = NULL, decision = NULL, failure = NULL, failed_at = NULL, setup_hash = NULL, setup_decision = NULL, carried_from = NULL, carried_commit = NULL`).run(repository, runId, path, branch, gitdir, new Date().toISOString())
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
   * not, untracked files as added; a removed worktree's from its branch. git reads through the
   * worktree's own administrative directory, with no optional lock, hook, or external diff; an
   * untracked file is read only when it is a regular file under the worktree, never through a link.
   * Undefined when this source holds no worktree of the run; a worktree that cannot be read throws.
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
    let run: (args: string[]) => Promise<string>
    let against: string[]
    if (live) {
      await this.verify(row)
      run = (args) => git(row.path, [...READ, `--git-dir=${row.gitdir}`, `--work-tree=${row.path}`, ...args])
      head = (await run(['rev-parse', 'HEAD'])).trim()
      against = [(await git(row.repository, [...READ, 'merge-base', base.sha, head])).trim()]
    } else {
      run = (args) => git(row.repository, [...READ, ...args])
      head = (await run(['rev-parse', '--verify', `refs/heads/${row.branch}^{commit}`])).trim()
      const fork = (await run(['merge-base', base.sha, head])).trim()
      against = [fork, head]
    }
    const fork = against[0]!
    // One diff queue, read three ways in the same order: name and status, lines, and the patch.
    const statuses = (await run(['diff', ...DIFF, '--name-status', '-z', ...against])).split('\0').filter(Boolean)
    const numbers = (await run(['diff', ...DIFF, '--numstat', '-z', ...against])).split('\0')
    const patch = await run(['diff', ...DIFF, ...against])
    const files: ChangedFile[] = []
    for (let i = 0, n = 0; i < statuses.length && statuses[i];) {
      const code = statuses[i++]!
      const from = code.startsWith('R') || code.startsWith('C') ? statuses[i++] : undefined
      const path = statuses[i++]!
      // numstat -z: "added\tremoved\tpath" or, for a rename, "added\tremoved\t" then from and to.
      const counts = (numbers[n++] ?? '').split('\t')
      if (from !== undefined) n += 2
      const binary = counts[0] === '-'
      files.push({ path, status: code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : from !== undefined ? 'renamed' : 'modified', ...(from !== undefined ? { from } : {}),
        ...(binary ? { binary: true as const } : { added: Number(counts[0]) || 0, removed: Number(counts[1]) || 0 }) })
    }
    const blocks = patch ? patch.split(/^(?=diff --git )/m).filter((b) => b.startsWith('diff --git ')) : []
    // The patch's blocks are the queue's files in order; should git ever disagree with itself, no file gets another's diff.
    const matched = blocks.length === files.length
    if (live) {
      for (const path of (await run(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).sort()) files.push(this.untracked(row.path, path))
    }
    let total = 0
    let truncated = false
    const shown = files.slice(0, CHANGE_BOUNDS.files).map((file, i) => {
      const diff = file.diff ?? (matched && i < blocks.length && !file.binary ? blocks[i]!.trimEnd() : undefined)
      if (diff === undefined) return file
      const room = Math.min(CHANGE_BOUNDS.fileChars, CHANGE_BOUNDS.totalChars - total)
      if (room <= 0) { truncated = true; const { diff: _, ...rest } = file; return { ...rest, truncated: true } }
      const cut = diff.length > room
      total += Math.min(diff.length, room)
      if (cut) truncated = true
      return { ...file, diff: cut ? diff.slice(0, room) : diff, ...(cut ? { truncated: true } : {}) }
    })
    const more = Math.max(0, files.length - CHANGE_BOUNDS.files)
    return { repository: row.repository, workspace: row.path, branch: row.branch, base: { branch: base.branch, sha: fork }, head, files: shown, more, truncated: truncated || more > 0, ...(live ? {} : { fromBranch: true as const }) }
  }

  /** An untracked file of a worktree as an added file: a regular file read through one descriptor that follows no link, else said and not shown. */
  private untracked(root: string, path: string): ChangedFile {
    const full = resolve(root, path)
    // Under the worktree by its real path, its directory too: a link that leads out is never read.
    const top = real(root)
    const dir = real(dirname(full))
    if (!top || !dir || !under(full, root) || !under(dir, top) || path.split('/').includes('..')) return { path, status: 'added', note: 'outside the worktree, not read' }
    let fd: number
    try {
      fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY)
    } catch {
      return { path, status: 'added', note: 'a link or a file that cannot be opened, not read' }
    }
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile()) return { path, status: 'added', note: 'not a regular file, not read' }
      const size = Math.min(stat.size, CHANGE_BOUNDS.fileChars + 1)
      const buffer = Buffer.alloc(size)
      const read = size ? readSync(fd, buffer, 0, size, 0) : 0
      const bytes = buffer.subarray(0, read)
      if (bytes.includes(0)) return { path, status: 'added', binary: true }
      const lines = bytes.toString('utf8').split('\n')
      if (lines.at(-1) === '') lines.pop()
      return { path, status: 'added', added: lines.length, removed: 0,
        diff: `new file ${path} (untracked)\n${lines.map((l) => `+${l}`).join('\n')}`, ...(stat.size > CHANGE_BOUNDS.fileChars ? { truncated: true } : {}) }
    } finally {
      closeSync(fd)
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
      if (carried?.outcome !== 'carried' && cut && cut.removed_at === null && cut.carried_from === from.workflow_run_id && !cut.carried_commit) await this.unmark(cut, base)
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
        db.prepare(`INSERT INTO agent_worktrees (repository, workflow_run_id, path, branch, gitdir, created_at, removed_at, decision, failure, failed_at, carried_from, carried_commit) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL)
          ON CONFLICT (repository, workflow_run_id) DO UPDATE SET path = excluded.path, branch = excluded.branch, gitdir = excluded.gitdir, created_at = excluded.created_at,
          removed_at = NULL, decision = NULL, failure = NULL, failed_at = NULL, setup_hash = NULL, setup_decision = NULL, carried_from = excluded.carried_from, carried_commit = NULL`).run(repository, step.runId, path, branch, gitdir, new Date().toISOString(), from.workflow_run_id)
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
   * A worktree cut to hold an earlier run's work that it was never given: its index and files are put
   * back to the base it was cut at, and it is a fresh worktree a run may work in. No agent has run in
   * it ({@link acquire} refuses one so marked). One that cannot be put back stays marked, and nothing
   * runs in it.
   */
  private async unmark(cut: WorktreeRow, base: string): Promise<void> {
    const restored = pointer(cut.path) === cut.gitdir
      && await git(cut.path, [`--git-dir=${cut.gitdir}`, `--work-tree=${cut.path}`, 'read-tree', '-u', '--reset', base]).then(() => true, () => false)
    if (restored) this.ctx.store.transaction((db) => void db.prepare('UPDATE agent_worktrees SET carried_from = NULL WHERE repository = ? AND workflow_run_id = ?').run(cut.repository, cut.workflow_run_id))
    else this.ctx.logger.warn(`agent Workers: the worktree ${cut.path} of run ${cut.workflow_run_id} was cut for the work of run ${cut.carried_from} and could not be put back to ${base}; nothing runs in it, and it is left for the operator`)
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

  /** Commit what the worktree holds on its branch, then remove it (never forced). Returns the new commit, if any. */
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
    let commit: string | undefined
    if ((await inside(['status', '--porcelain', '--untracked-files=all'])).trim()) {
      await inside(['add', '--all'])
      const staged = await inside(['diff', '--cached', '--quiet']).then(() => false, () => true)
      if (staged) {
        await inside(['commit', '--quiet', '--no-verify', '-m', `system: keep the uncommitted work of workflow run ${row.workflow_run_id}\n\nCommitted by system before the run's worktree was removed.`])
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
