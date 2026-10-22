/**
 * `ctx.approvals`: the store-backed provider of the gate seam (docs/design/approvals.md,
 * ADR-0036). The autonomy policies are the operator's configuration, checked at load; requests are
 * `approval-request@1.0` records in the store, validated before every write and after every read,
 * and each change to one is one store transaction with the decision it names (INV-13). Only an
 * operator verdict approves; expiry and withdrawal only reject (INV-2, INV-5, INV-6). A request is
 * queued only on an `ask` the loaded policies give again when it is made, and one they no longer
 * ask for is withdrawn at load and on every sweep.
 * @module @tsuuanmi/system-approvals
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  type Action, type ActionClass, type ApprovalRequest, Approvals, ApprovalsError, type ArtifactRef, type AutonomyPolicy, type AutonomyVerdict, MODES,
  type NewRequest, type RequestState, type Subject, type Verdict, type VerdictResult,
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
  /** How often the queue sweeps expired requests and batches open ones on its own, in seconds, and once at start (1 to 3600, default 60). */
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
const CONTENT_ID = /^sha256:[0-9a-f]{64}$/
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
/** INV-5: a request's subject is exact: it names a version, unless it is an artifact by its content id. */
const exactSubject = (subject: unknown): boolean => isObject(subject)
  && ((typeof subject.version === 'string' && subject.version !== '') || (subject.type === 'artifact' && typeof subject.ref === 'string' && CONTENT_ID.test(subject.ref)))
const sameList = (a: unknown, b: readonly string[]): boolean => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i])

/** The fields of a recorded `autonomy` decision that `request` checks. */
interface AutonomyDecision {
  decisionType?: string
  outcome?: { option?: string; detail?: { actionClass?: unknown; policies?: unknown } }
  decider?: { type?: string; id?: string; version?: string; hash?: string }
}

