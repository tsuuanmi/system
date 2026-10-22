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
/** Classes that always ask, even unattended: irreversible effects and the investor's own decisions. */
export const ALWAYS_ASK: readonly ActionClass[] = ['external-send', 'deploy', 'delete-data', 'spend', 'charter', 'funding', 'policy-change']

export type Mode = 'auto' | 'notify' | 'ask' | 'forbid'
/** Modes from least to most strict; the effective mode is the strictest of the policies. */
export const MODES: readonly Mode[] = ['auto', 'notify', 'ask', 'forbid']
export type Check = 'tests' | 'typecheck' | 'lint' | 'schema' | 'quote-check' | 'review'

/** `autonomy-policy@1.0`. */
export interface AutonomyPolicy {
  schema: 'autonomy-policy@1.0'
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
  /** For `command`: the argv; a command on the policy's list is classed by what it does instead. */
  command?: string[]
  /** For auto and notify rules: which of their required checks passed. */
  checks?: Partial<Record<Check, boolean>>
}

/** The mode the policy gives an action, and the `autonomy` decision that records it. */
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
  /** The `ask` verdict that requires it; a request without one is refused. */
  verdict: AutonomyVerdict
  classification: Classification
}

export interface Verdict {
  requestId: string
  /** The exact subject the operator saw (INV-5). */
  subject: Subject
  verdict: 'approved' | 'rejected'
  note?: string
}

export type Refusal = 'unknown-request' | 'already-resolved' | 'expired' | 'subject-changed'
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

  /** Classify one action under the effective policy, recording an `autonomy` decision. */
  abstract check(action: Action): Promise<AutonomyVerdict>

  /** Queue a request for an action whose verdict is `ask`; anything else is refused (`not-asked`). */
  abstract request(request: NewRequest, at?: Date): Promise<ApprovalRequest>

  abstract get(requestId: string): Promise<ApprovalRequest | undefined>

  /** Requests in the given states (default open and batched), by batch then expiry. */
  abstract list(filter?: { states?: RequestState[]; batchId?: string; projectId?: string }): Promise<ApprovalRequest[]>

  /** Group open requests into batches for the operator, as the policy's batch rule says. Returns the batch ids made. */
  abstract batch(at?: Date): Promise<string[]>

  /** The operator's verdicts, each bound to its request's exact subject. Only an operator channel calls it (INV-6). */
  abstract decide(verdicts: Verdict[], at?: Date): Promise<VerdictResult[]>

  /** Close a request whose waiting work ended first: it is rejected with cause `withdrawn`. */
  abstract withdraw(requestId: string, at?: Date): Promise<ApprovalRequest>

  /** Reject every request unanswered at `at` (cause `expired`, decision `denied:expired`). Returns those it rejected. */
  abstract sweep(at: Date): Promise<ApprovalRequest[]>
}
