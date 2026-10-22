/**
 * Gate seam definition: `ctx.approvals`, the autonomy policy and the one batched queue for every
 * action that needs a person (docs/design/approvals.md). The types mirror
 * `autonomy-policy@1.0`, `approval-request@1.0`, and `approval@1.0`; the schemas in `schemas/`
 * are canonical. A guarantee seam: it fails closed (INV-2), and its contract changes only by an
 * ADR (ADR-0036).
 * @module @tsuuanmi/system-approvals-core
 */
import { type Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    approvals: Approvals
  }
}

/** The contract version of this seam; its conformance suite names the same. */
export const APPROVALS_CONTRACT = '1.0'

export type ArtifactRef = `sha256:${string}`
export type Classification = 'public' | 'operator-shared' | 'local-private'
export interface Subject { type: 'content' | 'git-head' | 'pull-request' | 'artifact' | 'external'; ref: string; version?: string }

export type ActionClass =
  | 'read' | 'workspace-write' | 'merge' | 'command' | 'external-send' | 'deploy' | 'delete-data' | 'spend'
  | 'charter' | 'funding' | 'remediation' | 'policy-change'
/**
 * Classes that always ask, even unattended: irreversible effects, the investor's own decisions, and
 * remediation (the workflow's remediation already waits on an operator gate). A provider gives
 * them at least `ask` whatever a rule says, and a policy that gives one `auto` or `notify` is
 * refused when loaded.
 */
export const ALWAYS_ASK: readonly ActionClass[] = ['external-send', 'deploy', 'delete-data', 'spend', 'charter', 'funding', 'remediation', 'policy-change']

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

/** `autonomy-policy@1.1` (`@1.0` is read too: 1.1 refuses `auto` and `notify` for `remediation`). */
export interface AutonomyPolicy {
  schema: 'autonomy-policy@1.0' | 'autonomy-policy@1.1'
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
 * **`mode` is the mode once the required checks pass.** An `auto` or `notify` verdict with a
 * non-empty `failedChecks` is not yet allowed: the action goes back to the lead as work. A caller
 * that acts on a verdict passes the checks it ran (`Action.checks`) and treats a non-empty
 * `failedChecks` as not yet allowed; the lead runs the checks first.
 */
export interface AutonomyVerdict {
  mode: Mode
  /** For an auto or notify rule whose checks failed: which ones. The action goes back to the lead, not to the operator. */
  failedChecks?: Check[]
  policy: { id: string; version: number }
  decision: ArtifactRef
}

export type RequestState = 'open' | 'batched' | 'approved' | 'rejected'

/** `approval-request@1.0`. */
export interface ApprovalRequest {
  schema: 'approval-request@1.0'
  requestId: string
  state: RequestState
  subject: Subject
  action: { class: ActionClass; summary: string; consequences?: string; recommendation?: 'approve' | 'reject'; refs?: ArtifactRef[] }
  requester: { component: 'workflow' | 'board' | 'worker' | 'resources'; runId?: string; nodeId?: string; sessionId?: string; projectId?: string; taskId?: string; toolUseId?: string }
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

/** Why a verdict was not recorded; `failed`: the provider could not apply it (an error, logged), so nothing changed. */
export type Refusal = 'unknown-request' | 'already-resolved' | 'expired' | 'subject-changed' | 'failed'
export interface VerdictResult { requestId: string; state: RequestState; approval?: ArtifactRef; refused?: Refusal }

/** Why an approvals call was refused. Nothing changed. */
export type ApprovalsFailure = 'not-asked' | 'unknown-request' | 'invalid'
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

  /** The studio policy, the project's when it has one, and the effective mode per action class. */
  abstract policy(projectId?: string): Promise<{ policies: AutonomyPolicy[]; effective: Array<{ actionClass: ActionClass; mode: Mode }> }>

  /**
   * Classify one action under the effective policy, recording an `autonomy` decision (its decider
   * the policy, with the policy set's hash).
   *
   * **The verdict's `mode` is the mode once the required checks pass.** A caller that acts on a
   * verdict must pass the checks it ran in `action.checks` and treat a non-empty `failedChecks`
   * as not yet allowed, even when `mode` is `auto` or `notify`: the lead runs the checks first.
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

  /** Close a request whose waiting work ended first: it is rejected with cause `withdrawn`. */
  abstract withdraw(requestId: string, at?: Date): Promise<ApprovalRequest>

  /**
   * Reject every request unanswered at `at` (cause `expired`, decision `denied:expired`), then
   * every open one the loaded policy no longer asks for: its policy is not current at its version,
   * or its class no longer asks (cause `withdrawn`, the decision's reason: the policy changed).
   * A provider does the second at load too. Returns those it rejected.
   */
  abstract sweep(at: Date): Promise<ApprovalRequest[]>
}
