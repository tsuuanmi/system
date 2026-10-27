/**
 * The one request engine every digest provider runs on (D6): durable requests in the provider's own
 * table, driven under a lease, routed through `ctx.workers` for a read-only Worker on a tier, the
 * Worker's answer quote-checked, the one escalation, and the settling `acceptance` decision. A
 * provider keeps what differs: its migration and table, its preamble and brief ({@link DigestSpec.prepare}),
 * and how it reads an answer ({@link DigestSpec.accept}). A digest fails open (ADR-0036); a restart
 * picks up each pending request where it stood, never starting its Worker run twice (INV-4).
 */
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-ledger-core'
import type {} from '@tsuuanmi/system-gateway-core'
import { type Lease, LeaseLost, StaleGeneration } from '@tsuuanmi/system-board-core'
import { type Brief, bodyText, clampText, extractJson, NO_LOCAL_SANDBOX, renderBrief, sha256 } from '@tsuuanmi/system-libs'
import { AdmissionFailure, type Classification, type Tier, type WorkRequirement } from '@tsuuanmi/system-workers-core'
import { type ArtifactRef, checkedRequest, DIGEST_LIMITS, DigestError, type DigestRequest, type DigestState, type DigestView, type EscalationDecision, escalation, type QuoteCheck, settlement } from './index.ts'

/** A request as the provider's table holds it. `extract` is there only where the provider's table has the column. */
export interface DigestRow {
  request_id: string
  request_key: string | null
  sources: string
  classification: Classification
  state: DigestState
  source: string | null
  worker: string | null
  execution_id: string | null
  brief: string | null
  extract?: string | null
  digest: string | null
  decision: string | null
  kept: number | null
  dropped: number | null
  reason: string | null
  /** The tier the request runs on now: null for the configured one, `standard` once escalated. */
  tier: Tier | null
  /** The `escalation` decision, once the request escalated. */
  escalation: string | null
  /** The answer whose every claim failed the quote check before the escalation, and that check (JSON {@link Escalated}). */
  escalated_from: string | null
  created_at: string
  updated_at: string
}

/** What a provider gives the engine. */
export interface DigestSpec {
  /** The provider's table, and the prefix of its request ids. */
  table: string
  idPrefix: string
  /** The tier the Worker runs on, as both minimum and maximum. */
  tier: Tier
  maxPending: number
  timeoutMs: number
  /** What the Worker is asked for, in the work requirement. */
  goal: string
  /**
   * The brief and its inputs for a request, before routing: a string is why nothing can be asked
   * (the request is bypassed). An `extract` is recorded on the request (a column of the provider's table).
   */
  prepare: (row: DigestRow, sources: ArtifactRef[]) => { draft: Omit<Brief, 'sandbox'>; inputs: ArtifactRef[]; extract?: ArtifactRef } | string
  /** The quote check of the Worker's answer (the JSON object it ended with), or why it cannot be checked. */
  accept: (row: DigestRow, sources: ArtifactRef[], answer: Record<string, unknown> | undefined) => QuoteCheck | string
}

/** What the economy answer came to before a request escalated: it stands if the escalation cannot run. */
interface Escalated { answer: ArtifactRef; tier: Tier; check: QuoteCheck }

type Outcome =
  | { state: 'written'; check: QuoteCheck; inputs: ArtifactRef[] }
  | { state: 'not-written'; check?: QuoteCheck; reason: string; inputs?: ArtifactRef[] }
  | { state: 'bypassed'; reason: string; inputs?: ArtifactRef[] }

const CONTENT_ID = /^sha256:[0-9a-f]{64}$/
const RANK: Record<Classification, number> = { public: 0, 'operator-shared': 1, 'local-private': 2 }
const LEASE_TTL_MS = 60_000
/** How long one wait on the Worker's run lasts before the request looks at its deadline again. */
const POLL_MS = 30_000
const PRODUCER = { type: 'system', ref: 'digests' } as const
/** What a digest asks of routing: a Worker that reviews a provided subject on this machine, read-only (a read-only agent Worker proves both). */
const CAPABILITIES = ['review', 'local-data']
const now = (): string => new Date().toISOString()

