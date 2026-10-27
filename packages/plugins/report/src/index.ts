/**
 * The baseline report (PROP-0010 B8; PROP-0008's baseline and investor report;
 * docs/design/reports.md): what the recorded data says about a period, for one project or every
 * one. It reads the board, the approval queue, and the resource ledger through their definitions,
 * the event log, and the decisions those name; it writes nothing and decides nothing, and no model
 * takes part. The MCP tool `report` (client scope) answers with the report and its rendering;
 * `system report` prints it, by default over the last 7 days: the weekly investor report.
 * @module @tsuuanmi/system-report
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalRequest } from '@tsuuanmi/system-approvals-core'
import type { Envelope } from '@tsuuanmi/system-ledger-core'
import type { BoardTask, Project } from '@tsuuanmi/system-board-core'
import type { Digests } from '@tsuuanmi/system-digest-core'
import { type ToolSpec, WORKER_AVAILABLE_EVENT, WORKER_UNAVAILABLE_EVENT } from '@tsuuanmi/system-gateway-core'
import { ADVICE_EVENT, ADVICE_OUTCOME_EVENT, countedWhole, QUOTA_DRAW_EVENT, type QuotaDraw, quotaDrawOf, reconciledBy, SchemaRegistry, USAGE_UNKNOWN_EVENT, usageUnknownOf } from '@tsuuanmi/system-libs'
import { ResourcesError, type UsageRecord } from '@tsuuanmi/system-resources-core'
import { z as zod } from 'zod'
import { buildMetrics, MAX_RUNS_READ, READY_MOVES_READ, METRICS_DEFAULT_DAYS, type Metrics, renderMetrics, type RunDecision } from './metrics.ts'
import { renderReport } from './render.ts'
import { buildReport, type DecisionRead, type DigestRead, type DrawRead, LIVENESS_EVENTS, MAX_DAYS, periodOf, type Recorded, type Report, ReportError, type ReportInput, runsOf, type Scope, type UnknownRead, within } from './report.ts'

export { buildMetrics, METRIC_IDS, type Metric, type MetricId, type Metrics, type MetricSources, renderMetrics, type RunDecision } from './metrics.ts'
export { duration, renderReport, whole } from './render.ts'
export { buildReport, type DecisionRead, type DrawRead, MAX_PROJECTS, periodOf, type Period, type Recorded, type Report, ReportError, type ReportInput, runsOf, type Sources, type UnknownRead, within } from './report.ts'

export const name = 'report'
export const inject = ['artifacts', 'eventLog']

/** Event-log entries one report reads per query at most (INV-9): more refuses the report, never truncates it. */
const MAX_EVENTS = 100_000
const PAGE = 1000
/** The entries a report counts in its period, beside the task reports and digests it reads whole. */
const PERIOD_EVENTS = ['workflow.graph.grown', 'workflow.gate.opened', 'workflow.gate.closed', 'approvals.batched', ADVICE_EVENT, ADVICE_OUTCOME_EVENT, ...LIVENESS_EVENTS] as const
const STATES: ApprovalRequest['state'][] = ['open', 'batched', 'approved', 'rejected']

const schemas = new SchemaRegistry()

/** Every entry of the event log that matches, in order, at most {@link MAX_EVENTS}. */
function readEvents(ctx: Context, filter: { type: string; runId?: string; since?: string }): Recorded[] {
  const out: Recorded[] = []
  let afterSeq = 0
  for (;;) {
    const page = ctx.eventLog.query({ ...filter, afterSeq, limit: PAGE })
    for (const e of page) {
      out.push({ seq: e.seq, at: e.at, type: e.type, ...(e.runId !== undefined ? { runId: e.runId } : {}), ...(e.decision !== undefined ? { decision: e.decision } : {}), ...(e.data !== undefined ? { data: e.data } : {}) })
    }
    if (out.length > MAX_EVENTS) throw new ReportError('overloaded', `more than ${MAX_EVENTS} ${filter.type} entries to read${filter.since ? ': report a shorter period' : ', past what one report reads'}`)
    if (page.length < PAGE) return out
    afterSeq = page.at(-1)!.seq
  }
}

