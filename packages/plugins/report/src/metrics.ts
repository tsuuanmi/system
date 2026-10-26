/**
 * The maturity metrics of PROP-0016 §1, computed (docs/design/maturity-metrics.md): pure functions
 * from what was read to the `metrics` tool's output (`schemas/mcp-report.v1.json`
 * `$defs/metrics-output`), over a rolling window (30 days by default). Each metric gives its value,
 * the sample it is over, and the records it read; one the records cannot give yet says so and why,
 * and has no value (never 0). A level is a reading, never a switch (PROP-0016 §1): nothing here
 * changes what System does.
 */
import type { ApprovalRequest } from '@tsuuanmi/system-approvals-core'
import type { BoardTask, Escape } from '@tsuuanmi/system-board-core'
import type { QuotaDraw } from '@tsuuanmi/system-libs'
import type { UsageRecord } from '@tsuuanmi/system-resources-core'
import { LIVENESS_EVENTS, type DecisionRead, type Period, type Recorded } from './report.ts'

/** The window the metrics read by default, and the one a level is read over (PROP-0016 §1). */
export const METRICS_DEFAULT_DAYS = 30
/** Finished tasks a level reading needs; fewer reads "too few" (PROP-0016 §1). */
export const LEVEL_MIN_TASKS = 30
/** The board's latest moves to ready one reading reads (the artifacts seam's bound per read). */
export const READY_MOVES_READ = 1000
/** Runs whose decisions one reading reads at most (INV-9): more refuses it. */
export const MAX_RUNS_READ = 2000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export type MetricId = 'traced-landings' | 'gate-coverage' | 'board-coverage' | 'lead-touches' | 'operator-decisions' | 'unattended-completion'
  | 'ready-to-landed' | 'stalls' | 'escaped-defects' | 'worker-availability' | 'cost-per-accepted-result' | 'quota-idle'

/** The order the metrics are listed in: PROP-0016 §1's table. */
export const METRIC_IDS: readonly MetricId[] = ['traced-landings', 'gate-coverage', 'board-coverage', 'lead-touches', 'operator-decisions', 'unattended-completion',
  'ready-to-landed', 'stalls', 'escaped-defects', 'worker-availability', 'cost-per-accepted-result', 'quota-idle']

/**
 * Where a metric stands against its L3 line: `meets` or `misses` it; `unproven` when its value is a
 * bound on the side of the line that does not settle it; `not-read` when there is no value.
 */
export type LineStatus = 'meets' | 'misses' | 'unproven' | 'not-read'

/** One metric over the window. */
export interface Metric {
  id: MetricId
  /** What it is, in words. */
  name: string
  /** `share` (0 to 1), `touches`, `per-day`, `hours`, `per-100-runs`, `per-100-landed`, or `tokens`. */
  unit: 'share' | 'touches' | 'per-day' | 'hours' | 'per-100-runs' | 'per-100-landed' | 'tokens'
  state: 'measured' | 'not-measurable'
  /** Present only when measured. */
  value?: number
  /** Other figures of the same reading (a 90th percentile, a part of a sum). */
  figures?: Record<string, number>
  /** How many items the value is over, and what they are. */
  sample?: number
  sampleOf?: string
  /** The value is a bound: the records miss some of what it counts (`reason` says what). */
  bound?: 'lower' | 'upper'
  /** Why it cannot be measured, or why its value is a bound. */
  reason?: string
  /** Cost per accepted result only: its usage and quota draws by kind of work (PROP-0016 §1, "by kind"). */
  byKind?: KindCost[]
  /** The records it read. */
  sources: string[]
  /** PROP-0016's L3 line for it (a starting line, D83), and where the value stands against it. */
  l3: { line: string; status: LineStatus }
}

/** The level reading against the L3 lines (PROP-0016 §1; D83: starting lines, revisited after 30 days of data). */
export interface LevelReading {
  /** `holds` only when every L3 line is met over at least 30 days and {@link LEVEL_MIN_TASKS} finished tasks. */
  l3: 'holds' | 'not-shown'
  finishedTasks: number
  minTasks: number
  days: number
  met: MetricId[]
  missed: MetricId[]
  unproven: MetricId[]
  notRead: MetricId[]
  reasons: string[]
}

/** The `metrics` tool's output (`$defs/metrics-output`). */
export interface Metrics {
  period: Period
  projectId?: string
  /** When the board and the queue were read; absent in a report's `maturity`, whose report says it once. */
  asOf?: string
  days: number
  metrics: Metric[]
  level: LevelReading
  notes: string[]
}

/** A decision made on a run by a person: the lead (a `client` decider) or the operator. */
export interface RunDecision { id: string; createdAt: string; deciderType: 'client' | 'operator'; decisionType: string; option: string }

/**
 * What the metrics read, already narrowed to their scope (one project, or every one): the tasks as
 * the board holds them now, the queue's requests, the ledger's records observed in the window, the
 * event-log entries (`workflow.run.started`, `workflow.task.reported`, and `workflow.task.landing`
 * whenever recorded; the liveness entries of the window), the decisions the tasks and reports name,
 * the decisions people made on the runs read, and when each task first became ready.
 */
