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
 * command itself reported, on its own channel, that a nested bubblewrap it needed was refused); any
 * other nonzero exit is the check's own failure. Each check that ran is stored with its outcome, bound
 * to the subject, its argv, and the setup, and reused, never run again on that subject; one a crash or
 * a stop interrupted is an `error`, and one that ended before a stop keeps what it came to: neither is
 * run again to replace it (INV-4). What ran is recorded as one `check-run@1.0` evidence
 * artifact before the outcome is returned (INV-13: the workflow engine's acceptance decision names it).
 * @module @tsuuanmi/system-agent-workers/checks
 */
import { realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { childEnvironment } from '@tsuuanmi/system-agent-runtime-core'
import type { ArtifactRef } from '@tsuuanmi/system-approvals-core'
import type {} from '@tsuuanmi/system-artifacts'
import { captureGitSubject, subjectId } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import type {} from '@tsuuanmi/system-store'
import type { Checked, CheckResult, CheckStep, RunCheck } from '@tsuuanmi/system-workers-core'
import { CHECKS } from './gate.ts'
import { confineIn, type Confined, NESTED_REFUSED, runBounded, type Setup } from './setup.ts'
import type { Worktrees } from './worktrees.ts'

/** How much of what a check printed its record keeps, from the end (INV-9). */
export const CHECK_OUTPUT_TAIL = 4000
/** How long a check's reason its record keeps (`check-run@1.0`). */
const CHECK_REASON_CHARS = 2000

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
}

type Allowed = { check: RunCheck; line: string; argv: string[]; autonomy: ArtifactRef }

export interface RunChecksOptions {
  /**
   * Called once a check's command ended, before its outcome is stored (a test's view of that moment,
   * where a stop may come: what the command came to is stored all the same, INV-4).
   */
  commandEnded?: (check: RunCheck) => void
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

  /** `runDir`: the owner-only directory where the setups' private views are made (`<worktreeRoot>/.setup`). */
  constructor(private readonly ctx: Context, private readonly worktrees: Worktrees, private readonly setups: ReadonlyMap<string, Setup>, private readonly runDir: string, private readonly options: RunChecksOptions = {}) {}

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
    if (allowed.length) await this.execute(found, setup!, step, allowed, records, signal)
    const results: CheckResult[] = names.map((check) => {
      const r = records.get(check)!
      return { check, outcome: r.outcome, ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}), reason: r.reason }
    })
    if (!allowed.length) return { outcome: 'checked', results }
    const evidence = this.ctx.artifacts.put({
      kind: 'evidence', bodySchema: 'check-run@1.0',
      body: {
        schema: 'check-run@1.0', runId: step.runId, repository: found.repository, workspace: found.path,
        subject: { type: 'git-head', ref: step.subject.ref, version: step.subject.version }, setup: setup!.hash,
        checks: names.map((check) => ({ ...records.get(check)!, reason: records.get(check)!.reason.slice(0, CHECK_REASON_CHARS) })),
      },
      inputs: [...new Set(allowed.map((a) => a.autonomy))],
      classification: step.classification, producer: { type: 'system', ref: 'agent-workers' }, runId: step.runId,
    }).id as string
    this.ctx.logger.info(`agent Workers: the checks of run ${step.runId} on ${subjectId({ type: 'git-head', ...step.subject })}: ${results.map((r) => `${r.check} ${r.outcome}`).join(', ')} (evidence ${evidence})`)
    return { outcome: 'checked', results, evidence }
  }

  /** The key a check's stored outcome is bound to: the run, its worktree, the subject, the check, its argv, and the setup. */
  private keyOf(step: CheckStep, workspace: string, setup: Setup, a: Allowed): [string, string, string, string, string, string] {
    return [step.runId, workspace, subjectId({ type: 'git-head', ...step.subject }), a.check, JSON.stringify(a.argv), setup.hash]
  }

  /**
   * The stored outcome of a check that ran on this key before (a restart's, or an earlier call's):
   * the record it ended with, reused as it is; or, when it started and never recorded an end (the
   * daemon stopped meanwhile), an `error` stored in its place, never run again to replace whatever it
   * came to (INV-4). Undefined when it never started.
   */
  private stored(key: string[], a: Allowed): CheckRecord | undefined {
    const row = this.ctx.store.db.prepare('SELECT state, record, started_at FROM agent_check_runs WHERE workflow_run_id = ? AND workspace = ? AND subject = ? AND check_name = ? AND argv = ? AND setup_hash = ?')
      .get(...key) as { state: string; record: string | null; started_at: string } | undefined
    if (!row) return undefined
    if (row.state === 'done' && row.record) return JSON.parse(row.record) as CheckRecord
    const record: CheckRecord = {
      check: a.check, outcome: 'error', argv: a.argv, autonomy: a.autonomy,
      reason: `its command (${a.line}) started at ${row.started_at} and recorded no end (the daemon stopped meanwhile); it is not run again on this subject, so what it came to is never replaced (INV-4)`,
    }
    this.ctx.store.transaction((db) => {
      db.prepare('UPDATE agent_check_runs SET state = ?, record = ?, ended_at = ? WHERE workflow_run_id = ? AND workspace = ? AND subject = ? AND check_name = ? AND argv = ? AND setup_hash = ?').run('done', JSON.stringify(record), now(), ...key)
    })
    return record
  }

  /**
   * Run each allowed check in order, confined, recording each; a check that changed the tree ends the
   * run of the rest. A check stored on this key is not run again: its stored outcome stands.
   */
  private async execute(found: { repository: string; path: string }, setup: Setup, step: CheckStep, allowed: Allowed[], records: Map<RunCheck, CheckRecord>, signal: AbortSignal | undefined): Promise<void> {
    const todo: Allowed[] = []
    for (const a of allowed) {
      const key = this.keyOf(step, found.path, setup, a)
      if (this.running.has(JSON.stringify(key))) {
        records.set(a.check, { check: a.check, outcome: 'error', reason: `not run: its command (${a.line}) is running on this subject now`, argv: a.argv, autonomy: a.autonomy })
        continue
      }
      const before = this.stored(key, a)
      if (before) records.set(a.check, before)
      else todo.push(a)
    }
    if (!todo.length) return
    const worktree = real(found.path)
    const tree = subjectId({ type: 'git-head', ...step.subject })
    const stopped = (): unknown => signal?.reason ?? new ProviderError('aborted', 'stopped')
    const env = childEnvironment()
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
        // Stored before it starts: a crash from here on leaves it interrupted, never run again on this subject (INV-4).
        this.ctx.store.transaction((db) => {
          db.prepare('INSERT INTO agent_check_runs (workflow_run_id, workspace, subject, check_name, argv, setup_hash, state, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(...key, 'started', now())
        })
        const ran = await this.runOne(confined, setup, a, base, tree, found.path, env, signal)
        if ('unstarted' in ran) {
          // Its command was never executed: nothing of the check ran, so a later call may run it.
          this.forget(key)
          if (signal?.aborted) throw stopped()
          records.set(a.check, ran.record)
          continue
        }
        if ('moved' in ran) moved = ran.moved
        records.set(a.check, ran.record)
        // Stored before a stop is honoured: a check that ended keeps what it came to, and one a stop
        // killed is an error; neither is run again on this subject to replace it (INV-4).
        this.ctx.store.transaction((db) => {
          db.prepare('UPDATE agent_check_runs SET state = ?, record = ?, ended_at = ? WHERE workflow_run_id = ? AND workspace = ? AND subject = ? AND check_name = ? AND argv = ? AND setup_hash = ?').run('done', JSON.stringify(ran.record), now(), ...key)
        })
        if ('interrupted' in ran || signal?.aborted) throw stopped()
      } finally {
        this.running.delete(id)
        confined.dispose()
      }
    }
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
    env: Record<string, string>, signal: AbortSignal | undefined,
  ): Promise<Ran> {
    const deadline = AbortSignal.timeout(setup.checkTimeoutSeconds * 1000)
    const started = Date.now()
    let ended
    try {
      ended = await runBounded(confined.command(a.argv), env, signal ? AbortSignal.any([signal, deadline]) : deadline, true)
    } catch (error) {
      return { record: { ...base, outcome: 'error', reason: `its command (${a.line}) ${(error as Error).message.replace(/^its commands /, '')}` }, unstarted: true }
    }
    this.options.commandEnded?.(a.check)
    const output = { tail: ended.output.length > CHECK_OUTPUT_TAIL ? ended.output.slice(-CHECK_OUTPUT_TAIL) : ended.output, bytes: ended.bytes, sha256: `sha256:${ended.sha256}` }
    const ran = { ...base, durationMs: Date.now() - started, output, ...(ended.code !== null ? { exitCode: ended.code } : {}), ...(ended.signal ? { signal: ended.signal } : {}) }
    if (!ended.started && !deadline.aborted) {
      const said = ended.output.trim().split('\n').at(-1)?.slice(0, 300) ?? ''
      return { record: { ...ran, outcome: 'error', reason: `its command (${a.line}) was not started by the confinement (an infrastructure failure, not a failed check)${said ? `: ${said}` : ''}` }, unstarted: true }
    }
    if (ended.stopped && signal?.aborted && !deadline.aborted) {
      return { record: { ...ran, outcome: 'error', reason: `its command (${a.line}) was stopped before its end (a stop or a lost lease of the run); what it would have come to is not known, and it is not run again on this subject (INV-4)` }, interrupted: true }
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
    if (deadline.aborted) return { record: { ...ran, outcome: 'error', reason: `its command (${a.line}) did not finish within ${setup.checkTimeoutSeconds} s; it was stopped` } }
    if (ended.code === null) return { record: { ...ran, outcome: 'error', reason: `its command (${a.line}) ended on signal ${ended.signal ?? 'unknown'}` } }
    if (ended.code === 0) return { record: { ...ran, outcome: 'passed', reason: `its command (${a.line}) exited 0 on ${tree}` } }
    // Only the command's own report says a nonzero exit is the host's: any other is the check's failure.
    const refused = nestedRefused(ended.report)
    if (refused !== undefined) {
      return { record: { ...ran, outcome: 'error', reason: `its command (${a.line}) exited with code ${ended.code} on ${tree} and reported a nested bubblewrap refused${refused ? ` (${refused})` : ''}: an infrastructure failure, neither passed nor failed` } }
    }
    return { record: { ...ran, outcome: 'failed', reason: `its command (${a.line}) exited with code ${ended.code} on ${tree}` } }
  }
}

/**
 * The detail of a `nested-confinement-refused[: <detail>]` line a check's command reported on its own
 * channel (the descriptor `SYSTEM_CHECK_REPORT_FD` names, ./setup.ts); undefined when it reported none.
 */
function nestedRefused(report: string | undefined): string | undefined {
  for (const line of (report ?? '').split('\n')) {
    const text = line.trim()
    if (text === NESTED_REFUSED) return ''
    if (text.startsWith(`${NESTED_REFUSED}:`)) return text.slice(NESTED_REFUSED.length + 1).trim().slice(0, 300)
  }
  return undefined
}
