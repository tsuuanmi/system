/**
 * The baseline report, computed (docs/design/reports.md): pure functions from what was read to the
 * `report` tool's output (`schemas/mcp-report.v1.json` `$defs/report-output`). The same records
 * and period give the same report: everything is sorted before it is counted or summed, and no
 * model takes part.
 */
import type { ActionClass, ApprovalRequest } from '@tsuuanmi/system-approvals-core'
import type { BoardTask, Project, TaskState } from '@tsuuanmi/system-board-core'
import type { UsageUnknown } from '@tsuuanmi/system-libs'
import type { UsageRecord } from '@tsuuanmi/system-resources-core'

export const TASK_STATES: readonly TaskState[] = ['proposed', 'ready', 'claimed', 'running', 'review', 'waiting-for-input', 'waiting-for-approval', 'done', 'cancelled']
/** Projects one report lists (`mcp-report@1` bounds it); the rest are counted. */
export const MAX_PROJECTS = 100
/** Pools one report lists (`mcp-report@1`), as many as the ledger configures at once. */
export const MAX_POOLS = 64
/** The longest period one report covers (INV-9). */
export const MAX_DAYS = 366
export const DEFAULT_DAYS = 7
const DAY_MS = 86_400_000

/** A period from `since` (inclusive) to `until` (exclusive). */
export interface Period { since: string; until: string }

/** The `report` tool's input (`$defs/report-input`). */
export interface ReportInput { projectId?: string; since?: string; until?: string; days?: number }

/** Why a report was refused. Nothing was read. */
export class ReportError extends Error {
  constructor(readonly failure: 'invalid' | 'unknown-project' | 'unavailable' | 'overloaded', message: string) {
    super(message)
    this.name = 'ReportError'
  }
}

/** The period an input names: `until` (default `now`), and `since`, or the `days` (default 7) before `until`. */
export function periodOf(input: ReportInput, now: Date): Period {
  if (input.since !== undefined && input.days !== undefined) throw new ReportError('invalid', 'name the period by since or by days, not both')
  const until = input.until === undefined ? now.getTime() : Date.parse(input.until)
  const since = input.since === undefined ? until - (input.days ?? DEFAULT_DAYS) * DAY_MS : Date.parse(input.since)
  if (Number.isNaN(until) || Number.isNaN(since)) throw new ReportError('invalid', 'since and until are times (ISO 8601)')
  if (since >= until) throw new ReportError('invalid', `the period is empty: since ${new Date(since).toISOString()} is not before until ${new Date(until).toISOString()}`)
  if (until - since > MAX_DAYS * DAY_MS) throw new ReportError('invalid', `a report covers at most ${MAX_DAYS} days`)
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() }
}

/** An event-log entry as the report reads it. */
export interface Recorded { seq: number; at: string; type: string; runId?: string; decision?: string; data?: Record<string, unknown> }

/** A decision the report reads: who made it, when, and what it decided. */
export interface DecisionRead { createdAt: string; decisionType: string; deciderType: string; deciderId: string; option: string; checks?: Record<string, boolean> }

/** A settled digest request as its provider holds it. */
export interface DigestRead { kept?: number; dropped?: number; escalated: boolean }

/**
 * A `usage.unknown` entry as the report reads it: when it was recorded, the workflow run it names,
 * its record, and whether the ledger has counted a record of its run in its pool since (reconciled).
 */
export interface UnknownRead { at: string; runId?: string; fact: UsageUnknown; reconciled: boolean }

/**
 * What the report reads, already narrowed to its scope (one project, or every one): projects and
 * their tasks as the board holds them now, the queue's requests, the ledger's records observed in
 * the period, and the event-log entries of the period by type; the decisions those name, and the
 * digest requests the task results' digests settled.
 */
