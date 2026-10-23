/**
 * A digest of a board task's result (docs/design/workflow-engine.md#a-digest-of-a-tasks-result):
 * once a run's result reached its task on the board (submitted, then accepted, rejected, or held
 * for the operator; or reported by `reconcileRun`), the engine asks `ctx.digests` for a digest of
 * the result's artifacts, and sets the task's `result.digest` through the board's own
 * `attachDigest` once it is written.
 *
 * - **After the report, never before.** The run's outcome reaches the board first; the digest is
 *   asked for after, so it never blocks or changes an acceptance.
 * - **Bounded** (INV-9): one request per run (an attempt), keyed by the run, and at most
 *   `digestsPerHour` requested in any hour; a wait of at most {@link DIGEST_WAIT_MS}.
 * - **Fails open** (ADR-0036): no digest provider, the hourly bound reached, a request refused, a
 *   digest not written, or a board that does not take it leaves `result.digest` unset, recorded
 *   with why: the engine's `admission` decision (`workflow.task-digest`) when it does not ask, else
 *   the `workflow.task.digest` event naming the digest's own settling decision.
 * - **Restart is reconciliation** (INV-4): the request's state is durable on the run's
 *   `workflow_tasks` row; the bound is taken and the decision recorded in one transaction before
 *   the request, and the request is idempotent by its key, so a restart asks once.
 *
 * The digest seam and the board's `attachDigest` are both optional: the engine reaches them
 * through their definitions only, never a provider (ADR-0036 rule 1).
 */
import { BoardError } from '@tsuuanmi/system-board-core'
import { type ArtifactRef, DigestError, type DigestView } from '@tsuuanmi/system-digest-core'
import type { Engine } from './engine.ts'
import { now, type TaskDigest, type TaskRow } from './types.ts'

/** How long the engine waits for a requested digest to settle before it gives up on it (INV-9); the digest's own bound is shorter. */
export const DIGEST_WAIT_MS = 6 * 3600_000
/** How long one wait on the digest seam lasts before the engine looks at its bound again. */
const WAIT_SLICE_MS = 55_000
/** How soon a step that could not reach the digest seam or the board is tried again. */
const RETRY_MS = 30_000
const HOUR_MS = 3600_000
const PRODUCER = { producer: { type: 'system' as const, ref: 'workflow' } }

/** The outcomes whose result reached the board: they are due a digest. */
const SUBMITTED = new Set(['accepted', 'rejected', 'review', 'reconciled'])

