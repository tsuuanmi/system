/**
 * `ctx.approvals`: the store-backed provider of the gate seam (docs/design/approvals.md,
 * ADR-0036). The autonomy policies are the operator's configuration, checked at load; requests are
 * `approval-request@1.0` records in the store, validated before every write and after every read,
 * and each change to one is one store transaction with the decision it names (INV-13). Only an
 * operator verdict approves; expiry and withdrawal only reject (INV-2, INV-5, INV-6).
 * @module @tsuuanmi/system-approvals
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  type Action, type ApprovalRequest, Approvals, ApprovalsError, type ArtifactRef, type AutonomyPolicy, type AutonomyVerdict, MODES, type NewRequest,
  type RequestState, type Subject, type Verdict, type VerdictResult,
} from '@tsuuanmi/system-approvals-core'
import type {} from '@tsuuanmi/system-artifacts'
import type {} from '@tsuuanmi/system-event-log'
import type {} from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-store'
import { ACTION_CLASSES, PolicySet, policyProblems, rank } from './policy.ts'
import { registerTools } from './tools.ts'

export { ACTION_CLASSES, PolicySet, policyProblems } from './policy.ts'

export interface Config {
  /** `autonomy-policy@1.0` records: exactly one studio policy, and project policies that narrow it. */
  policies: readonly AutonomyPolicy[]
  /** How often the queue sweeps expired requests and batches open ones on its own, in seconds, and once at start; 0: only when called (default 60). */
  sweepSeconds?: number
}

/** A listing filter (the seam's `list`). */
export interface ListFilter { states?: RequestState[]; batchId?: string; projectId?: string }

/** A page of the queue, and the cursor of the next one (absent on the last). */
export interface RequestPage { requests: ApprovalRequest[]; next?: string }

export const REQUEST_STATES: readonly RequestState[] = ['open', 'batched', 'approved', 'rejected']
/** Requests one `approvals_list` page holds unless asked otherwise, and at most (`mcp-approvals@1`). */
export const DEFAULT_PAGE = 20
export const MAX_PAGE = 100
/** Requests the sweep reads per statement; a protocol constant, not a deployment value. */
const SWEEP_PAGE = 500
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
const OPEN: readonly RequestState[] = ['open', 'batched']
/** Listing order: batched requests by batch, then the rest; within each, by expiry, then by insertion. */
const ORDER = "batch_id IS NULL, COALESCE(batch_id, ''), expires_ms, seq"

const MIGRATIONS = [{
  version: 1,
  sql: `CREATE TABLE approval_requests (
    seq INTEGER PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, batch_id TEXT, project_id TEXT,
    created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL,
    CHECK (state IN ('open', 'batched', 'approved', 'rejected')),
    CHECK (state <> 'batched' OR batch_id IS NOT NULL)
  );
  CREATE INDEX approval_requests_state ON approval_requests (state, project_id, created_ms, seq);
  CREATE INDEX approval_requests_batch ON approval_requests (batch_id, expires_ms, seq);
  CREATE INDEX approval_requests_project ON approval_requests (project_id, state);
  CREATE INDEX approval_requests_expiry ON approval_requests (expires_ms, seq) WHERE state IN ('open', 'batched');`,
}]

const invalid = (message: string): ApprovalsError => new ApprovalsError('invalid', message)
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const sameSubject = (a: Subject, b: Subject): boolean => a.type === b.type && a.ref === b.ref && a.version === b.version
const newId = (prefix: string): string => `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 16)}`
const encodeCursor = (key: [number, string, number, number]): string => Buffer.from(JSON.stringify(key)).toString('base64url')
const decodeCursor = (cursor: string): [number, string, number, number] => {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(value) && value.length === 4 && (value[0] === 0 || value[0] === 1) && typeof value[1] === 'string'
      && Number.isSafeInteger(value[2]) && Number.isSafeInteger(value[3])) return value as [number, string, number, number]
  } catch {
    // refused below
  }
  throw invalid('after is not a cursor this queue gave out')
}

/**
 * The `system check` preflight (packages/cli): every problem of the configured policy set, as the
 * provider would refuse it at load; none when it loads.
 */
