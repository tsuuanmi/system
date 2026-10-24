/**
 * The `models` Worker source: every catalog entry of `ctx.models` is a Worker `model:<id>`.
 * Calls are durable, idempotent by key, egress-checked on the exact prompt, bounded (output
 * tokens, concurrency, deadline), and stored as `model-answer` artifacts. A model call has no
 * effect beyond its cost, so after a restart a call that was running is sent once more, never
 * twice (INV-4, safe-to-repeat with a bounded cost).
 *
 * A session (ADR-0031) is kept as its transcript: each turn replays the session's earlier turns,
 * one turn in flight at a time, within bounds, and the exact history a call was accepted with is
 * what any re-send replays. A transcript ends with its session.
 */
import { randomBytes } from 'node:crypto'
import { type Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import type { Classification } from '@tsuuanmi/system-egress'
import { type Lease, LeaseLost, StaleGeneration } from '@tsuuanmi/system-leases'
import { type ContentId, sha256 } from '@tsuuanmi/system-libs'
import { ModelError, type ModelFailure, type ModelStatus, type ModelTurn } from '@tsuuanmi/system-models-core'
import { ProviderError, type ProviderErrorKind, ProviderScheduler, dispositionOf, promptOfStart, toProviderError } from '@tsuuanmi/system-provider-core'
import type {} from '@tsuuanmi/system-store'
import type { ArtifactRef, CapabilityDescriptor, ExecutionStatus, WorkerExecution, WorkerStart } from '@tsuuanmi/system-workers-core'

export interface ModelWorkersConfig {
  /** Calls in flight at once, over every model Worker (default 4). */
  maxConcurrentCalls?: number
  /**
   * Hard ceiling per call, over every attempt and back-off; the call is stopped and fails as
   * `timeout` (default 15 min: the default re-attempts of a stalled stream fit within it). A
   * stalled stream is caught sooner, by `ctx.models` (`idleTimeoutMs`).
   */
  callTimeoutMs?: number
  /** Days a finished call (with its prompt) is kept, as turns are (default 30; INV-9). */
  retainDays?: number
  /**
   * A session's turns, at most (default 100, the session layer's own turn budget; an entry may set
   * its own; ADR-0031).
   */
  maxSessionTurns?: number
  /**
   * The characters of a session's history a turn may replay, at most (default 320,000, about 80k
   * tokens: above the session layer's compaction point, so a long session is compacted before it
   * reaches it; an entry may set its own).
   */
  maxHistoryChars?: number
}

interface TurnRow {
  seq: number
  prompt: string
  answer: string
  classification: string
}

interface SessionRow {
  worker: string
  family: string | null
  locality: string | null
  tier: string | null
  generation: number
}

/** A turn's replayed history and the classification of everything it sends and answers. */
interface History {
  turns: ModelTurn[]
  classification: Classification
}

const TIERS = ['economy', 'standard', 'frontier']
const CLASSIFICATIONS: readonly Classification[] = ['public', 'operator-shared', 'local-private']
const highest = (values: readonly string[]): Classification => CLASSIFICATIONS[Math.max(0, ...values.map((v) => CLASSIFICATIONS.indexOf(v as Classification)))]!
/** What a history is, by its turns: a re-send must replay exactly the turns it was accepted with. */
const hashTurns = (turns: readonly TurnRow[]): string => sha256(JSON.stringify(turns.map((t) => [t.seq, t.prompt, t.answer])))

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
  /** A session's turn: the session, its generation, and the history it was accepted with (its last turn and hash). */
  session_id: string | null
  session_generation: number | null
  history_seq: number | null
  history_hash: string | null
  created_at: string
  updated_at: string
}