/** A decision as the report reads it, or undefined when it is not stored here. */
function decisionOf(ctx: Context, id: string): DecisionRead | undefined {
  const envelope = ctx.artifacts.get(id)
  if (envelope?.kind !== 'decision') return undefined
  const body = envelope.body as { decisionType: string; decider: { type: string; id: string; version?: string }; outcome: { option: string; detail?: Record<string, unknown> } }
  const checks = body.outcome.detail?.['checks']
  return {
    createdAt: envelope.createdAt, decisionType: body.decisionType, deciderType: body.decider.type, deciderId: body.decider.id, ...(typeof body.decider.version === 'string' ? { deciderVersion: body.decider.version } : {}), option: body.outcome.option,
    ...(checks && typeof checks === 'object' && !Array.isArray(checks) ? { checks: checks as Record<string, boolean> } : {}),
  }
}

/**
 * The runs that wrote a digest request's answers: the agent runs whose results its settling decision
 * and its escalation took as inputs (an agent result names its run). The ledger counts their usage
 * by those run ids. Undefined when the provider loaded does not know the request: another provider
 * settled it, before its row was swapped for this one.
 */
async function digestRuns(ctx: Context, digests: Digests, requestId: string): Promise<string[] | undefined> {
  const view = await digests.get(requestId)
  if (!view) return undefined
  const runs: string[] = []
  for (const decision of [view.decision, view.escalation]) {
    const inputs = decision ? (ctx.artifacts.get(decision)?.body as { inputs?: string[] } | undefined)?.inputs ?? [] : []
    for (const input of inputs) {
      if (view.sources.includes(input as never)) continue
      const body = ctx.artifacts.get(input)?.body as { schema?: string; runId?: unknown } | undefined
      if (body?.schema?.startsWith('agent-result@') && typeof body.runId === 'string') runs.push(body.runId)
    }
  }
  return runs
}

/**
 * The report on `input`, read now: the period, the projects in scope and their tasks, and then
 * every record of the scope. Refused, reading nothing more, when the board, the queue, or the ledger
 * is not loaded (a report without one of them would be silently wrong, INV-2), for an unknown
 * project, or for more records than its bounds.
 */