export class TaskDigests {
  private readonly driving = new Map<string, Promise<void>>()
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly e: Engine) {}

  /**
   * In the transaction that reports a run: a completed run whose result reached its task is due a
   * digest, once. True when it became due.
   */
  due(row: TaskRow, status: string): boolean {
    if (!row.result || !row.acceptance || !SUBMITTED.has(status)) return false
    const changed = this.e.ctx.store.db.prepare('UPDATE workflow_tasks SET digest = ? WHERE run_id = ? AND digest IS NULL').run(JSON.stringify({ state: 'due' } satisfies TaskDigest), row.run_id).changes
    return Number(changed) === 1
  }

  /** On start, and when the board comes up: every digest not yet settled goes on where it stood. */
  recover(): void {
    const rows = this.e.ctx.store.db.prepare(`SELECT run_id FROM workflow_tasks WHERE json_extract(digest, '$.state') IN ('due', 'requesting', 'requested') ORDER BY updated_at`).all() as Array<{ run_id: string }>
    for (const { run_id } of rows) this.drive(run_id)
  }

  async close(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    await Promise.allSettled(this.driving.values())
  }

  /** The digest of the run's result as it stands, for the run's view. */
  view(row: TaskRow): TaskDigest | undefined {
    return row.digest ? JSON.parse(row.digest) as TaskDigest : undefined
  }

  /** Drive one run's digest, once at a time. */
  drive(runId: string): void {
    if (this.e.stopped.signal.aborted || this.driving.has(runId)) return
    clearTimeout(this.timers.get(runId))
    this.timers.delete(runId)
    const driving = this.step(runId)
      .catch((error: unknown) => {
        this.e.ctx.logger.warn(`workflow: the digest of run ${runId}'s result is tried again: ${(error as Error)?.message ?? String(error)}`)
        this.later(runId)
      })
      .finally(() => this.driving.delete(runId))
    this.driving.set(runId, driving)
  }

  private later(runId: string, delayMs = RETRY_MS): void {
    if (this.e.stopped.signal.aborted) return
    clearTimeout(this.timers.get(runId))
    const timer = setTimeout(() => {
      this.timers.delete(runId)
      this.drive(runId)
    }, delayMs)
    timer.unref()
    this.timers.set(runId, timer)
  }

  private row(runId: string): TaskRow | undefined {
    return this.e.ctx.store.db.prepare('SELECT * FROM workflow_tasks WHERE run_id = ?').get(runId) as TaskRow | undefined
  }

  private async step(runId: string): Promise<void> {
    for (;;) {
      if (this.e.stopped.signal.aborted) return
      const row = this.row(runId)
      const state = row && this.view(row)
      if (!row || !state) return
      if (state.state === 'due') this.admit(row)
      else if (state.state === 'requesting') {
        if (!(await this.request(row, state))) return
      } else if (state.state === 'requested') {
        if (!(await this.settle(row, state))) return
      } else return
    }
  }

  /**
   * Whether to ask for a digest at all, in one transaction: the digest seam loaded and the hourly
   * bound not reached, recorded as an `admission` decision either way (INV-13). Asking takes the
   * bound (`requestedAt`) before the request is made, so two runs reported at once never pass it.
   */
  private admit(row: TaskRow): void {
    const artifacts = (JSON.parse(row.result!) as { artifacts: ArtifactRef[] }).artifacts
    const cap = this.e.config.digestsPerHour ?? 6
    this.e.ctx.store.transaction((db) => {
      const current = this.row(row.run_id)
      if (!current?.digest || (JSON.parse(current.digest) as TaskDigest).state !== 'due') return
      const since = new Date(Date.now() - HOUR_MS).toISOString()
      const asked = (db.prepare("SELECT COUNT(*) AS n FROM workflow_tasks WHERE json_extract(digest, '$.requestedAt') > ?").get(since) as { n: number }).n
      const why = !this.e.ctx.get('digests') ? 'no digest provider is loaded (its row is off)'
        : cap === 0 ? 'automatic digests are off (workflow.digestsPerHour is 0)'
          : asked >= cap ? `${asked} digest(s) were requested in the last hour, the bound (workflow.digestsPerHour ${cap}; INV-9)`
            : undefined
      const option = why ? 'bypass' : 'request'
      const decision = this.e.ctx.artifacts.recordDecision({
        decisionType: 'admission',
        question: `Is a digest of run ${row.run_id}'s result asked for, for board task ${row.task_id}?`,
        inputs: artifacts,
        candidates: [
          { option: 'request', selected: !why, reasons: why ? [`not request: ${why}`] : [`the result reached its task, and ${asked} of ${cap} digest(s) were requested in the last hour`, 'one digest per attempt, asked for after the report, so it never blocks the acceptance'] },
          { option: 'bypass', selected: !!why, reasons: why ? [why, 'a digest fails open: the result keeps no digest, and nothing waits on it (ADR-0036)'] : ['not bypass: a digest provider is loaded and the hourly bound is not reached'] },
        ],
        decider: { type: 'rule', id: 'workflow.task-digest', version: '1' },
        outcome: { option, detail: { taskId: row.task_id, runId: row.run_id, requested: asked, perHour: cap } },
        deterministic: true,
      }, { ...PRODUCER, runId: row.run_id }).id as ArtifactRef
      if (why) return this.end(row, { state: 'bypassed', decision, reason: why, at: now() })
      this.write(row.run_id, { state: 'requesting', decision, requestedAt: now() })
    })
  }

  /** Ask the digest seam, idempotent by the run's key; a refusal leaves the result without a digest. True to go on. */
  private async request(row: TaskRow, state: Extract<TaskDigest, { state: 'requesting' }>): Promise<boolean> {
    const digests = this.e.ctx.get('digests')
    if (!digests) return this.unreachable(row, state, 'no digest provider is loaded any more (its row is off)')
    const sources = (JSON.parse(row.result!) as { artifacts: ArtifactRef[] }).artifacts
    let view: DigestView
    try {
      view = await digests.request({ sources, key: `workflow-task:${row.run_id}` })
    } catch (error) {
      if (!(error instanceof DigestError)) throw error
      this.e.ctx.store.transaction(() => this.end(row, { ...state, state: 'bypassed', reason: `the digest provider refused the request (${error.failure}: ${error.message})`, at: now() }))
      return false
    }
    this.e.ctx.store.transaction(() => this.write(row.run_id, { ...state, state: 'requested', requestId: view.requestId }))
    return true
  }

  /**
   * Wait for the request to settle, within {@link DIGEST_WAIT_MS} of asking; a written digest is set
   * on the task's result through the board's own `attachDigest`. True to go on.
   */
  private async settle(row: TaskRow, state: Extract<TaskDigest, { state: 'requested' }>): Promise<boolean> {
    const digests = this.e.ctx.get('digests')
    const deadline = Date.parse(state.requestedAt) + DIGEST_WAIT_MS
    if (!digests) return this.unreachable(row, state, 'no digest provider is loaded any more (its row is off)')
    let view = await digests.get(state.requestId)
    // A stop is not a failure: the request stays requested, and the next start waits for it again.
    const stop = this.e.stopped.signal
    const stopped = new Promise<undefined>((resolve) => (stop.aborted ? resolve(undefined) : stop.addEventListener('abort', () => resolve(undefined), { once: true })))
    while (view?.state === 'pending') {
      if (Date.now() >= deadline) {
        this.e.ctx.store.transaction(() => this.end(row, { ...state, state: 'bypassed', reason: `digest request ${state.requestId} did not settle within ${DIGEST_WAIT_MS / HOUR_MS} hours of asking (INV-9)`, at: now() }))
        return false
      }
      if (stop.aborted) return false
      const waited = await Promise.race([digests.wait(state.requestId, Math.max(1, Math.min(WAIT_SLICE_MS, deadline - Date.now()))), stopped])
      if (stop.aborted) return false
      view = waited
    }
    if (!view) {
      this.e.ctx.store.transaction(() => this.end(row, { ...state, state: 'bypassed', reason: `the digest provider no longer knows request ${state.requestId}`, at: now() }))
      return false
    }
    const settled = view.decision ? { settled: view.decision } : {}
    if (view.state !== 'written' || !view.digest) {
      this.e.ctx.store.transaction(() => this.end(row, { ...state, ...settled, state: 'bypassed', reason: `the digest was ${view.state}${view.reason ? `: ${view.reason}` : ''}`, at: now() }))
      return false
    }
    const board = this.e.board
    if (!board) return this.unreachable(row, state, 'no board is loaded to take the digest')
    if (!board.attachDigest) {
      this.e.ctx.store.transaction(() => this.end(row, { ...state, ...settled, state: 'bypassed', reason: `the board takes no digest (its contract is before 1.1); digest ${view.digest} is written but not on the task`, at: now() }))
      return false
    }
    try {
      await board.attachDigest(row.task_id, view.digest)
    } catch (error) {
      if (!(error instanceof BoardError)) throw error
      this.e.ctx.store.transaction(() => this.end(row, { ...state, ...settled, state: 'bypassed', reason: `the board did not take digest ${view.digest} (${error.failure}: ${error.message})`, at: now() }))
      return false
    }
    this.e.ctx.store.transaction(() => this.end(row, { ...state, ...settled, state: 'attached', digest: view.digest!, at: now() }))
    return false
  }

  /** A seam the step needs is not loaded: look again later, until the bound passes. Always false (stop for now). */
  private unreachable(row: TaskRow, state: Extract<TaskDigest, { state: 'requesting' | 'requested' }>, why: string): false {
    if (Date.now() >= Date.parse(state.requestedAt) + DIGEST_WAIT_MS) {
      this.e.ctx.store.transaction(() => this.end(row, { ...state, state: 'bypassed', reason: `${why}, for ${DIGEST_WAIT_MS / HOUR_MS} hours (INV-9)`, at: now() }))
    } else {
      this.later(row.run_id)
    }
    return false
  }

  private write(runId: string, state: TaskDigest): void {
    this.e.ctx.store.db.prepare('UPDATE workflow_tasks SET digest = ?, updated_at = ? WHERE run_id = ?').run(JSON.stringify(state), now(), runId)
  }

  /** The digest's end, attached or bypassed, with the event that says so (in the caller's transaction). */
  private end(row: TaskRow, state: Extract<TaskDigest, { state: 'attached' | 'bypassed' }>): void {
    this.write(row.run_id, state)
    const decision = state.settled ?? state.decision
    this.e.ctx.eventLog.append({
      type: 'workflow.task.digest', runId: row.run_id, ...(decision ? { decision } : {}),
      data: { taskId: row.task_id, state: state.state, ...('requestId' in state && state.requestId ? { requestId: state.requestId } : {}), ...(state.state === 'attached' ? { digest: state.digest } : { reason: state.reason }) },
    })
    if (state.state === 'bypassed') this.e.ctx.logger.info(`workflow: run ${row.run_id}'s result keeps no digest: ${state.reason}`)
  }
}
