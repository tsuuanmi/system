/**
 * A workflow run's checks (T151, ADR-0063): the checks a policy requires of a result (`tests`,
 * `typecheck`, `lint`) run by the source that holds the run's worktree, on the exact tree the result
 * is on, never taken from an agent's account of a command. Each check's command is the operator's
 * (`worktreeSetup[].checks` of the repository), judged by the autonomy policy as a `command` with its
 * exact argv and run only when the policy allows it unasked; it runs in the setup's confinement (the
 * host read-only, the worktree too, but for the setup's private views and `checkScratch`, no network)
 * within its deadline, so it cannot change what it checks, even for a while (INV-5). A check passes on
 * exit code 0 and fails on any other, only when its command was positively started and the tree it ran
 * on is still the subject afterwards; anything else is an `error`, which neither passes nor fails
 * (INV-2): among them an infrastructure failure (the confinement did not start the command, or the
 * command itself reported, in its report file, that a nested bubblewrap it needed was refused); any
 * other nonzero exit is the check's own failure. A command that reports its browser tests did not run
 * there keeps its outcome, and its reason and answer say so (T247). Each check that ran is stored with its outcome, bound
 * to the subject, its argv, and the setup, and reused, never run again on that subject: one that ended
 * before a stop keeps what it came to (INV-4). One the host cut (T269: the daemon stopped, by a stop or
 * a crash, with its command running) came to nothing, so it is run again on the same subject at the
 * next ask after the restart, the re-run a `gate` decision of its own (rule
 * `agent-workers.check-cut-rerun`), at most {@link MAX_CHECK_CUTS} cuts (INV-9); one a stop of its run
 * killed within the same daemon (the operator's stop, a lost lease) stays an `error`, never run again
 * on that subject. What ran is recorded as one `check-run@1.0` evidence
 * artifact before the outcome is returned (INV-13: the workflow engine's acceptance decision names it).
 * The setup owns installation (T235): a result that changed the setup's dependency files has its
 * worktree set up again first (./setup.ts `refresh`), refused as `dependency_unavailable` when that
 * needs a package the store lacks; a check runs with pnpm's verify-deps-before-run off, offline, so it
 * never installs; and one quiet for `checkStallSeconds` is told as stalled ({@link CHECK_EVENT}).
 * @module @tsuuanmi/system-agent-workers/checks
 */
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { ArtifactRef } from '@tsuuanmi/system-approvals-core'
import type {} from '@tsuuanmi/system-artifacts'
import { captureGitSubject, subjectId } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import type {} from '@tsuuanmi/system-store'
import type { Checked, CheckResult, CheckStep, RunCheck } from '@tsuuanmi/system-workers-core'
import { CHECKS } from './gate.ts'
import { BROWSER_TESTS_NOT_RUN, confineIn, type Confined, NESTED_REFUSED, noInstallEnvironment, runBounded, type Setup, WorktreeSetups } from './setup.ts'
import type { Worktrees } from './worktrees.ts'

/**
 * The event a check's stall is told by (T235): `stalled` once it printed nothing for its setup's
 * `checkStallSeconds` (with the check's `deadline`, past which it no longer runs, even when a restart
 * cut it before its `ended`), `resumed` when it prints again, `ended` when a stalled check ended.
 */
const CHECK_EVENT ='agent-workers.check'

/** How much of what a check printed its record keeps, from the end (INV-9). */
const CHECK_OUTPUT_TAIL =4000
/** How long a check's reason its record keeps (`check-run@1.0`). */
const CHECK_REASON_CHARS = 2000

/** The event a check the host cut and that runs again is told by (T269). */
const RERUN_EVENT = 'agent-workers.check.rerun'

/** How many times the host may cut one check on one subject: one cut that often stays an `error`, never run again (INV-9, T269). */
export const MAX_CHECK_CUTS = 3

/** The rule of the decision that runs again a check the host cut (T269). */
const RERUN_RULE = { type: 'rule', id: 'agent-workers.check-cut-rerun', version: '1' } as const

/** Each check that ran, by run, worktree, subject, check, argv, and setup: its outcome, reused on that subject, never run again (INV-4). */
export const CHECKS_MIGRATION = {
  version: 17,
  sql: `CREATE TABLE agent_check_runs (
    workflow_run_id TEXT NOT NULL, workspace TEXT NOT NULL, subject TEXT NOT NULL, check_name TEXT NOT NULL, argv TEXT NOT NULL, setup_hash TEXT NOT NULL,
    state TEXT NOT NULL, record TEXT, started_at TEXT NOT NULL, ended_at TEXT,
    PRIMARY KEY (workflow_run_id, workspace, subject, check_name, argv, setup_hash)
  );`,
}

