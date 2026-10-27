/**
 * Gate seam definition: `ctx.approvals`, the autonomy policy and the one batched queue for every
 * action that needs a person (docs/design/approvals.md). The types mirror
 * `autonomy-policy@1.0`, `approval-request@1.1`, `policy-change@1.1`, and `approval@1.0`; the
 * schemas in `schemas/` are canonical. A guarantee seam: it fails closed (INV-2), and its contract changes only by an
 * ADR (ADR-0036).
 * @module @tsuuanmi/system-approvals-core
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import type { MapOf, RiskTierMap } from './risk-tiers.ts'
import type { TierByRisk, TierByRiskOf } from './tier-by-risk.ts'
import type { WebAccessGrants } from './web-access.ts'

export * from './risk-tiers.ts'
export * from './tier-by-risk.ts'
export * from './web-access.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    approvals: Approvals
  }
}

/**
 * The contract version of this seam; its conformance suite names the same. 1.1 adds the optional
 * {@link Approvals.proposePolicy} and {@link Approvals.policyChanges} (a policy change through a
 * `policy-change` approval) and the optional `set` of `policy()`: a provider at 1.0 has none, and
 * its policy changes only by configuration and a restart.
 */
export const APPROVALS_CONTRACT = '1.1'

export type ArtifactRef = `sha256:${string}`
/** A sha256 of canonical JSON that names no artifact: a policy set's hash. */
export type ContentHash = `sha256:${string}`
export type Classification = 'public' | 'operator-shared' | 'local-private'
export interface Subject { type: 'content' | 'git-head' | 'pull-request' | 'artifact' | 'external'; ref: string; version?: string }

/**
 * What an action does, as the autonomy policy classifies it (`common@1` `actionClass`). `dispatch`
 * (ADR-0064): System starting a ready board task's next attempt with no person or lead asking for it;
 * it is reversible (the run can be stopped, nothing lands without `merge`), so it is not in
 * {@link ALWAYS_ASK}, and a policy written before it names no rule for it and takes its `default`.
 */
export type ActionClass =
  | 'read' | 'workspace-write' | 'merge' | 'command' | 'external-send' | 'deploy' | 'delete-data' | 'spend'
  | 'charter' | 'funding' | 'remediation' | 'policy-change' | 'promotion' | 'dispatch'
/**
 * Classes that always ask, even unattended: irreversible effects, the investor's own decisions,
 * remediation (a fix that writes, or a lost run going on: the workflow's remediation gate and the
 * board ask the queue about it), promotion (a plugin moved to `default` on an accepted
 * evaluation, PROP-0011: the loop never approves its own change), and merge (an accepted result
 * lands only on the operator's approval, D56, ADR-0060). A provider gives
 * them at least `ask` whatever a rule says, and a policy that gives one `auto` or `notify` is
 * refused when loaded.
 */
export const ALWAYS_ASK: readonly ActionClass[] = ['merge', 'external-send', 'deploy', 'delete-data', 'spend', 'charter', 'funding', 'remediation', 'policy-change', 'promotion']

/**
 * A shell metacharacter, or a character a shell or a naive split treats specially: `; & | $` and
 * the backquote, `< > ( )`, `{ } [ ]`, `* ? ~`, quotes, backslash, and newline, carriage return,
 * tab, and NUL. An argv word holding one is forbidden at `check`, and a commands-list entry holding
 * one is refused when its policy loads: argv is matched word for word, never through a shell.
 */
