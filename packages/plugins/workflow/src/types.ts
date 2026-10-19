/**
 * The engine's record, view, and config types, its row shapes in the store, and its typed
 * refusal. Shared by every module of the engine; nothing here touches the store.
 */
import { randomBytes } from 'node:crypto'
import type { ContentId } from '@tsuuanmi/system-libs'
import type { ArtifactRef, Classification, Tier, WorkRequirement } from '@tsuuanmi/system-workers-core'
import type { CallerOptions, NodeTemplate } from './spec.ts'

export type RunStatus = 'running' | 'completed' | 'failed'
/** `RETIRED` (workflow-node@1.1): a node a re-plan took out of the graph; it stays as history and never runs. */
export type NodeState = 'WAITING' | 'READY' | 'RUNNING' | 'BLOCKED' | 'COMPLETED' | 'FAILED' | 'RETIRED'

export interface WorkflowError {
  kind: string
  disposition: string
  message: string
}

/** A durable node record (`workflow-node@1.0`; `@1.1` once it is `RETIRED`). */
export interface NodeRecord {
  schema: 'workflow-node@1.0' | 'workflow-node@1.1'
  runId: string
  nodeId: string
  objective: string
  /** `team`: a team's deterministic tally or decision (no Worker). */
  executor: 'worker' | 'gate' | 'team' | 'effect'
  requirement: WorkRequirement
  dependsOn: string[]
  state: NodeState
  inputReceipt?: { inputHash: ContentId; bundle: ArtifactRef[] }
  outputReceipt?: { result: ArtifactRef; acceptance: ArtifactRef }
  execution?: { executionId: string; attempt: number; owner: string; generation: number; route: ArtifactRef }
  lastDecision?: ArtifactRef
  revision: number
}

export interface NodeView {
  nodeId: string
  state: NodeState
  /** The node's minimum tier. */
  minTier: Tier
  attempt: number
  /** The execution on the Worker's own runtime (a turn id for website Workers). */
  executionId?: string
  /** The Worker source that runs it. */
  source?: string
  worker?: string
  /** The tier of the Worker that served the node. */
  tier?: Tier
  quotaClass?: string
  result?: ArtifactRef
  /** Tokens the result reports spending, when its Worker counts them (model Workers). */
  usage?: { inputTokens: number; outputTokens: number }
  error?: WorkflowError
}

/** What callers see: never the input text. */
export interface RunView {
  runId: string
  template: string
  status: RunStatus
  specHash: ContentId
  sessionId?: string
  /** The final node's result, and its text. */
  result?: ArtifactRef
  answer?: string
  nodes: NodeView[]
  /**
   * What the run waits for: a `gate`, the operator's approval of `plan` (`approve`); or a team's
   * `tie`, a deciding `vote` on `decision` (one of `options`) until `until`.
   */
  blocked?: { kind: 'gate'; nodeId: string; plan: ArtifactRef; until?: string } | { kind: 'tie'; nodeId: string; decision: ArtifactRef; options: Array<{ option: string; summary: string }>; until: string }
  error?: WorkflowError
  createdAt: string
  /** The run's last progress: its own last change or any node's, whichever is later. */
  updatedAt: string
}

export interface StartInput extends CallerOptions {
  template: string
  /** The caller's text: the prompt or the research question. */
  input: string
  classification?: Classification | undefined
  /** Retry-safe request key: the same key returns the same run. */
  clientRequestId?: string | undefined
}

export interface ExplainedDecision {
  id: ArtifactRef
  type: string
  outcome: string
  /** Reasons of the selected candidate. */
  reasons: string[]
  /** The result an acceptance decision judged (read it with `system artifact`). */
  result?: ArtifactRef
  /** A team vote's ballots, per round: who chose what, how sure, and why. */
  ballots?: Array<{ round: number; member: string; choice: string; confidence: string; rationale: string }>
}

export interface Explanation {
  runId: string
  template: string
  status: RunStatus
  specHash: ContentId
  nodes: Array<{ nodeId: string; state: NodeState; executionId?: string; worker?: string; quotaClass?: string; decisions: ExplainedDecision[] }>
}