export interface Sources {
  asOf: string
  projects: Project[]
  tasks: BoardTask[]
  requests: ApprovalRequest[]
  usage: UsageRecord[]
  /** `workflow.task.reported`, `workflow.task.digest`, `workflow.graph.grown`, `workflow.gate.opened`, `workflow.gate.closed`, `approvals.batched`, and {@link LIVENESS_EVENTS}. */
  events: Recorded[]
  decisions: ReadonlyMap<string, DecisionRead>
  /** By request id; absent when no digest provider is loaded. */
  digests?: ReadonlyMap<string, DigestRead>
  /** The runs whose usage the ledger could not count (`usage.unknown`), recorded in the period; none when absent. */
  unknowns?: UnknownRead[]
  /** What could not be counted, found while reading. */
  notes: string[]
}

/**
 * What a project's report counts beyond the records that name the project: its tasks, and the runs
 * that served them, the executions those runs started (an agent Worker's run id), and the runs that
 * digested their results. With no project, every record counts (the studio report).
 */
export interface Scope { projectId?: string; tasks: ReadonlySet<string>; runs: ReadonlySet<string> }

/** The runs that served a task of the scope: each attempt's reported run, and each task's current one. */
export function runsOf(tasks: readonly BoardTask[], reported: readonly Recorded[]): Set<string> {
  const ids = new Set(tasks.map((t) => t.taskId))
  const runs = new Set<string>()
  for (const event of reported) if (event.runId && ids.has(String(event.data?.['taskId']))) runs.add(event.runId)
  for (const task of tasks) if (task.run) runs.add(task.run.runId)
  return runs
}

/** Whether a record, request, or event belongs to the scope. */
export const within = {
  request: (scope: Scope, r: ApprovalRequest): boolean => scope.projectId === undefined || r.requester.projectId === scope.projectId
    || (r.requester.taskId !== undefined && scope.tasks.has(r.requester.taskId)) || (r.requester.runId !== undefined && scope.runs.has(r.requester.runId)),
  usage: (scope: Scope, u: UsageRecord): boolean => scope.projectId === undefined || u.projectId === scope.projectId
    || (u.taskId !== undefined && scope.tasks.has(u.taskId)) || (u.runId !== undefined && scope.runs.has(u.runId)),
  /** A run whose usage is unknown, as its record would be scoped, or by the workflow run its entry names. */
  unknown: (scope: Scope, u: Pick<UnknownRead, 'runId' | 'fact'>): boolean => scope.projectId === undefined || u.fact.projectId === scope.projectId
    || (u.fact.taskId !== undefined && scope.tasks.has(u.fact.taskId)) || scope.runs.has(u.fact.runId) || (u.runId !== undefined && scope.runs.has(u.runId)),
  /** A task's event by its task; a run's by its run; a batch by the scope's requests it holds. */
  event: (scope: Scope, e: Recorded, requests: ReadonlySet<string>): boolean => {
    if (scope.projectId === undefined) return true
    if (e.type === 'approvals.batched') return Array.isArray(e.data?.['requests']) && (e.data['requests'] as unknown[]).some((id) => requests.has(String(id)))
    if (typeof e.data?.['taskId'] === 'string') return scope.tasks.has(e.data['taskId'])
    return e.runId !== undefined && scope.runs.has(e.runId)
  },
}

type Counts = Record<TaskState, number>
/**
 * Counted usage, and what a cap counts as 0 (D25), each only when there is any: records without
 * token counts, a cost, or turns, and the runs whose usage the ledger could not count and has not
 * counted since (`unknownRuns`).
 */
interface UsageTotals {
  records: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; turns: number; costUsd: number
  withoutTokens?: number; withoutCost?: number; withoutTurns?: number; unknownRuns?: number
}
/** The runs of the period whose usage the ledger could not count: each once, by the kind of its first entry, and those it has counted a record of since. */
interface UnknownUsage { runs: number; reconciled: number; notReported: number; interrupted: number; refused: number; failed: number }
interface ClassCounts { actionClass: ActionClass; asked: number; approved: number; rejected: number; expired: number; withdrawn: number }
interface Day { date: string; interruptions: number; batches: number; over?: true }
interface Attention { maxBatchesPerDay?: number; maxInterruptionsPerDay?: number }
/** The agent runs whose liveness asked for the operator in the period (PROP-0013), and those still held at its end. */
interface LivenessAttention { stalled: number; unknown: number; freed: number; held: Array<{ agentRun: string; worker: string; at: string; runId?: string }>; heldOmitted?: number }
/** A review held for the operator as the report is made (`mcp-report@1.3`): its task, project, and when it expires unseen. */
interface HeldReview { taskId: string; projectId: string; title: string; expiresAt: string; pendingChecks: string[] }