export interface MetricSources {
  asOf: string
  tasks: BoardTask[]
  requests: ApprovalRequest[]
  usage: UsageRecord[]
  events: Recorded[]
  decisions: ReadonlyMap<string, DecisionRead>
  /** By workflow run id: the decisions a client (the lead) or the operator made on it. */
  runDecisions: ReadonlyMap<string, RunDecision[]>
  /**
   * By request id: the decision that resolved each request a verdict resolved, as read (ADR-0076).
   * Its decider says who gave the verdict: the operator, or a project's lead (`client`, `lead:<project>`).
   * A verdict not in it is attributed to the operator, as every verdict was before the lead principal.
   */
  verdictBy?: ReadonlyMap<string, DecisionRead>
  /** By task id: when a `board` decision first moved it to `ready`. */
  readyAt: ReadonlyMap<string, string>
  /**
   * When the board's moves to ready were read only from this time on (the latest {@link READY_MOVES_READ}
   * filled the read): a task created before it may have become ready earlier than the move read.
   */
  readyReadFrom?: string
  /** Runs of the window whose usage the ledger could not count (`usage.unknown`). */
  usageUnknown?: number
  /** What the agent runs of the window drew from their accounts' windows (`quota.draw`), each a valid `quota-draw@1.0`. */
  draws?: QuotaDraw[]
  /**
   * The escaped defects the operator or the lead recorded against auto-accepted results (the board's
   * `escapes`, D93), in scope; absent when the board records none (the metric is then not measurable).
   */
  escapes?: readonly Escape[]
  /** Runs read whose decisions may not all have been read (more than one read holds): their people's decisions are a lower bound. */
  truncatedRuns?: readonly string[]
  /** Why decisions people made on runs in the window may not all have been read, when they may not. */
  unreadDecisions?: string
  notes: string[]
}

/** One kind of work's share of the cost per accepted result (`byKind`): its usage and its quota draws, each over the accepted results. */
export interface KindCost {
  /** Absent: not known (a usage record no draw names a kind for, or a run admitted for no kind). */
  kind?: string
  /** Each absent when none of the kind's usage records carries it (not known, never 0). */
  tokens?: number
  costUsd?: number
  turns?: number
  usageRecords: number
  /** Per window: the clean draws' points over the accepted results (absent with no clean draw: not known), and the draws left out by state. */
  quota: Array<{ window: string; points?: number; cleanDraws: number; excluded: { confounded: number; 'reset-crossing': number; 'no-reading': number } }>
}