/** Who resolved a request that no verdict resolved, and why: the decider rule and the reason it records. */
interface Withdrawal { rule: 'approvals.expiry' | 'approvals.withdraw' | 'approvals.policy'; why: string; before: string }
const EXPIRED: Withdrawal = { rule: 'approvals.expiry', why: 'expired', before: 'it expired' }
const WITHDRAWN: Withdrawal = { rule: 'approvals.withdraw', why: 'withdrawn', before: 'it was withdrawn' }
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
    sweepSeconds: z.natural().min(1).max(3600).default(60).description('Seconds between the queue\'s own passes (expired requests rejected, requests the policy no longer asks for withdrawn, then open ones batched), and one at start; never off, so every request expires (INV-9)'),
  }) as unknown as z<Config>

  private readonly schemas = new SchemaRegistry()
  private readonly set: PolicySet

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Checked before anything is written: an invalid set refuses the plugin, so no ctx.approvals
    // is provided, and an action that needs a person waits (fail-closed rule 5).
    this.set = PolicySet.load(config.policies, this.schemas)
    const seconds = config.sweepSeconds ?? 60
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error(`approvals: sweepSeconds must be a whole number of seconds from 1 to 3600, not ${seconds}: expiry is never off (INV-9)`)
    ctx.store.migrate('approvals', MIGRATIONS)
    // At load, before any verdict: a request this policy set no longer asks for is withdrawn (S1).
    this.withdrawStale(new Date())
    this.clock(seconds)
    ctx.inject(['mcp'], (c) => registerTools(c, this))
  }

  /**
   * The queue's own clock: a sweep, then a batch, once at start (a restart is a sweep, INV-4) and
   * every `seconds`, from the wall clock. Nothing else calls them in production; a test that names
   * the times itself replaces this.
   */
  protected clock(seconds: number): void {
    const ctx = this.ctx
    ctx.effect(() => {
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
    const { actionClass, rule: { policy, mode, named, raised }, failedChecks, policies, forbidden } = this.set.judge(action)
    const source = named ? `${policy.id}'s rule for ${actionClass}` : `${policy.id}'s default, as no rule of it names ${actionClass}`
    const reason = (m: typeof mode): string => forbidden ? (m === mode ? `${forbidden}: forbidden whatever a rule says` : `not ${m}: ${forbidden}`)
      : raised ? (m === mode ? `${source} says ${raised}, raised to ask: ${actionClass} always asks` : rank(m) < rank(mode) ? `not ${m}: ${actionClass} always asks` : `not ${m}: nothing that applies to ${actionClass} is that strict`)
      : m === mode ? `the strictest that applies is ${source}`
      : rank(m) < rank(mode) ? `not ${m}: laxer than ${source} (${mode}), the strictest that applies`
      : `not ${m}: nothing that applies to ${actionClass} is that strict`
    const decision = this.ctx.artifacts.recordDecision({
      schema: 'decision@1.4', decisionType: 'autonomy', question: `Which mode does the policy give a ${action.class} action?`, inputs: [],
      candidates: MODES.map((m) => ({ option: m, selected: m === mode, reasons: [reason(m)] })),
      decider: { type: 'policy', id: policy.id, version: String(policy.version), hash: this.set.hash(action.projectId) },
      outcome: { option: mode, detail: { actionClass, policies: policies.map((p) => p.id), ...(failedChecks.length ? { failedChecks } : {}), ...(forbidden ? { forbidden } : {}) } }, deterministic: true,
    }, { producer: { type: 'policy', ref: policy.id } })
    return { mode, ...(failedChecks.length ? { failedChecks } : {}), policy: { id: policy.id, version: policy.version }, decision: decision.id as ArtifactRef }
  }

  // --- the queue ---

  async request(request: NewRequest, at: Date = new Date()): Promise<ApprovalRequest> {
    const when = this.instant(at)
    if (!isObject(request) || !isObject(request.verdict) || !isObject(request.action) || !isObject(request.requester)) throw invalid('a request has a subject, an action, a requester, and the verdict that asked')
    const projectId = request.requester.projectId
    if (projectId !== undefined && typeof projectId !== 'string') throw invalid('requester.projectId is not a string')
    if (!ACTION_CLASSES.includes(request.action.class)) throw invalid(`${String(request.action.class)} is not an action class`)
    if (request.command !== undefined && (!Array.isArray(request.command) || request.command.some((word) => typeof word !== 'string'))) throw invalid('command must be an argv: a list of strings')
    if (!exactSubject(request.subject)) throw invalid('the subject names no version: a request binds to an exact subject (INV-5), a version, or an artifact subject by its sha256 content id')
    return this.ctx.store.transaction(() => {
      // Inside the transaction that writes the request: the decision it names is this provider's,
      // under the policies loaded now, and judging the action again says ask (INV-2).
      const policy = this.askedBy(request, projectId)
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
    // Each verdict is its own transaction: a refused one changes nothing, and the others still
    // apply. One that fails (a busy store, a write that went stale) is reported as failed, never
    // hidden behind an error that drops the outcomes of the others.
    return verdicts.map((v) => {
      try {
        return this.ctx.store.transaction((): VerdictResult => {
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
        })
      } catch (error) {
        this.ctx.logger.warn(`approvals: the verdict on ${v.requestId} was not applied, and nothing of it changed`)
        this.ctx.logger.warn(error)
        return { requestId: v.requestId, state: this.storedState(v.requestId), refused: 'failed' }
      }
    })
  }

  async withdraw(requestId: string, at: Date = new Date()): Promise<ApprovalRequest> {
    const when = this.instant(at)
    return this.ctx.store.transaction(() => {
      const request = typeof requestId === 'string' ? this.read(requestId)?.request : undefined
      if (!request) throw new ApprovalsError('unknown-request', `no approval request ${String(requestId)}`)
      return request.resolution ? request : this.resolve(request, 'withdrawn', 'withdrawn', when, undefined, WITHDRAWN)
    })
  }

  /**
   * Reject every request unanswered at `at`, then withdraw every open one the loaded policy no
   * longer asks for ({@link withdrawStale}), each in its own transaction; one that fails is logged
   * and left for the next sweep. Idempotent.
   */
  async sweep(at: Date): Promise<ApprovalRequest[]> {
    const when = this.instant(at)
    const expired = this.pass('expires_ms <= ?', when, (request) => Date.parse(request.expiresAt) > when.getTime() ? undefined : this.resolve(request, 'expired', 'denied:expired', when, undefined, EXPIRED))
    return [...expired, ...this.withdrawStale(when)]
  }

  // --- writes ---

  /**
   * Run `move` on every unresolved request matching `where` (one `?`, bound to `at`), a page at a
   * time, each in its own transaction that re-reads the request first; one that fails is logged and
   * left for the next pass.
   */
  private pass(where: string, at: Date, move: (request: ApprovalRequest) => ApprovalRequest | undefined): ApprovalRequest[] {
    const moved: ApprovalRequest[] = []
    let after = 0
    for (;;) {
      const page = this.ctx.store.db.prepare(`SELECT seq, request_id FROM approval_requests WHERE state IN ('open', 'batched') AND ${where} AND seq > ? ORDER BY seq LIMIT ${SWEEP_PAGE}`)
        .all(at.getTime(), after) as Array<{ seq: number; request_id: string }>
      for (const { request_id: requestId } of page) {
        try {
          const done = this.ctx.store.transaction(() => {
            const request = this.read(requestId)?.request
            return !request || request.resolution ? undefined : move(request)
          })
          if (done) moved.push(done)
        } catch (error) {
          this.skipped(requestId, error)
        }
      }
      if (page.length < SWEEP_PAGE) break
      after = Number(page.at(-1)!.seq)
    }
    return moved
  }

  /**
   * Withdraw every unexpired open request the loaded policy set no longer asks for (cause
   * `withdrawn`, decider rule `approvals.policy`, the reason: the policy changed): at load and on
   * every sweep, so a verdict never approves what the policy now forbids or lets run (S1).
   */
  private withdrawStale(at: Date): ApprovalRequest[] {
    return this.pass('expires_ms > ?', at, (request) => {
      if (Date.parse(request.expiresAt) <= at.getTime()) return undefined
      const why = this.staleness(request)
      return why ? this.resolve(request, 'withdrawn', 'withdrawn', at, undefined, { rule: 'approvals.policy', why: `the policy changed: ${why}`, before: 'the policy changed' }) : undefined
    })
  }

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

  /**
   * Resolve a request with its `approval` decision (inside the caller's transaction): every
   * candidate says why it was or was not the outcome. A resolution no verdict made names its
   * decider rule and reason (`by`).
   */
  private resolve(request: ApprovalRequest, cause: 'verdict' | 'expired' | 'withdrawn', option: string, at: Date, approval?: ArtifactRef, by?: Withdrawal): ApprovalRequest {
    const verdicts = ['approved', 'rejected']
    const lost = (o: string): string => cause === 'verdict' ? (verdicts.includes(o) ? `the operator's verdict is ${option}` : 'a verdict came first')
      : cause === 'expired' ? (o === 'withdrawn' ? 'it was not withdrawn before it expired' : 'no verdict came before it expired')
      : o === 'denied:expired' ? `${by!.before} before it expired` : `${by!.before} before a verdict`
    const decision = this.ctx.artifacts.recordDecision({
      schema: 'decision@1.4', decisionType: 'approval', question: `Is approval request ${request.requestId} approved?`, inputs: [request.policy.decision, ...(approval ? [approval] : [])],
      candidates: ['approved', 'rejected', 'denied:expired', 'withdrawn'].map((o) => ({ option: o, selected: o === option, reasons: [o === option ? (by?.why ?? cause) : `not ${o}: ${lost(o)}`] })),
      decider: cause === 'verdict' ? { type: 'operator', id: 'operator', version: '1' } : { type: 'rule', id: by!.rule, version: '1' },
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
   * The policy of the recorded `autonomy` decision a request's verdict cites, when the policies
   * loaded now still ask for its action; otherwise `not-asked`. The decision must be a policy's own
   * (`producer` and `decider` a policy), say ask, name the verdict's policy, be made under the
   * project's policy set as loaded (each policy current at its version, the set's hash, its
   * policies), and judging the action again (its class, `command`, and project) must say ask for
   * the class the decision names (B1, S1). The policy comes from the decision, never from the
   * caller's word for it.
   */
  private askedBy(request: NewRequest, projectId: string | undefined): ApprovalRequest['policy'] {
    const { verdict } = request
    const notAsked = (why: string) => new ApprovalsError('not-asked', `${String(request.action.class)}: ${why}`)
    if (verdict.mode !== 'ask') throw notAsked(`the policy verdict is ${String(verdict.mode)}, not ask`)
    const envelope = typeof verdict.decision === 'string' ? this.ctx.artifacts.get(verdict.decision) : undefined
    const body = envelope?.kind === 'decision' ? envelope.body as AutonomyDecision : undefined
    if (body?.decisionType !== 'autonomy' || body.outcome?.option !== 'ask') throw notAsked('the verdict is not a recorded autonomy decision that says ask')
    const policy = { id: String(body.decider?.id), version: Number(body.decider?.version) }
    if (body.decider?.type !== 'policy' || envelope!.producer?.type !== 'policy' || envelope!.producer.ref !== policy.id) throw notAsked('the decision it cites was not made by a policy')
    if (!isObject(verdict.policy) || verdict.policy.id !== policy.id || verdict.policy.version !== policy.version) throw notAsked('the verdict names another policy than the decision it cites')
    const of = projectId === undefined ? 'the studio' : `project ${projectId}`
    if (!this.set.current(policy, projectId)) throw notAsked(`the decision it cites is ${policy.id}'s at version ${policy.version}, which is not a policy of ${of} now`)
    if (!sameList(body.outcome.detail?.policies, this.set.of(projectId).map((p) => p.id)) || body.decider.hash !== this.set.hash(projectId)) {
      throw notAsked(`the decision it cites was made under other policies than ${of}'s, as loaded now`)
    }
    const judged = this.set.judge({ class: request.action.class, ...(projectId !== undefined ? { projectId } : {}), ...(request.command !== undefined ? { command: request.command } : {}) })
    if (judged.rule.mode !== 'ask') throw notAsked(`the policy now says ${judged.rule.mode}${judged.forbidden ? ` (${judged.forbidden})` : ''}`)
    if (body.outcome.detail?.actionClass !== judged.actionClass || judged.rule.policy.id !== policy.id) {
      throw notAsked(`the decision it cites is for ${String(body.outcome.detail?.actionClass)} by ${policy.id}, but the action is judged as ${judged.actionClass} by ${judged.rule.policy.id}`)
    }
    return { ...policy, decision: verdict.decision }
  }

  /**
   * Why the loaded policy set no longer asks for an open request, or undefined while it does: its
   * policy is not current at its version, or its class, or the class its decision judged it as (a
   * listed command's, whose argv the record does not keep), no longer asks.
   */
  private staleness(request: ApprovalRequest): string | undefined {
    const projectId = request.requester.projectId
    if (!this.set.current(request.policy, projectId)) return `${request.policy.id} at version ${request.policy.version} is not a policy of ${projectId === undefined ? 'the studio' : `project ${projectId}`} now`
    const judgedAs = (this.ctx.artifacts.get(request.policy.decision)?.body as AutonomyDecision | undefined)?.outcome?.detail?.actionClass
    const classes = new Set<ActionClass>([request.action.class, ...(ACTION_CLASSES.includes(judgedAs as ActionClass) ? [judgedAs as ActionClass] : [])])
    for (const actionClass of classes) {
      const { mode } = this.set.effective(actionClass, projectId)
      if (mode !== 'ask') return `it now gives ${actionClass} ${mode}`
    }
    return undefined
  }

  /** A request's stored state, without reading its record; `open` when even that fails. */
  private storedState(requestId: string): RequestState {
    try {
      const row = this.ctx.store.db.prepare('SELECT state FROM approval_requests WHERE request_id = ?').get(requestId) as { state: RequestState } | undefined
      return row ? row.state : 'rejected'
    } catch {
      return 'open'
    }
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