/** The event-log entries of an agent run's liveness the report counts (PROP-0013). */
export const LIVENESS_EVENTS = ['agent-workers.run.stalled', 'agent-workers.run.unknown', 'agent-workers.run.freed'] as const
/** Held runs, and held reviews, one report lists (`mcp-report@1.2`, `@1.3`); the rest are counted. */
export const MAX_HELD = 64

/** The `report` tool's output (`$defs/report-output`). */
export interface Report {
  period: Period
  projectId?: string
  asOf: string
  projects: Array<{ projectId: string; title: string; state: Project['state']; charterVersion: number; milestones: Array<{ id: string; title: string; state: string }>; attention?: Attention; tasks: Counts }>
  projectsOmitted?: number
  tasks: { now: Counts; created: number; done: number; doneByOperator: number; cancelled: number }
  attempts: { reported: number; accepted: number; rejected: number; heldForOperator: number; reconciled: number; other: number; review: { passed: number; failed: number; none: number } }
  remediation: { cycles: number; fixesOpened: number; fixesClosed: number }
  approvals: { asked: number; approved: number; rejected: number; expired: number; withdrawn: number; openNow: number; byClass: ClassCounts[]; wait?: { answered: number; medianSeconds: number; p90Seconds: number; maxSeconds: number } }
  /** `reviewsHeld` (1.3): the reviews held for the operator as the report is made, the soonest to expire first; only when there are any. */
  attention: { interruptions: number; batches: number; days: Day[]; threshold?: Attention; daysOver?: number; liveness?: LivenessAttention; reviewsHeld?: HeldReview[]; reviewsHeldOmitted?: number }
  usage: { total: UsageTotals; pools: Array<UsageTotals & { pool: string }>; byOutcome: { completed: number; failed: number; aborted: number; unknown: number }; unknown?: UnknownUsage }
  digests: { attached: number; bypassed: number; claimsKept?: number; claimsDropped?: number; escalated?: number }
  baseline: { acceptedResults: number; interruptions: number; attempts: number; perAcceptedResult?: { tokens: number; costUsd: number; turns: number; interruptions: number; attempts: number } }
  notes: string[]
}

