/**
 * A workflow run's checks (T151, ADR-0063): the checks a policy requires of a result (`tests`,
 * `typecheck`, `lint`) run by the source that holds the run's worktree, on the exact tree the result
 * is on, never taken from an agent's account of a command. Each check's command is the operator's
 * (`worktreeSetup[].checks` of the repository), judged by the autonomy policy as a `command` with its
 * exact argv and run only when the policy allows it unasked; it runs in the setup's confinement (the
 * host read-only but the worktree and the setup's private views, no network) within its deadline. A
 * check passes on exit code 0 and fails on any other, only while the tree it ran on is still the
 * subject afterwards; anything else is an `error`, which neither passes nor fails (INV-2). What ran is
 * recorded as one `check-run@1.0` evidence artifact before the outcome is returned (INV-13: the
 * workflow engine's acceptance decision names it).
 * @module @tsuuanmi/system-agent-workers/checks
 */
import { realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { childEnvironment } from '@tsuuanmi/system-agent-runtime-core'
import type { ArtifactRef } from '@tsuuanmi/system-approvals-core'
import type {} from '@tsuuanmi/system-artifacts'
import { captureGitSubject, subjectId } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import type { Checked, CheckResult, CheckStep, RunCheck } from '@tsuuanmi/system-workers-core'
import { CHECKS } from './gate.ts'
import { confineIn, type Confined, runBounded, type Setup } from './setup.ts'
import type { Worktrees } from './worktrees.ts'

/** How much of what a check printed its record keeps, from the end (INV-9). */
export const CHECK_OUTPUT_TAIL = 4000
/** How long a check's reason its record keeps (`check-run@1.0`). */
const CHECK_REASON_CHARS = 2000

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

const real = (path: string): string | undefined => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

export class RunChecks {
  /** `runDir`: the owner-only directory where the setups' private views are made (`<worktreeRoot>/.setup`). */
  constructor(private readonly ctx: Context, private readonly worktrees: Worktrees, private readonly setups: ReadonlyMap<string, Setup>, private readonly runDir: string) {}

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
    const allowed: Array<{ check: RunCheck; line: string; argv: string[]; autonomy: ArtifactRef }> = []
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

  /** Run each allowed check in order, confined, recording each; a check that changed the tree ends the run of the rest. */
  private async execute(found: { repository: string; path: string }, setup: Setup, step: CheckStep, allowed: Array<{ check: RunCheck; line: string; argv: string[]; autonomy: ArtifactRef }>, records: Map<RunCheck, CheckRecord>, signal: AbortSignal | undefined): Promise<void> {
    const worktree = real(found.path)
    let confined: Confined | undefined
    try {
      if (!worktree) throw new Error(`its worktree ${found.path} cannot be read`)
      confined = await confineIn(this.ctx, setup, worktree, this.runDir)
    } catch (error) {
      for (const a of allowed) records.set(a.check, { check: a.check, outcome: 'error', reason: `not run: ${(error as Error).message}`, argv: a.argv, autonomy: a.autonomy })
      return
    }
    const tree = subjectId({ type: 'git-head', ...step.subject })
    try {
      const env = childEnvironment()
      let moved: string | undefined
      for (const a of allowed) {
        const base = { check: a.check, argv: a.argv, autonomy: a.autonomy }
        if (moved) {
          records.set(a.check, { ...base, outcome: 'error', reason: `not run: ${moved}` })
          continue
        }
        const deadline = AbortSignal.timeout(setup.checkTimeoutSeconds * 1000)
        const started = Date.now()
        let ended
        try {
          ended = await runBounded(confined.command(a.argv), env, signal ? AbortSignal.any([signal, deadline]) : deadline)
        } catch (error) {
          records.set(a.check, { ...base, outcome: 'error', reason: `its command (${a.line}) ${(error as Error).message.replace(/^its commands /, '')}` })
          continue
        }
        if (signal?.aborted) throw signal.reason ?? new ProviderError('aborted', 'stopped')
        const output = { tail: ended.output.length > CHECK_OUTPUT_TAIL ? ended.output.slice(-CHECK_OUTPUT_TAIL) : ended.output, bytes: ended.bytes, sha256: `sha256:${ended.sha256}` }
        const ran = { ...base, durationMs: Date.now() - started, output, ...(ended.code !== null ? { exitCode: ended.code } : {}), ...(ended.signal ? { signal: ended.signal } : {}) }
        // INV-5: a check is the subject's only while the tree it ran on is still the subject.
        let now: string | undefined
        try {
          const captured = captureGitSubject(found.path)
          now = captured ? subjectId(captured.subject) : undefined
        } catch {
          now = undefined
        }
        if (now !== tree) {
          moved = `the ${a.check} check (${a.line}) left the worktree ${now ? `as ${now}` : 'unreadable'}, no longer ${tree}`
          records.set(a.check, { ...ran, outcome: 'error', reason: `${moved}: a check changes nothing it checks, so its exit code is not the subject's` })
          continue
        }
        if (deadline.aborted) records.set(a.check, { ...ran, outcome: 'error', reason: `its command (${a.line}) did not finish within ${setup.checkTimeoutSeconds} s; it was stopped` })
        else if (ended.code === null) records.set(a.check, { ...ran, outcome: 'error', reason: `its command (${a.line}) ended on signal ${ended.signal ?? 'unknown'}` })
        else if (ended.code === 0) records.set(a.check, { ...ran, outcome: 'passed', reason: `its command (${a.line}) exited 0 on ${tree}` })
        else records.set(a.check, { ...ran, outcome: 'failed', reason: `its command (${a.line}) exited with code ${ended.code} on ${tree}` })
      }
    } finally {
      confined.dispose()
    }
  }
}
