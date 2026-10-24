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
 * git runs with fixed argument lists, always with `-C <path>`, no shell, no hooks, no system or
 * global configuration (as the subject capture, `captureGitSubject`), and bounded time. Inside a
 * worktree, git is pointed at the worktree's own administrative directory recorded at creation,
 * never at whatever the worktree's `.git` file says later: an agent can write that file.
 */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import { BRIEF_FILE_PATH, ensurePrivateDir } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-store'

/** A workflow run id as it may name a branch and a directory: letters, digits, `_`, `-`. */
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
/** git 2.17 added `git worktree remove`. */
export const WORKTREE_GIT_FLOOR = [2, 17] as const
/** At most this many worktrees are retired by one sweep; the rest wait for the next. */
export const SWEEP_BATCH = 50
/** Who commits a worktree's pending changes before it is removed. */
export const SYSTEM_AUTHOR = { name: 'system', email: 'system@localhost' } as const

const GIT_MS = 60_000
const execFileAsync = promisify(execFile)
const ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  // Every ref the system moves (a new branch, a commit) is the system's, whoever the operator is.
  GIT_AUTHOR_NAME: SYSTEM_AUTHOR.name, GIT_AUTHOR_EMAIL: SYSTEM_AUTHOR.email, GIT_COMMITTER_NAME: SYSTEM_AUTHOR.name, GIT_COMMITTER_EMAIL: SYSTEM_AUTHOR.email,
}
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'submodule.recurse=false']

/**
 * A worktree whose workflow run has no agent run queued or running, none that ended without being
 * known to be gone (its agent may still write there: the worktree stays, INV-15; PROP-0013), and
 * whose last one ended before the cutoff (`?`).
 */
const IDLE = `NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.workflow_run_id = w.workflow_run_id AND r.status IN ('queued', 'running'))
  AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.workflow_run_id = w.workflow_run_id AND r.liveness_decision IS NOT NULL AND COALESCE(r.liveness_verdict, '') != 'dead')
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
}

export type RepositoryCheck = { repository: string } | { problem: string }

export interface SweepOutcome {
  removed: string[]
  /** Worktrees left in place: their commit or removal failed, and the next sweep tries again. */
  kept: string[]
}

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
      this.ctx.store.transaction((db) => {
        db.prepare(`INSERT INTO agent_worktrees (repository, workflow_run_id, path, branch, gitdir, created_at, removed_at, decision, failure, failed_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
          ON CONFLICT (repository, workflow_run_id) DO UPDATE SET path = excluded.path, branch = excluded.branch, gitdir = excluded.gitdir, created_at = excluded.created_at,
          removed_at = NULL, decision = NULL, failure = NULL, failed_at = NULL, setup_hash = NULL, setup_decision = NULL`).run(repository, runId, path, branch, gitdir, new Date().toISOString())
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
      ORDER BY failed_at IS NOT NULL, failed_at, created_at LIMIT ?`).all(cutoff, SWEEP_BATCH) as unknown as WorktreeRow[]
    for (const candidate of due) {
      if (stopped.aborted) break
      await this.exclusive(candidate.repository, async () => {
        // Looked at again alone: a run of the workflow run may have taken the worktree meanwhile.
        const row = this.ctx.store.db.prepare(`SELECT * FROM agent_worktrees w WHERE repository = ? AND workflow_run_id = ? AND removed_at IS NULL AND ${IDLE}`)
          .get(candidate.repository, candidate.workflow_run_id, cutoff) as WorktreeRow | undefined
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
    // system's own workspace files (`.system/`, see place) are never part of the work: gone before the commit,
    // even if the agent changed their .gitignore. A `.system` the repository tracks is the repository's,
    // and one that is not a plain directory is left to the commit. Emptied through its descriptor, as
    // place writes it, then removed by name: rmdir takes only an empty directory, never a link.
    const system = join(row.path, '.system')
    const own = openDirectory(system)
    if (typeof own === 'object') {
      try {
        if (!(await inside(['ls-files', '-z', '--', '.system'])).length) {
          for (const entry of readdirSync(own.at)) rmSync(join(own.at, entry), { recursive: true, force: true })
          rmdirSync(system)
        }
      } finally {
        closeSync(own.fd)
      }
    }
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