export interface Config {
  /** Workflow templates by name, added to (or replacing) the built-in `ask` and `research`. */
  templates?: Record<string, NodeTemplate[]>
  /** Attempts per node for IMMEDIATE, BACKOFF, and RECREATE_SESSION failures (default 3). */
  maxAttempts?: number
  /** First back-off delay; doubles per attempt (default 5 s). */
  retryDelayMs?: number
  /** Unfinished runs that execute at once (default 16); more are refused (INV-9). A run waiting only on an approval or a vote is not one. */
  maxActiveRuns?: number
  /** Runs waiting only on an approval or a vote, beyond `maxActiveRuns` (default 16): with that many, new runs are refused (INV-9). */
  maxWaitingRuns?: number
  /** A finished run's input text and prompts are cleared after this many days (default 30); the run stays. */
  retainDays?: number
  /** Days a finished run is kept, then deleted with what only it needed; 0 keeps every run (default 0). */
  retainRunsDays?: number
  /**
   * When no Worker of another provider family (or, for a team member, another account) is
   * admitted, run on the same family instead of failing, recorded as a `same-family` decision
   * (ADR-0029). Off by default.
   */
  allowSameFamily?: boolean
  /** Approve a high-confidence plan by policy (`by: policy`) instead of waiting for the operator (default false). */
  autoApprovePlans?: boolean
  /** Reviews of one change, the first included, before remediation stops (default 3). */
  maxReviewCycles?: number
  /** Hours a tied team waits for a deciding `vote`, then completes `inconclusive` by rule (default 24; INV-9). */
  tieTimeoutHours?: number
  /** Hours a plan's gate waits for the operator's verdict, then closes and fails the run by rule (default 24; INV-9). */
  gateTimeoutHours?: number
  /** A review's repository reads: the hosts allowed (default github.com) and the bounds (40 files, 300 KB, 48 KB a file; INV-9). */
  repositories?: { hosts?: string[]; maxFiles?: number; maxBytes?: number; maxFileBytes?: number; maxSourceChars?: number }
}

export interface RunRow {
  run_id: string
  request_key: string | null
  template: string
  spec_hash: string
  input: string
  classification: Classification | null
  session_id: string | null
  status: RunStatus
  result: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface NodeRow {
  run_id: string
  node_id: string
  ordinal: number
  spec: string
  record: string
  state: NodeState
  prompt: string | null
  /** JSON `{ workspace, subject }` of a review bound to an exact subject. */
  subject?: string | null
  execution_id: string | null
  source: string | null
  attempt: number
  not_before: string | null
  worker: string | null
  served_tier: Tier | null
  quota_class: string | null
  /** The turn's egress, tier, and route (or admission) decisions, kept here because runs outlive turns. */
  decisions: string | null
  /** Rejected results retried at a higher tier so far. */
  escalations: number
  /** JSON array of the Workers this node failed over from, unsent (ADR-0034); its routes leave them out. */
  excluded?: string | null
  error: string | null
  updated_at: string
}

export interface NodeHelpers {
  dependsOnCompleted: (all: NodeRow[]) => boolean
}

export const LEASE_TTL_MS = 60_000
export const newId = (prefix: string): string => `${prefix}_${randomBytes(8).toString('hex')}`
export const now = (): string => new Date().toISOString()

/** A workflow-level refusal, typed like a turn failure. */
export class WorkflowFailure extends Error {
  readonly disposition: string
  constructor(readonly kind: 'invalid_input' | 'overloaded' | 'config_error', message: string) {
    super(message)
    this.name = 'WorkflowFailure'
    this.disposition = kind === 'overloaded' ? 'BACKOFF' : kind === 'config_error' ? 'CODE_FIX' : 'NONE'
  }
}

export function errorOf(error: unknown): WorkflowError {
  const typed = error as { kind?: unknown; disposition?: unknown; message?: unknown }
  if (typeof typed?.kind === 'string' && typeof typed.disposition === 'string') {
    return { kind: typed.kind, disposition: typed.disposition, message: String(typed.message ?? '') }
  }
  return { kind: 'internal', disposition: 'CODE_FIX', message: error instanceof Error ? error.message : String(error) }
}