async function report(ctx: Context, input: ReportInput, now: Date = new Date()): Promise<Report> {
  const period = periodOf(input, now)
  const board = ctx.get('board')
  const approvals = ctx.get('approvals')
  const resources = ctx.get('resources')
  const missing = [board ? '' : 'the board', approvals ? '' : 'the approval queue', resources ? '' : 'the resource ledger'].filter(Boolean)
  if (!board || !approvals || !resources) throw new ReportError('unavailable', `${missing.join(', ')} not loaded: a report reads the board, the approval queue, and the resource ledger, so none is made`)
  const asOf = new Date().toISOString()
  const { projectId } = input
  let projects: Project[]
  if (projectId === undefined) {
    projects = await board.projects()
  } else {
    const project = await board.project(projectId)
    if (!project) throw new ReportError('unknown-project', `no project ${projectId} on the board`)
    projects = [project]
  }
  const tasks: BoardTask[] = []
  for (const p of projects) tasks.push(...await board.tasks({ projectId: p.projectId }))

  // A project's scope: its tasks, the runs that served them, the executions those runs started, and
  // the runs that digested their results. Every entry of these two types is read, whenever it was
  // made: a run that served the project may have consumed within the period and reported after it.
  const notes: string[] = []
  const digestsSeam = ctx.get('digests')
  const reportedAll = readEvents(ctx, { type: 'workflow.task.reported' })
  const digestedAll = readEvents(ctx, { type: 'workflow.task.digest' })
  const taskIds = new Set(tasks.map((t) => t.taskId))
  const runs = projectId === undefined ? new Set<string>() : runsOf(tasks, reportedAll)
  if (projectId !== undefined) {
    // The runs themselves only: the executions added here start no further reads.
    for (const runId of Array.from(runs)) {
      for (const e of readEvents(ctx, { type: 'workflow.node.started', runId })) if (typeof e.data?.['executionId'] === 'string') runs.add(e.data['executionId'])
    }
    const digested = digestedAll.filter((e) => taskIds.has(String(e.data?.['taskId'])) && typeof e.data?.['requestId'] === 'string')
    if (digestsSeam) {
      let unknown = 0
      for (const e of digested) {
        const served = await digestRuns(ctx, digestsSeam, String(e.data!['requestId']))
        if (!served) unknown += 1
        for (const runId of served ?? []) runs.add(runId)
      }
      if (unknown) notes.push(`${unknown} digest request(s) of the project's results are unknown to the digest provider loaded (another provider settled them before its row was swapped): the runs that served them are not counted in its usage`)
    } else if (digested.length) {
      notes.push('no digest provider is loaded: the runs that digested the project\'s results are not counted in its usage')
    }
  }
  const scope: Scope = { ...(projectId !== undefined ? { projectId } : {}), tasks: taskIds, runs }

  const requests = (await approvals.list({ states: STATES })).filter((r) => within.request(scope, r))
  const ids = new Set(requests.map((r) => r.requestId))
  let usage: UsageRecord[]
  try {
    usage = (await resources.usage({ since: period.since, until: period.until })).records.filter((u) => within.usage(scope, u))
  } catch (error) {
    if (error instanceof ResourcesError) throw new ReportError('overloaded', `the resource ledger refused the period's records (${error.message}): report a shorter period`)
    throw error
  }
  // The runs whose usage the ledger could not count (D25), recorded in the period, and whether it
  // has counted a record of each in its pool since. An entry that is not a valid record is not counted.
  const until = Date.parse(period.until)
  const unknowns: UnknownRead[] = []
  const reconciled = new Map<string, boolean>()
  let invalid = 0
  for (const e of readEvents(ctx, { type: USAGE_UNKNOWN_EVENT, since: period.since })) {
    if (Date.parse(e.at) >= until) continue
    const fact = usageUnknownOf(e.data)
    if (!fact) {
      invalid += 1
      continue
    }
    if (!within.unknown(scope, { ...(e.runId !== undefined ? { runId: e.runId } : {}), fact })) continue
    const key = `${fact.pool}\0${fact.runId}`
    if (!reconciled.has(key)) reconciled.set(key, countedWhole((await resources.usage({ runId: fact.runId, pool: fact.pool })).records))
    // A lower bound (`partial`, on its record or its fact) never reconciles a run (INV-2).
    unknowns.push({ at: e.at, ...(e.runId !== undefined ? { runId: e.runId } : {}), fact, reconciled: reconciledBy(fact, reconciled.get(key)!) })
  }
  if (invalid) notes.push(`${invalid} ${USAGE_UNKNOWN_EVENT} entr${invalid === 1 ? 'y is' : 'ies are'} not a valid usage-unknown@1.0 record: not counted`)
  // What the agent runs that ended in the period drew from their accounts' windows (PROP-0015 E2).
  // An entry that is not a valid record is not counted, and said.
  const draws: DrawRead[] = []
  let invalidDraws = 0
  for (const e of readEvents(ctx, { type: QUOTA_DRAW_EVENT, since: period.since })) {
    if (Date.parse(e.at) >= until) continue
    const record = quotaDrawOf(e.data)
    if (!record) invalidDraws += 1
    else if (within.draw(scope, { ...(e.runId !== undefined ? { runId: e.runId } : {}), record })) draws.push({ at: e.at, record })
  }
  if (invalidDraws) notes.push(`${invalidDraws} ${QUOTA_DRAW_EVENT} entr${invalidDraws === 1 ? 'y is' : 'ies are'} not a valid quota-draw@1.0 record: not counted`)
  const since = Date.parse(period.since)
  const events = [
    ...[...reportedAll, ...digestedAll].filter((e) => Date.parse(e.at) >= since),
    ...PERIOD_EVENTS.flatMap((type) => readEvents(ctx, { type, since: period.since })),
  ].filter((e) => within.event(scope, e, ids))

  // The decisions the counts rest on: each done task's acceptance, and each reported attempt's.
  const decisions = new Map<string, DecisionRead>()
  for (const id of [...tasks.map((t) => t.result?.acceptance), ...events.map((e) => (e.type === 'workflow.task.reported' ? e.decision : undefined))]) {
    if (id === undefined || decisions.has(id)) continue
    const read = decisionOf(ctx, id)
    if (read) decisions.set(id, read)
  }

  let digests: Map<string, DigestRead> | undefined
  const attached = events.filter((e) => e.type === 'workflow.task.digest' && e.data?.['state'] === 'attached' && typeof e.data?.['requestId'] === 'string')
  if (digestsSeam) {
    digests = new Map()
    let unknown = 0
    for (const e of attached) {
      const view = await digestsSeam.get(String(e.data!['requestId']))
      if (view) digests.set(view.requestId, { ...(view.claims ? { kept: view.claims.kept, dropped: view.claims.dropped } : {}), escalated: view.escalation !== undefined })
      else unknown += 1
    }
    if (unknown) notes.push(`${unknown} digest(s) attached in the period are unknown to the digest provider loaded (another provider settled them before its row was swapped): their claims are not counted`)
  } else if (attached.length) {
    notes.push('no digest provider is loaded: the claims of the digests attached are not counted')
  }
  // The dispatch advisor's probabilities each recorded outcome is scored against (PROP-0015 J1): its
  // choice's advice decision, by question id. A decision not stored here scores nothing.
  const advice = new Map<string, Record<string, number>>()
  for (const e of events) {
    const ref = e.type === ADVICE_OUTCOME_EVENT ? e.data?.['advice'] : undefined
    if (typeof ref !== 'string' || advice.has(ref)) continue
    const body = ctx.artifacts.get(ref)?.body as { outcome?: { option?: string }; modelAnswers?: Array<{ questionId?: unknown; probability?: unknown }> } | undefined
    if (body?.outcome?.option !== 'advice') continue
    advice.set(ref, Object.fromEntries((body.modelAnswers ?? []).filter((m) => typeof m.questionId === 'string' && typeof m.probability === 'number').map((m) => [m.questionId as string, m.probability as number])))
  }
  // An event log trimmed by retention holds nothing before its first entry.
  const [first] = ctx.eventLog.query({ limit: 1 })
  if (first && first.seq > 1 && Date.parse(first.at) > since) notes.push(`the event log keeps entries from ${first.at} on (retention): attempts, remediation, batches, and digests before then are not counted`)

  const made = buildReport(period, { asOf, projects, tasks, requests, usage, events, decisions, ...(digests ? { digests } : {}), unknowns, draws, advice, notes }, projectId)
  // The maturity metrics over the 30 days to the report's end, and the L3 reading (PROP-0016 I4).
  // One the bounds refuse leaves the report whole, and says so.
  try {
    // Without its own asOf: the report's says when it was read, and two reports of one period differ in that only.
    const { asOf: _read, ...maturity } = await metrics(ctx, { ...(projectId !== undefined ? { projectId } : {}), until: period.until })
    return { ...made, maturity }
  } catch (error) {
    if (!(error instanceof ReportError)) throw error
    return { ...made, notes: [...made.notes, `the maturity metrics were not read: ${error.message}`.slice(0, 500)].slice(0, 16) }
  }
}