/** One check as `check-run@1.0` records it. */
interface CheckRecord {
  check: RunCheck
  outcome: CheckResult['outcome']
  reason: string
  argv?: string[]
  autonomy?: ArtifactRef
  exitCode?: number
  signal?: string
  durationMs?: number
  output?: { tail: string; bytes: number; sha256: string }
  /** What the command reported it did not run (its browser tests, with why); kept in the store, said in `reason` in the evidence. */
  notRun?: string
  /** A stop killed its command before its end in this daemon (its instance): a later daemon reads that as the host's cut (T269). The store's only. */
  cutIn?: string
  /** How many times the host cut it on this subject so far (T269). The store's only. */
  cuts?: number
}

/** What a started check's row holds until it ends: the daemon that started it, and the cuts before it (T269). */
interface StartedMark { instance: string; cuts: number }

/** A check's row of `agent_check_runs`, as the store holds it. */
interface StoredRow { state: string; record: string | null; started_at: string; ended_at: string | null }

/**
 * Whether the host itself stopped: `signal` was aborted with a reason that says so (the engine's
 * stop, `HOST_STOPPED`), or this source is stopping (`hostStopped`). An operator's stop of a run and
 * a lost lease abort with neither (T269).
 */
export function hostStop(signal: AbortSignal | undefined, hostStopped?: AbortSignal): boolean {
  return hostStopped?.aborted === true || (signal?.aborted === true && (signal.reason as { hostStopped?: unknown } | undefined)?.hostStopped === true)
}

/** A check the host cut, to run again: how many times it was cut, and what says so. */
interface Cut { cuts: number; why: string }

/** The fields of a stored record that are the store's only, never in `check-run@1.0` or an answer. */
const evidenceOf = (record: CheckRecord): CheckRecord => {
  const copy: CheckRecord = { ...record }
  delete copy.notRun
  delete copy.cutIn
  delete copy.cuts
  return copy
}

type Allowed = { check: RunCheck; line: string; argv: string[]; autonomy: ArtifactRef }

export interface RunChecksOptions {
  /**
   * Called once a check's command ended, before its outcome is stored (a test's view of that moment,
   * where a stop may come: what the command came to is stored all the same, INV-4).
   */
  commandEnded?: (check: RunCheck) => void
  /** The source's worktree setups, so a setup run again for a result waits for one in flight in its worktree (one at a time per worktree). */
  setups?: WorktreeSetups
  /** Aborted when this source is stopping with the host: a check it kills then is cut by the host (T269). */
  hostStopped?: AbortSignal
}

/** What the run of one check came to. */
type Ran =
  | { record: CheckRecord }
  /** The tree is no longer the subject after it. */
  | { record: CheckRecord; moved: string }
  /** Nothing of it ran: the confinement never started its command. */
  | { record: CheckRecord; unstarted: true }
  /** A stop killed it before its end: what it would have come to is not known. */
  | { record: CheckRecord; interrupted: true }

const real = (path: string): string | undefined => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

const now = (): string => new Date().toISOString()

export class RunChecks {
  /** Keys of checks running in this process now: one is never started twice at once. */
  private readonly running = new Set<string>()

  /** This daemon's checks, as told apart from an earlier daemon's: a check an earlier one left cut was cut by the host (T269). */
  private readonly instance = randomUUID()

  /** What sets a worktree up again for a result that changed its dependencies (T235). */
  private readonly worktreeSetups: WorktreeSetups

  /** `runDir`: the owner-only directory where the setups' private views are made (`<worktreeRoot>/.setup`). */
  constructor(private readonly ctx: Context, private readonly worktrees: Worktrees, private readonly setups: ReadonlyMap<string, Setup>, private readonly runDir: string, private readonly options: RunChecksOptions = {}) {
    this.worktreeSetups = options.setups ?? new WorktreeSetups(ctx, runDir)
  }

