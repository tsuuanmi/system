/**
 * The daily check (T305b, D104): since T305 a change that does not touch the browser stack is not
 * checked against the browser specs before it lands, so a change that breaks one indirectly is caught
 * only by a full run. Once a day, from a configured UTC hour, the whole suite with every browser test
 * runs on the tip of a branch (default `dev`) of a repository: by the Worker source that holds the
 * repository (`ctx.workers.checkTip`), in a worktree of its own cut at that commit, confined and
 * read-only like an acceptance check, in the host's one queue of checks (T292), with the scope `daily`
 * (scripts/test-groups.ts). A pass is recorded. A failure proposes one board task: the failing tests'
 * names and assertions (T270's bound), the commit, and the last green commit; none while an earlier
 * one is open. A run that did not run to an exit code (no source, a refused setup, a timeout) is
 * recorded as an error and files nothing: it says nothing of the tree (INV-2). Off unless the
 * operator sets `dailyCheck.enabled`. A run the host stopped is resumed at the next start (INV-4):
 * its check is stored by its id, so the suite is never run twice for one row.
 *
 * Bounds (INV-9): one scheduled run a day, one task per failure, the failing lines of the check's own
 * bound, a deadline for the run.
 */
import type { BoardTask } from '@tsuuanmi/system-board-core'
import { clampText } from '@tsuuanmi/system-libs'
import { MAX_FAILURE_LINE_CHARS, MAX_FAILURE_LINES } from './checks.ts'
import type { Engine } from './engine.ts'
import { commitOf, dayOf, OPEN_STATES, squeeze } from './scheduled-review.ts'
import { type Config, type DailyCheckConfig, now } from './types.ts'

const DAILY_CHECK_DEFAULTS = { ref: 'dev', hourUtc: 4, timeoutMinutes: 180, actionClass: 'workspace-write' } as const

export interface DailyCheckSettings {
  enabled: boolean
  projectId?: string
  repository?: string
  ref: string
  hourUtc: number
  timeoutMinutes: number
  actionClass: string
  taskTemplate?: string
}

const KEYS = ['enabled', 'projectId', 'repository', 'ref', 'hourUtc', 'timeoutMinutes', 'actionClass', 'taskTemplate']
const PROJECT = /^[a-z][a-z0-9-]{0,23}$/
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
const NAME = /^[a-z][a-z0-9-]{0,63}$/

/** What this code would refuse in `dailyCheck` (at load, and `system check`): empty when it is fine. */
export function dailyCheckProblems(config: Pick<Config, 'dailyCheck'> = {}): string[] {
  const c: unknown = config.dailyCheck
  if (c === undefined) return []
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return ['dailyCheck must be an object']
  const v = c as Record<string, unknown>
  const problems = Object.keys(v).filter((k) => !KEYS.includes(k)).slice(0, 8).map((k) => `dailyCheck.${k} is not an option; it takes ${KEYS.join(', ')}`)
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') problems.push('dailyCheck.enabled must be true or false')
  for (const [key, min, max] of [['hourUtc', 0, 23], ['timeoutMinutes', 1, 1440]] as const) {
    if (v[key] !== undefined && (!Number.isInteger(v[key]) || (v[key] as number) < min || (v[key] as number) > max)) problems.push(`dailyCheck.${key} must be a whole number from ${min} to ${max}`)
  }
  const text = (key: string, pattern: RegExp, what: string): void => {
    if (v[key] !== undefined && (typeof v[key] !== 'string' || !pattern.test(v[key] as string))) problems.push(`dailyCheck.${key} must be ${what}`)
  }
  text('projectId', PROJECT, 'a project id (a lowercase letter, then lowercase letters, digits, and hyphens, at most 24)')
  text('ref', REF, 'a branch or ref name')
  text('actionClass', /^[a-z][a-z-]{0,31}$/, 'an action class')
  text('taskTemplate', NAME, 'a template name')
  if (v.repository !== undefined && (typeof v.repository !== 'string' || !v.repository.startsWith('/') || v.repository.length > 1024)) problems.push('dailyCheck.repository must be the absolute path of a git repository')
  if (v.enabled === true) {
    if (v.projectId === undefined) problems.push('dailyCheck.projectId is required when it is enabled: the board project the failure is proposed in')
    if (v.repository === undefined) problems.push('dailyCheck.repository is required when it is enabled: the repository whose tip is checked')
  }
  return problems
}

