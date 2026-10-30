/**
 * The web UI API's response bodies as the page reads them: one definition, imported by the server (`src/index.ts`, which checks
 * what it sends against it) and by the client (`client/`), each with `import type` from `./api.js` (a declaration file, so the
 * client's build emits nothing of it). A part that can fail to read is `Known<T>`: its value, or why it is unknown (INV-2).
 */
export type Known<T> = { value: T } | { unknown: string }

export interface Subject { type: string; ref: string; version?: string }
export interface Requester { component: string; runId?: string; sessionId?: string; nodeId?: string; taskId?: string; projectId?: string; policyChangeId?: string }
export interface ApprovalRequest {
  requestId: string
  subject: Subject
  action: { class: string; summary: string; consequences?: string; recommendation?: string }
  requester: Requester
  expiresAt: string
}
export interface Batch { batchId?: string; requests: ApprovalRequest[] }
export interface ApprovalsResponse { batches: Batch[] }
export interface VerdictBody { requestId: string; subject: Subject; verdict: 'approved' | 'rejected'; note?: string }
export interface DecideResult { requestId: string; refused?: string; approval?: string }
export interface DecideResponse { results: DecideResult[] }

export interface PolicyRule { actionClass: string; mode: string; requires?: string[]; expiresSeconds?: number }
export interface PolicyRecord {
  schema?: string; id: string; version: number; scope: string; projectId?: string; narrows?: string
  rules?: PolicyRule[]; default?: string; commands?: string[]
  expiry: { defaultSeconds?: number; maxSeconds?: number }
  batch?: { maxSize?: number; maxWaitSeconds?: number }
}
export interface PolicyChange {
  changeId: string; requestId: string; state: string; policy: PolicyRecord; previous?: PolicyRecord; note?: string
  hash: string; baseHash: string; proposedAt?: string; declined?: { cause: string }
  applied?: { at: string }; retired?: { at: string }
  effect: Array<{ projectId?: string; actionClass: string; from: string; to: string }>
  origin?: { shape: { command: string }; approved: number; windowSeconds: number; decision: string }
}
export interface PolicyResponse {
  set?: { source: string; changeId?: string; hash: string; configHash?: string }
  policies: PolicyRecord[]
  effective: Array<{ projectId?: string; effective: Array<{ actionClass: string; mode: string }> }>
  changes?: PolicyChange[]
  proposals?: boolean
  alwaysAsk?: string[]
}
export interface ProposeResponse { change: PolicyChange; request: { requestId: string } }

export interface Landing {
  state: string; requestId?: string; base?: string; commit?: string; head?: string; branch?: string; reason?: string
  acceptedBy?: { label: string }; approvedBy?: { label: string }
}
export interface RunLanding extends Omit<Landing, 'base'> { base?: { branch: string; sha?: string } }
export interface ReviewCheck { check: string; state: string; exitCode?: number; notRun?: string; why?: string }
export interface ReviewCard {
  taskId: string; title: string; goal?: string; actionClass: string; subject: Subject; artifacts: string[]
  project: { projectId: string; title?: string }; run?: { runId: string }; expiresAt?: string; heldFor?: string
  pendingChecks: string[]; checks?: { value: ReviewCheck[]; requiredUnknown?: string }
  /** Why the board holds it for the operator, from its hold decision (T330); absent when not held, or on an older hold. */
  holdReason?: string
  /** A result whose review expired, still within its wait for input (T350): `heldFor` is `expired`, this is when it expired and `expiresAt` when that wait ends. */
  expiredAt?: string
}
export interface AcceptedCard { taskId: string; title: string; project: { projectId: string; title?: string }; run?: { runId: string }; landing: Landing }
export interface ReviewsResponse { reviews: ReviewCard[]; accepted?: AcceptedCard[]; /** Results whose review expired and can still be reopened (T350); none for a lead. */ expired?: ReviewCard[] }
export interface ReviewDecideResponse { task: { state: string }; decision: string }
export interface ReviewReopenResponse { task: { state: string; waiting?: { pendingChecks: string[] } }; decision: string }