  /**
   * Run `step.checks` on the worktree `step.workspace` of workflow run `step.runId`; undefined when
   * no worktree of this source is that one. Refused, nothing run, when the worktree is gone, may
   * still be written, is not intact, or is no longer `step.subject`. Throws only when `signal`
   * stopped it.
   */
  async check(step: CheckStep, signal?: AbortSignal): Promise<Checked | undefined> {
    const found = await this.worktrees.checkable(step.runId, step.workspace, step.subject)
    if (!found) return undefined
    if ('cause' in found) return { outcome: 'refused', cause: found.cause, reason: found.reason }
    const names = [...new Set(step.checks)]
    const setup = [...this.setups.values()].find((s) => real(s.repository) === found.repository)
    const records = new Map<RunCheck, CheckRecord>()
    const error = (check: RunCheck, reason: string, more: Partial<CheckRecord> = {}): void => void records.set(check, { check, outcome: 'error', reason, ...more })
    const allowed: Allowed[] = []
    const approvals = this.ctx.get('approvals')
    for (const check of names) {
      const command = setup?.checks[check]
      if (!command) {
        error(check, `no command for the ${check} check is configured for ${found.repository} (agent-workers worktreeSetup checks)`)
        continue
      }
      // The commands run in the environment the setup prepares: a worktree it did not set up under the definition loaded now would not hold it.
      if (found.setupHash !== setup.hash) {
        error(check, `the worktree ${found.path} was not set up under ${found.repository}'s setup as loaded now (${setup.hash}), so its checks do not run there`, { argv: command.argv })
        continue
      }
      if (!approvals) {
        error(check, 'no approval queue (ctx.approvals) is loaded, and no check command runs without its autonomy decision', { argv: command.argv })
        continue
      }
      const verdict = await approvals.check({ class: 'command', command: command.argv })
      const pending = verdict.failedChecks ?? []
      if ((verdict.mode === 'auto' || verdict.mode === 'notify') && pending.every((c) => CHECKS.includes(c))) {
        allowed.push({ check, line: command.line, argv: command.argv, autonomy: verdict.decision })
        continue
      }
      error(check, verdict.mode === 'ask'
        ? `the autonomy policy asks the operator about its command (${command.line}): a check runs only as a command the policy allows unasked, such as a line on the studio policy's commands list`
        : verdict.mode === 'forbid' ? `the autonomy policy forbids its command (${command.line})`
          : `the autonomy policy gave its command (${command.line}) ${verdict.mode === 'auto' || verdict.mode === 'notify' ? `checks pending that no rule can require (${pending.join(', ')})` : `a mode this source does not know (${String(verdict.mode)})`}`,
      { argv: command.argv, autonomy: verdict.decision })
    }
    let again: ArtifactRef | undefined
    // The setup owns installation: a result that changed what it installs has it run again before any check runs (T235).
    if (allowed.length && allowed.some((a) => !this.has(this.keyOf(step, found.path, setup!, a)))) {
      const refreshed = await this.worktreeSetups.refresh({
        workflowRunId: step.runId, classification: step.classification, worktree: found.path, repository: found.repository, subject: subjectId({ type: 'git-head', ...step.subject }),
      }, setup!, signal ?? new AbortController().signal)
      if (refreshed.outcome === 'refused') return { outcome: 'refused', cause: refreshed.cause, reason: refreshed.reason }
      if (refreshed.outcome === 'ran') {
        again = refreshed.decision as ArtifactRef
        // INV-5: the setup could write the worktree; its checks run only while it is still the result's tree.
        const still = await this.worktrees.checkable(step.runId, step.workspace, step.subject)
        if (!still || 'cause' in still) {
          return { outcome: 'refused', cause: still ? still.cause : 'gone', reason: `after its setup ran again for the result's dependencies (decision ${again}): ${still ? still.reason : `the worktree ${found.path} is no longer this source's`}` }
        }
      }
    }
    const reruns = allowed.length ? await this.execute(found, setup!, step, allowed, records, signal) : []
    const results: CheckResult[] = names.map((check) => {
      const r = records.get(check)!
      return { check, outcome: r.outcome, ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}), reason: r.reason, ...(r.notRun ? { notRun: r.notRun } : {}) }
    })
    if (!allowed.length) return { outcome: 'checked', results }
    const evidence = this.ctx.artifacts.put({
      kind: 'evidence', bodySchema: 'check-run@1.0',
      body: {
        schema: 'check-run@1.0', runId: step.runId, repository: found.repository, workspace: found.path,
        subject: { type: 'git-head', ref: step.subject.ref, version: step.subject.version }, setup: setup!.hash,
        // check-run@1.0 says what did not run in the reason; the field is the store's and the answer's.
        checks: names.map((check) => {
          const record = evidenceOf(records.get(check)!)
          return { ...record, reason: record.reason.slice(0, CHECK_REASON_CHARS) }
        }),
      },
      inputs: [...new Set([...allowed.map((a) => a.autonomy), ...(again ? [again] : []), ...reruns])],
      classification: step.classification, producer: { type: 'system', ref: 'agent-workers' }, runId: step.runId,
    }).id as string
    this.ctx.logger.info(`agent Workers: the checks of run ${step.runId} on ${subjectId({ type: 'git-head', ...step.subject })}: ${results.map((r) => `${r.check} ${r.outcome}`).join(', ')} (evidence ${evidence})`)
    return { outcome: 'checked', results, evidence }
  }

  /** The key a check's stored outcome is bound to: the run, its worktree, the subject, the check, its argv, and the setup. */
  private keyOf(step: CheckStep, workspace: string, setup: Setup, a: Allowed): [string, string, string, string, string, string] {
    return [step.runId, workspace, subjectId({ type: 'git-head', ...step.subject }), a.check, JSON.stringify(a.argv), setup.hash]
  }

  /** Whether a check ran (or started) on this key before: its stored outcome stands, and nothing of it runs again. */
  private has(key: string[]): boolean {
    return !!this.ctx.store.db.prepare('SELECT 1 FROM agent_check_runs WHERE workflow_run_id = ? AND workspace = ? AND subject = ? AND check_name = ? AND argv = ? AND setup_hash = ?').get(...key)
  }

  /**
   * What a check that started on this key before (a restart's, or an earlier call's) came to. The
   * record it ended with is reused as it is (INV-4). One the host cut (T269), so that it came to
   * nothing, is to run again (`cut`): it started in an earlier daemon and recorded no end (the daemon
   * stopped, or crashed, meanwhile), or an earlier daemon's stop killed it before its end. Past
   * {@link MAX_CHECK_CUTS} cuts it stays an `error`, stored in its place (INV-9). One a stop killed in
   * this daemon (its run stopped, or its lease lost) stays the `error` it was stored as. Undefined
   * when it never started.
   */
  private stored(key: string[], a: Allowed): { record: CheckRecord } | { cut: Cut; prior: StoredRow } | undefined {
    const row = this.ctx.store.db.prepare('SELECT state, record, started_at, ended_at FROM agent_check_runs WHERE workflow_run_id = ? AND workspace = ? AND subject = ? AND check_name = ? AND argv = ? AND setup_hash = ?')
      .get(...key) as StoredRow | undefined
    if (!row) return undefined
    let cut: Cut
    if (row.state === 'done' && row.record) {
      const record = JSON.parse(row.record) as CheckRecord
      if (record.cutIn === undefined || record.cutIn === this.instance) return { record }
      cut = { cuts: record.cuts ?? 1, why: `its command (${a.line}) was stopped before its end by the host's stop, in the daemon before this one (started at ${row.started_at})` }
    } else {
      const mark = row.record ? JSON.parse(row.record) as Partial<StartedMark> : {}
      // Started in this daemon and not running: nothing of this daemon stops without storing its end.
      if (mark.instance === this.instance) return { record: this.storeError(key, a, `its command (${a.line}) started at ${row.started_at} and recorded no end; it is not run again on this subject (INV-4)`) }
      cut = { cuts: (mark.cuts ?? 0) + 1, why: `its command (${a.line}) started at ${row.started_at} and recorded no end: the daemon stopped meanwhile` }
    }
    if (cut.cuts >= MAX_CHECK_CUTS) {
      return { record: this.storeError(key, a, `${cut.why}; the host has cut it ${cut.cuts} times on this subject, so it is not run again (at most ${MAX_CHECK_CUTS}, INV-9)`) }
    }
    return { cut, prior: row }
  }

  /** Store an `error` in place of what a check came to, its end: it stands from now on. */
  private storeError(key: string[], a: Allowed, reason: string): CheckRecord {
    const record: CheckRecord = { check: a.check, outcome: 'error', argv: a.argv, autonomy: a.autonomy, reason }
    this.ctx.store.transaction((db) => {
      db.prepare('UPDATE agent_check_runs SET state = ?, record = ?, ended_at = ? WHERE workflow_run_id = ? AND workspace = ? AND subject = ? AND check_name = ? AND argv = ? AND setup_hash = ?').run('done', JSON.stringify(record), now(), ...key)
    })
    return record
  }

  /**
   * Run again a check the host cut (T269): a `gate` decision of rule `agent-workers.check-cut-rerun`
   * says so (INV-13) and an {@link RERUN_EVENT} event tells it. Its stored row stays, with its cuts,
   * until the check starts again and replaces it in one statement (`execute`).
   */
  private rerun(step: CheckStep, workspace: string, a: Allowed, cut: Cut): ArtifactRef {
    const subject = subjectId({ type: 'git-head', ...step.subject })
    const decision = this.ctx.artifacts.recordDecision({
      decisionType: 'gate', question: `May the ${a.check} check of workflow run ${step.runId} run again on its result ${subject}, the host having cut it?`.slice(0, 500),
      inputs: [a.autonomy],
      candidates: [
        { option: 'run', selected: true, reasons: [`cut by the host, re-run: ${cut.why}; it came to no outcome, so running it again on the same tree replaces nothing (INV-4), and the check is read-only to the tree (INV-5)`.slice(0, 500)] },
        { option: 'hold', selected: false, reasons: [`not hold: the host has cut it ${cut.cuts} time(s) on this subject, fewer than ${MAX_CHECK_CUTS}`] },
      ],
      decider: RERUN_RULE,
      outcome: { option: 'run', detail: { check: a.check, command: a.line, workspace, subject, cuts: cut.cuts, maxCuts: MAX_CHECK_CUTS, cause: 'cut-by-host' } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'agent-workers' }, runId: step.runId, classification: step.classification }).id as ArtifactRef
    try {
      this.ctx.get('eventLog')?.append({ type: RERUN_EVENT, runId: step.runId, decision, data: { check: a.check, command: a.line, workspace, subject, cuts: cut.cuts, reason: cut.why.slice(0, 500) } })
    } catch (error) {
      this.ctx.logger.warn(`agent Workers: the re-run event of the ${a.check} check of run ${step.runId} was not appended: ${(error as Error).message}`)
    }
    this.ctx.logger.info(`agent Workers: the ${a.check} check of run ${step.runId} on ${subject} was cut by the host (${cut.cuts} time(s)); it runs again (decision ${decision})`)
    return decision
  }

  /**
   * Run each allowed check in order, confined, recording each; a check that changed the tree ends the
   * run of the rest. A check stored on this key is not run again: its stored outcome stands; but one
   * the host cut runs again (T269). Returns the decisions of those re-runs.
   */
  private async execute(found: { repository: string; path: string }, setup: Setup, step: CheckStep, allowed: Allowed[], records: Map<RunCheck, CheckRecord>, signal: AbortSignal | undefined): Promise<ArtifactRef[]> {
    const todo: Allowed[] = []
    const reruns: ArtifactRef[] = []
    /** The cuts each check to run again had so far, carried into its started mark. */
    const cutsOf = new Map<RunCheck, number>()
    /** The rows those checks had, to put back when the re-run's command was never started. */
    const priors = new Map<RunCheck, StoredRow>()
    for (const a of allowed) {
      const key = this.keyOf(step, found.path, setup, a)
      if (this.running.has(JSON.stringify(key))) {
        records.set(a.check, { check: a.check, outcome: 'error', reason: `not run: its command (${a.line}) is running on this subject now`, argv: a.argv, autonomy: a.autonomy })
        continue
      }
      const before = this.stored(key, a)
      if (before && 'record' in before) {
        records.set(a.check, before.record)
        continue
      }
      if (before) {
        reruns.push(this.rerun(step, found.path, a, before.cut))
        cutsOf.set(a.check, before.cut.cuts)
        priors.set(a.check, before.prior)
      }
      todo.push(a)
    }
    if (!todo.length) return reruns
    const worktree = real(found.path)
    const tree = subjectId({ type: 'git-head', ...step.subject })
    const stopped = (): unknown => signal?.reason ?? new ProviderError('aborted', 'stopped')
    const env = noInstallEnvironment()
    let moved: string | undefined
    for (const a of todo) {
      const base = { check: a.check, argv: a.argv, autonomy: a.autonomy }
      if (signal?.aborted) throw stopped()
      if (moved) {
        records.set(a.check, { ...base, outcome: 'error', reason: `not run: ${moved}` })
        continue
      }
      // A confinement of its own for each check: its scratch directories are fresh, and gone once it ended,
      // so nothing one check writes there is seen by the next.
      let confined: Confined
      try {
        if (!worktree) throw new Error(`its worktree ${found.path} cannot be read`)
        confined = await confineIn(this.ctx, setup, worktree, this.runDir, 'check')
      } catch (error) {
        records.set(a.check, { ...base, outcome: 'error', reason: `not run: ${(error as Error).message}` })
        continue
      }
      const key = this.keyOf(step, found.path, setup, a)
      const id = JSON.stringify(key)
      this.running.add(id)
      try {
        if (signal?.aborted) throw stopped()
        // Stored before it starts, with this daemon's mark: a crash from here on leaves it cut by the
        // host, run again by the next daemon within the bound (T269), never by this one. A check run
        // again replaces its stored row in this one statement, so the cuts it had are never absent
        // from the store: a crash at any point keeps the count (INV-9).
        const mark: StartedMark = { instance: this.instance, cuts: cutsOf.get(a.check) ?? 0 }
        this.ctx.store.transaction((db) => {
          db.prepare(`INSERT INTO agent_check_runs (workflow_run_id, workspace, subject, check_name, argv, setup_hash, state, record, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (workflow_run_id, workspace, subject, check_name, argv, setup_hash) DO UPDATE SET state = excluded.state, record = excluded.record, started_at = excluded.started_at, ended_at = NULL`)
            .run(...key, 'started', JSON.stringify(mark), now())
        })
        const ran = await this.runOne(confined, setup, a, base, tree, found.path, env, signal, step.runId)
        if ('unstarted' in ran) {
          // Its command was never executed: nothing of the check ran, so a later call may run it. A
          // check that was to run again goes back to the row it had, its cuts with it.
          const prior = priors.get(a.check)
          if (prior) this.restore(key, prior)
          else this.forget(key)
          if (signal?.aborted) throw stopped()
          records.set(a.check, ran.record)
          continue
        }
        if ('moved' in ran) moved = ran.moved
        records.set(a.check, ran.record)
        // Stored before a stop is honoured: a check that ended keeps what it came to, never run again
        // on this subject to replace it (INV-4). One a stop killed is an error marked with this daemon:
        // this one never runs it again. Only the host's own stop (the engine's or this source's stopping,
        // not an operator's stop of the run or a lost lease) marks it cut: a later daemon reads that
        // and runs it again (T269); any other stop leaves the `error` final (INV-4).
        const stored = 'interrupted' in ran && hostStop(signal, this.options.hostStopped) ? { ...ran.record, cutIn: this.instance, cuts: mark.cuts + 1 } : ran.record
        this.ctx.store.transaction((db) => {
          db.prepare('UPDATE agent_check_runs SET state = ?, record = ?, ended_at = ? WHERE workflow_run_id = ? AND workspace = ? AND subject = ? AND check_name = ? AND argv = ? AND setup_hash = ?').run('done', JSON.stringify(stored), now(), ...key)
        })
        if ('interrupted' in ran || signal?.aborted) throw stopped()
      } finally {
        this.running.delete(id)
        confined.dispose()
      }
    }
    return reruns
  }

  /** Put a check's row back as it was before its re-run started (its command was never executed). */
  private restore(key: string[], row: StoredRow): void {
    this.ctx.store.transaction((db) => {
      db.prepare('UPDATE agent_check_runs SET state = ?, record = ?, started_at = ?, ended_at = ? WHERE workflow_run_id = ? AND workspace = ? AND subject = ? AND check_name = ? AND argv = ? AND setup_hash = ?')
        .run(row.state, row.record, row.started_at, row.ended_at, ...key)
    })
  }

  private forget(key: string[]): void {
    this.ctx.store.transaction((db) => {
      db.prepare('DELETE FROM agent_check_runs WHERE workflow_run_id = ? AND workspace = ? AND subject = ? AND check_name = ? AND argv = ? AND setup_hash = ? AND state = ?').run(...key, 'started')
    })
  }

  /**
   * Run one check to what it came to. `unstarted` when the confinement never started its command;
   * `interrupted` when `signal` killed it before its end; `moved` when the tree is no longer the
   * subject after it. A command that ended by itself is judged as it ended, even when `signal` stops
   * the run meanwhile: its outcome is stored, never lost to the stop (INV-4).
   */
  private async runOne(
    confined: Confined, setup: Setup, a: Allowed, base: Pick<CheckRecord, 'check' | 'argv' | 'autonomy'>, tree: string, path: string,
    env: Record<string, string>, signal: AbortSignal | undefined, runId: string,
  ): Promise<Ran> {
    const deadline = AbortSignal.timeout(setup.checkTimeoutSeconds * 1000)
    const started = Date.now()
    const watch = new StallWatch(this.ctx, { runId, check: a.check, line: a.line, workspace: path, subject: tree, deadline: new Date(started + setup.checkTimeoutSeconds * 1000).toISOString() }, setup.checkStallSeconds)
    let ended
    try {
      ended = await runBounded(confined.command(a.argv), env, signal ? AbortSignal.any([signal, deadline]) : deadline, { report: confined.report! }, () => watch.heard())
    } catch (error) {
      return { record: { ...base, outcome: 'error', reason: `its command (${a.line}) ${(error as Error).message.replace(/^its commands /, '')}` }, unstarted: true }
    } finally {
      watch.end()
    }
    this.options.commandEnded?.(a.check)
    const output = { tail: ended.output.length > CHECK_OUTPUT_TAIL ? ended.output.slice(-CHECK_OUTPUT_TAIL) : ended.output, bytes: ended.bytes, sha256: `sha256:${ended.sha256}` }
    const ran = { ...base, durationMs: Date.now() - started, output, ...(ended.code !== null ? { exitCode: ended.code } : {}), ...(ended.signal ? { signal: ended.signal } : {}) }
    if (!ended.started && !deadline.aborted) {
      const said = ended.output.trim().split('\n').at(-1)?.slice(0, 300) ?? ''
      return { record: { ...ran, outcome: 'error', reason: `its command (${a.line}) was not started by the confinement (an infrastructure failure, not a failed check)${said ? `: ${said}` : ''}` }, unstarted: true }
    }
    if (ended.stopped && signal?.aborted && !deadline.aborted) {
      return { record: { ...ran, outcome: 'error', reason: `its command (${a.line}) was stopped before its end (a stop or a lost lease of the run, or the host's stop); what it would have come to is not known, and it is not run again on this subject, unless the host's stop cut it: then it runs again after the restart (T269)` }, interrupted: true }
    }
    // INV-5: a check is the subject's only while the tree it ran on is still the subject (the worktree is read-only to it; this is the proof).
    let after: string | undefined
    try {
      const captured = captureGitSubject(path)
      after = captured ? subjectId(captured.subject) : undefined
    } catch {
      after = undefined
    }
    if (after !== tree) {
      const moved = `the ${a.check} check (${a.line}) left the worktree ${after ? `as ${after}` : 'unreadable'}, no longer ${tree}`
      return { record: { ...ran, outcome: 'error', reason: `${moved}: a check changes nothing it checks, so its exit code is not the subject's` }, moved }
    }
    if (deadline.aborted) return { record: { ...ran, outcome: 'error', reason: `its command (${a.line}) did not finish within ${setup.checkTimeoutSeconds} s; it was stopped${watch.quietFrom ? `, having printed nothing since ${watch.quietFrom}` : ''}` } }
    if (ended.code === null) return { record: { ...ran, outcome: 'error', reason: `its command (${a.line}) ended on signal ${ended.signal ?? 'unknown'}` } }
    // What it reported is not known: neither its exit nor its silence says that all its tests ran (T247).
    if (ended.reportUnread) return { record: { ...ran, outcome: 'error', reason: `its command (${a.line}) exited with code ${ended.code} on ${tree}, but its report file could not be read (${ended.reportUnread}): what it reported is not known, an infrastructure failure, neither passed nor failed` } }
    // Tests the command reported it could not run there: its exit says nothing of them, and the review is told (T247).
    const skipped = browserTestsNotRun(ended.report)
    const notRun = skipped !== undefined ? { notRun: `its browser tests${skipped ? ` (${skipped})` : ''}` } : {}
    const unrun = skipped !== undefined ? `; it reported that its browser tests did not run${skipped ? ` (${skipped})` : ''}, so its exit says nothing of them` : ''
    if (ended.code === 0) return { record: { ...ran, outcome: 'passed', reason: `its command (${a.line}) exited 0 on ${tree}${unrun}`, ...notRun } }
    // Only the command's own report says a nonzero exit is the host's: any other is the check's failure.
    const refused = nestedRefused(ended.report)
    if (refused !== undefined) {
      return { record: { ...ran, outcome: 'error', reason: `its command (${a.line}) exited with code ${ended.code} on ${tree} and reported a nested bubblewrap refused${refused ? ` (${refused})` : ''}: an infrastructure failure, neither passed nor failed` } }
    }
    return { record: { ...ran, outcome: 'failed', reason: `its command (${a.line}) exited with code ${ended.code} on ${tree}${unrun}`, ...notRun } }
  }
}