const ms = (at: string | undefined): number => (at === undefined ? Number.NaN : Date.parse(at))
const round = (value: number, places: number): number => {
  const f = 10 ** places
  return Math.round(value * f) / f
}
/** The nearest-rank percentile `q` of ascending `sorted`. */
const percentile = (sorted: readonly number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!
/** The median of ascending `sorted`: the mean of the two middle values for an even count. */
const median = (sorted: readonly number[]): number => {
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
const ascending = (values: number[]): number[] => [...values].sort((a, b) => a - b)

/** PROP-0016 §1's L3 lines (D83: starting lines), with the test of a value against each. */
const L3: Record<MetricId, { line: string; meets: (value: number) => boolean }> = {
  'traced-landings': { line: '≥ 98 %', meets: (v) => v >= 0.98 },
  'gate-coverage': { line: '100 %', meets: (v) => v >= 1 },
  'board-coverage': { line: '≥ 95 %', meets: (v) => v >= 0.95 },
  'lead-touches': { line: 'median ≤ 1', meets: (v) => v <= 1 },
  'operator-decisions': { line: '≤ 10 a day', meets: (v) => v <= 10 },
  'unattended-completion': { line: '≥ 50 %', meets: (v) => v >= 0.5 },
  'ready-to-landed': { line: 'median ≤ 1 working day (read as 24 h)', meets: (v) => v <= 24 },
  stalls: { line: '≤ 5 per 100 runs', meets: (v) => v <= 5 },
  'escaped-defects': { line: '≤ 5 per 100 landed', meets: (v) => v <= 5 },
  'worker-availability': { line: '≥ 95 %', meets: (v) => v >= 0.95 },
  'cost-per-accepted-result': { line: 'reported weekly', meets: () => true },
  'quota-idle': { line: '≤ 20 %', meets: (v) => v <= 0.2 },
}

/** Where a value stands against its line; a bound settles only a miss (a lower bound above an upper line, say). */
function statusOf(id: MetricId, value: number | undefined, bound: 'lower' | 'upper' | undefined): LineStatus {
  if (value === undefined) return 'not-read'
  const meets = L3[id].meets(value)
  // "Reported weekly" asks only that it be read: a bound on it still reports it.
  if (!bound || id === 'cost-per-accepted-result') return meets ? 'meets' : 'misses'
  // A bound that misses the line: the true value misses it too when the line is on the bound's far side.
  const higherIsBetter = L3[id].meets(Number.MAX_SAFE_INTEGER)
  const settlesMiss = (bound === 'lower' && !higherIsBetter) || (bound === 'upper' && higherIsBetter)
  return !meets && settlesMiss ? 'misses' : 'unproven'
}

type Draft = Omit<Metric, 'l3'>
const measured = (draft: Omit<Draft, 'state'>): Draft => ({ ...draft, state: 'measured' })
const unmeasurable = (id: MetricId, name: string, unit: Metric['unit'], reason: string, sources: string[]): Draft => ({ id, name, unit, state: 'not-measurable', reason, sources })

/** The metrics over `period` from `sources`, for `projectId` or every project. */
export function buildMetrics(period: Period, sources: MetricSources, projectId?: string): Metrics {
  const since = ms(period.since)
  const until = ms(period.until)
  const inWindow = (at: string | undefined): boolean => {
    const t = ms(at)
    return t >= since && t < until
  }
  const days = round((until - since) / DAY_MS, 2)
  const notes = [...sources.notes]
  const events = [...sources.events].sort((a, b) => a.seq - b.seq)
  const ofType = (type: string): Recorded[] => events.filter((e) => e.type === type)

  // Finished tasks: done, their accepting decision made in the window.
  const finished = sources.tasks.filter((t) => t.state === 'done' && t.result?.acceptance && inWindow(sources.decisions.get(t.result.acceptance)?.createdAt))
    .sort((a, b) => (a.taskId < b.taskId ? -1 : 1))

  // Nothing at or after the window's end counts: a later retry or decision never changes an earlier window's reading.
  const beforeEnd = (at: string | undefined): boolean => ms(at) < until

  // Each task's runs started before the window's end, as their started entries name them, and who started each.
  const started = ofType('workflow.run.started').filter((e) => beforeEnd(e.at))
  const runsOfTask = new Map<string, Array<{ runId: string; startedBy?: string }>>()
  for (const e of started) {
    const taskId = e.data?.['taskId']
    if (typeof taskId !== 'string' || !e.runId) continue
    const by = e.data?.['startedBy']
    const list = runsOfTask.get(taskId) ?? runsOfTask.set(taskId, []).get(taskId)!
    if (!list.some((r) => r.runId === e.runId)) list.push({ runId: e.runId, ...(typeof by === 'string' ? { startedBy: by } : {}) })
  }
  // A run reported before the window's end whose start the log does not hold (trimmed, or before the started entry named its task).
  const reported = ofType('workflow.task.reported').filter((e) => beforeEnd(e.at))
  for (const e of reported) {
    const taskId = e.data?.['taskId']
    if (typeof taskId !== 'string' || !e.runId) continue
    const list = runsOfTask.get(taskId) ?? runsOfTask.set(taskId, []).get(taskId)!
    if (!list.some((r) => r.runId === e.runId)) list.push({ runId: e.runId })
  }
  const truncated = new Set(sources.truncatedRuns ?? [])

  // The touches recorded on each finished task. A task with a run whose starter is not recorded, or whose
  // decisions were not all read, counts what is recorded: a lower bound of its own touches, so the median
  // over every finished task is still a lower bound of the true median.
  // Who gave a verdict in the queue (ADR-0076): a project's lead on its own token is a `client` decider; any other reading is the operator's.
  const verdictByLead = (requestId: string): boolean => sources.verdictBy?.get(requestId)?.deciderType === 'client'
  // `unmerged`: the same decisions but the lead's merge approvals, which unattended completion allows as it allows the operator's.
  const touches = new Map<string, { starts: number; decisions: number; unmerged: number; operatorStarted: boolean; partial: boolean }>()
  for (const task of finished) {
    const runs = runsOfTask.get(task.taskId) ?? []
    const starts = runs.filter((r) => r.startedBy === 'lead').length
    const ids = new Set<string>()
    const merges = new Set<string>()
    for (const r of runs) {
      for (const d of sources.runDecisions.get(r.runId) ?? []) if (d.deciderType === 'client' && ms(d.createdAt) >= ms(task.createdAt) && beforeEnd(d.createdAt)) ids.add(d.id)
    }
    // The lead's verdicts in the queue on this task's requests, and its acceptance of the task's result, are its touches too.
    const runIds = new Set(runs.map((r) => r.runId))
    for (const r of sources.requests) {
      if (r.resolution?.cause !== 'verdict' || !verdictByLead(r.requestId) || !beforeEnd(r.resolution.at) || ms(r.resolution.at) < ms(task.createdAt)) continue
      if (r.requester.taskId !== task.taskId && !(r.requester.runId !== undefined && runIds.has(r.requester.runId))) continue
      ids.add(`request:${r.requestId}`)
      if (r.action.class === 'merge') merges.add(`request:${r.requestId}`)
    }
    const accepting = task.result?.acceptance
    if (accepting !== undefined && sources.decisions.get(accepting)?.deciderType === 'client') ids.add(accepting)
    const partial = !runs.length || runs.some((r) => r.startedBy === undefined || truncated.has(r.runId))
    touches.set(task.taskId, { starts, decisions: ids.size, unmerged: ids.size - merges.size, operatorStarted: runs.some((r) => r.startedBy === 'operator'), partial })
  }
  const unattributed = [...touches.values()].filter((t) => t.partial).length
  const unattributedText = unattributed ? `; ${unattributed} finished task(s) count only the touches recorded: a run of theirs was started before its started entry named who started it, the log no longer holds its start, or its decisions were not all read` : ''
  const leadGap = 'the lead\'s moves on its own coordination board (salvage notes, retries by hand) and its messages to a session leave no System record yet, so the count misses them; what the lead decides on its own token (lead:<project>: verdicts in the queue, acceptances) is counted, and decisions it made on the operator\'s token before the lead principal are not told from the operator\'s'

  const drafts: Draft[] = []

  // Traced landings and gate coverage: what they divide by is not recorded.
  drafts.push(unmeasurable('traced-landings', 'Traced landings', 'share',
    'a change landed outside System leaves no System record: the share needs the repositories\' history beside the landing records (PROP-0016 I4, a later part)', ['workflow.task.landing']))
  drafts.push(unmeasurable('gate-coverage', 'Gate coverage', 'share',
    'a tool call the gate did not see leaves no record to count against its decisions: the share needs each runtime\'s own count of the calls it made (PROP-0016 I4, a later part)', ['the gate\'s autonomy decisions']))

  // Board coverage: the runs started in the window that serve a board task (every one does, with acceptance criteria).
  const startedInWindow = started.filter((e) => inWindow(e.at))
  if (projectId !== undefined) {
    drafts.push(unmeasurable('board-coverage', 'Board coverage', 'share', 'a run that serves no board task belongs to no project: read it for every project (no --project)', ['workflow.run.started']))
  } else if (!startedInWindow.length) {
    drafts.push(unmeasurable('board-coverage', 'Board coverage', 'share', 'no run started in the window', ['workflow.run.started']))
  } else {
    const bound = startedInWindow.filter((e) => typeof e.data?.['taskId'] === 'string').length
    drafts.push(measured({ id: 'board-coverage', name: 'Board coverage', unit: 'share', value: round(bound / startedInWindow.length, 4), figures: { bound }, sample: startedInWindow.length, sampleOf: 'runs started', sources: ['workflow.run.started'] }))
  }

  // Lead touches per finished task: the median.
  const touchSources = ['the board (done tasks)', 'acceptance decisions', 'workflow.run.started (startedBy)', 'decisions on the task\'s runs (client deciders)', 'approval requests (verdicts by a lead principal)']
  if (!finished.length) {
    drafts.push(unmeasurable('lead-touches', 'Lead touches per task', 'touches', 'no task finished in the window', touchSources))
  } else if (unattributed === finished.length) {
    drafts.push(unmeasurable('lead-touches', 'Lead touches per task', 'touches', `no finished task's runs all say who started them, with their decisions read (workflow.run.started names startedBy from PROP-0016 I4 on)${unattributedText}`, touchSources))
  } else {
    const all = [...touches.values()]
    const counts = ascending(all.map((t) => t.starts + t.decisions))
    drafts.push(measured({
      id: 'lead-touches', name: 'Lead touches per task', unit: 'touches', value: median(counts),
      figures: { p90: percentile(counts, 0.9), mean: round(counts.reduce((n, c) => n + c, 0) / counts.length, 2), starts: all.reduce((n, t) => n + t.starts, 0), decisions: all.reduce((n, t) => n + t.decisions, 0), unattributed },
      sample: touches.size, sampleOf: 'finished tasks', bound: 'lower', reason: `${leadGap}${unattributedText}`, sources: touchSources,
    }))
  }

  // Operator decisions per day: verdicts in the queue, acceptances, and decisions on runs, each once.
  const operatorIds = new Set<string>()
  // Only the operator principal's: a lead's verdict is a lead touch of its task, never an operator decision (ADR-0076).
  const verdicts = sources.requests.filter((r) => r.resolution?.cause === 'verdict' && inWindow(r.resolution.at) && !verdictByLead(r.requestId))
  for (const r of verdicts) operatorIds.add(`request:${r.requestId}`)
  let acceptances = 0
  for (const [id, d] of sources.decisions) {
    if (d.deciderType === 'operator' && inWindow(d.createdAt) && !operatorIds.has(id)) {
      operatorIds.add(id)
      acceptances += 1
    }
  }
  let onRuns = 0
  for (const list of sources.runDecisions.values()) {
    for (const d of list) {
      if (d.deciderType === 'operator' && inWindow(d.createdAt) && !operatorIds.has(d.id)) {
        operatorIds.add(d.id)
        onRuns += 1
      }
    }
  }
  const anyRecord = sources.tasks.length > 0 || sources.requests.length > 0 || events.length > 0 || sources.usage.length > 0 || sources.runDecisions.size > 0
  const operatorSources = ['approval requests (verdicts)', 'acceptance decisions', 'decisions on runs (operator deciders)']
  // Decisions not all read make the count a lower bound, said, never a silent miss.
  const unread = [truncated.size ? `${truncated.size} run(s) hold more decisions than one reading takes, so some of theirs may not have been read` : '', sources.unreadDecisions ?? ''].filter(Boolean)
  drafts.push(!anyRecord
    ? unmeasurable('operator-decisions', 'Operator decisions per day', 'per-day', 'nothing is recorded in the scope: no task, request, run, decision on a run, or usage', operatorSources)
    : measured({
      id: 'operator-decisions', name: 'Operator decisions per day', unit: 'per-day', value: round(operatorIds.size / days, 2),
      figures: { decisions: operatorIds.size, verdicts: verdicts.length, acceptances, onRuns }, sample: operatorIds.size, sampleOf: `decisions over ${days} day(s)`,
      ...(unread.length ? { bound: 'lower' as const, reason: `${unread.join('; ')}: the count is a lower bound` } : {}), sources: operatorSources,
    }))

  // Unattended completion: of every finished task, the share that went from ready to landed (a merged
  // landing before the window's end) with no touch known: no lead touch, no run the operator started, no
  // operator decision but the merge approval, before the window's end. A task whose touches are not all
  // recorded, or whose move to ready was not read, counts as unattended unless a touch is known, so the
  // share stays an upper bound.
  const landedAt = new Map<string, string>()
  for (const e of ofType('workflow.task.landing')) {
    const taskId = e.data?.['taskId']
    if (e.data?.['state'] === 'merged' && typeof taskId === 'string' && beforeEnd(e.at) && !landedAt.has(taskId)) landedAt.set(taskId, e.at)
  }
  const touchedByOperator = (task: BoardTask): boolean => {
    const runs = new Set((runsOfTask.get(task.taskId) ?? []).map((r) => r.runId))
    if (sources.requests.some((r) => r.resolution?.cause === 'verdict' && !verdictByLead(r.requestId) && beforeEnd(r.resolution.at) && r.action.class !== 'merge'
      && (r.requester.taskId === task.taskId || (r.requester.runId !== undefined && runs.has(r.requester.runId))))) return true
    if (sources.decisions.get(task.result!.acceptance!)?.deciderType === 'operator') return true
    for (const e of reported) {
      const d = e.decision ? sources.decisions.get(e.decision) : undefined
      if (e.data?.['taskId'] === task.taskId && d?.deciderType === 'operator' && beforeEnd(d.createdAt)) return true
    }
    for (const runId of runs) if ((sources.runDecisions.get(runId) ?? []).some((d) => d.deciderType === 'operator' && beforeEnd(d.createdAt))) return true
    return false
  }
  const unattendedSources = [...touchSources, 'workflow.task.landing (merged)', 'board decisions (to ready)', 'approval requests (verdicts other than merge)', 'decisions on the task\'s runs (operator deciders)']
  if (!finished.length) {
    drafts.push(unmeasurable('unattended-completion', 'Unattended completion', 'share', 'no task finished in the window', unattendedSources))
  } else {
    // A finished task with no merged landing before the window's end did not go from ready to landed:
    // never unattended. A landed one whose move to ready was not read still counts (the upper bound holds).
    const landed = finished.filter((t) => landedAt.has(t.taskId))
    let unknown = 0
    let readyNotRead = 0
    const untouched = landed.filter((task) => {
      const t = touches.get(task.taskId)!
      const known = t.starts + t.unmerged > 0 || t.operatorStarted || touchedByOperator(task)
      if (!known && t.partial) unknown += 1
      if (!known && !(sources.readyAt.has(task.taskId) && ms(sources.readyAt.get(task.taskId)) <= ms(landedAt.get(task.taskId)))) readyNotRead += 1
      return !known
    }).length
    const notLanded = finished.length - landed.length
    const caveats = [
      unknown ? `${unknown} count as unattended only because their touches are not all recorded` : '',
      readyNotRead ? `${readyNotRead} count as unattended though no move of theirs to ready was read` : '',
      notLanded ? `${notLanded} finished task(s) had no merged landing before the window's end: never unattended` : '',
    ].filter(Boolean)
    drafts.push(measured({
      id: 'unattended-completion', name: 'Unattended completion', unit: 'share', value: round(untouched / finished.length, 4),
      figures: { untouched, notAttributed: unknown, readyNotRead, finishedNotLanded: notLanded },
      sample: finished.length, sampleOf: 'finished tasks', bound: 'upper',
      reason: `over every risk tier (tiers are recorded from PROP-0016 I2 on); ${leadGap}${caveats.length ? `; ${caveats.join('; ')}` : ''}`, sources: unattendedSources,
    }))
  }

  // Time ready-to-landed: from a task's first move to ready to its result merged, for the merges of the window.
  const merged = ofType('workflow.task.landing').filter((e) => e.data?.['state'] === 'merged' && inWindow(e.at) && typeof e.data?.['taskId'] === 'string')
  // When the moves to ready were read only from `readyReadFrom` on, a task created before then may have
  // become ready earlier than the move read: its time is a lower bound, and so is the median.
  const readFrom = sources.readyReadFrom === undefined ? undefined : ms(sources.readyReadFrom)
  const createdAt = new Map(sources.tasks.map((t) => [t.taskId, t.createdAt]))
  const hours: number[] = []
  const landedTasks = new Set<string>()
  let noReady = 0
  let earlierReady = 0
  for (const e of merged) {
    const taskId = String(e.data!['taskId'])
    if (landedTasks.has(taskId)) continue
    landedTasks.add(taskId)
    const ready = sources.readyAt.get(taskId)
    if (ready === undefined || ms(ready) > ms(e.at)) {
      noReady += 1
      continue
    }
    const created = createdAt.get(taskId)
    if (readFrom !== undefined && (created === undefined || ms(created) < readFrom)) earlierReady += 1
    hours.push(round((ms(e.at) - ms(ready)) / HOUR_MS, 2))
  }
  const landingSources = ['workflow.task.landing (merged)', 'board decisions (to ready)']
  const noReadyText = noReady ? `; ${noReady} merged result(s) left out: no board decision moving their task to ready was read` : ''
  const earlierText = earlierReady
    ? `; the moves to ready were read from ${sources.readyReadFrom} on only (the latest ${READY_MOVES_READ}), so ${earlierReady} task(s) created before then may have become ready earlier: their times, and the median, are lower bounds`
    : ''
  if (!hours.length) {
    drafts.push(unmeasurable('ready-to-landed', 'Time ready-to-landed', 'hours', merged.length ? `no merged result's task has a move to ready read${noReadyText}` : 'no result was merged in the window', landingSources))
  } else {
    const sorted = ascending(hours)
    drafts.push(measured({
      id: 'ready-to-landed', name: 'Time ready-to-landed', unit: 'hours', value: round(median(sorted), 2), figures: { p90: percentile(sorted, 0.9), ...(earlierReady ? { earlierReady } : {}) },
      sample: sorted.length, sampleOf: 'results merged', ...(earlierReady ? { bound: 'lower' as const } : {}),
      reason: `over every risk tier: the light tier's line is read on all (tiers are recorded from PROP-0016 I2 on)${noReadyText}${earlierText}`, sources: landingSources,
    }))
  }

  // Stalls: workflow runs started in the window, and those with an agent run that stalled or ended unknown.
  const liveness = events.filter((e) => (e.type === LIVENESS_EVENTS[0] || e.type === LIVENESS_EVENTS[1]) && inWindow(e.at))
  const stalledRuns = new Set(liveness.map((e) => (e.runId ? `run:${e.runId}` : `agent:${String(e.data?.['agentRun'])}`)))
  const stallSources = ['workflow.run.started', LIVENESS_EVENTS[0], LIVENESS_EVENTS[1]]
  drafts.push(!startedInWindow.length
    ? unmeasurable('stalls', 'Stalls per 100 runs', 'per-100-runs', 'no run started in the window', stallSources)
    : measured({
      id: 'stalls', name: 'Stalls per 100 runs', unit: 'per-100-runs', value: round((stalledRuns.size / startedInWindow.length) * 100, 2),
      figures: { stalledOrHeld: stalledRuns.size }, sample: startedInWindow.length, sampleOf: 'runs started', sources: stallSources,
    }))

  // Escaped defects, Worker availability, quota idle: the records they need do not exist yet.
  const escapeSources = ['the board (recorded escapes of auto-accepted results)', 'workflow.task.landing (merged)']
  if (sources.escapes === undefined) {
    drafts.push(unmeasurable('escaped-defects', 'Escaped defects per 100 landed', 'per-100-landed',
      'the board records no escapes (no `escapes` read), and nothing else links a fix to the task whose landed change it fixes: a task\'s title naming another is not evidence of a defect', escapeSources))
  } else {
    // The escapes the operator or the lead recorded against auto-accepted results, found in the window: the count the
    // auto-accept circuit breaker trips on (board.autoAccept.breaker, default 2 in 7 days; read this over 7 days).
    const found = sources.escapes.filter((e) => inWindow(e.foundAt))
    const landed = landedTasks.size
    drafts.push(!landed
      ? unmeasurable('escaped-defects', 'Escaped defects per 100 landed', 'per-100-landed',
        `${found.length} escaped defect(s) of auto-accepted results were recorded in the window, and no result was merged in it to divide by`, escapeSources)
      : measured({
        id: 'escaped-defects', name: 'Escaped defects per 100 landed', unit: 'per-100-landed', value: round((found.length / landed) * 100, 2),
        figures: { escapes: found.length }, sample: landed, sampleOf: 'results merged',
        reason: 'only defects the operator or the lead recorded against auto-accepted results count: a defect in a result they accepted by hand is not recorded, so the value is a lower bound', bound: 'lower', sources: escapeSources,
      }))
  }
  drafts.push(unmeasurable('worker-availability', 'Worker availability', 'share',
    'when a Worker could not take work, and when it could again, is not recorded over time: the roster reads availability now only (PROP-0016 I3 and I4)', ['the roster (now only)']))
  drafts.push(measuredCost(sources.usage.filter((u) => inWindow(u.observedAt)), (sources.draws ?? []).filter((d) => inWindow(d.observedAt)), sources.usageUnknown ?? 0, finished.length))
  drafts.push(unmeasurable('quota-idle', 'Quota idle while work is ready', 'share',
    'an account\'s headroom is read when a run is routed and not recorded over time, so the hours with headroom above the reserve while a task waited ready cannot be counted (PROP-0016 I4, a later part)', ['quota readings (not kept)', 'board decisions (to ready)']))

  const metrics: Metric[] = METRIC_IDS.map((id) => {
    const draft = drafts.find((d) => d.id === id)!
    return { ...draft, l3: { line: L3[id].line, status: statusOf(id, draft.value, draft.bound) } }
  })
  return { period, ...(projectId !== undefined ? { projectId } : {}), asOf: sources.asOf, days, metrics, level: levelOf(metrics, finished.length, days), notes: notes.slice(0, 16) }
}

/** Kinds of work one cost reading lists at most (INV-9); the totals still count the rest, and the reason says how many. */
export const MAX_COST_KINDS = 32

/**
 * Cost per accepted result: the ledger's counted usage of the window, and the quota its agent runs drew
 * (`quota.draw`, clean draws only, in percentage points of each window), over the results accepted in
 * it; and the same by kind of work. A usage record's kind is the kind its run's draw names; a record
 * no draw names a kind for is listed under no kind (not known), as is a run admitted for none.
 */
function measuredCost(records: readonly UsageRecord[], draws: readonly QuotaDraw[], usageUnknown: number, accepted: number): Draft {
  const costSources = ['the resource ledger (usage records)', 'quota.draw', 'the board (done tasks)', 'acceptance decisions']
  if (!accepted) return unmeasurable('cost-per-accepted-result', 'Cost per accepted result', 'tokens', 'no result was accepted in the window: nothing to divide by', costSources)
  if (!records.length && !draws.length) return unmeasurable('cost-per-accepted-result', 'Cost per accepted result', 'tokens', 'the ledger counted no usage, and no run recorded a quota draw, in the window', costSources)
  // Each run's draw once, by its first record, sorted so the same records give the same reading.
  const ordered = [...draws].sort((a, b) => ms(a.observedAt) - ms(b.observedAt) || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
  const byRun = new Map<string, QuotaDraw>()
  for (const d of ordered) if (!byRun.has(d.runId)) byRun.set(d.runId, d)
  // Each component is summed over the records that carry it, and counted: one no record carries is not
  // known, and has no figure (never 0).
  type Sum = { sum: number; n: number }
  const sum = (): Sum => ({ sum: 0, n: 0 })
  const add = (s: Sum, value: number | undefined): void => {
    if (value === undefined) return
    s.sum += value
    s.n += 1
  }
  const kinds = new Map<string, { kind?: string; tokens: Sum; costUsd: Sum; turns: Sum; usageRecords: number; windows: Map<string, { points: number; cleanDraws: number; excluded: KindCost['quota'][number]['excluded'] }> }>()
  const kindOf = (kind: string | undefined) => {
    const key = kind ?? '\0'
    return kinds.get(key) ?? kinds.set(key, { ...(kind !== undefined ? { kind } : {}), tokens: sum(), costUsd: sum(), turns: sum(), usageRecords: 0, windows: new Map() }).get(key)!
  }
  const tokens = sum()
  const costUsd = sum()
  const turns = sum()
  let withoutKind = 0
  for (const u of records) {
    const draw = u.runId !== undefined ? byRun.get(u.runId) : undefined
    if (draw?.kind === undefined) withoutKind += 1
    const k = kindOf(draw?.kind)
    const t = u.usage ? (u.usage.inputTokens ?? 0) + (u.usage.outputTokens ?? 0) : undefined
    for (const [total, part, value] of [[tokens, k.tokens, t], [costUsd, k.costUsd, u.cost?.amount], [turns, k.turns, u.turns]] as const) {
      add(total, value)
      add(part, value)
    }
    k.usageRecords += 1
  }
  let points = 0
  let cleanDraws = 0
  let notClean = 0
  for (const d of byRun.values()) {
    const k = kindOf(d.kind)
    for (const entry of d.windows) {
      const w = k.windows.get(entry.window) ?? k.windows.set(entry.window, { points: 0, cleanDraws: 0, excluded: { confounded: 0, 'reset-crossing': 0, 'no-reading': 0 } }).get(entry.window)!
      if (entry.state === 'clean' && entry.draw !== undefined) {
        w.points += entry.draw
        w.cleanDraws += 1
        points += entry.draw
        cleanDraws += 1
      } else if (entry.state !== 'clean') {
        w.excluded[entry.state] += 1
        notClean += 1
      }
    }
  }
  const order = (a?: string, b?: string): number => (a === b ? 0 : a === undefined ? 1 : b === undefined ? -1 : a < b ? -1 : 1)
  const per = (s: Sum, places: number): number | undefined => (s.n ? round(s.sum / accepted, places) : undefined)
  const byKind: KindCost[] = [...kinds.values()].sort((a, b) => order(a.kind, b.kind)).slice(0, MAX_COST_KINDS).map((k) => {
    const [t, c, n] = [per(k.tokens, 2), per(k.costUsd, 6), per(k.turns, 2)]
    return {
      ...(k.kind !== undefined ? { kind: k.kind } : {}),
      ...(t !== undefined ? { tokens: t } : {}), ...(c !== undefined ? { costUsd: c } : {}), ...(n !== undefined ? { turns: n } : {}), usageRecords: k.usageRecords,
      quota: [...k.windows.entries()].sort(([a], [b]) => order(a, b)).slice(0, 64).map(([window, w]) => ({
        window, ...(w.cleanDraws ? { points: round(w.points / accepted, 3) } : {}), cleanDraws: w.cleanDraws, excluded: { ...w.excluded },
      })),
    }
  })
  // What is not known of each component, said: a part missing makes a figure count the others only; a component none carries has no figure.
  const part = (s: Sum, what: string, missing: string): string => (!records.length ? '' : !s.n ? `no usage record carries ${missing}: ${what} is not known` : s.n < records.length ? `${records.length - s.n} of ${records.length} usage record(s) carry no ${missing}: ${what} counts the others only` : '')
  const gaps = [
    !records.length ? 'the ledger counted no usage in the window: tokens, cost, and turns are not known' : '',
    part(tokens, 'tokens', 'token counts'), part(costUsd, 'cost', 'cost'), part(turns, 'turns', 'turn count'),
    usageUnknown ? `${usageUnknown} run(s) of the window had usage the ledger could not count: tokens, cost, and turns count the others only` : '',
    !draws.length ? 'no run recorded a quota draw in the window: the quota drawn is not known' : '',
    notClean ? `${notClean} window draw(s) are not clean (confounded, across a reset, or without a reading): their quota is not known and not counted` : '',
    draws.length && !cleanDraws ? 'no window draw is clean: the quota drawn is not known' : '',
    withoutKind ? `${withoutKind} usage record(s) have no kind known (no quota draw of their run names one): listed under no kind` : '',
    kinds.size > MAX_COST_KINDS ? `${kinds.size - MAX_COST_KINDS} more kind(s) not listed` : '',
  ].filter(Boolean)
  const [perTokens, perCost, perTurns] = [per(tokens, 2), per(costUsd, 6), per(turns, 2)]
  const figures: Record<string, number> = {
    ...(perCost !== undefined ? { costUsd: perCost } : {}), ...(perTurns !== undefined ? { turns: perTurns } : {}), usageRecords: records.length,
    ...(cleanDraws ? { quotaPoints: round(points / accepted, 3) } : {}), ...(draws.length ? { quotaDraws: byRun.size } : {}),
  }
  const reason = gaps.length ? gaps.join('; ') : undefined
  // The value is tokens per accepted result: with no record carrying token counts it is not known, and the
  // figures that are (quota drawn, cost, turns) stay.
  if (perTokens === undefined) {
    return { ...unmeasurable('cost-per-accepted-result', 'Cost per accepted result', 'tokens', reason!, costSources), figures, byKind }
  }
  const lower = tokens.n < records.length || usageUnknown > 0
  return measured({
    id: 'cost-per-accepted-result', name: 'Cost per accepted result', unit: 'tokens', value: perTokens, figures,
    sample: accepted, sampleOf: 'accepted results', ...(lower ? { bound: 'lower' as const } : {}), ...(reason ? { reason } : {}),
    byKind, sources: costSources,
  })
}

/** The reading against the L3 lines: it holds only when every line is met, over 30 days or more and enough finished tasks. */
function levelOf(metrics: Metric[], finishedTasks: number, days: number): LevelReading {
  const by = (status: LineStatus): MetricId[] => metrics.filter((m) => m.l3.status === status).map((m) => m.id)
  const met = by('meets')
  const missed = by('misses')
  const unproven = by('unproven')
  const notRead = by('not-read')
  const reasons: string[] = []
  if (days < METRICS_DEFAULT_DAYS) reasons.push(`the window is ${days} day(s): a level is read over ${METRICS_DEFAULT_DAYS}`)
  if (finishedTasks < LEVEL_MIN_TASKS) reasons.push(`too few: ${finishedTasks} finished task(s), a level needs ${LEVEL_MIN_TASKS}`)
  if (missed.length) reasons.push(`missed: ${missed.join(', ')}`)
  if (unproven.length) reasons.push(`not shown by a bound: ${unproven.join(', ')}`)
  if (notRead.length) reasons.push(`not measurable yet: ${notRead.join(', ')}`)
  return { l3: reasons.length ? 'not-shown' : 'holds', finishedTasks, minTasks: LEVEL_MIN_TASKS, days, met, missed, unproven, notRead, reasons }
}

/** A metric's value as a person reads it. */
export function metricValueText(m: Metric): string {
  if (m.value === undefined) return 'not measurable'
  const v = m.value
  const text = m.unit === 'share' ? `${round(v * 100, 2)} %` : m.unit === 'hours' ? `${v} h` : m.unit === 'per-day' ? `${v} a day` : m.unit === 'per-100-runs' || m.unit === 'per-100-landed' ? `${v} per 100` : `${v}`
  return `${m.bound === 'lower' ? 'at least ' : m.bound === 'upper' ? 'at most ' : ''}${text}`
}

/**
 * The metrics rendered for a terminal or a report section (`heading` `##`): one line per metric,
 * then the level reading; when they were read, if they say (a report's section does not).
 */
export function renderMetrics(m: Metrics, heading = '#'): string[] {
  const scope = m.projectId === undefined ? 'every project' : `project ${m.projectId}`
  const asOf = m.asOf !== undefined ? `, read as of ${m.asOf}` : ''
  const lines = [`${heading} Maturity metrics: ${scope}`, '', `${m.period.since} to ${m.period.until} (${m.days} days)${asOf}; against PROP-0016's L3 lines, starting lines (D83).`, '']
  for (const x of m.metrics) {
    const figures = x.figures ? ` (${Object.entries(x.figures).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''
    const sample = x.sample !== undefined ? `; over ${x.sample} ${x.sampleOf ?? ''}`.trimEnd() : ''
    lines.push(`- ${x.name}: ${metricValueText(x)}${figures}${sample}; L3 ${x.l3.line}: ${x.l3.status}.`)
    if (x.reason) lines.push(`  ${x.state === 'measured' ? 'Note' : 'Why'}: ${x.reason}.`)
    for (const k of x.byKind ?? []) {
      const quota = k.quota.map((q) => {
        const left = Object.entries(q.excluded).filter(([, n]) => n).map(([state, n]) => `${n} ${state}`)
        return `${q.window} ${q.points !== undefined ? `${q.points} points` : 'points not known'} (${q.cleanDraws} clean${left.length ? `; not known: ${left.join(', ')}` : ''})`
      })
      const known = (v: number | undefined, text: (n: number) => string, what: string): string => (v !== undefined ? text(v) : `${what} not known`)
      lines.push(`  ${k.kind ?? 'kind not known'}: ${known(k.tokens, (n) => `${n} tokens`, 'tokens')}, ${known(k.costUsd, (n) => `$${n}`, 'cost')}, ${known(k.turns, (n) => `${n} turns`, 'turns')} (${k.usageRecords} record(s)); quota: ${quota.length ? quota.join(', ') : 'no draw recorded'}.`)
    }
    lines.push(`  Read: ${x.sources.join(', ')}.`)
  }
  const l = m.level
  lines.push('', `L3: ${l.l3 === 'holds' ? 'holds' : 'not shown'} (${l.finishedTasks} finished task(s) over ${l.days} day(s); ${l.met.length} line(s) met).`)
  for (const r of l.reasons) lines.push(`- ${r}`)
  if (m.notes.length) lines.push('', ...m.notes.map((n) => `- ${n}`))
  return lines
}
