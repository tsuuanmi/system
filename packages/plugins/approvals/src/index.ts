/**
 * `ctx.approvals`: the store-backed provider of the gate seam (docs/design/approvals.md,
 * ADR-0036). The autonomy policies are the operator's configuration, checked at load; requests are
 * `approval-request@1.0` records in the store, validated before every write and after every read,
 * and each change to one is one store transaction with the decision it names (INV-13). Only an
 * operator verdict approves; expiry and withdrawal only reject (INV-2, INV-5, INV-6). A request is
 * queued only on an `ask` the loaded policies give again when it is made, and one they no longer
 * ask for is withdrawn at load and on every sweep. A policy change the operator proposes is asked
 * through the queue as a `policy-change` request on the proposed set's hash, applied only on the
 * operator's approval, and kept in the store; the stored set applies only while the configuration
 * it derives from is unchanged (docs/design/approvals.md#a-policy-change). When configured, the queue
 * itself proposes, never applies, a change from approvals the operator gave one exact studio command
 * again and again (docs/design/approvals.md#the-queue-proposes-a-policy-change).
 * @module @tsuuanmi/system-approvals
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  type Action, type ActionClass, ALWAYS_ASK, type ApprovalRequest, Approvals, ApprovalsError, type ArtifactRef, type AutonomyPolicy, type AutonomyVerdict, type ContentHash, HOST_STOPPED_RECONCILIATION, MODES,
  type NewRequest, POLICY_SET_REF, type PolicyChange, type PolicyChangeOrigin, type PolicySetInForce, type RequestState, type Subject, type Verdict, type VerdictResult,
} from '@tsuuanmi/system-approvals-core'
import type {} from '@tsuuanmi/system-artifacts'
import type {} from '@tsuuanmi/system-event-log'
import { LEAD_PROJECT, leadId, type LeadRemediation, leadMayDecide } from '@tsuuanmi/system-gateway-core'
import { isRecord, SchemaRegistry } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-store'
import { ACTION_CLASSES, commandProblems, effectOf, PolicySet, policyProblems, proposedSet, rank, webAccessEffect } from './policy.ts'
import { registerTools } from './tools.ts'

export { ACTION_CLASSES, policyProblems } from './policy.ts'

export interface Config {
  /** `autonomy-policy@1.x` records: exactly one studio policy, and project policies that narrow it. */
  policies: readonly AutonomyPolicy[]
  /** How often the queue sweeps expired requests and batches open ones on its own, in seconds, and once at start (1 to 3600, default 60). */
  sweepSeconds?: number
  /**
   * The hash of the applied policy set in the store that this configuration replaces. Only read at
   * a start where the stored set no longer matches the configuration it was derived from: naming
   * its exact hash lets the configuration take over (the change is retired, recorded); otherwise
   * the plugin is refused (docs/design/approvals.md#the-configuration-and-the-stored-set).
   */
  supersedes?: ContentHash
  /**
   * Off unless `enabled`. Then the queue proposes (never applies) a policy change once the operator
   * approved one exact studio command `approvals` times among the requests made in the last
   * `windowSeconds`, and rejected or let expire none of them: one `policy-change` request adding that
   * argv, and nothing more, to the studio policy's commands list
   * (docs/design/approvals.md#the-queue-proposes-a-policy-change).
   */
  repeatedApprovals?: RepeatedApprovals
  /**
   * The dev branches of each project, by project id (ADR-0076): the branches where the project's lead,
   * on its own token, may approve a merge and accept a result. A branch not listed (a protected one,
   * `main`) stays the operator's; a project not listed has none, so its lead decides no merge or
   * acceptance. Each name is a plain branch name, never `main` or `master`.
   */
  devBranches?: Record<string, string[]>
}

/** Branch names no project may list as a dev branch: the lead never decides on them (ADR-0076). */
const PROTECTED_BRANCHES: readonly string[] = ['main', 'master']
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/

/** Every problem of a `devBranches` value; none when it is absent or valid. */
function devBranchProblems(value: unknown): string[] {
  if (value === undefined) return []
  if (!isRecord(value)) return ['devBranches must be an object: {<projectId>: [<branch>, …]}']
  const problems: string[] = []
  for (const [project, branches] of Object.entries(value)) {
    if (!LEAD_PROJECT.test(project)) problems.push(`devBranches names project ${JSON.stringify(project)}, which is not a project id a lead token can be issued for`)
    if (!Array.isArray(branches) || branches.some((b) => typeof b !== 'string')) {
      problems.push(`devBranches.${project} must be a list of branch names`)
      continue
    }
    for (const branch of branches as string[]) {
      if (!BRANCH.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) problems.push(`devBranches.${project}: ${JSON.stringify(branch)} is not a branch name`)
      else if (PROTECTED_BRANCHES.includes(branch)) problems.push(`devBranches.${project}: ${branch} is a protected branch; only the operator decides on it, so it cannot be listed`)
    }
  }
  return problems
}

/** When the queue proposes a policy change from repeated approvals of one shape. */
export interface RepeatedApprovals {
  /** Whether the queue proposes at all (default false). */
  enabled?: boolean
  /** Approvals of one shape in the window before the queue proposes (3 to 100, default 5). */
  approvals?: number
  /** The window, in seconds: requests made in it count (3600 to 7776000, default 604800, a week). */
  windowSeconds?: number
}

/** The threshold the queue proposes at, once enabled. */
interface Threshold { approvals: number; windowSeconds: number }

/** The bounds and defaults of {@link RepeatedApprovals}: conservative, since a proposal asks the operator once more. */
const REPEATED_APPROVALS = { approvals: { min: 3, max: 100, default: 5 }, windowSeconds: { min: 3600, max: 7776000, default: 604800 } } as const

/** Every problem of a `repeatedApprovals` value; none when it is absent or valid. */
function repeatedProblems(value: unknown): string[] {
  if (value === undefined) return []
  if (!isRecord(value)) return ['repeatedApprovals must be an object: {enabled?, approvals?, windowSeconds?}']
  const problems: string[] = []
  for (const key of Object.keys(value)) if (key !== 'enabled' && key !== 'approvals' && key !== 'windowSeconds') problems.push(`repeatedApprovals.${key} is not an option`)
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') problems.push('repeatedApprovals.enabled must be true or false')
  for (const key of ['approvals', 'windowSeconds'] as const) {
    const n = value[key]
    const { min, max } = REPEATED_APPROVALS[key]
    if (n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max)) problems.push(`repeatedApprovals.${key} must be a whole number from ${min} to ${max}, not ${String(n)}`)
  }
  return problems
}

/** The policy set in force, and where it comes from: `key` names the stored row it was read from, or the configuration. */
interface InForce { key: string; set: PolicySet; source: 'configuration' | 'store'; changeId?: string }

/** A listing filter (the seam's `list`). */
export interface ListFilter { states?: RequestState[]; batchId?: string; projectId?: string }

/** A page of the queue, and the cursor of the next one (absent on the last). */
export interface RequestPage { requests: ApprovalRequest[]; next?: string }

const REQUEST_STATES: readonly RequestState[] = ['open', 'batched', 'approved', 'rejected']
/** An artifact as the queue reads it for a lead's rights: its kind, run, inputs, and body. */
type ReadArtifact = (ref: string) => { kind: string; runId?: string; inputs: readonly string[]; body?: unknown } | undefined

/**
 * Which routine remediation a request is, read from its own fields and the records they name, never
 * its summary (ADR-0076, amended by T302). Fails closed: any other remediation is undefined.
 * - `review-fix`: requester `workflow` with a run and a gate node; the subject is a `plan` artifact of
 *   that run, which the action's one ref names, grown by a review's `workflow.remediation` decision
 *   (`graph-growth`, `append`) of the same run, and holding one step, the fix, after that gate.
 * - `host-stopped-retry`: requester `board` with a task; subject `board-task:<id>:attempt:<n>` at
 *   version {@link HOST_STOPPED_RECONCILIATION}, the board's mark that the run's lease lapsed while the
 *   host was stopped. A lost run without the mark (a holder that hung while the host ran, or blocked
 *   itself) stays the operator's.
 */