/** The settings with their defaults; a configuration `dailyCheckProblems` refuses is refused here too. */
export function dailyCheckSettings(config: Pick<Config, 'dailyCheck'> = {}): DailyCheckSettings {
  const problems = dailyCheckProblems(config)
  if (problems.length) throw new TypeError(`workflow: ${problems.join('; ')}`)
  const c: DailyCheckConfig = config.dailyCheck ?? {}
  return {
    enabled: c.enabled ?? false, ...(c.projectId ? { projectId: c.projectId } : {}), ...(c.repository ? { repository: c.repository } : {}),
    ref: c.ref ?? DAILY_CHECK_DEFAULTS.ref, hourUtc: c.hourUtc ?? DAILY_CHECK_DEFAULTS.hourUtc, timeoutMinutes: c.timeoutMinutes ?? DAILY_CHECK_DEFAULTS.timeoutMinutes,
    actionClass: c.actionClass ?? DAILY_CHECK_DEFAULTS.actionClass, ...(c.taskTemplate ? { taskTemplate: c.taskTemplate } : {}),
  }
}

/** A daily run as its row keeps it. `error`: the check did not run to an exit code on the tip (`problem` says why). */
export interface DailyCheckRow {
  checkId: string
  day: string
  trigger: 'schedule' | 'manual'
  ref: string
  commit: string
  state: 'running' | 'passed' | 'failed' | 'error'
  problem?: string
  /** The failing lines of a failed run: its tests' names and assertions, bounded. */
  failures: string[]
  evidence?: string
  /** The latest earlier run that passed, when a failure was filed against it. */
  lastGreen?: string
  /** The task a failure proposed, or the open task it was a duplicate of (`duplicate`). */
  taskId?: string
  duplicate: boolean
  startedAt: string
  finishedAt?: string
}

interface Stored {
  check_id: string; day: string; trigger: string; repo_ref: string; commit_sha: string; state: string; problem: string | null; failures: string; evidence: string | null
  last_green: string | null; task_id: string | null; duplicate: number; started_at: string; finished_at: string | null
}

const viewOf = (r: Stored): DailyCheckRow => ({
  checkId: r.check_id, day: r.day, trigger: r.trigger as DailyCheckRow['trigger'], ref: r.repo_ref, commit: r.commit_sha, state: r.state as DailyCheckRow['state'],
  ...(r.problem ? { problem: r.problem } : {}), failures: JSON.parse(r.failures) as string[], ...(r.evidence ? { evidence: r.evidence } : {}), ...(r.last_green ? { lastGreen: r.last_green } : {}),
  ...(r.task_id ? { taskId: r.task_id } : {}), duplicate: r.duplicate === 1, startedAt: r.started_at, ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
})

export interface DailyCheckReport {
  enabled: boolean
  ref: string
  hourUtc: number
  /** The latest run, running or ended. */
  last?: DailyCheckRow
  /** The latest run that passed. */
  lastGreen?: DailyCheckRow
  /** Each run, the latest first, at most `limit`. */
  runs: DailyCheckRow[]
}

/** The report as text: the latest run and the last green commit. */
export function renderDailyReport(report: DailyCheckReport): string {
  if (!report.last) return report.enabled ? `No daily run yet: it runs once a day on ${report.ref}, from ${String(report.hourUtc).padStart(2, '0')}:00 UTC.` : 'The daily run is off (dailyCheck.enabled).'
  const l = report.last
  return [
    `Last daily run: ${l.state} on ${l.ref} at ${l.commit.slice(0, 12)}, ${l.startedAt.slice(0, 16).replace('T', ' ')} UTC${l.problem ? ` (${l.problem.slice(0, 120)})` : ''}${l.taskId ? `; task ${l.taskId}${l.duplicate ? ' (open already)' : ''}` : ''}`,
    report.lastGreen ? `Last green: ${report.lastGreen.commit.slice(0, 12)} on ${report.lastGreen.day}` : 'No daily run has passed yet.',
  ].join('\n')
}