/** The `metrics` tool's input (`$defs/metrics-input`): one project or every one, and the window as the days before until. */
interface MetricsInput { projectId?: string; days?: number; until?: string }

/**
 * The maturity metrics on `input`, read now (docs/design/maturity-metrics.md): the window (30 days
 * by default) to `until`, the projects in scope and their tasks, and every record the metrics read.
 * Refused, as a report is, when the board, the queue, or the ledger is not loaded, for an unknown
 * project, or for more records than its bounds.
 */
async function metrics(ctx: Context, input: MetricsInput, now: Date = new Date()): Promise<Metrics> {
  const period = periodOf({ days: input.days ?? METRICS_DEFAULT_DAYS, ...(input.until !== undefined ? { until: input.until } : {}) }, now)
  const board = ctx.get('board')
  const approvals = ctx.get('approvals')
  const resources = ctx.get('resources')
  const missing = [board ? '' : 'the board', approvals ? '' : 'the approval queue', resources ? '' : 'the resource ledger'].filter(Boolean)
  if (!board || !approvals || !resources) throw new ReportError('unavailable', `${missing.join(', ')} not loaded: the metrics read the board, the approval queue, and the resource ledger, so none is read`)
  const asOf = new Date().toISOString()
  const { projectId } = input
  let projects: Project[]
  if (projectId === undefined) {
    projects = await board.projects()
  } else {
    const project = await board.project(projectId)
    if (!project) throw new ReportError('unknown-project', `no project ${projectId} on the board`)
    projects = [project]
  }
  const tasks: BoardTask[] = []
  for (const p of projects) tasks.push(...await board.tasks({ projectId: p.projectId }))
  const taskIds = new Set(tasks.map((t) => t.taskId))
  const notes: string[] = []
  // The last daily run of every browser spec (T305b), said in the notes: the metrics' own records are the board's and the queue's.
  const daily = (ctx.get('workflow' as never) as { dailyCheckReport?: (limit?: number) => { enabled: boolean; text: string; last?: unknown } } | undefined)?.dailyCheckReport?.(1)
  if (daily && (daily.enabled || daily.last)) notes.push(...daily.text.split('\n'))

  // Whenever recorded: the runs started and reported, and the landings (a task finished in the
  // window may have started long before it); the window's liveness entries and unknown usage.
  const startedAll = readEvents(ctx, { type: 'workflow.run.started' })
  const reportedAll = readEvents(ctx, { type: 'workflow.task.reported' })
  const landingAll = readEvents(ctx, { type: 'workflow.task.landing' })
  const runs = projectId === undefined ? new Set<string>() : runsOf(tasks, reportedAll)
  if (projectId !== undefined) for (const e of startedAll) if (e.runId && taskIds.has(String(e.data?.['taskId']))) runs.add(e.runId)
  const scope: Scope = { ...(projectId !== undefined ? { projectId } : {}), tasks: taskIds, runs }
  const liveness = LIVENESS_EVENTS.slice(0, 2).flatMap((type) => readEvents(ctx, { type, since: period.since }))
  const events = [...startedAll, ...reportedAll, ...landingAll, ...liveness].filter((e) => within.event(scope, e, new Set()))

  const requests = (await approvals.list({ states: STATES })).filter((r) => within.request(scope, r))
  let usage: UsageRecord[]
  try {
    usage = (await resources.usage({ since: period.since, until: period.until })).records.filter((u) => within.usage(scope, u))
  } catch (error) {
    if (error instanceof ResourcesError) throw new ReportError('overloaded', `the resource ledger refused the window's records (${error.message}): read a shorter window`)
    throw error
  }
  const until = Date.parse(period.until)
  let usageUnknown = 0
  for (const e of readEvents(ctx, { type: USAGE_UNKNOWN_EVENT, since: period.since })) {
    const fact = usageUnknownOf(e.data)
    if (fact && Date.parse(e.at) < until && within.unknown(scope, { ...(e.runId !== undefined ? { runId: e.runId } : {}), fact })) usageUnknown += 1
  }

  // The decisions the counts rest on: each done task's acceptance, and each reported attempt's.
  const decisions = new Map<string, DecisionRead>()
  for (const id of [...tasks.map((t) => t.result?.acceptance), ...events.map((e) => (e.type === 'workflow.task.reported' ? e.decision : undefined))]) {
    if (id === undefined || decisions.has(id)) continue
    const read = decisionOf(ctx, id)
    if (read) decisions.set(id, read)
  }

  // Who gave each verdict in the queue (ADR-0076): the decider of the decision that resolved the request. A verdict
  // whose decision cannot be read is not attributed: it counts as the operator's, as every verdict did before the lead principal.
  const verdictBy = new Map<string, DecisionRead>()
  for (const r of requests) {
    if (r.resolution?.cause !== 'verdict' || Date.parse(r.resolution.at) >= until) continue
    const read = decisionOf(ctx, r.resolution.decision)
    if (read) verdictBy.set(r.requestId, read)
  }

  // What the agent runs of the window drew (`quota.draw`): an entry that is not a valid record is not counted, and said.
  const draws: QuotaDraw[] = []
  let invalidDraws = 0
  for (const e of readEvents(ctx, { type: QUOTA_DRAW_EVENT, since: period.since })) {
    if (Date.parse(e.at) >= until) continue
    const record = quotaDrawOf(e.data)
    if (!record) invalidDraws += 1
    else if (within.draw(scope, { ...(e.runId !== undefined ? { runId: e.runId } : {}), record })) draws.push(record)
  }
  if (invalidDraws) notes.push(`${invalidDraws} ${QUOTA_DRAW_EVENT} entr${invalidDraws === 1 ? 'y is' : 'ies are'} not a valid quota-draw@1.0 record: not counted`)

  // The decisions people made on the runs. Read for: the done tasks' runs; every run with an entry of
  // its own in the window (an older run stopped, continued, approved, or freed in it); and every run a
  // person decided on in the window among the latest decisions stored. What may be missed is said.
  const since = Date.parse(period.since)
  const inWindow = (at: string): boolean => Date.parse(at) >= since && Date.parse(at) < until
  const doneTasks = new Set(tasks.filter((t) => t.state === 'done').map((t) => t.taskId))
  const toRead = new Set<string>()
  for (const e of [...startedAll, ...reportedAll]) {
    if (!e.runId || !within.event(scope, e, new Set())) continue
    if (doneTasks.has(String(e.data?.['taskId'])) || (e.type === 'workflow.run.started' && inWindow(e.at))) toRead.add(e.runId)
  }
  for (const e of readWindow(ctx, period.since)) if (e.runId && inWindow(e.at) && within.event(scope, e, new Set())) toRead.add(e.runId)
  const latest = ctx.artifacts.list({ kind: 'decision', newest: true, limit: DECISIONS_PAGE })
  for (const envelope of latest) {
    const type = (envelope.body as { decider?: { type?: string } } | undefined)?.decider?.type
    if (envelope.runId && (type === 'client' || type === 'operator') && inWindow(envelope.createdAt) && (projectId === undefined || runs.has(envelope.runId))) toRead.add(envelope.runId)
  }
  const unreadDecisions = latest.length === DECISIONS_PAGE && Date.parse(latest.at(-1)!.createdAt) > since
    ? `a decision a person made in the window on a run with no entry of its own in it, before the ${DECISIONS_PAGE} latest decisions (the oldest ${latest.at(-1)!.createdAt}), is not read`
    : undefined
  if (toRead.size > MAX_RUNS_READ) throw new ReportError('overloaded', `more than ${MAX_RUNS_READ} runs' decisions to read: read a shorter window or one project`)
  const runDecisions = new Map<string, RunDecision[]>()
  const truncatedRuns: string[] = []
  for (const runId of [...toRead].sort()) {
    // The oldest page, and the newest when the oldest is full: a run whose two pages share no decision may hold more between them.
    const pages = new Map<string, Envelope>()
    const oldest = ctx.artifacts.list({ kind: 'decision', runId, limit: DECISIONS_PAGE })
    for (const envelope of oldest) pages.set(envelope.id, envelope)
    if (oldest.length === DECISIONS_PAGE) {
      for (const envelope of ctx.artifacts.list({ kind: 'decision', runId, limit: DECISIONS_PAGE, newest: true })) pages.set(envelope.id, envelope)
      if (pages.size === 2 * DECISIONS_PAGE) truncatedRuns.push(runId)
    }
    const people: RunDecision[] = []
    for (const envelope of pages.values()) {
      const body = envelope.body as { decisionType?: string; decider?: { type?: string }; outcome?: { option?: string } } | undefined
      const type = body?.decider?.type
      if (type === 'client' || type === 'operator') people.push({ id: envelope.id, createdAt: envelope.createdAt, deciderType: type, decisionType: String(body?.decisionType), option: String(body?.outcome?.option) })
    }
    if (people.length) runDecisions.set(runId, people.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1)))
  }

  // When each task first became ready: the board's decisions moving a task to ready, the latest first.
  const readyAt = new Map<string, string>()
  const readies = ctx.artifacts.list({ kind: 'decision', decisionType: 'board', outcome: 'ready', newest: true, limit: READY_MOVES_READ })
  for (const envelope of readies) {
    const detail = (envelope.body as { outcome?: { detail?: { taskId?: unknown; at?: unknown } } }).outcome?.detail
    const taskId = detail?.taskId
    if (typeof taskId !== 'string' || !taskIds.has(taskId)) continue
    const when = typeof detail?.at === 'string' ? detail.at : envelope.createdAt
    const known = readyAt.get(taskId)
    if (known === undefined || Date.parse(when) < Date.parse(known)) readyAt.set(taskId, when)
  }
  // A full read may not reach a task's first move to ready: the reading takes it as a bound, never as the time.
  const readyReadFrom = readies.length === READY_MOVES_READ ? readies.at(-1)!.createdAt : undefined
  const [first] = ctx.eventLog.query({ limit: 1 })
  if (first && first.seq > 1 && Date.parse(first.at) > since) notes.push(`the event log keeps entries from ${first.at} on (retention): runs, landings, and stalls before then are not counted`)

  // The escaped defects recorded against auto-accepted results (D93): read when the board records them.
  const escapes = board.escapes ? await board.escapes(projectId) : undefined
  // Worker availability over time, whenever recorded (a Worker serves every project, so not scoped): the state each was left in before the window, then each change.
  const availability = [WORKER_UNAVAILABLE_EVENT, WORKER_AVAILABLE_EVENT].flatMap((type) => readEvents(ctx, { type }))

  // Records before the lead principal name the operator whoever used the token (the lead's scripts used it): said, never migrated (ADR-0076).
  const before = [...verdictBy.entries()].filter(([, d]) => d.deciderType === 'operator' && d.deciderVersion === '1' && inWindow(d.createdAt)).length
    + [...decisions.values()].filter((d) => d.decisionType === 'acceptance' && d.deciderType === 'operator' && d.deciderVersion === '1' && inWindow(d.createdAt)).length
  if (before) notes.push(`${before} verdict(s) or acceptance(s) of the window were recorded before the lead principal (decider operator, version 1): they count as the operator's, whoever used the token`)

  return buildMetrics(period, {
    asOf, tasks, requests, usage, events, decisions, runDecisions, verdictBy, readyAt, usageUnknown, draws, notes,
    ...(escapes ? { escapes } : {}), defectLinks: true, availability,
    ...(truncatedRuns.length ? { truncatedRuns } : {}), ...(unreadDecisions ? { unreadDecisions } : {}), ...(readyReadFrom ? { readyReadFrom } : {}),
  }, projectId)
}