export function checkConfig(config: Partial<Config> = {}): string[] {
  return policyProblems(config.policies)
}

export class StoreApprovals extends Approvals {
  static inject = ['store', 'artifacts']
  static Config: z<Config> = z.object({
    policies: z.array(z.any()).required().description('autonomy-policy@1.0 records: exactly one studio policy, and project policies that narrow it. '
      + 'Checked at load against the schema and its load-time rules (one rule per action class; expiry.defaultSeconds and every rule\'s expiresSeconds within expiry.maxSeconds; '
      + 'a project policy, one per project, narrowing the studio policy); an invalid set refuses the plugin, so nothing that needs a person runs (INV-2)'),
    sweepSeconds: z.natural().max(3600).default(60).description('Seconds between the queue\'s own passes (expired requests rejected, then open ones batched), and one at start; 0 leaves both to the caller'),
  }) as unknown as z<Config>

  private readonly schemas = new SchemaRegistry()
  private readonly set: PolicySet

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Checked before anything is written: an invalid set refuses the plugin, so no ctx.approvals
    // is provided, and an action that needs a person waits (fail-closed rule 5).
    this.set = PolicySet.load(config.policies, this.schemas)
    ctx.store.migrate('approvals', MIGRATIONS)
    ctx.effect(() => {
      const seconds = config.sweepSeconds ?? 60
      if (!seconds) return () => {}
      let running: Promise<unknown> | undefined
      const tick = (): void => {
        if (running) return
        const at = new Date()
        running = this.sweep(at).then(() => this.batch(at))
          .catch((error: unknown) => {
            ctx.logger.warn('approvals: a sweep or batch pass failed; the next pass retries')
            ctx.logger.warn(error)
          })
          .finally(() => { running = undefined })
      }
      // A restart is a sweep (INV-4): what expired while the queue was down is rejected first.
      const first = setTimeout(tick, 0)
      const every = setInterval(tick, seconds * 1000)
      first.unref()
      every.unref()
      return async () => {
        clearTimeout(first)
        clearInterval(every)
        await running
      }
    })
    ctx.inject(['mcp'], (c) => registerTools(c, this))
  }

  // --- the policy ---

  async policy(projectId?: string) {
    if (projectId !== undefined && typeof projectId !== 'string') throw invalid('projectId is not a string')
    return {
      policies: structuredClone(this.set.of(projectId)),
      effective: ACTION_CLASSES.map((actionClass) => ({ actionClass, mode: this.set.effective(actionClass, projectId).mode })),
    }
  }

  async check(action: Action): Promise<AutonomyVerdict> {
    this.validAction(action)
    const { actionClass, rule: { policy, mode, named }, failedChecks, policies } = this.set.judge(action)
    const source = named ? `${policy.id}'s rule for ${actionClass}` : `${policy.id}'s default, as no rule of it names ${actionClass}`
    const decision = this.ctx.artifacts.recordDecision({
      schema: 'decision@1.4', decisionType: 'autonomy', question: `Which mode does the policy give a ${action.class} action?`, inputs: [],
      candidates: MODES.map((m) => ({
        option: m, selected: m === mode,
        reasons: [m === mode ? `the strictest that applies is ${source}`
          : rank(m) < rank(mode) ? `not ${m}: laxer than ${source} (${mode}), the strictest that applies`
          : `not ${m}: nothing that applies to ${actionClass} is that strict`],
      })),
      decider: { type: 'policy', id: policy.id, version: String(policy.version) },
      outcome: { option: mode, detail: { actionClass, policies: policies.map((p) => p.id), ...(failedChecks.length ? { failedChecks } : {}) } }, deterministic: true,
    }, { producer: { type: 'policy', ref: policy.id } })
    return { mode, ...(failedChecks.length ? { failedChecks } : {}), policy: { id: policy.id, version: policy.version }, decision: decision.id as ArtifactRef }
  }

  // --- the queue ---

  async request(request: NewRequest, at: Date = new Date()): Promise<ApprovalRequest> {
    const when = this.instant(at)
    if (!isObject(request) || !isObject(request.verdict) || !isObject(request.action) || !isObject(request.requester)) throw invalid('a request has a subject, an action, a requester, and the verdict that asked')
    const projectId = request.requester.projectId
    if (projectId !== undefined && typeof projectId !== 'string') throw invalid('requester.projectId is not a string')
    return this.ctx.store.transaction(() => {
      // Inside the transaction that writes the request: the decision it names is recorded and says ask.
      const policy = this.askedBy(request.verdict, request.action.class)
      const expiresMs = when.getTime() + this.set.expirySeconds(request.action.class, projectId) * 1000
      const created: ApprovalRequest = {
        schema: 'approval-request@1.0', requestId: newId('apr'), state: 'open',
        subject: request.subject, action: request.action, requester: request.requester,
        policy, classification: request.classification,
        createdAt: when.toISOString(), expiresAt: new Date(expiresMs).toISOString(), revision: 0,
      }
      try {
        this.schemas.assertRecord(created)
      } catch (error) {
        throw invalid((error as Error).message)
      }
      this.ctx.store.db.prepare('INSERT INTO approval_requests (request_id, state, batch_id, project_id, created_ms, expires_ms, revision, record) VALUES (?, \'open\', NULL, ?, ?, ?, 0, ?)')
        .run(created.requestId, projectId ?? null, when.getTime(), expiresMs, JSON.stringify(created))
      return structuredClone(created)
    })
  }

  async get(requestId: string) {
    return typeof requestId === 'string' ? this.read(requestId)?.request : undefined
  }

  async list(filter: ListFilter = {}) {
    const { where, params } = this.where(filter)
    if (!where) return []
    const rows = this.ctx.store.db.prepare(`SELECT request_id, record FROM approval_requests WHERE ${where} ORDER BY ${ORDER}`).all(...params) as Array<{ request_id: string; record: string }>
    return rows.map((r) => this.load(r.request_id, r.record))
  }

  /**
   * One page of {@link list}, for `approvals_list`: at most `limit` requests (default
   * {@link DEFAULT_PAGE}, at most {@link MAX_PAGE}) after the opaque cursor `after`, and the next
   * cursor while more remain.
   */
  page(filter: ListFilter = {}, options: { limit?: number; after?: string } = {}): RequestPage {
    const limit = options.limit ?? DEFAULT_PAGE
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw invalid(`limit must be a whole number from 1 to ${MAX_PAGE}`)
    const { where, params } = this.where(filter)
    if (!where) return { requests: [] }
    const after = options.after === undefined ? undefined : decodeCursor(options.after)
    const rows = this.ctx.store.db.prepare(`SELECT seq, request_id, batch_id, expires_ms, record FROM approval_requests
      WHERE ${where}${after ? ` AND (batch_id IS NULL, COALESCE(batch_id, ''), expires_ms, seq) > (?, ?, ?, ?)` : ''} ORDER BY ${ORDER} LIMIT ?`)
      .all(...params, ...(after ?? []), limit + 1) as Array<{ seq: number; request_id: string; batch_id: string | null; expires_ms: number; record: string }>
    const shown = rows.slice(0, limit)
    const last = rows.length > limit ? shown.at(-1)! : undefined
    return {
      requests: shown.map((r) => this.load(r.request_id, r.record)),
      ...(last ? { next: encodeCursor([last.batch_id === null ? 1 : 0, last.batch_id ?? '', Number(last.expires_ms), Number(last.seq)]) } : {}),
    }
  }

  /**
   * Group open requests into batches, one group per project: a batch holds at most the policy's
   * `maxSize`, oldest first; a full one is made at once, and the last, smaller one once its oldest
   * request has waited `maxWaitSeconds`. A request already expired at `at` is left for the sweep.
   */
  async batch(at: Date = new Date()): Promise<string[]> {
    const when = this.instant(at)
    const groups = this.ctx.store.db.prepare("SELECT DISTINCT project_id FROM approval_requests WHERE state = 'open' AND expires_ms > ?").all(when.getTime()) as Array<{ project_id: string | null }>
    const made: string[] = []
    for (const { project_id: projectId } of groups) {
      try {
        made.push(...this.batchGroup(projectId, when))
      } catch (error) {
        this.skipped(`the open requests of ${projectId ?? 'no project'}`, error)
      }
    }
    return made
  }

  async decide(verdicts: Verdict[], at: Date = new Date()): Promise<VerdictResult[]> {
    const when = this.instant(at)
    if (!Array.isArray(verdicts)) throw invalid('verdicts is not a list')
    verdicts.forEach((v, i) => this.validVerdict(v, i))
    // A stored record that fails its schema refuses the whole call before any verdict applies.
    for (const v of verdicts) this.read(v.requestId)
    // Each verdict is its own transaction: a refused one changes nothing, and the others still apply.
    return verdicts.map((v) => this.ctx.store.transaction((): VerdictResult => {
      const request = this.read(v.requestId)?.request
      if (!request) return { requestId: v.requestId, state: 'rejected', refused: 'unknown-request' }
      if (request.resolution) return { requestId: v.requestId, state: request.state, refused: 'already-resolved' }
      if (Date.parse(request.expiresAt) <= when.getTime()) return { requestId: v.requestId, state: request.state, refused: 'expired' }
      if (!sameSubject(request.subject, v.subject)) return { requestId: v.requestId, state: request.state, refused: 'subject-changed' }
      // INV-5: the verdict is written on the request's own subject, the one the operator saw.
      const approval = this.ctx.artifacts.put({
        kind: 'approval', bodySchema: 'approval@1.0', body: { schema: 'approval@1.0', subject: request.subject, verdict: v.verdict, by: 'operator', ...(v.note ? { note: v.note } : {}) },
        classification: request.classification === 'local-private' ? 'local-private' : 'operator-shared', producer: { type: 'operator', ref: 'operator' }, subject: request.subject,
      }).id as ArtifactRef
      const resolved = this.resolve(request, 'verdict', v.verdict, when, approval)
      return { requestId: v.requestId, state: resolved.state, approval }
    }))
  }

  async withdraw(requestId: string, at: Date = new Date()): Promise<ApprovalRequest> {
    const when = this.instant(at)
    return this.ctx.store.transaction(() => {
      const request = typeof requestId === 'string' ? this.read(requestId)?.request : undefined
      if (!request) throw new ApprovalsError('unknown-request', `no approval request ${String(requestId)}`)
      return request.resolution ? request : this.resolve(request, 'withdrawn', 'withdrawn', when)
    })
  }

  /** Reject every request unanswered at `at`, each in its own transaction; one that fails is logged and left for the next sweep. Idempotent. */
  async sweep(at: Date): Promise<ApprovalRequest[]> {
    const when = this.instant(at)
    const expired: ApprovalRequest[] = []
    let after = 0
    for (;;) {
      const page = this.ctx.store.db.prepare(`SELECT seq, request_id FROM approval_requests WHERE state IN ('open', 'batched') AND expires_ms <= ? AND seq > ? ORDER BY seq LIMIT ${SWEEP_PAGE}`)
        .all(when.getTime(), after) as Array<{ seq: number; request_id: string }>
      for (const { request_id: requestId } of page) {
        try {
          const rejected = this.ctx.store.transaction(() => {
            const request = this.read(requestId)?.request
            if (!request || request.resolution || Date.parse(request.expiresAt) > when.getTime()) return undefined
            return this.resolve(request, 'expired', 'denied:expired', when)
          })
          if (rejected) expired.push(rejected)
        } catch (error) {
          this.skipped(requestId, error)
        }
      }
      if (page.length < SWEEP_PAGE) break
      after = Number(page.at(-1)!.seq)
    }
    return expired
  }

  // --- writes ---

  /** Batch one project's open requests, in one transaction with the `approvals.batched` events. */
  private batchGroup(projectId: string | null, at: Date): string[] {
    return this.ctx.store.transaction(() => {
      const rows = this.ctx.store.db.prepare("SELECT request_id, record FROM approval_requests WHERE state = 'open' AND project_id IS ? AND expires_ms > ? ORDER BY created_ms, seq")
        .all(projectId, at.getTime()) as Array<{ request_id: string; record: string }>
      const open = rows.map((r) => this.load(r.request_id, r.record))
      const rule = this.set.batchRule(projectId ?? undefined)
      const made: string[] = []
      for (let i = 0; i < open.length; i += rule.maxSize) {
        const members = open.slice(i, i + rule.maxSize)
        // Only the last group of the project can be smaller than maxSize: it waits for its oldest request.
        if (members.length < rule.maxSize && at.getTime() - Date.parse(members[0]!.createdAt) < rule.maxWaitSeconds * 1000) break
        const batchId = `batch-${at.toISOString()}-${randomUUID().slice(0, 8)}`
        for (const request of members) this.write(request, { ...request, state: 'batched', batchId, revision: request.revision + 1 })
        this.ctx.get('eventLog')?.append({ type: 'approvals.batched', data: { batchId, ...(projectId !== null ? { projectId } : {}), requests: members.map((r) => r.requestId) } })
        made.push(batchId)
      }
      return made
    })
  }

  /** Resolve a request with its `approval` decision (inside the caller's transaction): every candidate says why it was or was not the outcome. */
  private resolve(request: ApprovalRequest, cause: 'verdict' | 'expired' | 'withdrawn', option: string, at: Date, approval?: ArtifactRef): ApprovalRequest {
    const verdicts = ['approved', 'rejected']
    const lost = (o: string): string => cause === 'verdict' ? (verdicts.includes(o) ? `the operator's verdict is ${option}` : 'a verdict came first')
      : cause === 'expired' ? (o === 'withdrawn' ? 'it was not withdrawn before it expired' : 'no verdict came before it expired')
      : o === 'denied:expired' ? 'it was withdrawn before it expired' : 'it was withdrawn before a verdict'
    const decision = this.ctx.artifacts.recordDecision({
      schema: 'decision@1.4', decisionType: 'approval', question: `Is approval request ${request.requestId} approved?`, inputs: [request.policy.decision, ...(approval ? [approval] : [])],
      candidates: ['approved', 'rejected', 'denied:expired', 'withdrawn'].map((o) => ({ option: o, selected: o === option, reasons: [o === option ? cause : `not ${o}: ${lost(o)}`] })),
      decider: cause === 'verdict' ? { type: 'operator', id: 'operator', version: '1' } : { type: 'rule', id: cause === 'expired' ? 'approvals.expiry' : 'approvals.withdraw', version: '1' },
      outcome: { option, detail: { requestId: request.requestId } }, deterministic: cause !== 'verdict',
    }, { producer: { type: cause === 'verdict' ? 'operator' : 'system', ref: 'approvals' }, classification: request.classification === 'local-private' ? 'local-private' : 'operator-shared' })
    const next: ApprovalRequest = {
      ...request, state: option === 'approved' ? 'approved' : 'rejected', revision: request.revision + 1,
      resolution: { cause, ...(approval ? { approval } : {}), decision: decision.id as ArtifactRef, at: at.toISOString() },
    }
    this.write(request, next)
    return next
  }

  /** Write a request's next revision, revision-checked; it must stay a valid record. */
  private write(before: ApprovalRequest, next: ApprovalRequest): void {
    this.schemas.assertRecord(next)
    const changes = this.ctx.store.db.prepare('UPDATE approval_requests SET state = ?, batch_id = ?, revision = ?, record = ? WHERE request_id = ? AND revision = ?')
      .run(next.state, next.batchId ?? null, next.revision, JSON.stringify(next), next.requestId, before.revision).changes
    if (Number(changes) !== 1) throw new Error(`approvals: ${next.requestId} changed under this write (revision ${before.revision} is stale)`)
  }

  // --- reads and checks ---

  private read(requestId: string): { request: ApprovalRequest } | undefined {
    const row = this.ctx.store.db.prepare('SELECT record FROM approval_requests WHERE request_id = ?').get(requestId) as { record: string } | undefined
    return row && { request: this.load(requestId, row.record) }
  }

  /** A stored record is validated when it is read too: one that fails is never acted on (reference/schemas.md#validation-points). */
  private load(requestId: string, json: string): ApprovalRequest {
    const request = JSON.parse(json) as ApprovalRequest
    try {
      this.schemas.assertRecord(request)
    } catch (error) {
      throw new Error(`approvals: the stored request ${requestId} is not a valid approval-request@1.0 and is not used: ${(error as Error).message}`)
    }
    return request
  }

  /**
   * The policy of the recorded `autonomy` decision a verdict names, when that decision says ask;
   * otherwise `not-asked`. The policy comes from the decision, never from the caller's word for it.
   */
  private askedBy(verdict: AutonomyVerdict, actionClass: unknown): ApprovalRequest['policy'] {
    const notAsked = (why: string) => new ApprovalsError('not-asked', `${String(actionClass)}: ${why}`)
    if (verdict.mode !== 'ask') throw notAsked(`the policy verdict is ${String(verdict.mode)}, not ask`)
    const envelope = typeof verdict.decision === 'string' ? this.ctx.artifacts.get(verdict.decision) : undefined
    const body = envelope?.kind === 'decision' ? envelope.body as { decisionType?: string; outcome?: { option?: string }; decider?: { id?: string; version?: string } } : undefined
    if (body?.decisionType !== 'autonomy' || body.outcome?.option !== 'ask') throw notAsked('the verdict is not a recorded autonomy decision that says ask')
    const policy = { id: String(body.decider?.id), version: Number(body.decider?.version) }
    if (!isObject(verdict.policy) || verdict.policy.id !== policy.id || verdict.policy.version !== policy.version) throw notAsked('the verdict names another policy than the decision it cites')
    return { ...policy, decision: verdict.decision }
  }

  private where(filter: ListFilter): { where: string; params: Array<string | null> } {
    if (!isObject(filter)) throw invalid('the filter is not an object')
    const states = filter.states ?? OPEN
    if (!Array.isArray(states) || states.some((s) => !REQUEST_STATES.includes(s))) throw invalid(`states must be a list of ${REQUEST_STATES.join(', ')}`)
    if (!states.length) return { where: '', params: [] }
    const clauses = [`state IN (${states.map(() => '?').join(', ')})`]
    const params: Array<string | null> = [...states]
    for (const [key, column] of [['batchId', 'batch_id'], ['projectId', 'project_id']] as const) {
      const value = filter[key]
      if (value === undefined) continue
      if (typeof value !== 'string') throw invalid(`${key} is not a string`)
      clauses.push(`${column} = ?`)
      params.push(value)
    }
    return { where: clauses.join(' AND '), params }
  }

  private validAction(action: Action): void {
    if (!isObject(action)) throw invalid('the action is not an object')
    if (!ACTION_CLASSES.includes(action.class)) throw invalid(`${String(action.class)} is not an action class`)
    if (action.projectId !== undefined && (typeof action.projectId !== 'string' || !ID.test(action.projectId))) throw invalid(`projectId ${JSON.stringify(action.projectId)} is not an id`)
    if (action.command !== undefined && (!Array.isArray(action.command) || action.command.some((word) => typeof word !== 'string'))) throw invalid('command must be an argv: a list of strings')
    if (action.checks !== undefined && !isObject(action.checks)) throw invalid('checks must be an object of check names to whether they passed')
  }

  private validVerdict(v: Verdict, index: number): void {
    const subject = isObject(v) ? v.subject : undefined
    const ok = isObject(v) && typeof v.requestId === 'string' && isObject(subject) && typeof subject.type === 'string' && typeof subject.ref === 'string'
      && (subject.version === undefined || typeof subject.version === 'string') && (v.verdict === 'approved' || v.verdict === 'rejected')
      && (v.note === undefined || typeof v.note === 'string')
    if (!ok) throw invalid(`verdict ${index} is not {requestId, subject, verdict: approved | rejected, note?}: nothing was decided`)
  }

  private instant(at: Date): Date {
    if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw invalid('at is not a date')
    return at
  }

  private skipped(what: string, error: unknown): void {
    this.ctx.logger.warn(`approvals: left ${what} as it was; the next pass retries`)
    this.ctx.logger.warn(error)
  }
}

export default StoreApprovals