function leadRemediationOf(request: ApprovalRequest, read: ReadArtifact): LeadRemediation | undefined {
  const { requester, subject, action } = request
  if (action.class !== 'remediation') return undefined
  if (requester.component === 'board') {
    return requester.taskId !== undefined && subject.type === 'content' && subject.version === HOST_STOPPED_RECONCILIATION
      && subject.ref.startsWith(`board-task:${requester.taskId}:attempt:`) ? 'host-stopped-retry' : undefined
  }
  if (requester.component !== 'workflow' || requester.runId === undefined || requester.nodeId === undefined) return undefined
  if (subject.type !== 'artifact' || action.refs?.length !== 1 || action.refs[0] !== subject.ref) return undefined
  const plan = read(subject.ref)
  if (plan?.kind !== 'plan' || plan.runId !== requester.runId) return undefined
  const body = plan.body as { runId?: unknown; nodes?: Array<{ dependsOn?: unknown }> } | undefined
  const fix = body?.nodes?.length === 1 ? body.nodes[0] : undefined
  if (body?.runId !== requester.runId || !Array.isArray(fix?.dependsOn) || fix.dependsOn.length !== 1 || fix.dependsOn[0] !== requester.nodeId) return undefined
  const grown = plan.inputs.some((ref) => {
    const decision = read(ref)
    const d = decision?.body as { decisionType?: unknown; decider?: { id?: unknown }; outcome?: { option?: unknown } } | undefined
    return decision?.kind === 'decision' && decision.runId === requester.runId
      && d?.decisionType === 'graph-growth' && d.decider?.id === 'workflow.remediation' && d.outcome?.option === 'append'
  })
  return grown ? 'review-fix' : undefined
}

/** Requests one `approvals_list` page holds unless asked otherwise, and at most (`mcp-approvals@1`). */
const DEFAULT_PAGE = 20
const MAX_PAGE = 100
/** Requests the sweep reads per statement; a protocol constant, not a deployment value. */
const SWEEP_PAGE = 500
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
const CONTENT_ID = /^sha256:[0-9a-f]{64}$/
/** Policy changes one `policyChanges` call returns unless asked otherwise, and at most. */
const DEFAULT_CHANGES = 20
const MAX_CHANGES = 100
const CHANGE_STATES: ReadonlyArray<PolicyChange['state']> = ['asked', 'applied', 'declined', 'retired']
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
}, {
  // Policy changes (policy-change@1.0): applied_seq orders the applied ones; the latest is the set in force while it is not retired.
  version: 2,
  sql: `CREATE TABLE policy_changes (
    seq INTEGER PRIMARY KEY, change_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, hash TEXT NOT NULL, base_hash TEXT NOT NULL, config_hash TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE, proposed_ms INTEGER NOT NULL, applied_seq INTEGER UNIQUE, revision INTEGER NOT NULL, record TEXT NOT NULL,
    CHECK (state IN ('asked', 'applied', 'declined', 'retired')),
    CHECK ((applied_seq IS NOT NULL) = (state IN ('applied', 'retired')))
  );
  CREATE INDEX policy_changes_state ON policy_changes (state, seq);`,
}, {
  // Repeated approvals (docs/design/approvals.md#the-queue-proposes-a-policy-change): the exact
  // shape of each request the queue could propose a change for (a studio command's argv as a
  // commands-list line), written with the request; and the shape a queue-proposed change is for.
  version: 3,
  sql: `CREATE TABLE request_shapes (
    request_id TEXT PRIMARY KEY REFERENCES approval_requests (request_id), shape TEXT NOT NULL, created_ms INTEGER NOT NULL
  );
  CREATE INDEX request_shapes_window ON request_shapes (created_ms, shape);
  CREATE INDEX request_shapes_shape ON request_shapes (shape, created_ms);
  ALTER TABLE policy_changes ADD COLUMN origin_shape TEXT;
  CREATE INDEX policy_changes_origin ON policy_changes (origin_shape) WHERE origin_shape IS NOT NULL;`,
}]

const invalid = (message: string): ApprovalsError => new ApprovalsError('invalid', message)
const sameSubject = (a: Subject, b: Subject): boolean => a.type === b.type && a.ref === b.ref && a.version === b.version
/** INV-5: a request's subject is exact: it names a version, unless it is an artifact by its content id. */
const exactSubject = (subject: unknown): boolean => isRecord(subject)
  && ((typeof subject.version === 'string' && subject.version !== '') || (subject.type === 'artifact' && typeof subject.ref === 'string' && CONTENT_ID.test(subject.ref)))
const sameList = (a: unknown, b: readonly string[]): boolean => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i])
/** A window in words: whole days, else whole hours, else seconds. */
const span = (seconds: number): string => seconds % 86400 === 0 ? `${seconds / 86400} day${seconds === 86400 ? '' : 's'}`
  : seconds % 3600 === 0 ? `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}` : `${seconds} seconds`
/** Approval artifacts a queue proposal's decision cites at most: the newest it counted. */
const MAX_COUNTED = 100

/**
 * One shape the operator approved repeatedly (docs/design/approvals.md#the-queue-proposes-a-policy-change):
 * the commands-list line, the approved requests counted in the window (oldest first), and the window.
 */
interface Repeated { shape: string; requests: ApprovalRequest[]; windowSeconds: number; threshold: number }