const round = (value: number, places: number): number => {
  const f = 10 ** places
  return Math.round(value * f) / f
}
const ms = (at: string | undefined): number => (at === undefined ? Number.NaN : Date.parse(at))
const dateOf = (at: string): string => new Date(ms(at)).toISOString().slice(0, 10)
const byKey = <T>(key: (t: T) => string) => (a: T, b: T): number => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
const counts = (tasks: readonly BoardTask[]): Counts => {
  const out = Object.fromEntries(TASK_STATES.map((s) => [s, 0])) as Counts
  for (const task of tasks) out[task.state] += 1
  return out
}
const emptyUsage = (): UsageTotals => ({ records: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, turns: 0, costUsd: 0 })
/** The report's name of each kind of unknown usage (`usage-unknown@1.0`). */
const KINDS = { 'not-reported': 'notReported', interrupted: 'interrupted', refused: 'refused', failed: 'failed' } as const satisfies Record<UsageUnknown['kind'], keyof UnknownUsage>
/** The nearest-rank percentile `q` of ascending `sorted`. */
const percentile = (sorted: readonly number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!

/** The report on `sources` over `period`. */
export function buildReport(period: Period, sources: Sources, projectId?: string): Report {
  const since = ms(period.since)
  const until = ms(period.until)
  const inPeriod = (at: string | undefined): boolean => {
    const t = ms(at)
    return t >= since && t < until
  }
  const notes = [...sources.notes]
  const events = [...sources.events].filter((e) => inPeriod(e.at)).sort((a, b) => a.seq - b.seq)
  const ofType = (type: string): Recorded[] => events.filter((e) => e.type === type)

  // Projects, by id; tasks per state now.
  const projects = [...sources.projects].sort(byKey((p) => p.projectId))
  const listed = projects.slice(0, MAX_PROJECTS).map((p) => {
    const attention = p.charter.budget.attention
    return {
      projectId: p.projectId, title: p.title, state: p.state, charterVersion: p.charter.version,
      milestones: p.milestones.map((m) => ({ id: m.id, title: m.title, state: m.state })),
      ...(attention && (attention.maxBatchesPerDay !== undefined || attention.maxInterruptionsPerDay !== undefined) ? { attention: { ...attention } } : {}),
      tasks: counts(sources.tasks.filter((t) => t.projectId === p.projectId)),
    }
  })

  // Tasks: proposed, done (their accepting decision made in the period), cancelled.
  let done = 0
  let doneByOperator = 0
  for (const task of sources.tasks) {
    if (task.state !== 'done' || !task.result?.acceptance) continue
    const decision = sources.decisions.get(task.result.acceptance)
    if (!decision || !inPeriod(decision.createdAt)) continue
    done += 1
    if (decision.deciderType === 'operator') doneByOperator += 1
  }
  const tasks = {
    now: counts(sources.tasks), created: sources.tasks.filter((t) => inPeriod(t.createdAt)).length, done, doneByOperator,
    cancelled: sources.tasks.filter((t) => t.state === 'cancelled' && inPeriod(t.cancellation?.at)).length,
  }

  // Attempts: each run's outcome as it reached its task, and the review its acceptance reports.
  const reported = ofType('workflow.task.reported')
  // A run reported with reconcileRun is classed by where it left its task: done (accepted), held for the operator, or not.
  const status = (e: Recorded): string => {
    const s = String(e.data?.['status'])
    return s !== 'reconciled' ? s : e.data?.['state'] === 'done' ? 'accepted' : e.data?.['state'] === 'review' ? 'review' : s
  }
  const review = { passed: 0, failed: 0, none: 0 }
  for (const event of reported) {
    const decision = event.decision ? sources.decisions.get(event.decision) : undefined
    const passed = decision?.decisionType === 'acceptance' ? decision.checks?.['review'] : undefined
    review[passed === true ? 'passed' : passed === false ? 'failed' : 'none'] += 1
  }
  const attempts = {
    reported: reported.length,
    accepted: reported.filter((e) => status(e) === 'accepted').length,
    rejected: reported.filter((e) => status(e) === 'rejected').length,
    heldForOperator: reported.filter((e) => status(e) === 'review').length,
    reconciled: reported.filter((e) => status(e) === 'reconciled').length,
    other: reported.filter((e) => !['accepted', 'rejected', 'review', 'reconciled'].includes(status(e))).length,
    review,
  }

  // Remediation: the cycles grown, and the fixes the queue opened or closed.
  const remediation = {
    cycles: ofType('workflow.graph.grown').filter((e) => typeof e.data?.['cycle'] === 'number').length,
    fixesOpened: ofType('workflow.gate.opened').filter((e) => e.data?.['by'] === 'queue').length,
    fixesClosed: ofType('workflow.gate.closed').filter((e) => e.data?.['by'] === 'queue').length,
  }

  // Approvals: asked in the period; resolved in it, by cause; the waits for the operator's verdicts.
  const requests = [...sources.requests].sort(byKey((r) => r.requestId))
  const asked = requests.filter((r) => inPeriod(r.createdAt))
  const resolved = requests.filter((r) => r.resolution && inPeriod(r.resolution.at))
  const verdicts = resolved.filter((r) => r.resolution!.cause === 'verdict')
  const outcome = (r: ApprovalRequest): 'approved' | 'rejected' | 'expired' | 'withdrawn' =>
    r.resolution!.cause === 'verdict' ? (r.state === 'approved' ? 'approved' : 'rejected') : r.resolution!.cause
  const classes = new Map<ActionClass, ClassCounts>()
  const classOf = (c: ActionClass): ClassCounts => classes.get(c) ?? classes.set(c, { actionClass: c, asked: 0, approved: 0, rejected: 0, expired: 0, withdrawn: 0 }).get(c)!
  for (const r of asked) classOf(r.action.class).asked += 1
  for (const r of resolved) classOf(r.action.class)[outcome(r)] += 1
  const waits = verdicts.map((r) => Math.max(0, Math.round((ms(r.resolution!.at) - ms(r.createdAt)) / 1000))).sort((a, b) => a - b)
  const approvals = {
    asked: asked.length,
    approved: resolved.filter((r) => outcome(r) === 'approved').length,
    rejected: resolved.filter((r) => outcome(r) === 'rejected').length,
    expired: resolved.filter((r) => outcome(r) === 'expired').length,
    withdrawn: resolved.filter((r) => outcome(r) === 'withdrawn').length,
    openNow: requests.filter((r) => r.state === 'open' || r.state === 'batched').length,
    byClass: [...classes.values()].sort(byKey((c) => c.actionClass)),
    ...(waits.length ? { wait: { answered: waits.length, medianSeconds: percentile(waits, 0.5), p90Seconds: percentile(waits, 0.9), maxSeconds: waits.at(-1)! } } : {}),
  }

  // Attention, per UTC day: what asked for the operator (requests, reviews held for the operator), and the batches shown.
  const days = new Map<string, Day>()
  const dayOf = (at: string): Day => days.get(dateOf(at)) ?? days.set(dateOf(at), { date: dateOf(at), interruptions: 0, batches: 0 }).get(dateOf(at))!
  for (const r of asked) dayOf(r.createdAt).interruptions += 1
  for (const e of reported) if (status(e) === 'review') dayOf(e.at).interruptions += 1
  for (const e of ofType('approvals.batched')) dayOf(e.at).batches += 1
  for (const r of verdicts) if (!r.batchId) dayOf(r.resolution!.at).batches += 1
  const project = projectId === undefined ? undefined : sources.projects.find((p) => p.projectId === projectId)
  const threshold = project?.charter.budget.attention
  const limits = threshold && (threshold.maxBatchesPerDay !== undefined || threshold.maxInterruptionsPerDay !== undefined) ? { ...threshold } : undefined
  const ordered = [...days.values()].sort(byKey((d) => d.date)).map((d): Day => {
    const over = limits && ((limits.maxInterruptionsPerDay !== undefined && d.interruptions > limits.maxInterruptionsPerDay) || (limits.maxBatchesPerDay !== undefined && d.batches > limits.maxBatchesPerDay))
    return over ? { ...d, over: true } : d
  })
  // Agent runs whose liveness asked for the operator (PROP-0013): stalls, runs that ended unknown, and
  // those the operator freed; a run that ended unknown and was not freed in the period is still held.
  // Shown beside the interruptions, never counted as one: the baseline's figure keeps its meaning.
  const stalls = ofType(LIVENESS_EVENTS[0])
  const unknowns = ofType(LIVENESS_EVENTS[1])
  const frees = ofType(LIVENESS_EVENTS[2])
  const freedRuns = new Set(frees.map((e) => String(e.data?.['agentRun'])))
  const heldAll = [...new Map(unknowns.filter((e) => !freedRuns.has(String(e.data?.['agentRun']))).map((e) => [String(e.data?.['agentRun']), e])).values()].reverse()
  const liveness: LivenessAttention | undefined = stalls.length || unknowns.length || frees.length ? {
    stalled: stalls.length, unknown: unknowns.length, freed: new Set(frees.filter((e) => e.data?.['again'] !== true).map((e) => String(e.data?.['agentRun']))).size,
    held: heldAll.slice(0, MAX_HELD).map((e) => ({ agentRun: String(e.data?.['agentRun']), worker: String(e.data?.['worker']), at: e.at, ...(e.runId !== undefined ? { runId: e.runId } : {}) })),
    ...(heldAll.length > MAX_HELD ? { heldOmitted: heldAll.length - MAX_HELD } : {}),
  } : undefined
  // The reviews held for the operator now: each expires unseen at its time, and its task then waits for input (T99 D6).
  const heldReviews = sources.tasks.filter((t) => t.state === 'review' && t.waiting?.reason === 'operator-review')
    .map((t): HeldReview => ({ taskId: t.taskId, projectId: t.projectId, title: t.title, expiresAt: t.waiting!.expiresAt, pendingChecks: [...(t.waiting!.pendingChecks ?? [])] }))
    .sort((a, b) => ms(a.expiresAt) - ms(b.expiresAt) || byKey<HeldReview>((r) => r.taskId)(a, b))
  const attention = {
    interruptions: ordered.reduce((n, d) => n + d.interruptions, 0), batches: ordered.reduce((n, d) => n + d.batches, 0), days: ordered,
    ...(limits ? { threshold: limits, daysOver: ordered.filter((d) => d.over).length } : {}),
    ...(liveness ? { liveness } : {}),
    ...(heldReviews.length ? { reviewsHeld: heldReviews.slice(0, MAX_HELD), ...(heldReviews.length > MAX_HELD ? { reviewsHeldOmitted: heldReviews.length - MAX_HELD } : {}) } : {}),
  }

  // Usage: the ledger's counted records observed in the period, per pool, summed in one order.
  const records = sources.usage.filter((u) => inPeriod(u.observedAt))
    .sort((a, b) => ms(a.observedAt) - ms(b.observedAt) || byKey<UsageRecord>((u) => `${u.source}\0${u.requestId}`)(a, b))
  const total = emptyUsage()
  const pools = new Map<string, UsageTotals & { pool: string }>()
  const byOutcome = { completed: 0, failed: 0, aborted: 0, unknown: 0 }
  const poolOf = (id: string): UsageTotals & { pool: string } => pools.get(id) ?? pools.set(id, { pool: id, ...emptyUsage() }).get(id)!
  /** A cap counts what a record or run does not carry as 0 (D25): counted where there is any. */
  const missing = (sums: UsageTotals[], key: 'withoutTokens' | 'withoutCost' | 'withoutTurns' | 'unknownRuns'): void => {
    for (const sum of sums) sum[key] = (sum[key] ?? 0) + 1
  }
  for (const u of records) {
    const pool = poolOf(u.pool)
    for (const sum of [total, pool]) {
      sum.records += 1
      sum.inputTokens += u.usage?.inputTokens ?? 0
      sum.outputTokens += u.usage?.outputTokens ?? 0
      sum.cacheReadInputTokens += u.usage?.cacheReadInputTokens ?? 0
      sum.cacheCreationInputTokens += u.usage?.cacheCreationInputTokens ?? 0
      sum.turns += u.turns ?? 0
      sum.costUsd += u.cost?.amount ?? 0
    }
    byOutcome[u.outcome ?? 'unknown'] += 1
    if (!u.usage) missing([total, pool], 'withoutTokens')
    if (!u.cost) missing([total, pool], 'withoutCost')
    if (u.turns === undefined) missing([total, pool], 'withoutTurns')
  }
  // Runs whose usage the ledger could not count, recorded in the period: each once per pool, by its
  // first entry; one the ledger has counted a record of since is reconciled.
  const facts = (sources.unknowns ?? []).filter((u) => inPeriod(u.at))
    .sort((a, b) => ms(a.at) - ms(b.at) || byKey<UnknownRead>((u) => `${u.fact.pool}\0${u.fact.runId}\0${u.fact.kind}`)(a, b))
  const seen = new Set<string>()
  let unknown: UnknownUsage | undefined
  for (const u of facts) {
    const key = `${u.fact.pool}\0${u.fact.runId}`
    if (seen.has(key)) continue
    seen.add(key)
    unknown ??= { runs: 0, reconciled: 0, notReported: 0, interrupted: 0, refused: 0, failed: 0 }
    unknown.runs += 1
    unknown[KINDS[u.fact.kind]] += 1
    if (u.reconciled) unknown.reconciled += 1
    else missing([total, poolOf(u.fact.pool)], 'unknownRuns')
  }
  if (pools.size > MAX_POOLS) throw new ReportError('overloaded', `the period's records name ${pools.size} pools, more than ${MAX_POOLS}: report a shorter period`)
  for (const sum of [total, ...pools.values()]) sum.costUsd = round(sum.costUsd, 6)
  if (total.withoutTokens) notes.push(`${total.withoutTokens} usage record(s) carry no token counts (the runtime reported none): tokens count the others only`)
  if (total.withoutCost) notes.push(`${total.withoutCost} usage record(s) carry no cost (the runtime reported none): cost counts the others only`)
  if (total.withoutTurns) notes.push(`${total.withoutTurns} usage record(s) carry no turn count: turns count the others only`)
  if (total.unknownRuns && unknown) {
    const kinds = (Object.entries(KINDS) as Array<[UsageUnknown['kind'], keyof UnknownUsage]>).filter(([, key]) => unknown[key]).map(([kind, key]) => `${unknown[key]} ${kind}`).join(', ')
    notes.push(`${total.unknownRuns} run(s) whose usage the ledger could not count, and has not counted since: no figure counts them, and a cap counts them as 0 `
      + `(${unknown.runs} recorded in the period: ${kinds}${unknown.reconciled ? `, ${unknown.reconciled} of them counted since` : ''}; system events --type usage.unknown)`)
  }

  // Digests of task results: attached or bypassed, and how the attached ones fared.
  const settled = ofType('workflow.task.digest')
  const attached = settled.filter((e) => e.data?.['state'] === 'attached')
  let digestDetail: { claimsKept: number; claimsDropped: number; escalated: number } | undefined
  if (sources.digests) {
    digestDetail = { claimsKept: 0, claimsDropped: 0, escalated: 0 }
    for (const e of attached) {
      const view = typeof e.data?.['requestId'] === 'string' ? sources.digests.get(e.data['requestId']) : undefined
      if (!view) continue
      digestDetail.claimsKept += view.kept ?? 0
      digestDetail.claimsDropped += view.dropped ?? 0
      if (view.escalated) digestDetail.escalated += 1
    }
  }
  const digests = { attached: attached.length, bypassed: settled.filter((e) => e.data?.['state'] === 'bypassed').length, ...digestDetail }

  // The baseline: accepted results, what asked for the operator, and what each accepted result cost.
  const accepted = tasks.done
  const baseline = {
    acceptedResults: accepted, interruptions: attention.interruptions, attempts: attempts.reported,
    ...(accepted ? {
      perAcceptedResult: {
        tokens: round((total.inputTokens + total.outputTokens) / accepted, 2), costUsd: round(total.costUsd / accepted, 6), turns: round(total.turns / accepted, 2),
        interruptions: round(attention.interruptions / accepted, 2), attempts: round(attempts.reported / accepted, 2),
      },
    } : {}),
  }

  return {
    period, ...(projectId !== undefined ? { projectId } : {}), asOf: sources.asOf,
    projects: listed, ...(projects.length > MAX_PROJECTS ? { projectsOmitted: projects.length - MAX_PROJECTS } : {}),
    tasks, attempts, remediation, approvals, attention,
    usage: { total, pools: [...pools.values()].sort(byKey((p) => p.pool)), byOutcome, ...(unknown ? { unknown } : {}) },
    digests, baseline, notes: notes.slice(0, 16),
  }
}