const PREFIX = 'model:'
/** The default ceiling per call: three attempts' worth of the default silence bound. */
export const DEFAULT_CALL_TIMEOUT_MS = 15 * 60_000
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
  /** Each model Worker as last described (its family, locality, and tier): what a session may move to. */
  private readonly described = new Map<string, { family: string | undefined; locality: string; tier: string }>()

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
    }, {
      version: 2,
      sql: `ALTER TABLE model_calls ADD COLUMN session_id TEXT;
      ALTER TABLE model_calls ADD COLUMN session_generation INTEGER;
      ALTER TABLE model_calls ADD COLUMN history_seq INTEGER;
      ALTER TABLE model_calls ADD COLUMN history_hash TEXT;
      CREATE INDEX model_calls_session ON model_calls (session_id, status);
      CREATE TABLE model_sessions (
        session_id TEXT PRIMARY KEY, worker TEXT NOT NULL, family TEXT, locality TEXT, tier TEXT,
        generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE model_session_turns (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL, call_id TEXT NOT NULL, prompt TEXT NOT NULL, answer TEXT NOT NULL,
        classification TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (session_id, seq)
      );`,
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
      // A session stays on its model; only an escalation moves it, within the family and locality.
      affinity: (sessionId) => {
        const session = this.session(sessionId)
        return session ? [session.worker, ...[...this.described.keys()].filter((w) => w !== session.worker && this.escalates(session, w))] : undefined
      },
      handle: (sessionId) => (this.session(sessionId) ? `model-session:${sessionId}` : undefined),
      // A fresh conversation on the same Worker: the transcript goes, the session and its model stay.
      reset: (sessionId) => this.resetSession(sessionId),
      // The session ended: its transcript goes with it (ADR-0031).
      release: (sessionIds) => {
        this.forget(sessionIds)
        return { due: 0 }
      },
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

  /**
   * Each catalog entry: `reason` while its route serves the model, unavailable otherwise; and
   * `persistent-conversation`, which this source provides by replay (ADR-0031), so its own
   * conformance is the evidence.
   */
  private async describe(): Promise<CapabilityDescriptor[]> {
    const observedAt = now()
    const models = await this.ctx.models.list()
    for (const model of models) this.described.set(PREFIX + model.id, { family: model.family, locality: model.locality, tier: model.tier })
    return models.map((model): CapabilityDescriptor => ({
      schema: model.description ? 'capability-descriptor@1.7' : model.maxInputChars ? 'capability-descriptor@1.2' : model.family ? 'capability-descriptor@1.1' : 'capability-descriptor@1.0', worker: PREFIX + model.id, provider: 'models',
      ...(model.family ? { family: model.family } : {}), ...(model.description ? { description: model.description } : {}), ...(model.maxInputChars ? { maxInputChars: model.maxInputChars } : {}), tier: model.tier, quotaClass: model.quotaClass, locality: model.locality,
      capabilities: model.available
        ? [{ capability: 'reason', evidence: { kind: 'probe', at: observedAt } }, { capability: 'persistent-conversation', evidence: { kind: 'conformance', at: observedAt } }]
        : [],
      state: model.available ? 'ready' : 'unavailable', observedAt,
    }))
  }

  /** Accept a call on an admitted model Worker: durable at once, idempotent by key. */
  private start(request: WorkerStart): WorkerExecution {
    if (!request.worker.startsWith(PREFIX)) throw new ProviderError('invalid_input', `${request.worker} is not a model Worker`)
    // A brief is rendered here, at start, its pointers resolved to their artifacts' text (INV-12).
    const { prompt, classification } = promptOfStart(request, (ref) => this.ctx.artifacts.get(ref))
    if (!prompt.trim()) throw new ProviderError('invalid_input', 'prompt must not be empty')
    const key = sha256(`model\0${request.key}`)
    const sessionId = request.sessionId ?? null
    return this.ctx.store.transaction((db) => {
      const existing = db.prepare('SELECT * FROM model_calls WHERE request_key = ?').get(key) as CallRow | undefined
      if (existing) {
        if (existing.prompt !== prompt || existing.session_id !== sessionId) throw new ProviderError('invalid_input', 'the request key was reused with a different prompt or session')
        return execution(existing)
      }
      let historySeq: number | null = null
      let historyHash: string | null = null
      let generation: number | null = null
      if (sessionId) {
        // One turn in flight per session: the next replays the history this one appends to.
        const busy = db.prepare("SELECT call_id FROM model_calls WHERE session_id = ? AND status IN ('queued', 'running')").get(sessionId) as { call_id: string } | undefined
        if (busy) throw new ProviderError('overloaded', `session ${sessionId} has a turn in flight (${busy.call_id}); its next turn waits for it`)
        let session = this.session(sessionId)
        if (!session) {
          // The session is the source's from its first turn: its model, family, and locality bind it.
          const seen = this.described.get(request.worker)
          db.prepare('INSERT INTO model_sessions (session_id, worker, family, locality, tier, generation, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
            .run(sessionId, request.worker, seen?.family ?? null, seen?.locality ?? null, seen?.tier ?? null, now())
          session = this.session(sessionId)!
        } else if (session.worker !== request.worker && !this.escalates(session, request.worker)) {
          throw new ProviderError('invalid_input', `session ${sessionId} is with ${session.worker}; ${request.worker} may take it only as an escalation within its family and locality`)
        }
        generation = session.generation
        const turns = this.turns(sessionId, Number.MAX_SAFE_INTEGER)
        historySeq = turns.at(-1)?.seq ?? 0
        historyHash = hashTurns(turns)
      }
      const row: CallRow = {
        call_id: newId(), request_key: key, worker: request.worker, prompt, classification,
        max_tokens: request.requirement.budget?.maxTokens ?? null, status: 'queued', sends: 0, submitted_at: null, result: null, error: null, decisions: '[]',
        session_id: sessionId, session_generation: generation, history_seq: historySeq, history_hash: historyHash, created_at: now(), updated_at: now(),
      }
      db.prepare(`INSERT INTO model_calls (call_id, request_key, worker, prompt, classification, max_tokens, status, session_id, session_generation, history_seq, history_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`).run(row.call_id, key, row.worker, row.prompt, row.classification, row.max_tokens, sessionId, generation, historySeq, historyHash, row.created_at, row.updated_at)
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
    // While another process holds it, it finishes the call, or crashed and its lease expires.
    const outcome = await this.ctx.leases.hold(`model-call:${callId}`, LEASE_TTL_MS, async ({ lease: current, lost }) => {
      const cancel = new AbortController()
      this.cancels.set(callId, cancel)
      const signal = AbortSignal.any([lost, this.stopped.signal, cancel.signal])
      try {
        const row = this.row(callId)
        if (!row || row.status === 'completed' || row.status === 'failed') return
        // A call already sent was interrupted by a stop or a crash: whether it is sent again is a
        // recorded decision (INV-4, INV-13), as a website turn's reconciliation is.
        if (row.sends > 0 && !this.reconcile(row, current)) return
        const model = (await this.ctx.models.list()).find((m) => PREFIX + m.id === row.worker)
        if (!model) throw new ProviderError('config_error', `${row.worker} is no longer in the model catalog`)
        // The history this turn was accepted with, within this entry's bounds; nothing is sent otherwise.
        const history = this.history(row, model)
        // Before every send: the route may have changed since an earlier one (INV-12).
        if (!(await this.egress(row, model, history, current))) return
        await this.scheduler.runTurn(row.call_id, signal, async (slot) => this.execute(row, model, history, AbortSignal.any([signal, slot.signal]), current))
      } catch (error) {
        if (this.stopped.signal.aborted) return
        if (error instanceof LeaseLost || error instanceof StaleGeneration || lost.aborted) {
          this.retryLater(callId, LEASE_TTL_MS)
          return
        }
        const row = this.row(callId)
        if (!row || row.status === 'completed' || row.status === 'failed') return
        this.fail(row, cancel.signal.aborted ? new ProviderError('aborted', 'cancelled by the operator') : error, current)
      } finally {
        this.cancels.delete(callId)
      }
    })
    if (!outcome.held) this.retryLater(callId, outcome.retryInMs)
  }

  /**
   * INV-12: what is sent is checked before it is sent: the prompt, and a session's replayed turns
   * (serialized as the turns sent, in order), at the highest classification of the prompt and of
   * every replayed prompt and answer. A remote model is Worker class `model`, a local one
   * `model-local`; local-private data reaches either only if the operator allows it.
   */
  private async egress(row: CallRow, model: ModelStatus, history: History, lease: () => Lease): Promise<boolean> {
    const payload = history.turns.length ? JSON.stringify([...history.turns, { role: 'user', text: row.prompt }]) : row.prompt
    const verdict = await this.ctx.egress.check({
      payload, classification: history.classification, workerClass: model.locality === 'local' ? 'model-local' : 'model',
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
      candidates: [
        { option: 'resend', selected: resend, reasons: resend ? [reason] : [`not resend: the bound of ${MAX_SENDS} sends is reached`] },
        { option: 'fail', selected: !resend, reasons: resend ? [`not fail: ${row.sends} of at most ${MAX_SENDS} sends were used`] : [reason] },
      ],
      decider: { type: 'rule', id: 'models.reconcile', version: '1' }, outcome: { option: resend ? 'resend' : 'fail', detail: { callId: row.call_id, sends: row.sends } }, deterministic: true,
    }, { producer: { type: 'worker', ref: row.worker } }).id
    this.addDecision(row, decision, lease)
    this.ctx.get('eventLog')?.append({ type: resend ? 'models.call.resent' : 'models.call.abandoned', data: { callId: row.call_id, worker: row.worker, sends: row.sends, decision } })
    if (!resend) this.fail(row, new ProviderError('reconciliation_failed', `${reason} (decision ${decision})`), lease)
    return resend
  }

  /**
   * A session turn's history: exactly the turns it was accepted with (their hash must match, so a
   * reset since is not replayed as if nothing happened), within this entry's bounds. Past a bound
   * the turn fails, and nothing is cut.
   */
  private history(row: CallRow, model: ModelStatus): History {
    if (!row.session_id) return { turns: [], classification: row.classification as Classification }
    const turns = this.turns(row.session_id, row.history_seq ?? 0)
    if (hashTurns(turns) !== row.history_hash) throw new ProviderError('invalid_input', `session ${row.session_id} changed after this turn was accepted (it was reset); it is not sent`)
    const maxTurns = model.maxSessionTurns ?? this.config.maxSessionTurns ?? 100
    if (turns.length + 1 > maxTurns) throw new ProviderError('invalid_input', `session ${row.session_id} would have ${turns.length + 1} turns; ${model.id} allows ${maxTurns} (maxSessionTurns)`)
    const chars = turns.reduce((n, t) => n + t.prompt.length + t.answer.length, 0)
    const maxChars = model.maxHistoryChars ?? this.config.maxHistoryChars ?? 320_000
    if (chars > maxChars) throw new ProviderError('invalid_input', `session ${row.session_id} has ${chars} characters of history; ${model.id} replays at most ${maxChars} (maxHistoryChars)`)
    return {
      turns: turns.flatMap((t): ModelTurn[] => [{ role: 'user', text: t.prompt }, { role: 'assistant', text: t.answer }]),
      // What this turn sends and answers is as sensitive as anything it replays.
      classification: highest([row.classification, ...turns.map((t) => t.classification)]),
    }
  }

  /** Whether `worker` may take over `session` as an escalation: the same family and locality, a higher tier. */
  private escalates(session: SessionRow, worker: string): boolean {
    const to = this.described.get(worker)
    const from = this.described.get(session.worker)
    const family = session.family ?? from?.family
    const locality = session.locality ?? from?.locality
    const tier = session.tier ?? from?.tier
    return !!to && !!family && to.family === family && to.locality === locality && TIERS.indexOf(to.tier) > TIERS.indexOf(tier ?? '')
  }

  /** A fresh conversation on the same Worker: the turns go, the session (and so its affinity) stays, at a new generation. */
  private resetSession(sessionId: string): boolean {
    return this.ctx.store.transaction((db) => {
      db.prepare('DELETE FROM model_session_turns WHERE session_id = ?').run(sessionId)
      return Number(db.prepare('UPDATE model_sessions SET generation = generation + 1 WHERE session_id = ?').run(sessionId).changes) > 0
    })
  }

  private turns(sessionId: string, upTo: number): TurnRow[] {
    return this.ctx.store.db.prepare('SELECT seq, prompt, answer, classification FROM model_session_turns WHERE session_id = ? AND seq <= ? ORDER BY seq').all(sessionId, upTo) as unknown as TurnRow[]
  }

  private session(sessionId: string): SessionRow | undefined {
    return this.ctx.store.db.prepare('SELECT worker, family, locality, tier, generation FROM model_sessions WHERE session_id = ?').get(sessionId) as SessionRow | undefined
  }

  /** Delete sessions' transcripts; how many sessions there were. */
  private forget(sessionIds: readonly string[]): number {
    return this.ctx.store.transaction((db) => {
      let n = 0
      for (const id of sessionIds) {
        db.prepare('DELETE FROM model_session_turns WHERE session_id = ?').run(id)
        n += Number(db.prepare('DELETE FROM model_sessions WHERE session_id = ?').run(id).changes)
      }
      return n
    })
  }

  private async execute(row: CallRow, model: ModelStatus, history: History, signal: AbortSignal, lease: () => Lease): Promise<void> {
    // Sent from here on: each send may be billed, so it is counted before it happens.
    this.update(row.call_id, { status: 'running', submitted_at: now(), sends: row.sends + 1 }, lease)
    const timeoutMs = this.config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    const deadline = AbortSignal.timeout(timeoutMs)
    const completion = await this.ctx.models.complete({ model: model.id, prompt: row.prompt, maxTokens: row.max_tokens ?? undefined, ...(history.turns.length ? { history: history.turns } : {}) }, AbortSignal.any([signal, deadline]))
      .catch((error: unknown) => {
        if (deadline.aborted && !signal.aborted) throw new ProviderError('timeout', `${row.worker} did not finish within ${timeoutMs} ms (callTimeoutMs, the ceiling over every attempt); the call was stopped`, { cause: error })
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
        // As sensitive as everything it was answered from, the replayed history included (REQ-WRK-7).
        classification: history.classification,
        producer: { type: 'worker', ref: row.worker },
      })
      if (row.session_id) this.append(row, model, completion.text, history.classification)
      this.update(row.call_id, { status: 'completed', result: artifact.id }, lease)
    })
  }

  /**
   * The turn joins its session's transcript with the call's completion, never apart, and only into
   * the session it was accepted for: one that ended (released) or started over (reset) since, or
   * has moved on, takes nothing. The call still completes.
   */
  private append(row: CallRow, model: ModelStatus, answer: string, classification: Classification): void {
    const db = this.ctx.store.db
    const session = this.session(row.session_id!)
    const last = (db.prepare('SELECT MAX(seq) AS seq FROM model_session_turns WHERE session_id = ?').get(row.session_id!) as { seq: number | null }).seq ?? 0
    if (!session || session.generation !== row.session_generation || last !== (row.history_seq ?? 0)) {
      this.ctx.get('eventLog')?.append({ type: 'models.session.turn-dropped', data: { callId: row.call_id, sessionId: row.session_id, reason: !session ? 'the session ended' : session.generation !== row.session_generation ? 'the session was reset' : 'the session moved on' } })
      return
    }
    db.prepare('UPDATE model_sessions SET family = COALESCE(family, ?), locality = COALESCE(locality, ?), tier = COALESCE(tier, ?) WHERE session_id = ?')
      .run(model.family ?? null, model.locality, model.tier, row.session_id!)
    db.prepare('INSERT INTO model_session_turns (session_id, seq, call_id, prompt, answer, classification, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.session_id!, last + 1, row.call_id, row.prompt, answer, classification, now())
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