export class DailyChecks {
  readonly settings: DailyCheckSettings
  private running: Promise<DailyCheckRow | undefined> | undefined

  constructor(private readonly e: Engine) {
    // A setting out of its range refuses the row, with its path (INV-2).
    this.settings = dailyCheckSettings(e.config)
  }

  get enabled(): boolean {
    return this.settings.enabled
  }

  /**
   * The timer's pass, at `at`: when enabled, from the configured UTC hour, and no scheduled run is
   * recorded for the day, the tip is checked. Never throws: a failure is recorded on the row, or logged.
   * A run a stop left running is resumed first, schedule on or not (INV-4).
   */
  async tick(at: Date = new Date()): Promise<DailyCheckRow | undefined> {
    const s = this.settings
    void this.reconcile()
    if (!s.enabled || at.getUTCHours() < s.hourUtc || this.e.draining || this.e.stopped.signal.aborted) return undefined
    if (this.running) return this.running
    if (this.e.ctx.store.db.prepare("SELECT 1 FROM workflow_daily_checks WHERE day = ? AND trigger = 'schedule'").get(dayOf(at))) return undefined
    return this.guarded(() => this.start(at, 'schedule'))
  }

  /** A run now, outside the schedule (the operator's, or a test's). */
  async now(at: Date = new Date()): Promise<DailyCheckRow | undefined> {
    if (this.running) return this.running
    return this.guarded(() => this.start(at, 'manual'))
  }

  /** Resume every run a stop or restart left running: its check is stored by its id, so the suite never runs twice for it (INV-4). */
  reconcile(): Promise<Array<DailyCheckRow | undefined>> {
    const e = this.e
    if (!e.board || e.stopped.signal.aborted || this.running) return Promise.resolve([])
    const rows = e.ctx.store.db.prepare("SELECT check_id FROM workflow_daily_checks WHERE state = 'running' ORDER BY started_at").all() as Array<{ check_id: string }>
    if (!rows.length) return Promise.resolve([])
    const resumed = Promise.all(rows.map((r) => this.settle(r.check_id).catch((error: unknown) => this.fail(r.check_id, error)))).finally(() => {
      this.running = undefined
    })
    this.running = resumed.then((all) => all[0])
    return resumed
  }

  private guarded(run: () => Promise<DailyCheckRow>): Promise<DailyCheckRow | undefined> {
    const started = run().catch((error: unknown) => {
      this.e.ctx.logger.warn(`workflow: the daily check did not run: ${(error as Error)?.message ?? String(error)}`)
      return undefined
    }).finally(() => {
      this.running = undefined
    })
    this.running = started
    return started
  }

  /** Each run, the latest first, with the latest and the latest green. */
  report(limit = 30): DailyCheckReport {
    const db = this.e.ctx.store.db
    const runs = (db.prepare('SELECT * FROM workflow_daily_checks ORDER BY started_at DESC, check_id DESC LIMIT ?').all(Math.max(1, Math.min(limit, 1000))) as unknown as Stored[]).map(viewOf)
    const green = db.prepare("SELECT * FROM workflow_daily_checks WHERE state = 'passed' ORDER BY started_at DESC, check_id DESC LIMIT 1").get() as unknown as Stored | undefined
    return { enabled: this.settings.enabled, ref: this.settings.ref, hourUtc: this.settings.hourUtc, ...(runs[0] ? { last: runs[0] } : {}), ...(green ? { lastGreen: viewOf(green) } : {}), runs }
  }

  private row(checkId: string): DailyCheckRow {
    return viewOf(this.e.ctx.store.db.prepare('SELECT * FROM workflow_daily_checks WHERE check_id = ?').get(checkId) as unknown as Stored)
  }