function digestView(row: DigestRow): DigestView {
  return {
    requestId: row.request_id, state: row.state, sources: JSON.parse(row.sources) as ArtifactRef[],
    ...(row.digest ? { digest: row.digest as ArtifactRef } : {}), ...(row.decision ? { decision: row.decision as ArtifactRef } : {}),
    ...(row.brief ? { brief: row.brief as ArtifactRef } : {}), ...(row.worker ? { worker: row.worker } : {}),
    ...(row.kept !== null && row.dropped !== null ? { claims: { kept: row.kept, dropped: row.dropped } } : {}), ...(row.escalation ? { escalation: row.escalation as ArtifactRef } : {}),
    ...(row.reason ? { reason: row.reason } : {}), createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true })))
}

export class DigestEngine {
  private readonly stopped = new AbortController()
  private readonly inflight = new Set<Promise<void>>()
  private readonly retries = new Set<NodeJS.Timeout>()
  private readonly driving = new Set<string>()
  private readonly waiters = new Map<string, Set<() => void>>()

  /** Call after the provider's migration: it starts on mount and stops with the provider. */
  constructor(private readonly ctx: Context, private readonly spec: DigestSpec) {
    ctx.effect(() => {
      queueMicrotask(() => this.recover())
      return async () => {
        // A stop is not a failure: a pending request stays pending, and the next start goes on with it.
        this.stopped.abort()
        for (const timer of this.retries) clearTimeout(timer)
        await Promise.allSettled(this.inflight)
        for (const set of this.waiters.values()) for (const wake of set) wake()
        this.waiters.clear()
      }
    })
  }