export interface FileChange { path: string; status: string; from?: string; binary?: boolean; note?: string; added?: number; removed?: number; diff?: string; truncated?: boolean }
export interface BranchChange { branch: string; base: { branch: string; sha: string }; fromBranch?: boolean; workspace: string; files: FileChange[]; more: number }
export interface WorkChange { changes: BranchChange[]; unread: Array<{ source: string; detail: string }> }
export interface Finding {
  severity: string; title: string; file?: string; line?: number; class?: string; repeated?: string; demoted?: boolean
  evidence?: string; detail?: string; verification?: { vote: string; node: string; reason?: string }
}
export interface Assessment { verdict: string; nodeId?: string; reviewer?: string; summary?: string; findings: Finding[] }
export interface RunReview {
  runId: string
  change: Known<WorkChange>
  assessments: Known<Assessment[]> & { more?: number; moreAtLeast?: boolean }
  report?: { nodeId: string; text: string; truncated?: boolean }
  landing?: Landing
}

export interface Failure { kind?: string; disposition?: string; message: string }
export interface RunNode { nodeId: string; state: string; worker?: string; attempt: number; tier?: string; minTier: string; model?: string; error?: Failure }
export interface RunBlocked {
  kind: string; nodeId: string; until?: string; approvalRequest?: string; plan?: string; decision?: string
  options?: Array<{ option: string; summary: string }>
}
export interface RunSummary {
  runId: string; template: string; status: string; createdAt: string; updatedAt: string
  blocked?: RunBlocked; error?: Failure; task?: { taskId: string }; nodes: RunNode[]
}
export interface RunsResponse { runs: RunSummary[] }
export interface Decision { id: string; type: string; outcome: string; reasons: string[]; at?: string }
export interface Handbook {
  tokens: number; bound: { tokens: number; mode: string }; selection: { role: string; tier: string }
  layers: Array<{ layer: number; renderedBy: string; atMost?: boolean; tokens: number; version: string; parts: string[] }>
  source?: Array<{ part: string; tokens: number; version: string; lessons?: number }>
}
export interface Explain {
  nodes: Array<{ nodeId: string; decisions: Decision[]; handbook?: Handbook }>
  risk?: { tier: string; reasons: string[]; decision: string }
  stalledChecks?: Array<{ check: string; command: string; quietSince: string; since: string; stallSeconds: number }>
  landing?: { position?: number; length: number; key: string; holder?: { taskId: string }; batch?: { index: number; size: number; limit: number } }
  webCalls?: { count: number; auto: number; asked: number; denied: number; calls: Array<{ at: string; tool: string; target: string; verdict: string; reason?: string; egress: string }> }
}
export interface StepTiming { startedAt: string; endedAt?: string }
export interface RunDetail extends RunSummary {
  answer?: string; specHash: string; sessionId?: string
  task?: { taskId: string; carry?: Carry; landing?: RunLanding }
}
export interface Carry { state: string; from?: { attempt: number; runId: string }; commit?: string; reason?: string }
export interface RunDetailResponse { run: RunDetail; explain?: Explain; timings?: Known<Record<string, StepTiming>> }
export interface LiveRun {
  runId: string
  steps: Array<{ nodeId: string; worker?: string; since?: string; attempt: number }>
  lastEvent: Known<{ type: string; at: string }>
  stalled: Known<{ since: string } | null>
}
export interface LiveResponse { asOf: string; runs: Known<LiveRun[]> & { more?: boolean } }

export interface TaskCard {
  taskId: string; title: string; state: string; actionClass: string; template?: string; createdAt: string; updatedAt?: string
  attempts: { count: number; max: number }; run?: { runId: string; startedAt?: string }
  waiting?: { reason: string; expiresAt: string; since?: string; approvalRequest?: string }; landing?: Landing
}
export interface ProjectCard {
  projectId: string; title: string; state: string; revision: number; charter: { version: number; intent?: unknown }; amendment?: number
  closure?: { outcome: string }; open: Record<string, number>; more?: Record<string, number>; tasks?: TaskCard[]
  autoAcceptBreakers?: Array<{ branch: string; escapes: Array<{ taskId: string }>; line: { escapes: number; days: number }; now?: { lineHolds?: boolean } }>
}
export interface ProjectsResponse { projects: ProjectCard[] }
export interface ProjectMoveResponse { project: { state: string }; decision: string }
export interface StartStep {
  objective: string; source?: boolean; tier: string; capabilities: string[]; kind?: string; plans?: boolean; team?: { members: number }
  workers?: { free: string[]; busy: string[] } | { unknown: string }
}
export interface StartPreview { task: { revision: number; template: string; attempts: { count: number; max: number } }; steps: StartStep[] }
export interface StartResponse { run: { runId: string }; pending?: { runId: string; reason: string } }