  private write(id: string, fields: Record<string, string | number | null>): void {
    const names = Object.keys(fields)
    this.e.ctx.store.db.prepare(`UPDATE workflow_daily_checks SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE check_id = ?`).run(...names.map((n) => fields[n]!), id)
  }

  /** A run that threw is recorded as an error on its row, or logged when that cannot be. */
  private fail(checkId: string, error: unknown): DailyCheckRow | undefined {
    try {
      this.write(checkId, { state: 'error', finished_at: now(), problem: clampText((error as Error)?.message ?? String(error), 500) })
      return this.row(checkId)
    } catch {
      this.e.ctx.logger.warn(`workflow: the daily check ${checkId} was not settled: ${(error as Error)?.message ?? String(error)}`)
      return undefined
    }
  }

  private async start(at: Date, trigger: 'schedule' | 'manual'): Promise<DailyCheckRow> {
    const e = this.e
    const s = this.settings
    const problems = dailyCheckProblems(e.config)
    if (problems.length) throw new Error(problems.join('; '))
    if (!s.projectId || !s.repository) throw new Error('dailyCheck.projectId and dailyCheck.repository are required')
    if (!e.board) throw new Error('there is no board to propose a failure on')
    const sha = commitOf(s.repository, s.ref)
    const day = dayOf(at)
    // The id names the worktree and the stored check: a manual run of the same commit and day finds the same outcome.
    const checkId = `daily-${day}-${sha.slice(0, 12)}${trigger === 'manual' ? `-m${at.getTime().toString(36)}` : ''}`
    e.ctx.store.db.prepare(`INSERT INTO workflow_daily_checks (check_id, day, trigger, repo_ref, commit_sha, state, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)`)
      .run(checkId, day, trigger, s.ref, sha, at.toISOString())
    return (await this.settle(checkId).catch((error: unknown) => this.fail(checkId, error))) ?? this.row(checkId)
  }

  /** Run the row's check and record what it came to; a failure is filed. The engine stopping leaves the row running, for {@link reconcile}. */
  private async settle(checkId: string): Promise<DailyCheckRow> {
    const e = this.e
    const s = this.settings
    const stored = this.row(checkId)
    const finish = (state: 'passed' | 'failed' | 'error', fields: Record<string, string | number | null>): DailyCheckRow => {
      this.write(checkId, { state, finished_at: now(), ...fields })
      return this.row(checkId)
    }
    if (typeof e.ctx.workers.checkTip !== 'function') return finish('error', { problem: 'the workers seam runs no check on a tip (ctx.workers.checkTip)' })
    if (!s.repository) return finish('error', { problem: 'dailyCheck.repository is not set any more' })
    const signal = AbortSignal.any([e.stopped.signal, AbortSignal.timeout(s.timeoutMinutes * 60_000)])
    let checked: Awaited<ReturnType<NonNullable<typeof e.ctx.workers.checkTip>>>
    try {
      checked = await e.ctx.workers.checkTip({ runId: checkId, repository: s.repository, commit: stored.commit, classification: 'operator-shared' }, signal)
    } catch (error) {
      // The host stopping: the run is resumed at the next start. Its deadline: an error, never a pass.
      if (e.stopped.signal.aborted) return this.row(checkId)
      return finish('error', { problem: signal.aborted ? `the run did not finish within ${s.timeoutMinutes} minutes` : clampText((error as Error)?.message ?? String(error), 500) })
    }
    if (!checked) return finish('error', { problem: `no Worker source holds ${s.repository} with a setup (agent-workers worktreeSetup) that runs its tests check on a tip` })
    if (checked.outcome === 'refused') return finish('error', { problem: clampText(`source ${checked.source} refused (${checked.cause}): ${checked.reason}`, 500) })
    const { result } = checked
    const evidence = checked.evidence ?? null
    // A pass that did not run the browser specs says nothing of them, and they are what this run is for:
    // an error, never a pass, so it never becomes the last green commit (INV-2).
    if (result.outcome === 'passed' && result.notRun) return finish('error', { evidence, problem: clampText(`its command exited 0 without running ${result.notRun}: this run is for them, so it is not a pass`, 500) })
    if (result.outcome === 'passed') return finish('passed', { evidence, problem: null })
    if (result.outcome === 'error') return finish('error', { evidence, problem: clampText(result.reason, 500) })
    const failures = (result.failures ?? []).slice(0, MAX_FAILURE_LINES).map((line) => String(line).slice(0, MAX_FAILURE_LINE_CHARS))
    const lastGreen = (e.ctx.store.db.prepare("SELECT commit_sha FROM workflow_daily_checks WHERE state = 'passed' AND check_id != ? ORDER BY started_at DESC, check_id DESC LIMIT 1").get(checkId) as { commit_sha: string } | undefined)?.commit_sha ?? null
    this.write(checkId, { failures: JSON.stringify(failures), evidence, last_green: lastGreen, problem: clampText(result.reason, 500) })
    try {
      const filed = await this.file(checkId, this.row(checkId), result.exitCode, failures, lastGreen)
      return finish('failed', { task_id: filed.taskId ?? null, duplicate: filed.duplicate ? 1 : 0 })
    } catch (error) {
      // The failure stands, and says that its task was not proposed.
      return finish('failed', { problem: clampText(`${result.reason}; its task was not proposed: ${(error as Error)?.message ?? String(error)}`, 500) })
    }
  }