/** Decisions one artifact read returns at most (the artifacts seam's own bound). */
const DECISIONS_PAGE = 1000

/** Every entry of the event log from `since` on, of any type, at most {@link MAX_EVENTS}: more refuses the reading, never truncates it. */
function readWindow(ctx: Context, since: string): Array<{ at: string; runId?: string; data?: Record<string, unknown>; type: string; seq: number }> {
  const out: Array<{ at: string; runId?: string; data?: Record<string, unknown>; type: string; seq: number }> = []
  let afterSeq = 0
  for (;;) {
    const page = ctx.eventLog.query({ since, afterSeq, limit: PAGE })
    for (const e of page) out.push({ seq: e.seq, at: e.at, type: e.type, ...(e.runId !== undefined ? { runId: e.runId } : {}), ...(e.data !== undefined ? { data: e.data } : {}) })
    if (out.length > MAX_EVENTS) throw new ReportError('overloaded', `more than ${MAX_EVENTS} event-log entries in the window: read a shorter window`)
    if (page.length < PAGE) return out
    afterSeq = page.at(-1)!.seq
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
const INPUT: ToolSpec['inputSchema'] = {
  projectId: zod.string().regex(ID).optional().describe('One project; absent: every project on the board'),
  since: zod.string().max(64).optional().describe('The period\'s start, ISO 8601 (inclusive); not with days'),
  until: zod.string().max(64).optional().describe('The period\'s end, ISO 8601 (exclusive); default now'),
  days: zod.number().int().min(1).max(MAX_DAYS).optional().describe('The period as the days before until (default 7, the weekly investor report)'),
}
const DESCRIPTION = 'The baseline report, from recorded data only (no model writes it), for a period (default: the 7 days before now) and one project or every one: the board\'s progress and tasks, the attempts and their reviews, remediation, the approval requests asked and answered and how long verdicts took, what asked for the operator per day against the charter\'s attention budget, the reviews held for you now, usage per pool, the digests of task results, and the baseline: accepted results, interruptions, and what each accepted result cost; and, once dispatch choices were advised, the advisor\'s calibration in shadow (a Brier score per question); and the maturity metrics over the 30 days to its end, with the reading against the L3 lines (as `metrics` gives them). Answers with the report and its one-screen rendering.'

const refused = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] })