/** What a check's stall event names: the workflow run, the check and its command, the worktree, the tree it checks, and when its deadline stops it. */
interface Watched { runId: string; check: RunCheck; line: string; workspace: string; subject: string; deadline: string }

/**
 * A check's stall watch (T235): once its command printed nothing for `seconds`, an
 * {@link CHECK_EVENT} `stalled` event says so, with when it last printed, so the run's explain and the
 * web UI show it while it lasts, long before its deadline; `resumed` when it prints again, `ended` when
 * a check that stalled ended. Nothing about it stops the check: the deadline does.
 */
class StallWatch {
  private timer: NodeJS.Timeout | undefined
  /** When the timer was last set. */
  private armedAt = 0
  private last = Date.now()
  private stalled = false
  private over = false
  /** When it last printed, once it was reported stalled and has not printed since. */
  quietFrom: string | undefined

  constructor(private readonly ctx: Context, private readonly watched: Watched, private readonly seconds: number) {
    this.arm()
  }

  /** The command printed: the watch starts over, and a stall reported is over. */
  heard(): void {
    if (this.over) return
    this.last = Date.now()
    if (this.stalled) {
      this.stalled = false
      this.quietFrom = undefined
      this.tell('resumed')
    }
    // Re-armed at most once a second: a command that prints a lot costs no timer per piece.
    if (!this.timer || this.armedAt + 1000 <= this.last) this.arm()
  }