  /** The failure as one proposed task, unless an earlier run's task, or a task of the same title, is still open. */
  private async file(checkId: string, run: DailyCheckRow, exitCode: number | undefined, failures: string[], lastGreen: string | null): Promise<{ taskId?: string; duplicate: boolean }> {
    const e = this.e
    const s = this.settings
    const board = e.board
    if (!board || !s.projectId) throw new Error('there is no board to propose a failure on')
    const open = new Set(OPEN_STATES as readonly string[])
    const title = clampText(`Daily run of every browser spec failed on ${s.ref}`, 200)
    // An earlier run's task, while it is open: the failure is that task's until it is done or cancelled.
    const earlier = e.ctx.store.db.prepare('SELECT task_id FROM workflow_daily_checks WHERE task_id IS NOT NULL AND check_id != ? ORDER BY started_at DESC').all(checkId) as Array<{ task_id: string }>
    for (const { task_id } of earlier) {
      const state = (await board.task(task_id))?.state
      if (state && open.has(state)) return { taskId: task_id, duplicate: true }
    }
    const same = (await board.tasks({ projectId: s.projectId, states: [...OPEN_STATES] })).find((t: BoardTask) => squeeze(t.title) === squeeze(title))
    if (same) return { taskId: same.taskId, duplicate: true }
    const task = await board.propose({
      projectId: s.projectId, title, actionClass: s.actionClass as BoardTask['actionClass'], ...(s.taskTemplate ? { template: s.taskTemplate } : {}),
      goal: clampText([
        `The daily run of the whole suite, every browser spec with it, failed on the tip of ${s.ref}, commit ${run.commit} (exit code ${exitCode ?? 'unknown'}). A change that touched no browser code is not checked against the browser specs before it lands (T305), so a change that broke one indirectly is found here.`,
        `Commit: ${run.commit}`,
        `Last green commit: ${lastGreen ?? 'none recorded: no daily run has passed yet'}`,
        'Failing tests, their names and assertions:',
        ...(failures.length ? failures : ['(the check printed no failing line it could read: see the check-run evidence)']),
        `Found by daily run ${checkId}${run.evidence ? `, check-run evidence ${run.evidence}` : ''}.`,
      ].join('\n'), 4000),
      acceptance: [{ id: 'fixed', statement: clampText(`The whole suite, every browser spec with it, passes on the tip of ${s.ref}, and the failing tests above pass again`, 500) }],
    })
    return { taskId: task.taskId, duplicate: false }
  }
}