const METRICS_INPUT: ToolSpec['inputSchema'] = {
  projectId: zod.string().regex(ID).optional().describe('One project; absent: every project on the board'),
  days: zod.number().int().min(1).max(MAX_DAYS).optional().describe(`The window as the days before until (default ${METRICS_DEFAULT_DAYS}, the window a level is read over)`),
  until: zod.string().max(64).optional().describe('The window\'s end, ISO 8601 (exclusive); default now'),
}
const METRICS_DESCRIPTION = `The maturity metrics of PROP-0016 §1, from recorded data only, over a rolling window (default the ${METRICS_DEFAULT_DAYS} days before now) for one project or every one: each metric's value, the sample it is over, and the records it read, or why it cannot be measured yet (never 0); a value the records only bound says so. Then the reading against the L3 lines (starting lines, D83): it holds only when every line is met over 30 days and 30 finished tasks. Reads only; changes nothing.`

/**
 * The input a caller may read (T285, ADR-0076): a project's lead reads its own project only, by
 * default too; another project, named, is refused with the reason (the string). The operator and a
 * client token with no project read what they name, or every project.
 */
function ownProject(args: Record<string, unknown>, lead: string | undefined): Record<string, unknown> | string {
  if (lead === undefined) return args
  if (args.projectId !== undefined && args.projectId !== lead) {
    return `forbidden: the lead token of project ${lead} reaches only project ${lead}; project ${String(args.projectId)} is another project's, so nothing was read`
  }
  return { ...args, projectId: lead }
}