  async request(input: DigestRequest): Promise<DigestView> {
    const { table } = this.spec
    const sources = [...(input.sources ?? [])]
    if (!sources.length || sources.length > DIGEST_LIMITS.sources) throw new DigestError('invalid', `a digest request names 1 to ${DIGEST_LIMITS.sources} artifacts, not ${sources.length}`)
    if (new Set(sources).size !== sources.length) throw new DigestError('invalid', 'a digest request names each artifact once')
    if (input.key !== undefined && (typeof input.key !== 'string' || !input.key || [...input.key].length > 200)) throw new DigestError('invalid', 'a request key is 1 to 200 characters')
    let classification: Classification = 'public'
    for (const ref of sources) {
      const stored = CONTENT_ID.test(ref) ? this.ctx.artifacts.get(ref) : undefined
      if (!stored) throw new DigestError('invalid', `${String(ref).slice(0, 80)} is not a stored artifact; nothing was requested`)
      if (RANK[stored.classification] > RANK[classification]) classification = stored.classification
    }
    const key = input.key !== undefined ? sha256(`digests\0${input.key}`) : null
    return this.ctx.store.transaction((db) => {
      const existing = key ? db.prepare(`SELECT * FROM ${table} WHERE request_key = ?`).get(key) as DigestRow | undefined : undefined
      if (existing) {
        if (existing.sources !== JSON.stringify(sources)) throw new DigestError('invalid', 'the request key was used for other sources; nothing was requested')
        return checkedRequest(input, digestView(existing))
      }
      const pending = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE state = 'pending'`).get() as { n: number }).n
      if (pending >= this.spec.maxPending) throw new DigestError('overloaded', `${pending} digest requests are pending (limit ${this.spec.maxPending}); ask again once one settles`)
      const id = `${this.spec.idPrefix}-${randomBytes(12).toString('hex')}`
      const at = now()
      db.prepare(`INSERT INTO ${table} (request_id, request_key, sources, classification, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`)
        .run(id, key, JSON.stringify(sources), classification, at, at)
      // Checked before it commits (contract 1.2): a check that throws records nothing and schedules nothing.
      const made = checkedRequest(input, digestView(this.row(id)!))
      this.ctx.store.afterCommit(() => this.schedule(id))
      return made
    })
  }

  async get(requestId: string): Promise<DigestView | undefined> {
    const row = this.row(requestId)
    return row && digestView(row)
  }

  async wait(requestId: string, timeoutMs: number): Promise<DigestView> {
    const current = this.row(requestId)
    if (!current) throw new DigestError('unknown-request', `no digest request ${String(requestId).slice(0, 80)}`)
    if (current.state !== 'pending' || this.stopped.signal.aborted || timeoutMs <= 0) return digestView(current)
    await new Promise<void>((resolve) => {
      const set = this.waiters.get(requestId) ?? new Set()
      this.waiters.set(requestId, set)
      const wake = (): void => {
        clearTimeout(timer)
        set.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, timeoutMs)
      set.add(wake)
    })
    return digestView(this.row(requestId)!)
  }

  /** On start: every pending request goes on where it stood. */
  private recover(): void {
    if (this.stopped.signal.aborted) return
    const rows = this.ctx.store.db.prepare(`SELECT request_id FROM ${this.spec.table} WHERE state = 'pending' ORDER BY created_at`).all() as Array<{ request_id: string }>
    for (const { request_id } of rows) this.schedule(request_id)
  }

  private schedule(requestId: string): void {
    if (this.stopped.signal.aborted || this.driving.has(requestId)) return
    this.driving.add(requestId)
    const driving = this.drive(requestId).catch((error: unknown) => {
      this.ctx.logger.warn(`digests: request ${requestId} could not be driven: ${(error as Error)?.message ?? String(error)}`)
    }).finally(() => {
      this.driving.delete(requestId)
      this.inflight.delete(driving)
    })
    this.inflight.add(driving)
  }

  private retryLater(requestId: string, delayMs: number): void {
    if (this.stopped.signal.aborted) return
    const timer = setTimeout(() => {
      this.retries.delete(timer)
      this.schedule(requestId)
    }, delayMs)
    timer.unref()
    this.retries.add(timer)
  }

  /** Drive one request under its lease, so one holder serves it; anything unexpected bypasses it (fail open). */
  private async drive(requestId: string): Promise<void> {
    const outcome = await this.ctx.leases.hold(`digest:${requestId}`, LEASE_TTL_MS, async ({ lease, lost }) => {
      const signal = AbortSignal.any([lost, this.stopped.signal])
      try {
        await this.serve(requestId, lease, signal)
      } catch (error) {
        if (this.stopped.signal.aborted) return
        if (lost.aborted || error instanceof LeaseLost || error instanceof StaleGeneration) {
          this.retryLater(requestId, LEASE_TTL_MS)
          return
        }
        // A digest fails open (ADR-0036): whatever went wrong, the request is bypassed and recorded.
        const row = this.row(requestId)
        if (row?.state === 'pending') this.fail(row, `the digest could not be written: ${(error as Error)?.message ?? String(error)}`, lease)
      }
    })
    if (!outcome.held) this.retryLater(requestId, outcome.retryInMs)
  }

  private async serve(requestId: string, lease: () => Lease, signal: AbortSignal): Promise<void> {
    let row = this.row(requestId)
    // At most two runs: the configured tier's, and one escalation (INV-9).
    while (row?.state === 'pending') {
      const sources = JSON.parse(row.sources) as ArtifactRef[]
      if (!row.execution_id) {
        const started = await this.start(row, sources, lease, signal)
        if (!started) return
        row = started
      }
      const source = this.ctx.workers.source(row.source!)
      if (!source) return this.fail(row, `its Worker source ${row.source} is no longer registered (its row is off); nothing was digested`, lease)
      const deadline = Date.parse(row.created_at) + this.spec.timeoutMs
      let current = source.get(row.execution_id!)
      const stop = aborted(signal)
      while (current && (current.status === 'queued' || current.status === 'running')) {
        if (signal.aborted) return
        if (Date.now() >= deadline) {
          source.cancel?.(current.id)
          return this.fail(row, `the digest Worker did not finish within ${this.spec.timeoutMs / 60_000} minutes (timeoutMinutes); its run was cancelled`, lease)
        }
        await Promise.race([source.wait(current.id, Math.max(1, Math.min(POLL_MS, deadline - Date.now()))), stop])
        if (signal.aborted) return
        current = source.get(current.id)
      }
      if (!current) return this.fail(row, `the digest Worker's execution ${row.execution_id} is gone`, lease)
      if (current.status === 'failed' || !current.result) {
        const error = current.error
        return this.fail(row, `the digest Worker's run failed (${error ? `${error.kind}: ${error.message}` : 'no result'})`, lease)
      }
      const result = current.result
      const body = this.ctx.artifacts.get(result)?.body
      const check = this.spec.accept(row, sources, body !== undefined ? extractJson(bodyText(body)) : undefined)
      if (typeof check === 'string') return this.fail(row, check, lease)
      const after = [...(row.escalation ? [row.escalation as ArtifactRef] : []), ...(row.extract ? [row.extract as ArtifactRef] : [])]
      if (check.digest) return this.settle(row, { state: 'written', check, inputs: [result, ...after] }, lease)
      const tier = row.tier ?? this.spec.tier
      const decided = escalation({ requestId: row.request_id, sources, tier, escalated: !!row.escalation }, check, result)
      if (!decided) {
        const reason = row.escalation ? `${check.reason}, on ${tier} too, after one escalation: given up` : check.reason!
        return this.settle(row, { state: 'not-written', check, reason, inputs: [result, ...after] }, lease)
      }
      row = this.escalate(row, decided, { answer: result, tier, check }, lease)
    }
  }

  /**
   * Escalate once (contract 1.1): the `escalation` decision recorded, and the request made ready to
   * route again on the standard tier, in one transaction under its lease, so a restart routes the
   * second run once, never a third (INV-4, INV-13). The second run is given the same extract, if any.
   */
  private escalate(row: DigestRow, decision: EscalationDecision, from: Escalated, lease: () => Lease): DigestRow | undefined {
    return this.ctx.store.transaction((db) => {
      this.ctx.leases.fence(lease())
      const current = this.row(row.request_id)
      if (current?.state !== 'pending' || current.escalation) return current
      const recorded = this.ctx.artifacts.recordDecision(decision, { producer: PRODUCER, classification: row.classification }).id
      db.prepare(`UPDATE ${this.spec.table} SET tier = ?, escalation = ?, escalated_from = ?, source = NULL, worker = NULL, execution_id = NULL, updated_at = ? WHERE request_id = ?`)
        .run(decision.outcome.detail['to'] as string, recorded, JSON.stringify(from), now(), row.request_id)
      this.ctx.logger.info(`digests: request ${row.request_id} escalated to ${String(decision.outcome.detail['to'])}: every claim of the ${from.tier} answer failed the quote check`)
      return this.row(row.request_id)
    })
  }

  /**
   * A run that could not give an answer: the request fails open, bypassed. After an escalation a
   * Worker did answer, on the tier before it, so that answer stands: the request settles
   * `not-written` on its check, with why the escalation did not run to an answer.
   */
  private fail(row: DigestRow, why: string, lease: () => Lease, inputs: ArtifactRef[] = []): void {
    const extract = row.extract ? [row.extract as ArtifactRef] : []
    if (!row.escalation || !row.escalated_from) return this.settle(row, { state: 'bypassed', reason: why, inputs: [...inputs, ...extract] }, lease)
    const from = JSON.parse(row.escalated_from) as Escalated
    const reason = `${from.check.reason}; the escalation to ${row.tier} did not answer (${why}), so the ${from.tier} answer stands`
    this.settle(row, { state: 'not-written', check: from.check, reason, inputs: [from.answer, row.escalation as ArtifactRef, ...inputs, ...extract] }, lease)
  }

  /**
   * Prepare the brief, route the request, and start its Worker run, given a brief recorded before it
   * starts, in the transaction that names the execution on the request (so a restart never starts it
   * twice). Nothing to ask, no Worker admitted, or a start refused bypasses the request. The started row, or undefined.
   */
  private async start(row: DigestRow, sources: ArtifactRef[], lease: () => Lease, signal: AbortSignal): Promise<DigestRow | undefined> {
    const prepared = this.spec.prepare(row, sources)
    if (typeof prepared === 'string') {
      this.fail(row, prepared, lease)
      return undefined
    }
    const { draft, inputs, extract } = prepared
    const held = extract ? { ...row, extract } : row
    const tier = row.tier ?? this.spec.tier
    const requirement: WorkRequirement = {
      schema: 'work-requirement@1.0', objective: this.spec.goal, capabilities: CAPABILITIES, data: { classification: row.classification, refs: sources },
      egressPolicy: 'egress.classification-and-secrets',
      tier: row.escalation ? { min: tier, max: tier, source: 'decision', decision: row.escalation as ArtifactRef } : { min: tier, max: tier, source: 'profile' },
      acceptance: { contract: 'digests.quote-check', resultSchema: 'digest@1.0' },
    }
    const chars = [...renderBrief({ ...draft, sandbox: NO_LOCAL_SANDBOX }, (ref) => this.ctx.artifacts.get(ref))].length
    let admitted
    try {
      admitted = await this.ctx.workers.route(requirement, { producer: 'digests', input: { chars } })
    } catch (error) {
      if (!(error instanceof AdmissionFailure)) throw error
      this.fail(held, `no Worker can write it (a read-only Worker on the ${tier} tier): ${error.message}`, lease, [error.decision])
      return undefined
    }
    try {
      if (signal.aborted) return undefined
      const source = this.ctx.workers.source(admitted.source)
      if (!source) throw new Error(`Worker source ${admitted.source} is gone`)
      return this.ctx.store.transaction((db) => {
        this.ctx.leases.fence(lease())
        const body: Brief = { ...draft, sandbox: source.sandbox?.(admitted.worker.worker) ?? NO_LOCAL_SANDBOX }
        const brief = this.ctx.artifacts.put({ kind: 'objective', bodySchema: body.schema, body, inputs, classification: row.classification, producer: PRODUCER }).id as ArtifactRef
        // The escalated run has a key of its own, so its start is never mistaken for the first run's.
        const key = row.escalation ? `digests:${row.request_id}:${tier}` : `digests:${row.request_id}`
        const execution = source.start({ key, worker: admitted.worker.worker, brief, requirement, decisions: admitted.decisions, ...(admitted.tier ? { tier: admitted.tier } : {}) })
        db.prepare(`UPDATE ${this.spec.table} SET source = ?, worker = ?, execution_id = ?, brief = ?, ${extract ? 'extract = ?, ' : ''}updated_at = ? WHERE request_id = ?`)
          .run(admitted.source, admitted.worker.worker, execution.id, brief, ...(extract ? [extract] : []), now(), row.request_id)
        return this.row(row.request_id)!
      })
    } catch (error) {
      if (error instanceof LeaseLost || error instanceof StaleGeneration) throw error
      this.fail(held, `the digest Worker ${admitted.worker.worker} refused the run: ${(error as Error).message}`, lease, [admitted.decisions.route])
      return undefined
    } finally {
      admitted.release()
    }
  }

  /**
   * Settle a request, once, in one transaction under its lease: the digest (when written), the
   * `acceptance` decision that names it (INV-13), the request's end, and `digests.settled`.
   */
  private settle(row: DigestRow, outcome: Outcome, lease: () => Lease): void {
    const sources = JSON.parse(row.sources) as ArtifactRef[]
    this.ctx.store.transaction((db) => {
      this.ctx.leases.fence(lease())
      const current = this.row(row.request_id)
      if (current?.state !== 'pending') return
      const digest = outcome.state === 'written'
        ? this.ctx.artifacts.put({
          kind: 'report', bodySchema: 'digest@1.0', body: outcome.check.digest, inputs: sources, classification: row.classification,
          producer: current.worker ? { type: 'worker', ref: current.worker } : PRODUCER,
        }).id as ArtifactRef
        : undefined
      const decision = this.ctx.artifacts.recordDecision(settlement({ requestId: row.request_id, sources }, { ...outcome, inputs: [...(outcome.inputs ?? []), ...(digest ? [digest] : [])] } as Parameters<typeof settlement>[1]), {
        producer: PRODUCER, classification: row.classification,
      }).id as ArtifactRef
      const check = 'check' in outcome ? outcome.check : undefined
      // The extract, when the request failed before the start recorded it, is kept with the settlement.
      db.prepare(`UPDATE ${this.spec.table} SET state = ?, ${'extract' in row ? 'extract = COALESCE(extract, ?), ' : ''}digest = ?, decision = ?, kept = ?, dropped = ?, reason = ?, updated_at = ? WHERE request_id = ?`).run(
        outcome.state, ...('extract' in row ? [row.extract ?? null] : []), digest ?? null, decision, check ? check.kept : null, check ? check.dropped.length : null, outcome.state === 'written' ? null : clampText(outcome.reason, 1000), now(), row.request_id,
      )
      this.ctx.get('eventLog')?.append({ type: 'digests.settled', decision, data: { requestId: row.request_id, state: outcome.state, ...(digest ? { digest } : {}) } })
      if (outcome.state === 'bypassed') this.ctx.logger.info(`digests: request ${row.request_id} bypassed: ${outcome.reason}`)
    })
    this.ctx.store.afterCommit(() => {
      for (const wake of this.waiters.get(row.request_id) ?? []) wake()
      this.waiters.delete(row.request_id)
    })
  }

  private row(requestId: string): DigestRow | undefined {
    return this.ctx.store.db.prepare(`SELECT * FROM ${this.spec.table} WHERE request_id = ?`).get(requestId) as DigestRow | undefined
  }
}