/** Text cut to a bound on whole characters, ending in an ellipsis when cut. */
const clip = (text: string, max: number): string => { const chars = [...text]; return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…` }

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
 * provider would refuse it at load; none when it loads. Whether a stored policy change still
 * matches the configuration is known only at start, from the store.
 */
export function checkConfig(config: Partial<Config> = {}): string[] {
  const problems = policyProblems(config.policies)
  if (config.supersedes !== undefined && (typeof config.supersedes !== 'string' || !CONTENT_ID.test(config.supersedes))) problems.push('supersedes must be the sha256:… hash of a stored policy set')
  problems.push(...repeatedProblems(config.repeatedApprovals))
  problems.push(...devBranchProblems(config.devBranches))
  return problems
}

export class StoreApprovals extends Approvals {
  static inject = ['store', 'artifacts']
  static Config: z<Config> = z.object({
    policies: z.array(z.any()).required().description('autonomy-policy@1.x records: exactly one studio policy, and project policies that narrow it. '
      + 'Checked at load against the schema and its load-time rules (one rule per action class; no auto or notify for a class that always asks; '
      + 'expiry.defaultSeconds and every rule\'s expiresSeconds within expiry.maxSeconds; commands entries of non-empty words with no shell metacharacter; '
      + 'a batch wait under the shortest expiry it batches; a project policy, one per project, narrowing the studio policy; at most 101 policies); an invalid set refuses the plugin, so nothing that needs a person runs (INV-2)'),
    sweepSeconds: z.natural().min(1).max(3600).default(60).description('Seconds between the queue\'s own passes (expired requests rejected, requests the policy no longer asks for withdrawn, then open ones batched), and one at start; never off, so every request expires (INV-9)'),
    supersedes: z.string().pattern(CONTENT_ID).description('The sha256:… hash of the applied policy set in the store that this configuration replaces. Read only at a start where that set no longer matches the configuration it was derived from: '
      + 'then the configuration takes over and the stored change is retired, recorded; without it the plugin is refused, so nothing that needs a person runs (INV-2)'),
    repeatedApprovals: z.object({
      enabled: z.boolean().default(false).description('Whether the queue proposes such a change at all; off by default'),
      approvals: z.natural().min(REPEATED_APPROVALS.approvals.min).max(REPEATED_APPROVALS.approvals.max).default(REPEATED_APPROVALS.approvals.default)
        .description('Approvals of one exact studio command, among the requests made in the window, before the queue proposes listing it'),
      windowSeconds: z.natural().min(REPEATED_APPROVALS.windowSeconds.min).max(REPEATED_APPROVALS.windowSeconds.max).default(REPEATED_APPROVALS.windowSeconds.default)
        .description('The window in seconds: the requests made in it count, and none of the shape may have been rejected or have expired'),
    }).description('Off unless enabled. The queue proposes, never applies, a policy change adding one exact studio command (its argv, nothing more) to the studio policy\'s commands list, '
      + 'once the operator approved it often enough in the window and rejected or let expire none; never for a class that always asks, never again for a command whose proposal was rejected or expired, at most one proposal open'),
    devBranches: z.dict(z.array(z.string())).description('The dev branches of each project, by project id: the branches where the project\'s lead, on its own token (`system lead-token issue`), may approve a merge and accept a result. '
      + 'A branch not listed, and main and master always, stay the operator\'s; a project not listed has none (ADR-0076)'),
  }) as unknown as z<Config>

  private readonly schemas = new SchemaRegistry()
  /** The configured set, checked at load. */
  private readonly configured: PolicySet
  private readonly supersedes: ContentHash | undefined
  /** When the queue proposes a change from repeated approvals; off when undefined. */
  private readonly repeated: Threshold | undefined
  /** The set in force as last read from the store (see {@link current}). */
  private state: InForce | undefined
  /** Each project's dev branches (ADR-0076). */
  private readonly dev: Map<string, string[]>

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Checked before anything is written: an invalid set refuses the plugin, so no ctx.approvals
    // is provided, and an action that needs a person waits (fail-closed rule 5).
    this.configured = PolicySet.load(config.policies, this.schemas)
    if (config.supersedes !== undefined && (typeof config.supersedes !== 'string' || !CONTENT_ID.test(config.supersedes))) throw new Error('approvals: supersedes must be the sha256:… hash of a stored policy set')
    this.supersedes = config.supersedes
    const repeated = repeatedProblems(config.repeatedApprovals)
    if (repeated.length) throw new Error(`approvals: ${repeated.join('; ')}`)
    const branches = devBranchProblems(config.devBranches)
    if (branches.length) throw new Error(`approvals: ${branches.join('; ')}`)
    this.dev = new Map(Object.entries(config.devBranches ?? {}).map(([project, list]) => [project, [...list]]))
    this.repeated = config.repeatedApprovals?.enabled !== true ? undefined : {
      approvals: config.repeatedApprovals.approvals ?? REPEATED_APPROVALS.approvals.default,
      windowSeconds: config.repeatedApprovals.windowSeconds ?? REPEATED_APPROVALS.windowSeconds.default,
    }
    const seconds = config.sweepSeconds ?? 60
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error(`approvals: sweepSeconds must be a whole number of seconds from 1 to 3600, not ${seconds}: expiry is never off (INV-9)`)
    ctx.store.migrate('approvals', MIGRATIONS)
    // Which set is in force: the configured one, or an applied change derived from it. A stored
    // set whose configuration changed refuses the plugin unless the configuration supersedes it.
    this.state = this.inForce(new Date(), true)
    // At load, before any verdict: a request this policy set no longer asks for is withdrawn (S1).
    this.withdrawStale(new Date())
    this.clock(seconds)
    ctx.inject(['mcp'], (c) => registerTools(c, this))
  }

  /**
   * The queue's own clock: a sweep, then its own proposal from repeated approvals (when configured;
   * one that fails is logged and never stops the pass), then a batch, once at start (a restart is a
   * sweep, INV-4) and every `seconds`, from the wall clock. Nothing else calls them in production; a
   * test that names the times itself replaces this.
   */
  protected clock(seconds: number): void {
    const ctx = this.ctx
    ctx.effect(() => {
      let running: Promise<unknown> | undefined
      const tick = (): void => {
        if (running) return
        const at = new Date()
        running = this.sweep(at).then(() => this.proposeRepeated(at)).then(() => this.batch(at))
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
    const { set, source, changeId } = this.current()
    const inForce: PolicySetInForce = { hash: set.setHash(), source, configHash: this.configured.setHash(), ...(changeId ? { changeId } : {}), projects: set.projectIds() }
    return {
      policies: structuredClone(set.of(projectId)),
      effective: ACTION_CLASSES.map((actionClass) => ({ actionClass, mode: set.effective(actionClass, projectId).mode })),
      set: inForce,
    }
  }

  async check(action: Action): Promise<AutonomyVerdict> {
    this.validAction(action)
    const { actionClass, rule: { policy, mode, named, raised }, failedChecks, policies, forbidden, commandRule } = this.set.judge(action)
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
      outcome: { option: mode, detail: { actionClass, policies: policies.map((p) => p.id), ...(failedChecks.length ? { failedChecks } : {}), ...(forbidden ? { forbidden } : {}), ...(commandRule ? { commandRule } : {}) } }, deterministic: true,
    }, { producer: { type: 'policy', ref: policy.id } })
    return { mode, ...(failedChecks.length ? { failedChecks } : {}), policy: { id: policy.id, version: policy.version }, decision: decision.id as ArtifactRef }
  }

  // --- the queue ---

  async request(request: NewRequest, at: Date = new Date()): Promise<ApprovalRequest> {
    const when = this.instant(at)
    if (!isRecord(request) || !isRecord(request.verdict) || !isRecord(request.action) || !isRecord(request.requester)) throw invalid('a request has a subject, an action, a requester, and the verdict that asked')
    // Only the queue asks for its own policy changes (proposePolicy); a caller never names it.
    if (request.requester.component === 'approvals' || request.requester.policyChangeId !== undefined) throw invalid('only the queue requests a policy change of its own, through proposePolicy')
    return this.open(request, when, 'approval-request@1.0')
  }

  /** Queue a request, checking the verdict it cites inside the transaction that writes it. */
  private open(request: NewRequest, when: Date, schema: ApprovalRequest['schema']): ApprovalRequest {
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
        schema, requestId: newId('apr'), state: 'open',
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
      // Its exact shape, if the queue could ever propose a change for it, in the same transaction.
      const shape = this.shapeOf(request, projectId)
      if (shape !== undefined) this.ctx.store.db.prepare('INSERT INTO request_shapes (request_id, shape, created_ms) VALUES (?, ?, ?)').run(created.requestId, shape, when.getTime())
      // Ids, the class, and the expiry only: never the summary, consequences, or command (a surface reads it).
      this.announce('approvals.requested', {
        requestId: created.requestId, actionClass: created.action.class, expiresAt: created.expiresAt, component: created.requester.component,
        ...(projectId !== undefined ? { projectId } : {}), ...(created.requester.taskId !== undefined ? { taskId: created.requester.taskId } : {}), ...(created.requester.policyChangeId !== undefined ? { policyChangeId: created.requester.policyChangeId } : {}),
      })
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

  /**
   * Apply the operator's verdicts. `check` sees every verdict's result before any of them commits:
   * with it the verdicts apply in one transaction, so one that throws applies none of them, and an
   * open request is judged again under a policy one would have approved only once all committed.
   */
  async decide(verdicts: Verdict[], at: Date = new Date(), check?: (results: VerdictResult[]) => void): Promise<VerdictResult[]> {
    return this.decideBy(verdicts, this.instant(at), check)
  }

  /**
   * A project's lead gives verdicts on its own token (ADR-0076): each is checked against the lead's
   * closed list of rights first ({@link leadMayDecide}), and one outside it refuses the whole call,
   * with the reason, before anything is decided. What is decided is recorded with the decider
   * `lead:<project>`, never as the operator's.
   */
  async decideAsLead(project: string, verdicts: Verdict[], at: Date = new Date(), check?: (results: VerdictResult[]) => void): Promise<VerdictResult[]> {
    const when = this.instant(at)
    if (typeof project !== 'string' || !LEAD_PROJECT.test(project)) throw invalid('a lead decides for a project')
    if (!Array.isArray(verdicts)) throw invalid('verdicts is not a list')
    verdicts.forEach((v, i) => this.validVerdict(v, i))
    const refused: string[] = []
    const outside: Array<{ requestId: string; actionClass: string }> = []
    for (const v of verdicts) {
      const request = this.read(v.requestId)?.request
      if (!request) continue
      const may = leadMayDecide({
        project, of: await this.projectOfRequest(request), action: request.action.class,
        branch: request.action.class === 'merge' ? this.baseBranchOf(request) : undefined, devBranches: this.devBranches(project),
        remediation: request.action.class === 'remediation' ? leadRemediationOf(request, (ref) => this.ctx.artifacts.get(ref as never)) : undefined,
      })
      if (!may.ok) {
        refused.push(`${v.requestId} (${request.action.class}): ${may.reason}`)
        outside.push({ requestId: v.requestId, actionClass: request.action.class })
      }
    }
    if (refused.length) {
      // The refusal is recorded (ids and classes only) so the project's lead inbox tells that the request needs the operator.
      try {
        for (const o of outside.slice(0, 50)) this.ctx.get('eventLog')?.append({ type: 'approvals.lead-refused', data: { projectId: project, requestId: o.requestId, actionClass: o.actionClass } })
      } catch (error) {
        this.ctx.logger.warn(`approvals: the lead refusal of project ${project} was not recorded: ${(error as Error).message}`)
      }
    }
    if (refused.length) throw new ApprovalsError('forbidden', `${leadId(project)} may not give ${refused.length === 1 ? 'this verdict' : 'these verdicts'}; nothing was decided. ${refused.join(' | ')}`)
    return this.decideBy(verdicts, when, check, project)
  }

  /**
   * The project a request belongs to, for a lead's rights (ADR-0076): the project its requester names;
   * else, for a Worker's command (judged under the studio policy, so its requester names no project),
   * the board project of the task the requester names, as the board holds it. Undefined when neither
   * is known: then no lead decides it.
   */
  async projectOfRequest(request: ApprovalRequest): Promise<string | undefined> {
    if (request.requester.projectId !== undefined) return request.requester.projectId
    const taskId = request.requester.taskId
    if (taskId === undefined) return undefined
    const board = this.ctx.get('board' as never) as { task?: (taskId: string) => Promise<{ projectId?: string } | undefined> } | undefined
    return (await board?.task?.(taskId))?.projectId
  }

  /** The branches a project lists as dev branches (ADR-0076); none for a project not listed. */
  devBranches(project: string): string[] {
    return [...(this.dev.get(project) ?? [])]
  }

  /** The branch a `merge` request merges into, read from the landing of its run (the workflow engine); undefined when it cannot be read. */
  private baseBranchOf(request: ApprovalRequest): string | undefined {
    const runId = request.requester.runId
    if (runId === undefined) return undefined
    const workflow = this.ctx.get('workflow' as never) as { landing?: (runId: string) => { base?: { branch?: string }; requestId?: string } | undefined } | undefined
    const landing = workflow?.landing?.(runId)
    return landing?.requestId === request.requestId ? landing.base?.branch : undefined
  }

  private decideBy(verdicts: Verdict[], when: Date, check?: (results: VerdictResult[]) => void, lead?: string): VerdictResult[] {
    if (!Array.isArray(verdicts)) throw invalid('verdicts is not a list')
    verdicts.forEach((v, i) => this.validVerdict(v, i))
    // A stored record that fails its schema refuses the whole call before any verdict applies.
    for (const v of verdicts) this.read(v.requestId)
    if (!check) return this.applyVerdicts(verdicts, when, lead)
    return this.ctx.store.transaction(() => {
      const results = this.applyVerdicts(verdicts, when, lead)
      check(results)
      return results
    })
  }

  /** {@link decide}'s verdicts, each in its own transaction (a savepoint inside the caller's). */
  private applyVerdicts(verdicts: Verdict[], when: Date, lead?: string): VerdictResult[] {
    // Each verdict is its own transaction: a refused one changes nothing, and the others still
    // apply. One that fails (a busy store, a write that went stale) is reported as failed, never
    // hidden behind an error that drops the outcomes of the others.
    let changed = false
    const results = verdicts.map((v): VerdictResult => {
      try {
        return this.ctx.store.transaction((): VerdictResult => {
          const request = this.read(v.requestId)?.request
          if (!request) return { requestId: v.requestId, state: 'rejected', refused: 'unknown-request' }
          if (request.resolution) return { requestId: v.requestId, state: request.state, refused: 'already-resolved' }
          if (Date.parse(request.expiresAt) <= when.getTime()) return { requestId: v.requestId, state: request.state, refused: 'expired' }
          if (!sameSubject(request.subject, v.subject)) return { requestId: v.requestId, state: request.state, refused: 'subject-changed' }
          // A policy change applies only to the set it was proposed on: once another set is in
          // force, what the operator was shown is not what an approval would do (INV-5). The next
          // sweep withdraws it; a rejection still applies.
          const change = this.changeOf(request)
          if (change && v.verdict === 'approved' && change.baseHash !== this.set.setHash()) return { requestId: v.requestId, state: request.state, refused: 'subject-changed' }
          // INV-5: the verdict is written on the request's own subject, the one the operator saw.
          // A lead's verdict is the lead's (ADR-0076): approval@1.0's `by` is closed to operator and policy, so the
          // artifact says who gave it in its producer (system, `lead:<project>`) and its note, and the decision names the decider.
          const note = lead !== undefined ? `[${leadId(lead)}] ${v.note ?? ''}`.trim().slice(0, 2000) : v.note
          const approval = this.ctx.artifacts.put({
            kind: 'approval', bodySchema: 'approval@1.0', body: { schema: 'approval@1.0', subject: request.subject, verdict: v.verdict, by: 'operator', ...(note ? { note } : {}) },
            classification: request.classification === 'local-private' ? 'local-private' : 'operator-shared',
            producer: lead !== undefined ? { type: 'system', ref: leadId(lead) } : { type: 'operator', ref: 'operator' }, subject: request.subject,
          }).id as ArtifactRef
          const resolved = this.resolve(request, 'verdict', v.verdict, when, approval, undefined, lead)
          if (change && v.verdict === 'approved') changed = true
          return { requestId: v.requestId, state: resolved.state, approval }
        })
      } catch (error) {
        this.ctx.logger.warn(`approvals: the verdict on ${v.requestId} was not applied, and nothing of it changed`)
        this.ctx.logger.warn(error)
        return { requestId: v.requestId, state: this.storedState(v.requestId), refused: 'failed' }
      }
    })
    // A new policy set is in force: every open request is judged again under it, as at load (S1).
    if (changed) this.withdrawStale(when)
    return results
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

  // --- policy changes (contract 1.1) ---

  /**
   * Propose one policy record (docs/design/approvals.md#a-policy-change): the whole set it makes
   * must load as a configured set would, or nothing is stored (`invalid`). The `policy-change`
   * class is judged under the studio's policies (a project's policy: the project's), and on `ask`
   * one request is queued on the proposed set's hash, in the transaction that stores the change.
   * Only the operator's channels call it (the web UI, MCP `approvals_policy_propose`; INV-6).
   * `check` sees the change and its request before they commit: one that throws stores neither.
   */
  async proposePolicy(proposal: { policy: AutonomyPolicy; note?: string }, at: Date = new Date(), check?: (proposed: { change: PolicyChange; request: ApprovalRequest }) => void): Promise<{ change: PolicyChange; request: ApprovalRequest }> {
    const when = this.instant(at)
    if (!isRecord(proposal) || !isRecord(proposal.policy)) throw invalid('a proposal is {policy, note?}: one autonomy-policy@1.0 record')
    const note = proposal.note
    if (note !== undefined && (typeof note !== 'string' || note.length > 2000)) throw invalid('note must be a string of at most 2000 characters')
    try {
      this.schemas.assert('autonomy-policy@1.0', proposal.policy)
    } catch (error) {
      throw invalid(`the proposed policy is not a valid autonomy-policy@1.0: ${(error as Error).message}`)
    }
    return this.propose(structuredClone(proposal.policy), note, when, undefined, check)
  }

  /**
   * Ask one policy record as a change (the operator's proposal, or the queue's own `from` repeated
   * approvals): the set it makes must load, `policy-change` must ask, and the change and its request
   * are stored in one transaction on the set in force. The queue's own proposal also records its
   * `policy-change` decision there (INV-13), and is refused while any change is asked, once its
   * shape is barred, or when its shape's requests no longer read as they did when it was counted.
   * `check`, as {@link proposePolicy}'s, runs last in that transaction.
   */
  private async propose(policy: AutonomyPolicy, note: string | undefined, when: Date, from?: Repeated, check?: (proposed: { change: PolicyChange; request: ApprovalRequest }) => void): Promise<{ change: PolicyChange; request: ApprovalRequest }> {
    const base = this.current()
    const made = proposedSet(base.set, policy)
    if ('problems' in made) throw invalid(made.problems.join('; '))
    const problems = policyProblems(made.policies, this.schemas)
    if (problems.length) throw invalid(`the set it makes would be refused at load: ${problems.join('; ')}`)
    const next = PolicySet.load(made.policies, this.schemas)
    const hash = next.setHash()
    const baseHash = base.set.setHash()
    if (hash === baseHash) throw invalid('it changes nothing in the set in force')
    const projectId = policy.scope === 'project' ? policy.projectId : undefined
    const verdict = await this.check({ class: 'policy-change', ...(projectId !== undefined ? { projectId } : {}) })
    if (verdict.mode !== 'ask') throw new ApprovalsError('not-asked', `policy-change: the policy says ${verdict.mode} (decision ${verdict.decision}), so no change can be asked; change the configuration instead`)
    const effect = effectOf(base.set, next)
    const changeId = newId('pch')
    const summary = from
      ? clip(`The queue proposes: list the command \`${from.shape}\` in ${policy.id} (version ${made.previous!.version} to ${policy.version})`, 500)
      : made.previous
        ? `Change the autonomy policy ${policy.id}: version ${made.previous.version} to ${policy.version}`
        : `Add project ${String(projectId)}'s autonomy policy ${policy.id} (version ${policy.version})`
    const modes = effect.map((e) => `${e.projectId ?? 'studio'} ${e.actionClass} ${e.from} → ${e.to}`).join('; ')
    // A web access grant moves no mode (external-send still asks), so the operator is shown it apart (ADR-0074).
    const web = webAccessEffect(base.set, next)
    const listed = from && next.effective('workspace-write')
    const consequences = clip((from
      ? `Proposed by the queue, not by you: you approved this exact command ${from.requests.length} times among the requests of the last ${span(from.windowSeconds)}, and rejected none and let none expire. `
        + `If approved: exactly this argv, with nothing added, is judged as workspace-write (${listed!.mode}${listed!.requires.length ? `, its checks ${listed!.requires.join(', ')} pending until the result is accepted` : ''}) instead of asking; `
        + `the set ${hash} replaces the set in force (${baseHash}) at once, and every open request is judged again under it (one made under ${policy.id} version ${made.previous!.version} is withdrawn, and its requester asks again). `
        + 'If rejected or unanswered: nothing changes, and the queue never proposes this command again.'
      : `If approved: the set ${hash} replaces the set in force (${baseHash}) at once, and every open request is judged again under it. `
        + `If rejected or unanswered: nothing changes. ${effect.length ? `Effective modes: ${modes}.` : 'No effective mode moves (expiry, batching, commands, web access, or required checks only).'}${web ? ` Web access (external-send still asks; these web calls run unasked once the egress check passes): ${web}.` : ''}${note ? ` Note: ${note}` : ''}`), 2000)
    return this.ctx.store.transaction(() => {
      // The base is the set in force when the change is stored, never an older one (INV-5).
      if (this.current().key !== base.key) throw invalid('another policy change came into force while this one was proposed; propose it again on the set in force')
      // The queue's own: at most one change asked at a time, and never for a shape barred (checked again under the write lock).
      if (from && (this.changeAsked() || this.barred(from.shape))) throw invalid(`the queue proposes no change for \`${from.shape}\` now: a change is asked, or this command's proposal was settled`)
      // And its requests read again: one settled while the policy was checked (rejected, expired, or
      // approved) changes whether it qualifies and what its consequences and origin say.
      if (from) {
        const again = this.repeatedOf(from.shape, when.getTime() - from.windowSeconds * 1000, when, { approvals: from.threshold, windowSeconds: from.windowSeconds })
        if (!again || !sameList(again.requests.map((r) => r.requestId), from.requests.map((r) => r.requestId))) {
          throw invalid(`the queue proposes no change for \`${from.shape}\` now: its requests changed while it was proposed; the next pass reads them again`)
        }
      }
      const request = this.open({
        subject: { type: 'content', ref: POLICY_SET_REF, version: hash },
        action: { class: 'policy-change', summary, consequences },
        requester: { component: 'approvals', policyChangeId: changeId, ...(projectId !== undefined ? { projectId } : {}) },
        verdict, classification: 'operator-shared',
      }, when, 'approval-request@1.1')
      const origin = from && this.recordProposal(from, { changeId, requestId: request.requestId, baseHash, hash, policy, verdict })
      const change: PolicyChange = {
        schema: origin ? 'policy-change@1.1' : 'policy-change@1.0', changeId, state: 'asked', policy, ...(made.previous ? { previous: structuredClone(made.previous) } : {}),
        policies: next.all(), hash, baseHash, configHash: this.configured.setHash(), effect, requestId: request.requestId,
        ...(note ? { note } : {}), ...(origin ? { origin } : {}), proposedAt: when.toISOString(), revision: 0,
      }
      try {
        this.schemas.assertRecord(change)
      } catch (error) {
        throw invalid((error as Error).message)
      }
      this.ctx.store.db.prepare('INSERT INTO policy_changes (change_id, state, hash, base_hash, config_hash, request_id, proposed_ms, applied_seq, revision, record, origin_shape) VALUES (?, \'asked\', ?, ?, ?, ?, ?, NULL, 0, ?, ?)')
        .run(changeId, hash, baseHash, change.configHash, request.requestId, when.getTime(), JSON.stringify(change), from?.shape ?? null)
      const proposed = { change: structuredClone(change), request }
      check?.(proposed)
      return proposed
    })
  }

  /** The policy changes, newest first: at most `limit` (default {@link DEFAULT_CHANGES}, at most {@link MAX_CHANGES}), in the given states (default all). */
  async policyChanges(filter: { states?: Array<PolicyChange['state']>; limit?: number } = {}): Promise<PolicyChange[]> {
    if (!isRecord(filter)) throw invalid('the filter is not an object')
    const limit = filter.limit ?? DEFAULT_CHANGES
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CHANGES) throw invalid(`limit must be a whole number from 1 to ${MAX_CHANGES}`)
    const states = filter.states ?? CHANGE_STATES
    if (!Array.isArray(states) || !states.length || states.some((s) => !CHANGE_STATES.includes(s))) throw invalid(`states must be a non-empty list of ${CHANGE_STATES.join(', ')}`)
    const rows = this.ctx.store.db.prepare(`SELECT change_id, record FROM policy_changes WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY seq DESC LIMIT ?`)
      .all(...states, limit) as Array<{ change_id: string; record: string }>
    return rows.map((r) => this.loadChange(r.change_id, r.record))
  }

  // --- the queue's own proposal from repeated approvals ---

  /**
   * When configured (`repeatedApprovals`), propose, never apply, one policy change
   * (docs/design/approvals.md#the-queue-proposes-a-policy-change): for the studio command the
   * operator approved most often among the requests made in the window, at least `approvals` times,
   * none of its requests there rejected by a verdict or expired, and no change of the queue's for it
   * ever asked, applied, retired, rejected, or expired; only while no policy change is asked at all
   * and the policy asks for `policy-change`. The change adds exactly that argv, as one line, to the
   * studio policy's commands list, and only where that lets the argv run as `workspace-write` under
   * `auto` or `notify`, moving no class's mode. Recorded as a `policy-change` decision (decider rule
   * `approvals.repeated-approvals`) in the transaction that stores the change and its request.
   * Deterministic from the store, so a restart or a second process proposes nothing twice. Returns
   * the change, if one was proposed. Never throws: a pass that fails is logged, and the queue goes
   * on, since the proposal only saves the operator verdicts.
   */
  async proposeRepeated(at: Date = new Date()): Promise<PolicyChange | undefined> {
    const rule = this.repeated
    if (!rule) return undefined
    try {
      const when = this.instant(at)
      if (this.changeAsked()) return undefined
      const set = this.set
      // A change the policy would not ask (forbid) is never proposed, nor its autonomy decision recorded on every pass.
      if (set.effective('policy-change').mode !== 'ask') return undefined
      const since = when.getTime() - rule.windowSeconds * 1000
      const shapes = this.ctx.store.db.prepare(`SELECT s.shape AS shape FROM request_shapes s JOIN approval_requests r ON r.request_id = s.request_id
        WHERE s.created_ms > ? AND s.created_ms <= ? AND r.state = 'approved' GROUP BY s.shape HAVING COUNT(*) >= ? ORDER BY COUNT(*) DESC, s.shape`)
        .all(since, when.getTime(), rule.approvals) as Array<{ shape: string }>
      for (const { shape } of shapes) {
        if (this.barred(shape)) continue
        const from = this.repeatedOf(shape, since, when, rule)
        const policy = from && this.listing(set, shape)
        if (!from || !policy) continue
        const { change } = await this.propose(policy, undefined, when, from)
        this.ctx.logger.info(`approvals: the queue proposes policy change ${change.changeId} (request ${change.requestId}): list \`${shape}\`, approved ${from.requests.length} times in ${span(rule.windowSeconds)}`)
        return change
      }
      return undefined
    } catch (error) {
      this.ctx.logger.warn('approvals: the queue proposed no policy change from repeated approvals on this pass; the next pass tries again')
      this.ctx.logger.warn(error)
      return undefined
    }
  }

  /**
   * The exact shape the queue may ever propose a change for: a request for a studio `command` (no
   * project) that is not `local-private`, judged as the `command` class, whose argv is a valid
   * commands-list line word for word; that line. Any other request has none and is never counted.
   */
  private shapeOf(request: NewRequest, projectId: string | undefined): string | undefined {
    const argv = request.command
    if (request.action.class !== 'command' || projectId !== undefined || request.classification === 'local-private' || argv === undefined || !argv.length) return undefined
    const line = argv.join(' ')
    if ([...line].length > 200 || commandProblems(line).length || !sameList(line.split(' '), argv)) return undefined
    return this.set.judge({ class: 'command', command: argv }).actionClass === 'command' ? line : undefined
  }

  /**
   * A shape's requests made in the window, each validated: the approved ones (by the operator's
   * verdict) when there are at least the threshold and none was rejected by a verdict or expired;
   * withdrawn and open ones count neither way. A record that fails its schema leaves the shape out.
   */
  private repeatedOf(shape: string, since: number, when: Date, rule: Threshold): Repeated | undefined {
    const rows = this.ctx.store.db.prepare(`SELECT r.request_id AS request_id, r.record AS record FROM request_shapes s JOIN approval_requests r ON r.request_id = s.request_id
      WHERE s.shape = ? AND s.created_ms > ? AND s.created_ms <= ? ORDER BY s.created_ms, r.seq`).all(shape, since, when.getTime()) as Array<{ request_id: string; record: string }>
    const approved: ApprovalRequest[] = []
    for (const row of rows) {
      let request: ApprovalRequest
      try {
        request = this.load(row.request_id, row.record)
      } catch (error) {
        this.skipped(`the repeated approvals of \`${shape}\``, error)
        return undefined
      }
      const { resolution } = request
      if (request.action.class !== 'command' || request.requester.projectId !== undefined || request.classification === 'local-private') return undefined
      if (request.state === 'rejected' && (resolution?.cause === 'verdict' || resolution?.cause === 'expired')) return undefined
      if (request.state === 'approved' && resolution?.cause === 'verdict' && resolution.approval) approved.push(request)
    }
    return approved.length >= rule.approvals ? { shape, requests: approved, windowSeconds: rule.windowSeconds, threshold: rule.approvals } : undefined
  }

  /**
   * The studio policy at its next version with the line added to its commands list, nothing else
   * changed, when that is exactly the shape and lowers what is asked: the argv asks as the `command`
   * class under the set in force, and is judged as `workspace-write` under `auto` or `notify` once
   * listed; no class's effective mode moves; neither class always asks; the set it makes loads.
   */
  private listing(set: PolicySet, shape: string): AutonomyPolicy | undefined {
    const argv = shape.split(' ')
    if (commandProblems(shape).length) return undefined
    const now = set.judge({ class: 'command', command: argv })
    if (now.actionClass !== 'command' || now.rule.mode !== 'ask' || now.forbidden || ALWAYS_ASK.includes(now.actionClass)) return undefined
    const studio = set.studio
    const policy: AutonomyPolicy = { ...structuredClone(studio), version: studio.version + 1, commands: [...(studio.commands ?? []), shape] }
    const made = proposedSet(set, policy)
    if ('problems' in made || policyProblems(made.policies, this.schemas).length) return undefined
    const next = PolicySet.load(made.policies, this.schemas)
    const listed = next.judge({ class: 'command', command: argv })
    if (listed.actionClass !== 'workspace-write' || (listed.rule.mode !== 'auto' && listed.rule.mode !== 'notify') || ALWAYS_ASK.includes(listed.actionClass)) return undefined
    return effectOf(set, next).length ? undefined : policy
  }

  /**
   * Record the queue's proposal as a `policy-change` decision (decider rule
   * `approvals.repeated-approvals`), inside the transaction that stores the change, and return the
   * change's `origin`: the proposed set selected, the set in force kept until the operator approves;
   * its inputs the `autonomy` decision that said ask and the operator's approvals it counted (the
   * newest {@link MAX_COUNTED}).
   */
  private recordProposal(from: Repeated, at: { changeId: string; requestId: string; baseHash: ContentHash; hash: ContentHash; policy: AutonomyPolicy; verdict: AutonomyVerdict }): PolicyChangeOrigin {
    const counted = from.requests.slice(-MAX_COUNTED)
    const approved = from.requests.length
    const decision = this.ctx.artifacts.recordDecision({
      schema: 'decision@1.6', decisionType: 'policy-change', question: 'Which autonomy policy set does the queue propose to the operator?',
      inputs: [...new Set([at.verdict.decision, ...counted.map((r) => r.resolution!.approval!)])],
      candidates: [
        { option: at.hash, selected: true, reasons: [`the operator approved \`${from.shape}\` ${approved} times among the requests of the last ${span(from.windowSeconds)} (at least ${from.threshold}), and rejected none and let none expire; proposed, never applied: only the operator's approval of request ${at.requestId} applies it`] },
        { option: at.baseHash, selected: false, reasons: ['the set in force stays in force until the operator approves the proposal'] },
      ],
      decider: { type: 'rule', id: 'approvals.repeated-approvals', version: '1', hash: at.hash },
      outcome: {
        option: at.hash,
        detail: {
          cause: 'repeated-approvals', changeId: at.changeId, requestId: at.requestId, from: at.baseHash, to: at.hash, configHash: this.configured.setHash(),
          policy: { id: at.policy.id, version: at.policy.version }, shape: { actionClass: 'command', command: from.shape },
          approved, threshold: from.threshold, windowSeconds: from.windowSeconds, requests: counted.map((r) => r.requestId),
        },
      },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'approvals' }, classification: 'operator-shared' }).id as ArtifactRef
    return { rule: 'approvals.repeated-approvals', shape: { actionClass: 'command', command: from.shape }, approved, windowSeconds: from.windowSeconds, decision }
  }

  /** Whether any policy change is asked now: the queue proposes nothing then. */
  private changeAsked(): boolean {
    return this.ctx.store.db.prepare("SELECT 1 FROM policy_changes WHERE state = 'asked' LIMIT 1").get() !== undefined
  }

  /**
   * Whether the queue never proposes for a shape again: a change of its for that shape was asked,
   * applied, retired, or declined as rejected or expired. Only a withdrawn one (its base no longer
   * in force, or the policy no longer asking) leaves the shape open; a record that fails its schema
   * bars it too.
   */
  private barred(shape: string): boolean {
    const rows = this.ctx.store.db.prepare('SELECT change_id, state, record FROM policy_changes WHERE origin_shape = ?').all(shape) as Array<{ change_id: string; state: string; record: string }>
    return rows.some((row) => {
      if (row.state !== 'declined') return true
      try {
        return this.loadChange(row.change_id, row.record).declined?.cause !== 'withdrawn'
      } catch {
        return true
      }
    })
  }

  /** The set in force, read again from the store whenever its latest applied change moved (a verdict here, or another process). */
  private current(): InForce {
    const row = this.latestApplied()
    const key = row ? `${row.change_id}:${row.state}` : 'configuration'
    if (this.state?.key === key) return this.state
    return this.state = this.inForce(new Date(), false, row)
  }

  /** The set judged under now. */
  private get set(): PolicySet {
    return this.current().set
  }

  private latestApplied(): { change_id: string; state: PolicyChange['state']; hash: string; config_hash: string } | undefined {
    return this.ctx.store.db.prepare('SELECT change_id, state, hash, config_hash FROM policy_changes WHERE applied_seq IS NOT NULL ORDER BY applied_seq DESC LIMIT 1')
      .get() as { change_id: string; state: PolicyChange['state']; hash: string; config_hash: string } | undefined
  }

  /**
   * Which set is in force (docs/design/approvals.md#the-configuration-and-the-stored-set): the latest
   * applied change's while it is not retired, its configuration (`configHash`) is the configured
   * set's hash (or its set is the configured set), and its set still loads; the configured set when
   * no change is in force. A stored set the configuration no longer matches is never used, nor
   * silently dropped: at a start, a configuration whose `supersedes` names its hash retires it
   * (recorded) and takes over; otherwise this throws, and the plugin is refused (INV-2).
   */
  private inForce(at: Date, atLoad: boolean, row = this.latestApplied()): InForce {
    if (!row || row.state === 'retired') return { key: row ? `${row.change_id}:retired` : 'configuration', set: this.configured, source: 'configuration' }
    const key = `${row.change_id}:${row.state}`
    const configHash = this.configured.setHash()
    let why: string
    if (row.config_hash === configHash || row.hash === configHash) {
      const change = this.change(row.change_id)!
      try {
        const set = PolicySet.load(change.policies, this.schemas)
        if (set.setHash() !== row.hash) throw new Error(`it hashes to ${set.setHash()}, not to its recorded ${row.hash}`)
        return { key, set, source: 'store', changeId: row.change_id }
      } catch (error) {
        why = `its set no longer loads: ${(error as Error).message}`
      }
    } else {
      why = `it was derived from the configured set ${row.config_hash}, and the configuration is now ${configHash}`
    }
    if (atLoad && this.supersedes === row.hash) {
      this.retire(row.change_id, at, why)
      return { key: `${row.change_id}:retired`, set: this.configured, source: 'configuration' }
    }
    throw new Error(`approvals: the autonomy policy set in the store (${row.hash}, policy change ${row.change_id}) is not used: ${why}. Neither set applies, so no ctx.approvals is provided and every action that needs a person waits (fail closed). `
      + `Restore the configuration it was derived from, or set supersedes: '${row.hash}' in the approvals row to let the configuration replace it.`)
  }

  /** Retire the applied change a configuration supersedes, with its `policy-change` decision (INV-13). */
  private retire(changeId: string, at: Date, why: string): void {
    this.ctx.store.transaction(() => {
      const change = this.change(changeId)!
      const to = this.configured.setHash()
      const decision = this.recordSetChange(change, 'configuration', to, [change.applied!.decision], `the configuration (${to}) names the stored set in supersedes, which is not used: ${why}`, 'not kept: the configuration supersedes it')
      this.writeChange(change, { ...change, state: 'retired', retired: { at: at.toISOString(), decision }, revision: change.revision + 1 })
    })
    this.ctx.logger.info(`approvals: the configuration supersedes the stored policy set of change ${changeId} (${why}); the configured set is in force`)
  }

  /**
   * Settle the queue's own policy-change request's change in the transaction that resolved it:
   * approved, its set comes into force; rejected, expired, or withdrawn, it is declined and nothing
   * changes.
   */
  private settle(change: PolicyChange, request: ApprovalRequest, at: Date): void {
    if (change.state !== 'asked') throw new Error(`approvals: policy change ${change.changeId} is ${change.state}; its request ${request.requestId} cannot settle it`)
    const resolution = request.resolution!
    if (request.state !== 'approved') {
      const cause = resolution.cause === 'verdict' ? 'rejected' : resolution.cause
      this.writeChange(change, { ...change, state: 'declined', declined: { at: at.toISOString(), cause, decision: resolution.decision }, revision: change.revision + 1 })
      return
    }
    // Only onto the set it was proposed on, and only a set that loads (INV-2, INV-5).
    const before = this.current().set.setHash()
    if (change.baseHash !== before) throw new Error(`approvals: policy change ${change.changeId} was proposed on ${change.baseHash}, and ${before} is in force`)
    const after = PolicySet.load(change.policies, this.schemas)
    if (after.setHash() !== change.hash) throw new Error(`approvals: policy change ${change.changeId} does not hash to its recorded set`)
    const decision = this.recordSetChange(change, 'approved', change.hash, [request.policy.decision, resolution.approval!, resolution.decision],
      `the operator approved request ${request.requestId} on this set, proposed on the set in force`, 'not kept: the operator approved the change', request.requestId)
    const seq = (this.ctx.store.db.prepare('SELECT COALESCE(MAX(applied_seq), 0) + 1 AS seq FROM policy_changes').get() as { seq: number }).seq
    this.writeChange(change, { ...change, state: 'applied', applied: { at: at.toISOString(), decision }, revision: change.revision + 1 }, Number(seq))
  }

  /** The `policy-change` decision (`decision@1.6`): which set is in force, the old and new hashes its two candidates. */
  private recordSetChange(change: PolicyChange, cause: 'approved' | 'configuration', to: ContentHash, inputs: ArtifactRef[], why: string, whyNot: string, requestId?: string): ArtifactRef {
    const from = cause === 'approved' ? change.baseHash : change.hash
    return this.ctx.artifacts.recordDecision({
      schema: 'decision@1.6', decisionType: 'policy-change', question: 'Which autonomy policy set is in force?', inputs,
      candidates: [{ option: to, selected: true, reasons: [why] }, { option: from, selected: false, reasons: [whyNot] }],
      decider: { type: 'rule', id: cause === 'approved' ? 'approvals.policy-change' : 'approvals.configuration', version: '1', hash: to },
      outcome: { option: to, detail: { cause, changeId: change.changeId, ...(requestId ? { requestId } : {}), from, to, configHash: this.configured.setHash(), policy: { id: change.policy.id, version: change.policy.version } } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'approvals' }, classification: 'operator-shared' }).id as ArtifactRef
  }

  /** The queue's own policy-change request's change, checked against the request; undefined for any other request. */
  private changeOf(request: ApprovalRequest): PolicyChange | undefined {
    if (request.requester.component !== 'approvals') return undefined
    const changeId = request.requester.policyChangeId
    const change = changeId === undefined ? undefined : this.change(changeId)
    // A record that disagrees with its request is never acted on.
    if (!change || change.requestId !== request.requestId || change.hash !== request.subject.version || request.action.class !== 'policy-change') {
      throw new Error(`approvals: request ${request.requestId} names policy change ${String(changeId)}, which is missing or names another request or set`)
    }
    return change
  }

  private change(changeId: string): PolicyChange | undefined {
    const row = this.ctx.store.db.prepare('SELECT record FROM policy_changes WHERE change_id = ?').get(changeId) as { record: string } | undefined
    return row && this.loadChange(changeId, row.record)
  }

  /** A stored change is validated when it is read: one that fails is never acted on. */
  private loadChange(changeId: string, json: string): PolicyChange {
    const change = JSON.parse(json) as PolicyChange
    try {
      this.schemas.assertRecord(change)
    } catch (error) {
      throw new Error(`approvals: the stored policy change ${changeId} is not a valid policy-change@1.x and is not used: ${(error as Error).message}`)
    }
    return change
  }

  /** Write a change's next revision, revision-checked; `appliedSeq` orders an applied one. */
  private writeChange(before: PolicyChange, next: PolicyChange, appliedSeq?: number): void {
    this.schemas.assertRecord(next)
    const changes = this.ctx.store.db.prepare('UPDATE policy_changes SET state = ?, applied_seq = COALESCE(?, applied_seq), revision = ?, record = ? WHERE change_id = ? AND revision = ?')
      .run(next.state, appliedSeq ?? null, next.revision, JSON.stringify(next), next.changeId, before.revision).changes
    if (Number(changes) !== 1) throw new Error(`approvals: policy change ${next.changeId} changed under this write (revision ${before.revision} is stale)`)
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
  private resolve(request: ApprovalRequest, cause: 'verdict' | 'expired' | 'withdrawn', option: string, at: Date, approval?: ArtifactRef, by?: Withdrawal, lead?: string): ApprovalRequest {
    const verdicts = ['approved', 'rejected']
    const lost = (o: string): string => cause === 'verdict' ? (verdicts.includes(o) ? `${lead !== undefined ? `${leadId(lead)}'s` : 'the operator\'s'} verdict is ${option}` : 'a verdict came first')
      : cause === 'expired' ? (o === 'withdrawn' ? 'it was not withdrawn before it expired' : 'no verdict came before it expired')
      : o === 'denied:expired' ? `${by!.before} before it expired` : `${by!.before} before a verdict`
    const decision = this.ctx.artifacts.recordDecision({
      // A lead's verdict has a `client` decider that is no vote: decision@1.10 (ADR-0076); every other is decision@1.4 as before.
      schema: cause === 'verdict' && lead !== undefined ? 'decision@1.10' : 'decision@1.4', decisionType: 'approval', question: `Is approval request ${request.requestId} approved?`, inputs: [request.policy.decision, ...(approval ? [approval] : [])],
      candidates: ['approved', 'rejected', 'denied:expired', 'withdrawn'].map((o) => ({ option: o, selected: o === option, reasons: [o === option ? (by?.why ?? cause) : `not ${o}: ${lost(o)}`] })),
      // Who decided: the operator (version 2: a record at version 1 is from before the lead principal, when the lead's scripts
      // used the operator's token), a project's lead (a `client` decider, `lead:<project>`), or the rule that withdrew it.
      decider: cause !== 'verdict' ? { type: 'rule', id: by!.rule, version: '1' }
        : lead !== undefined ? { type: 'client', id: leadId(lead), version: '1' } : { type: 'operator', id: 'operator', version: '2' },
      outcome: { option, detail: { requestId: request.requestId } }, deterministic: cause !== 'verdict',
    }, { producer: { type: cause === 'verdict' && lead === undefined ? 'operator' : 'system', ref: cause === 'verdict' && lead !== undefined ? leadId(lead) : 'approvals' }, classification: request.classification === 'local-private' ? 'local-private' : 'operator-shared' })
    const next: ApprovalRequest = {
      ...request, state: option === 'approved' ? 'approved' : 'rejected', revision: request.revision + 1,
      resolution: { cause, ...(approval ? { approval } : {}), decision: decision.id as ArtifactRef, at: at.toISOString() },
    }
    this.write(request, next)
    // The queue's own policy-change request settles its change in the same transaction.
    const change = this.changeOf(request)
    if (change) this.settle(change, next, at)
    this.announce('approvals.resolved', { requestId: request.requestId, state: next.state, cause, option }, decision.id as ArtifactRef)
    return next
  }

  /**
   * Append one event of the queue inside the caller's transaction, so it commits with the change it
   * names. The event log is optional, and an append that fails is logged: it never fails the change.
   */
  private announce(type: 'approvals.requested' | 'approvals.resolved', data: Record<string, unknown>, decision?: ArtifactRef): void {
    try {
      this.ctx.get('eventLog')?.append({ type, ...(decision ? { decision } : {}), data })
    } catch (error) {
      this.ctx.logger.warn(`approvals: the ${type} event of ${String(data.requestId)} was not appended: ${(error as Error).message}`)
    }
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
    if (!isRecord(verdict.policy) || verdict.policy.id !== policy.id || verdict.policy.version !== policy.version) throw notAsked('the verdict names another policy than the decision it cites')
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
    const change = this.changeOf(request)
    if (change) {
      // A policy change is put to the set it was proposed on; once another is in force, or its
      // set no longer loads, an approval could not apply it as shown.
      if (change.baseHash !== this.set.setHash()) return `the set it was proposed on (${change.baseHash}) is no longer in force`
      const problems = policyProblems(change.policies, this.schemas)
      if (problems.length) return `the set it proposes no longer loads: ${problems[0]}`
    }
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
    if (!isRecord(filter)) throw invalid('the filter is not an object')
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
    if (!isRecord(action)) throw invalid('the action is not an object')
    if (!ACTION_CLASSES.includes(action.class)) throw invalid(`${String(action.class)} is not an action class`)
    if (action.projectId !== undefined && (typeof action.projectId !== 'string' || !ID.test(action.projectId))) throw invalid(`projectId ${JSON.stringify(action.projectId)} is not an id`)
    if (action.command !== undefined && (!Array.isArray(action.command) || action.command.some((word) => typeof word !== 'string'))) throw invalid('command must be an argv: a list of strings')
    if (action.commandRule !== undefined && (typeof action.commandRule !== 'string' || !/^[a-z][a-z0-9.-]{0,63}$/.test(action.commandRule))) throw invalid('commandRule must be a command rule id')
    if (action.checks !== undefined && !isRecord(action.checks)) throw invalid('checks must be an object of check names to whether they passed')
  }

  private validVerdict(v: Verdict, index: number): void {
    const subject = isRecord(v) ? v.subject : undefined
    const ok = isRecord(v) && typeof v.requestId === 'string' && isRecord(subject) && typeof subject.type === 'string' && typeof subject.ref === 'string'
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
