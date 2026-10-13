/**
 * The `models` Worker source: every catalog entry of `ctx.models` is a Worker `model:<id>`.
 * Calls are durable, idempotent by key, egress-checked on the exact prompt, bounded (output
 * tokens, concurrency, deadline), and stored as `model-answer` artifacts. A model call has no
 * effect beyond its cost, so after a restart a call that was running is sent once more, never
 * twice (INV-4, safe-to-repeat with a bounded cost).
 */
import { randomBytes } from 'node:crypto'
import { type Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import type { Classification } from '@tsuuanmi/system-egress'
import { type Lease, LeaseLost, StaleGeneration } from '@tsuuanmi/system-leases'
import { type ContentId, sha256 } from '@tsuuanmi/system-libs'
import { ModelError, type ModelFailure, type ModelStatus } from '@tsuuanmi/system-models-core'
import { ProviderError, type ProviderErrorKind, ProviderScheduler, dispositionOf, toProviderError } from '@tsuuanmi/system-provider-core'
import type {} from '@tsuuanmi/system-store'
import type { ArtifactRef, CapabilityDescriptor, ExecutionStatus, WorkerExecution, WorkerStart } from '@tsuuanmi/system-workers-core'

export interface ModelWorkersConfig {
  /** Calls in flight at once, over every model Worker (default 4). */
  maxConcurrentCalls?: number
  /** Hard deadline per call; the call is stopped and fails as `timeout` (default 5 min). */
  callTimeoutMs?: number
  /** Days a finished call (with its prompt) is kept, as turns are (default 30; INV-9). */
  retainDays?: number
}

interface CallRow {
  call_id: string
  request_key: string
  worker: string
  prompt: string
  classification: string
  max_tokens: number | null
  status: ExecutionStatus
  /** How many times the prompt was sent; a restart sends it once more at most. */
  sends: number
  submitted_at: string | null
  result: string | null
  error: string | null
  /** Every decision the call's sends were made under: each egress check, each reconciliation (JSON array). */
  decisions: string
  created_at: string
  updated_at: string
}

const PREFIX = 'model:'
const LEASE_TTL_MS = 60_000
/** The first send, and one more after a restart (INV-4). */
const MAX_SENDS = 2
const newId = (): string => `mcall_${randomBytes(8).toString('hex')}`
const now = (): string => new Date().toISOString()

/** The seam's failures as the engine's failure classes. */
const KINDS: Record<ModelFailure, ProviderErrorKind> = {
  'unknown-model': 'config_error', unavailable: 'config_error', credential: 'reauth_required', quota: 'quota_exhausted',
  'rate-limit': 'overloaded', transient: 'network', timeout: 'timeout', 'invalid-request': 'invalid_input', aborted: 'aborted',
}

export class ModelWorkers {
  static inject = ['store', 'artifacts', 'leases', 'workers', 'egress', 'models']

  private readonly scheduler: ProviderScheduler
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly inflight = new Set<Promise<void>>()
  private readonly cancels = new Map<string, AbortController>()
  private readonly stopped = new AbortController()
  private readonly retries = new Set<NodeJS.Timeout>()

  constructor(private readonly ctx: Context, private readonly config: ModelWorkersConfig = {}) {
    this.scheduler = new ProviderScheduler(config.maxConcurrentCalls ?? 4)
    ctx.store.migrate('models', [{
      version: 1,
      sql: `CREATE TABLE model_calls (
        call_id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, worker TEXT NOT NULL, prompt TEXT NOT NULL, classification TEXT NOT NULL,
        max_tokens INTEGER, status TEXT NOT NULL, sends INTEGER NOT NULL DEFAULT 0, submitted_at TEXT, result TEXT, error TEXT, decisions TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX model_calls_status ON model_calls (status);`,
    }])
    ctx.workers.register({
      name: 'models',
      describe: () => this.describe(),
      start: (request) => this.start(request),
      get: (id) => {
        const row = this.row(id)
        return row && execution(row)
      },
      wait: (id, timeoutMs) => this.wait(id, timeoutMs),
      cancel: (id) => this.cancel(id),
    })
    ctx.effect(() => {
      queueMicrotask(() => {
        this.purge()
        this.recover()
      })
      const daily = setInterval(() => this.purge(), 24 * 60 * 60_000)
      daily.unref()
      return async () => {
        clearInterval(daily)
        // A stop is not a failure: a running call stays as it is, and the next start sends it again once.
        this.stopped.abort()
        for (const timer of this.retries) clearTimeout(timer)
        this.scheduler.close(new ProviderError('aborted', 'model Workers stopped'))
        await Promise.allSettled(this.inflight)
        for (const set of this.waiters.values()) for (const wake of set) wake()
        this.waiters.clear()
      }
    })
  }

  /**
   * Finished calls and their prompts go after `retainDays` (INV-9); the answer stays an artifact
   * while anything retained references it. A failed pass is logged and retried the next day.
   */
  purge(now: number = Date.now()): number {
    const cutoff = new Date(now - (this.config.retainDays ?? 30) * 24 * 60 * 60_000).toISOString()
    try {
      return Number(this.ctx.store.transaction((db) => db.prepare("DELETE FROM model_calls WHERE status IN ('completed', 'failed') AND updated_at < ?").run(cutoff)).changes)
    } catch (error) {
      this.ctx.logger.warn('models: removing finished calls failed; the next daily pass retries')
      this.ctx.logger.warn(error)
      return 0
    }
  }

  /** Each catalog entry: `reason` while its route serves the model, unavailable otherwise. */
  private async describe(): Promise<CapabilityDescriptor[]> {
    const observedAt = now()
    return (await this.ctx.models.list()).map((model): CapabilityDescriptor => ({
      schema: 'capability-descriptor@1.0', worker: PREFIX + model.id, provider: 'models', tier: model.tier, quotaClass: model.quotaClass,
      locality: model.locality,
      capabilities: model.available ? [{ capability: 'reason', evidence: { kind: 'probe', at: observedAt } }] : [],
      state: model.available ? 'ready' : 'unavailable', observedAt,
    }))
  }

  /** Accept a call on an admitted model Worker: durable at once, idempotent by key. */
  private start(request: WorkerStart): WorkerExecution {
    if (!request.worker.startsWith(PREFIX)) throw new ProviderError('invalid_input', `${request.worker} is not a model Worker`)
    if (request.sessionId) throw new ProviderError('invalid_input', 'model Workers hold no sessions; a session needs persistent-conversation')
    if (!request.prompt.trim()) throw new ProviderError('invalid_input', 'prompt must not be empty')
    const key = sha256(`model\0${request.key}`)
    return this.ctx.store.transaction((db) => {
      const existing = db.prepare('SELECT * FROM model_calls WHERE request_key = ?').get(key) as CallRow | undefined
      if (existing) {
        if (existing.prompt !== request.prompt) throw new ProviderError('invalid_input', 'the request key was reused with a different prompt')
        return execution(existing)
      }
      const row: CallRow = {
        call_id: newId(), request_key: key, worker: request.worker, prompt: request.prompt, classification: request.requirement.data.classification,
        max_tokens: request.requirement.budget?.maxTokens ?? null, status: 'queued', sends: 0, submitted_at: null, result: null, error: null, decisions: '[]',
        created_at: now(), updated_at: now(),
      }
      db.prepare(`INSERT INTO model_calls (call_id, request_key, worker, prompt, classification, max_tokens, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`).run(row.call_id, key, row.worker, row.prompt, row.classification, row.max_tokens, row.created_at, row.updated_at)
      this.ctx.store.afterCommit(() => this.schedule(row.call_id))
      return execution(row)
    })
  }

  private async wait(callId: string, timeoutMs: number): Promise<WorkerExecution> {
    const current = this.row(callId)
    if (!current) throw new ProviderError('invalid_input', `unknown model call ${callId}`)
    if (current.status === 'completed' || current.status === 'failed' || this.stopped.signal.aborted) return execution(current)
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(callId) ?? new Set()
      this.waiters.set(callId, set)
      const wake = (): void => {
        clearTimeout(timer)
        set.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, timeoutMs)
      set.add(wake)
    })
    return execution(this.row(callId)!)
  }

  /** Cancel a call (REQ-WRK-4): a running call is aborted, a queued one is never sent. */
  private cancel(callId: string): boolean {
    const row = this.row(callId)
    if (!row || row.status === 'completed' || row.status === 'failed') return false
    const running = this.cancels.get(callId)
    if (running) {
      running.abort(new ProviderError('aborted', 'cancelled by the operator'))
      return true
    }
    const lease = this.ctx.leases.acquire(`model-call:${callId}`, LEASE_TTL_MS)
    if (!lease) return false
    try {
      this.fail(row, new ProviderError('aborted', 'cancelled by the operator'), () => lease)
    } finally {
      this.ctx.leases.release(lease)
    }
    return true
  }

  private recover(): void {
    if (this.stopped.signal.aborted) return
    const rows = this.ctx.store.db.prepare("SELECT call_id FROM model_calls WHERE status IN ('queued', 'running') ORDER BY created_at").all() as Array<{ call_id: string }>
    for (const { call_id } of rows) this.schedule(call_id)
  }

  private retryLater(callId: string, delayMs: number): void {
    if (this.stopped.signal.aborted) return
    const timer = setTimeout(() => {
      this.retries.delete(timer)
      this.schedule(callId)
    }, delayMs)
    timer.unref()
    this.retries.add(timer)
  }

  private schedule(callId: string): void {
    if (this.stopped.signal.aborted) return
    const running = this.runOwned(callId).catch(() => undefined)
    this.inflight.add(running)
    void running.finally(() => this.inflight.delete(running))
  }

  private async runOwned(callId: string): Promise<void> {
    const resource = `model-call:${callId}`
    let lease = this.ctx.leases.acquire(resource, LEASE_TTL_MS)
    if (!lease) {
      // Another process holds it: it finishes the call, or crashed and its lease expires.
      const holder = this.ctx.leases.current(resource)
      this.retryLater(callId, Math.max(1000, (holder?.expiresAt ?? Date.now()) - Date.now() + 1000))
      return
    }
    const lost = new AbortController()
    const heartbeat = setInterval(() => {
      try {
        lease = this.ctx.leases.renew(lease!, LEASE_TTL_MS)
      } catch (error) {
        lost.abort(error)
      }
    }, LEASE_TTL_MS / 3)
    heartbeat.unref()
    const current = (): Lease => lease!
    const cancel = new AbortController()
    this.cancels.set(callId, cancel)
    const signal = AbortSignal.any([lost.signal, this.stopped.signal, cancel.signal])
    try {
      const row = this.row(callId)
      if (!row || row.status === 'completed' || row.status === 'failed') return
      // A call already sent was interrupted by a stop or a crash: whether it is sent again is a
      // recorded decision (INV-4, INV-13), as a website turn's reconciliation is.
      if (row.sends > 0 && !this.reconcile(row, current)) return
      const model = (await this.ctx.models.list()).find((m) => PREFIX + m.id === row.worker)
      if (!model) throw new ProviderError('config_error', `${row.worker} is no longer in the model catalog`)
      // Before every send: the route may have changed since an earlier one (INV-12).
      if (!(await this.egress(row, model, current))) return
      await this.scheduler.runTurn(row.call_id, signal, async (slot) => this.execute(row, model, AbortSignal.any([signal, slot.signal]), current))
    } catch (error) {
      if (this.stopped.signal.aborted) return
      if (error instanceof LeaseLost || error instanceof StaleGeneration || lost.signal.aborted) {
        this.retryLater(callId, LEASE_TTL_MS)
        return
      }
      const row = this.row(callId)
      if (!row || row.status === 'completed' || row.status === 'failed') return
      this.fail(row, cancel.signal.aborted ? new ProviderError('aborted', 'cancelled by the operator') : error, current)
    } finally {
      this.cancels.delete(callId)
      clearInterval(heartbeat)
      try {
        this.ctx.leases.release(current())
      } catch {
        // the store may already be closing; an unreleased lease simply expires
      }
    }
  }

  /**
   * INV-12: the exact prompt is checked before it is sent. A remote model is Worker class
   * `model`; a local one is `model-local`, which by default may also receive local-private data.
   */
  private async egress(row: CallRow, model: ModelStatus, lease: () => Lease): Promise<boolean> {
    const verdict = await this.ctx.egress.check({
      payload: row.prompt, classification: row.classification as Classification, workerClass: model.locality === 'local' ? 'model-local' : 'model',
    })
    this.addDecision(row, verdict.decision, lease)
    if (!verdict.allowed) this.fail(row, new ProviderError('egress_denied', `${verdict.reason} (decision ${verdict.decision})`), lease)
    return verdict.allowed
  }

  private addDecision(row: CallRow, decision: string, lease: () => Lease): void {
    row.decisions = JSON.stringify([...(JSON.parse(row.decisions) as string[]), decision])
    this.ctx.store.transaction((db) => {
      this.ctx.leases.fence(lease())
      db.prepare('UPDATE model_calls SET decisions = ? WHERE call_id = ?').run(row.decisions, row.call_id)
    })
  }

  /**
   * Send a started call once more, or fail it, and record which (a `reconciliation` decision and a
   * `models.call.resent` event). A model call is safe to repeat at a bounded cost: at most
   * `MAX_SENDS` sends, each of which may take re-attempts and be billed.
   */
  private reconcile(row: CallRow, lease: () => Lease): boolean {
    const resend = row.sends < MAX_SENDS
    const reason = resend
      ? `the host stopped after ${row.sends} send(s) of this call; a model call is safe to repeat, so it is sent again (at most ${MAX_SENDS})`
      : `the host stopped after ${row.sends} sends of this call; it is not sent again`
    const decision = this.ctx.artifacts.recordDecision({
      decisionType: 'reconciliation', question: `Is model call ${row.call_id} sent again after the host stopped?`, inputs: [],
      candidates: [{ option: 'resend', selected: resend, reasons: resend ? [reason] : [] }, { option: 'fail', selected: !resend, reasons: resend ? [] : [reason] }],
      decider: { type: 'rule', id: 'models.reconcile', version: '1' }, outcome: { option: resend ? 'resend' : 'fail', detail: { callId: row.call_id, sends: row.sends } }, deterministic: true,
    }, { producer: { type: 'worker', ref: row.worker } }).id
    this.addDecision(row, decision, lease)
    this.ctx.get('eventLog')?.append({ type: resend ? 'models.call.resent' : 'models.call.abandoned', data: { callId: row.call_id, worker: row.worker, sends: row.sends, decision } })
    if (!resend) this.fail(row, new ProviderError('reconciliation_failed', `${reason} (decision ${decision})`), lease)
    return resend
  }

  private async execute(row: CallRow, model: ModelStatus, signal: AbortSignal, lease: () => Lease): Promise<void> {
    // Sent from here on: each send may be billed, so it is counted before it happens.
    this.update(row.call_id, { status: 'running', submitted_at: now(), sends: row.sends + 1 }, lease)
    const timeoutMs = this.config.callTimeoutMs ?? 5 * 60_000
    const deadline = AbortSignal.timeout(timeoutMs)
    const completion = await this.ctx.models.complete({ model: model.id, prompt: row.prompt, maxTokens: row.max_tokens ?? undefined }, AbortSignal.any([signal, deadline]))
      .catch((error: unknown) => {
        if (deadline.aborted && !signal.aborted) throw new ProviderError('timeout', `${row.worker} did not answer within ${timeoutMs} ms; the call was stopped`, { cause: error })
        if (error instanceof ModelError) throw new ProviderError(KINDS[error.failure], error.message, { cause: error })
        throw error
      })
    this.ctx.store.transaction(() => {
      this.ctx.leases.fence(lease())
      const artifact = this.ctx.artifacts.put({
        kind: 'report', bodySchema: 'model-answer@1.0',
        body: {
          schema: 'model-answer@1.0', worker: row.worker, model: model.id, callId: row.call_id, promptHash: sha256(row.prompt),
          quotaClass: model.quotaClass, locality: model.locality, finish: completion.finish, maxTokens: completion.maxTokens,
          // Every provider request this call made may be billed: sends of the call, re-attempts of the last one.
          sends: row.sends + 1, attempts: completion.attempts, usage: completion.usage, text: completion.text,
        },
        classification: row.classification as Classification,
        producer: { type: 'worker', ref: row.worker },
      })
      this.update(row.call_id, { status: 'completed', result: artifact.id }, lease)
    })
  }

  private fail(row: CallRow, error: unknown, lease: () => Lease): void {
    const typed = toProviderError(error)
    this.update(row.call_id, { status: 'failed', error: JSON.stringify({ kind: typed.kind, disposition: dispositionOf(typed.kind), message: typed.message }) }, lease)
  }

  private update(callId: string, fields: Partial<Omit<CallRow, 'call_id'>>, lease: () => Lease): void {
    const entries = Object.entries({ ...fields, updated_at: now() })
    this.ctx.store.transaction((db) => {
      this.ctx.leases.fence(lease())
      db.prepare(`UPDATE model_calls SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE call_id = ?`).run(...entries.map(([, v]) => v as string | number | null), callId)
    })
    if (fields.status === 'completed' || fields.status === 'failed') {
      this.ctx.store.afterCommit(() => {
        for (const wake of this.waiters.get(callId) ?? []) wake()
        this.waiters.delete(callId)
      })
    }
  }

  private row(callId: string): CallRow | undefined {
    return this.ctx.store.db.prepare('SELECT * FROM model_calls WHERE call_id = ?').get(callId) as CallRow | undefined
  }
}

function execution(row: CallRow): WorkerExecution {
  return {
    id: row.call_id, status: row.status, submitted: row.submitted_at !== null,
    ...(row.result ? { result: row.result as ArtifactRef } : {}),
    ...(row.error ? { error: JSON.parse(row.error) as WorkerExecution['error'] & object } : {}),
    decisions: JSON.parse(row.decisions) as ContentId[],
  }
}