  /** The command ended: no stall is reported after it, and one reported is over. */
  end(): void {
    if (this.over) return
    this.over = true
    clearTimeout(this.timer)
    if (this.stalled) this.tell('ended')
  }

  private arm(): void {
    clearTimeout(this.timer)
    this.armedAt = Date.now()
    const due = Math.max(0, this.last + this.seconds * 1000 - this.armedAt)
    this.timer = setTimeout(() => this.due(), due)
    this.timer.unref()
  }

  private due(): void {
    if (this.over || this.stalled) return
    const quiet = Date.now() - this.last
    // Heard meanwhile (the timer is re-armed at most once a second): wait the rest of the bound.
    if (quiet < this.seconds * 1000) return this.arm()
    this.stalled = true
    this.quietFrom = new Date(this.last).toISOString()
    this.tell('stalled')
  }

  private tell(state: 'stalled' | 'resumed' | 'ended'): void {
    const { runId, check, line, workspace, subject, deadline } = this.watched
    try {
      this.ctx.get('eventLog')?.append({
        type: CHECK_EVENT, runId,
        data: { check, command: line, state, workspace, subject, stallSeconds: this.seconds, ...(state === 'stalled' ? { quietSince: this.quietFrom, deadline } : {}) },
      })
    } catch (error) {
      this.ctx.logger.warn(`agent Workers: the ${state} event of the ${check} check of run ${runId} was not appended: ${(error as Error).message}`)
    }
    if (state === 'stalled') this.ctx.logger.warn(`agent Workers: the ${check} check of run ${runId} (${line}) printed nothing for ${this.seconds} s; it goes on to its deadline`)
  }
}

/**
 * The detail of a `nested-confinement-refused[: <detail>]` line a check's command reported on its own
 * channel (the report file `SYSTEM_CHECK_REPORT_PATH` names, ./setup.ts); undefined when it reported none.
 */
function nestedRefused(report: string | undefined): string | undefined {
  return reported(report, NESTED_REFUSED)
}

/**
 * The detail of a `browser-tests-not-run[: <detail>]` line a check's command reported on its own
 * channel: its browser tests were skipped where it ran, and why. Undefined when it reported none.
 */
function browserTestsNotRun(report: string | undefined): string | undefined {
  return reported(report, BROWSER_TESTS_NOT_RUN)
}

/** The detail of the first `<word>[: <detail>]` line of `report` (at most 300 characters); undefined when none. */
function reported(report: string | undefined, word: string): string | undefined {
  for (const line of (report ?? '').split('\n')) {
    const text = line.trim()
    if (text === word) return ''
    if (text.startsWith(`${word}:`)) return text.slice(word.length + 1).trim().slice(0, 300)
  }
  return undefined
}