export const SHELL_METACHARACTER = /[;&|$`<>(){}[\]*?~'"\\\n\r\t\0]/

export type Mode = 'auto' | 'notify' | 'ask' | 'forbid'
/** Modes from least to most strict; the effective mode is the strictest of the policies. */
export const MODES: readonly Mode[] = ['auto', 'notify', 'ask', 'forbid']
export type Check = 'tests' | 'typecheck' | 'lint' | 'schema' | 'quote-check' | 'review'

/**
 * The policies of a set (the studio's, then the project's) that apply to a class: a project policy
 * constrains only the classes it names. Pure: the vocabulary's semantics, shared by every provider
 * and by callers that bound a wait by the policy.
 */
export function applyingPolicies(policies: readonly AutonomyPolicy[], actionClass: ActionClass): AutonomyPolicy[] {
  const [studio, ...narrowing] = policies
  if (!studio) return []
  const names = (p: AutonomyPolicy): boolean => p.rules.some((r) => r.actionClass === actionClass)
  return [studio, ...narrowing.filter((p) => !names(studio) || names(p))]
}

/**
 * How long a wait for a person on the class lasts, in seconds: the shortest `expiresSeconds` of
 * the rules that apply to it (the studio's and the project's), else the stricter
 * `expiry.defaultSeconds`, never more than the stricter `expiry.maxSeconds`. A request in the queue
 * expires after it; so does the board's review held for the operator.
 */
export function waitSeconds(policies: readonly AutonomyPolicy[], actionClass: ActionClass): number {
  const named = applyingPolicies(policies, actionClass).flatMap((p) => p.rules.filter((r) => r.actionClass === actionClass && r.expiresSeconds !== undefined).map((r) => r.expiresSeconds!))
  const seconds = named.length ? Math.min(...named) : Math.min(...policies.map((p) => p.expiry.defaultSeconds))
  return Math.min(seconds, ...policies.map((p) => p.expiry.maxSeconds))
}

/** `autonomy-policy@1.x`: `@1.1` adds the optional path map `riskTiers` (ADR-0071); `@1.2` the tier a step takes at its task's risk tier, `tierByRisk` (ADR-0073); `@1.3` the optional `webAccess` grants (ADR-0074). */
export interface AutonomyPolicy {
  schema: 'autonomy-policy@1.0' | 'autonomy-policy@1.1' | 'autonomy-policy@1.2' | 'autonomy-policy@1.3'
  id: string
  version: number
  scope: 'studio' | 'project'
  projectId?: string
  narrows?: string
  rules: Array<{ actionClass: ActionClass; mode: Mode; requires?: Check[]; expiresSeconds?: number; note?: string }>
  default: 'ask' | 'forbid'
  commands?: string[]
  expiry: { defaultSeconds: number; maxSeconds: number }
  batch?: { maxSize: number; maxWaitSeconds: number }
  /**
   * `@1.1`, optional: the path map that gives each path a change touches a risk tier
   * (./risk-tiers.ts, ADR-0071). With no applying policy carrying one, tiering is off.
   */
  riskTiers?: RiskTierMap
  /**
   * `@1.2`, optional: the intelligence tier a board task's step takes at its task's risk tier
   * (./tier-by-risk.ts, ADR-0073). With no applying policy carrying one, steps keep their templates' tiers.
   */
  tierByRisk?: TierByRisk
  /**
   * `@1.3`, optional: web calls a research role's Workers make unasked when the egress check passes,
   * bounded per run (./web-access.ts, ADR-0074). `external-send` still always asks; the agent gate
   * applies a grant only to a call the policy said `ask` for. With none, every web call asks.
   */
  webAccess?: WebAccessGrants
}

/** The path maps of a policy set (the studio's, then the project's), each with the policy that carries it. */
export function riskTierMaps(policies: readonly AutonomyPolicy[]): MapOf[] {
  return policies.filter((p) => p.riskTiers !== undefined).map((p) => ({ policy: { id: p.id, version: p.version }, map: p.riskTiers! }))
}

/** The tier-by-risk maps of a policy set (the studio's, then the project's), each with the policy that carries it. */
export function tierByRiskMaps(policies: readonly AutonomyPolicy[]): TierByRiskOf[] {
  return policies.filter((p) => p.tierByRisk !== undefined).map((p) => ({ policy: { id: p.id, version: p.version }, map: p.tierByRisk! }))
}

/** An action a core component wants to take, as the policy classifies it. */
export interface Action {
  class: ActionClass
  projectId?: string
  /**
   * For `command`: the argv. An argv equal word for word to a line on every applying commands list
   * is judged as `workspace-write` (unless the `command` class is forbidden); any other is the
   * `command` class. Matching is exact, never by prefix. An argv with a word holding a
   * {@link SHELL_METACHARACTER} is forbidden, whatever its class.
   */
  command?: string[]
  /** For auto and notify rules: which of their required checks passed. */
  checks?: Partial<Record<Check, boolean>>
}

/**
 * The mode the policy gives an action, and the `autonomy` decision that records it.
 *
 * **`mode` is the mode once the required checks pass.** A rule's required checks are checks the
 * result must pass before it is accepted. A caller that accepts or applies a result passes the
 * checks it ran (`Action.checks`) and treats a non-empty `failedChecks` as not yet allowed: the
 * result goes back to the lead as work. A caller that gates work while it runs (readiness, a
 * Worker's tool call) cannot have run them: it lets the work go on and records them as pending,
 * and they bind at acceptance (docs/design/approvals.md#a-verdict-is-not-yet-a-permission).
 */
export interface AutonomyVerdict {
  mode: Mode
  /** For an auto or notify rule whose checks failed: which ones. The action goes back to the lead, not to the operator. */
  failedChecks?: Check[]
  policy: { id: string; version: number }
  decision: ArtifactRef
}

export type RequestState = 'open' | 'batched' | 'approved' | 'rejected'

/** `approval-request@1.x`: 1.1 for the queue's own `policy-change` requests, 1.0 for every other. */
export interface ApprovalRequest {
  schema: 'approval-request@1.0' | 'approval-request@1.1'
  requestId: string
  state: RequestState
  subject: Subject
  action: { class: ActionClass; summary: string; consequences?: string; recommendation?: 'approve' | 'reject'; refs?: ArtifactRef[] }
  /** `approvals` (1.1): the queue's own request for a policy change, naming its `policyChangeId`; no caller of `request` may name it. */
  requester: { component: 'workflow' | 'board' | 'worker' | 'resources' | 'approvals'; runId?: string; nodeId?: string; sessionId?: string; projectId?: string; taskId?: string; toolUseId?: string; policyChangeId?: string }
  policy: { id: string; version: number; decision: ArtifactRef }
  classification: Classification
  batchId?: string
  createdAt: string
  expiresAt: string
  resolution?: { cause: 'verdict' | 'expired' | 'withdrawn'; approval?: ArtifactRef; decision: ArtifactRef; at: string }
  revision: number
}

export interface NewRequest {
  subject: Subject
  action: ApprovalRequest['action']
  requester: ApprovalRequest['requester']
  /**
   * The `ask` verdict that requires it, from `check` under the policies loaded now. `request`
   * judges the action again (its class, `command`, and `requester.projectId`) and refuses
   * (`not-asked`) unless the policy still says ask, as the cited decision recorded it.
   */
  verdict: AutonomyVerdict
  /** For a `command` action: the argv `check` was given, judged again. */
  command?: string[]
  classification: Classification
}

export interface Verdict {
  requestId: string
  /** The exact subject the operator saw (INV-5). */
  subject: Subject
  verdict: 'approved' | 'rejected'
  note?: string
}

/**
 * The subject version of the board's `remediation` request for a lost run whose lease lapsed while
 * the host was stopped (still live at the board's recorded clean stop, expired by its next start): the
 * structured host-stopped mark a lead's rights read (ADR-0076, amended by T302). A lost run without it
 * is `reconciliation-failed`.
 */
export const HOST_STOPPED_RECONCILIATION = 'reconciliation-failed:host-stopped'

/** The subject ref of a `policy-change` request; its version is the proposed set's hash (INV-5). */
export const POLICY_SET_REF = 'autonomy-policy-set'

/** An effective mode a policy change moves, for the studio (no `projectId`) or one project. */
export interface ModeChange { projectId?: string; actionClass: ActionClass; from: Mode; to: Mode }

/**
 * `policy-change@1.x` (contract 1.1): one change of the autonomy policy set, asked through a
 * `policy-change` request on the proposed set's hash and applied only on the operator's approval
 * (docs/design/approvals.md#a-policy-change). `@1.1` adds the optional `origin` of a change the
 * queue proposed itself.
 */
export interface PolicyChange {
  /** `@1.1` for a change the queue proposed itself (with its `origin`), `@1.0` for the operator's own. */
  schema: 'policy-change@1.0' | 'policy-change@1.1'
  changeId: string
  /** `asked` → `applied` (approved) or `declined` (rejected, expired, withdrawn); `applied` → `retired` (a configuration superseded it). */
  state: 'asked' | 'applied' | 'declined' | 'retired'
  /** The proposed record. */
  policy: AutonomyPolicy
  /** The record it replaces; absent when it adds a project's policy. */
  previous?: AutonomyPolicy
  /** The whole set once applied: the studio policy, then the project policies by project id. */
  policies: AutonomyPolicy[]
  /** The sha256 of the canonical JSON of `policies`: its request's exact subject. */
  hash: ContentHash
  /** The set in force when proposed: it applies only while that set is still in force. */
  baseHash: ContentHash
  /** The configured set the base derives from. */
  configHash: ContentHash
  /** Every effective mode it moves. */
  effect: ModeChange[]
  requestId: string
  note?: string
  /**
   * `policy-change@1.1`, optional: set when the queue proposed the change itself, from approvals the
   * operator gave the same exact shape again and again (docs/design/approvals.md#the-queue-proposes-a-policy-change);
   * absent when the operator proposed it. It is no authority: only the operator's approval of its
   * request applies the change.
   */
  origin?: PolicyChangeOrigin
  proposedAt: string
  applied?: { at: string; decision: ArtifactRef }
  declined?: { at: string; cause: 'rejected' | 'expired' | 'withdrawn'; decision: ArtifactRef }
  retired?: { at: string; decision: ArtifactRef }
  revision: number
}

/**
 * Why the queue proposed a policy change itself (`policy-change@1.1`): the shape the operator
 * approved repeatedly (a studio command's exact argv, as a commands-list line), how many approvals
 * of it fell in the window, and the `policy-change` decision that recorded the proposal (INV-13).
 */
export interface PolicyChangeOrigin {
  rule: 'approvals.repeated-approvals'
  shape: { actionClass: 'command'; command: string }
  approved: number
  windowSeconds: number
  decision: ArtifactRef
}

/** The policy set in force (contract 1.1): its hash, where it comes from, the configured set's hash, and the projects with a policy. */
export interface PolicySetInForce {
  hash: ContentHash
  source: 'configuration' | 'store'
  configHash: ContentHash
  /** The applied change in force, when the source is the store. */
  changeId?: string
  projects: string[]
}

/** Why a verdict was not recorded; `failed`: the provider could not apply it (an error, logged), so nothing changed. */
export type Refusal = 'unknown-request' | 'already-resolved' | 'expired' | 'subject-changed' | 'failed'
export interface VerdictResult { requestId: string; state: RequestState; approval?: ArtifactRef; refused?: Refusal }

/** Why an approvals call was refused. Nothing changed. */
export type ApprovalsFailure = 'not-asked' | 'unknown-request' | 'invalid' | 'forbidden'
export class ApprovalsError extends Error {
  constructor(readonly failure: ApprovalsFailure, message: string) {
    super(message)
    this.name = 'ApprovalsError'
  }
}

export abstract class Approvals extends Service {
  constructor(ctx: Context) {
    super(ctx, 'approvals')
  }

  /**
   * The studio policy, the project's when it has one, and the effective mode per action class; at
   * contract 1.1, also the set in force (`set`).
   */
  abstract policy(projectId?: string): Promise<{ policies: AutonomyPolicy[]; effective: Array<{ actionClass: ActionClass; mode: Mode }>; set?: PolicySetInForce }>

  /**
   * Classify one action under the effective policy, recording an `autonomy` decision (its decider
   * the policy, with the policy set's hash).
   *
   * **The verdict's `mode` is the mode once the required checks pass.** A caller that accepts or
   * applies a result must pass the checks it ran in `action.checks` and treat a non-empty
   * `failedChecks` as not yet allowed, even when `mode` is `auto` or `notify`; one that gates work
   * while it runs records them as pending, and they bind at acceptance ({@link AutonomyVerdict}).
   */
  abstract check(action: Action): Promise<AutonomyVerdict>

  /**
   * Queue a request for an action whose verdict is `ask`, judged again under the policies loaded
   * now; anything else is refused (`not-asked`). The subject carries a `version` unless it is an
   * `artifact` subject whose ref is a `sha256:` content id (`invalid` otherwise, INV-5).
   *
   * `at` (here and in `batch`, `decide`, `withdraw`, `sweep`) is a test seam: the MCP tools, the
   * web UI, the board, and the queue's own passes fill it from the wall clock. A core caller never
   * passes another time.
   */
  abstract request(request: NewRequest, at?: Date): Promise<ApprovalRequest>

  abstract get(requestId: string): Promise<ApprovalRequest | undefined>

  /** Requests in the given states (default open and batched), by batch then expiry. */
  abstract list(filter?: { states?: RequestState[]; batchId?: string; projectId?: string }): Promise<ApprovalRequest[]>

  /** Group open requests into batches for the operator, as the policy's batch rule says. Returns the batch ids made. */
  abstract batch(at?: Date): Promise<string[]>

  /**
   * The operator's verdicts, each bound to its request's exact subject, each applied or refused on
   * its own: one result per verdict, in order. Only an operator channel calls it (INV-6).
   */
  abstract decide(verdicts: Verdict[], at?: Date): Promise<VerdictResult[]>

  /**
   * Optional (ADR-0076): a project's lead gives verdicts on its own token, not the operator's. The
   * rights are a closed list the provider enforces: the commands and dispatch starts of the lead's
   * project, and merges into the project's listed dev branches; any verdict outside it refuses the
   * whole call (`forbidden`, with the reason), and nothing is decided. What is decided is recorded
   * with the decider `lead:<project>` (a `client` decider), never as the operator's. A provider
   * without it takes no lead's verdict.
   */
  decideAsLead?(project: string, verdicts: Verdict[], at?: Date): Promise<VerdictResult[]>

  /** Optional (ADR-0076): the branches a project lists as dev branches, where its lead decides merges and results. */
  devBranches?(project: string): string[]

  /** Optional (ADR-0076): the project a request belongs to, for a lead's rights: its requester's, else its requester's board task's. */
  projectOfRequest?(request: ApprovalRequest): Promise<string | undefined>

  /** Close a request whose waiting work ended first: it is rejected with cause `withdrawn`. */
  abstract withdraw(requestId: string, at?: Date): Promise<ApprovalRequest>

  /**
   * Reject every request unanswered at `at` (cause `expired`, decision `denied:expired`), then
   * every open one the loaded policy no longer asks for: its policy is not current at its version,
   * or its class no longer asks (cause `withdrawn`, the decision's reason: the policy changed).
   * A provider does the second at load too. Returns those it rejected.
   */
  abstract sweep(at: Date): Promise<ApprovalRequest[]>

  /**
   * Contract 1.1, optional: propose one policy record, a policy of the set at a higher version or a
   * policy for a project that has none. The whole set it makes must load under the configured
   * set's rules, or nothing is stored (`invalid`); a policy that forbids `policy-change` refuses it
   * (`not-asked`). Otherwise one `policy-change` request is queued on the proposed set's hash, and
   * the set comes into force only when the operator approves that request while the set it was
   * proposed on is still in force: atomically with the verdict, recorded as a `policy-change`
   * decision with the old and new hashes, after which every open request is judged again as at
   * load. Only an operator channel calls it (INV-6).
   */
  abstract proposePolicy?(proposal: { policy: AutonomyPolicy; note?: string }, at?: Date): Promise<{ change: PolicyChange; request: ApprovalRequest }>

  /** Contract 1.1, optional: the policy changes, newest first (default 20, at most 100). */
  abstract policyChanges?(filter?: { states?: Array<PolicyChange['state']>; limit?: number }): Promise<PolicyChange[]>
}