/** The `report` tool: input and output checked against `mcp-report@1.6`; the text is the rendering. */
function registerTool(ctx: Context): void {
  ctx.mcp.tool('metrics', { scope: 'client', description: METRICS_DESCRIPTION, inputSchema: METRICS_INPUT }, async (args, context) => {
    try {
      schemas.assertDef('mcp-report@1.6', 'metrics-input', args)
    } catch (error) {
      return refused(`invalid input, nothing read: ${(error as Error).message}`)
    }
    const scoped = ownProject(args, context?.lead)
    if (typeof scoped === 'string') return refused(scoped)
    let made: Metrics
    try {
      made = await metrics(ctx, scoped as MetricsInput)
    } catch (error) {
      return refused(error instanceof ReportError ? `${error.failure}: ${error.message}` : `metrics: ${(error as Error).message}`)
    }
    try {
      schemas.assertDef('mcp-report@1.6', 'metrics-output', made)
    } catch (error) {
      return refused(`metrics: the reading made an output its schema refuses (a defect): ${(error as Error).message}`)
    }
    return { content: [{ type: 'text' as const, text: `${renderMetrics(made).join('\n')}\n` }], structuredContent: { ...made } }
  })
  ctx.mcp.tool('report', { scope: 'client', description: DESCRIPTION, inputSchema: INPUT }, async (args, context) => {
    try {
      schemas.assertDef('mcp-report@1.6', 'report-input', args)
    } catch (error) {
      return refused(`invalid input, nothing read: ${(error as Error).message}`)
    }
    const scoped = ownProject(args, context?.lead)
    if (typeof scoped === 'string') return refused(scoped)
    let made: Report
    try {
      made = await report(ctx, scoped as ReportInput)
    } catch (error) {
      return refused(error instanceof ReportError ? `${error.failure}: ${error.message}` : `report: ${(error as Error).message}`)
    }
    try {
      schemas.assertDef('mcp-report@1.6', 'report-output', made)
    } catch (error) {
      return refused(`report: the report made an output its schema refuses (a defect): ${(error as Error).message}`)
    }
    return { content: [{ type: 'text' as const, text: renderReport(made) }], structuredContent: { ...made } }
  })
}

export function apply(ctx: Context): void {
  ctx.inject(['mcp'], (c) => registerTool(c))
}