export interface WaitingResponse {
  asOf: string; since?: string; count: number; partial?: boolean
  runs: Known<RunSummary[]> & { more?: boolean }
  requests: Known<number>
  reviews: Known<number> & { firstExpires?: string }
}
export interface ActivityResponse {
  since: string; asOf: string
  runs: Known<Array<{ at: string; runId: string; taskId?: string; template: string; status: string; error?: string; failure?: Partial<Failure> }>> & { more?: boolean }
  tasks: Known<Array<{ at: string; taskId: string; title: string; state: string; project: { projectId: string; title: string }; landing?: Landing; waiting?: { reason: string; approvalRequest?: string }; run?: { runId: string } }>> & { more?: boolean }
  expired: Known<Array<{ at: string; requestId: string; summary?: string }>> & { more?: boolean }
}

export interface DispatchWindow { window: string; seconds?: number; used?: number; reserve: number; resets?: string; observedAt?: string }
export interface DispatchResponse {
  enabled: boolean; paused?: { since: string; reason?: string }; pausedProjects?: Array<{ projectId?: string; since: string; reason?: string }>
  asks: Array<{ state: string; requestId?: string; title: string; attempt: number; worker: string; projectId: string; why: string; windows: DispatchWindow[] }>
  lastPass?: { at: string; reason?: string; more?: number; tasks: Array<{ title: string; reason: string }> }
  started?: Array<{ taskId: string; runId: string; title: string; attempt: number; startedAt: string; runStatus: string; worker: string; mode: string }>
}
export interface DailyResponse {
  enabled: boolean; ref: string; hourUtc: number; lastGreen?: { commit: string; day: string }
  last?: { state: string; ref: string; commit: string; startedAt: string; problem?: string; taskId?: string; duplicate?: boolean }
}
export interface LeadResponse {
  project: string
  unread: Array<{ title: string; at: string; text: string; act: string[] }>
  digests: Array<{ at: string; text: string }>
  stats: { handled: number; waitMs: { median?: number }; touches: { median?: number } }
}

export interface Pool {
  pool: string; available: boolean; until?: string
  windows: Array<{ id: string; seconds?: number; state: string; observedAt?: string; used: Known<number>; resets: Known<string> }>
  unknownUsage?: Known<{ runs: number }>
}
export interface AccountInfo {
  id: string; limitUntil?: string
  record: Known<{ kind: string; status: string; slot?: number; quarantine?: { reason: string; detail?: string }; sameAs?: string[] }>
}
export interface WorkItem { runId: string; nodeId: string; template: string; summary: string; startedBy?: string; since: Known<string>; task?: { board: Known<{ title: string; projectId: string }> } }
export interface Live { state: string; summary: string; runId?: string; execution: string }
export type Availability =
  | { state: 'busy'; summary: string; slots?: number; running?: number }
  | { state: 'ready'; summary: string }
  | { state: 'resting'; summary: string; until: Known<string> }
  | { state: 'unavailable'; summary: string; reason: Known<string> }
  | { state: 'quarantined'; summary: string; reason: string; detail?: string; since: string }
export interface RosterWorker {
  worker: string; name: string; description?: Known<string>; availability: Availability
  account: Known<AccountInfo>; pools: Known<Pool[]>; work: Known<{ items: WorkItem[]; more?: number; unread?: string }>
  liveness?: Known<Live[]>; limits: Array<{ capability: string; until: string }>; teams?: Known<{ summary: string }>
  derived: string; tier: string; quotaClass: string; locality: string; provider: string
  family: Known<string>; role: Known<string | null>; load: Known<{ running: number; slots: number; queued: number; pending: number }>
}
export interface NowList<T> { value: { items: T[]; more?: number; unread?: string } }
export type NowRows<T> = NowList<T> | { unknown: string }
export interface Quota { left: number; seconds?: number; window: string; headroom?: number; resetsAt?: string }
export interface RosterNow {
  free: NowRows<{ worker: string; name: string; quota: Quota | null }>
  quotaUnknown: NowRows<{ name: string; why: string }>
  stalled: NowRows<{ name: string; runId?: string }>
  noQuota: NowRows<{ name: string; until: Known<string> }>
  cannotWork: NowRows<{ name: string; reason: string }>
  ready: NowRows<{ title: string; likely: Known<{ name: string } | null> }>
}
export interface RosterResponse {
  asOf: string
  counts: Record<string, number>
  unlisted?: number
  workers: Known<RosterWorker[]>
  sources: Known<Array<{ source: string; state: string; at: string; detail?: string | undefined; describing?: boolean | undefined }>>
  now?: RosterNow
}
