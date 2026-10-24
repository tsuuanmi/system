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
import type {} from '@tsuuanmi/system-artifacts'
import type { BoardTask, Project } from '@tsuuanmi/system-board-core'
import type { Digests } from '@tsuuanmi/system-digest-core'
import type {} from '@tsuuanmi/system-event-log'
import type { ToolSpec } from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry, USAGE_UNKNOWN_EVENT, usageUnknownOf } from '@tsuuanmi/system-libs'
import { ResourcesError, type UsageRecord } from '@tsuuanmi/system-resources-core'
import { z as zod } from 'zod'
import { renderReport } from './render.ts'
import { buildReport, type DecisionRead, type DigestRead, LIVENESS_EVENTS, MAX_DAYS, periodOf, type Recorded, type Report, ReportError, type ReportInput, runsOf, type Scope, type UnknownRead, within } from './report.ts'

export { duration, renderReport, whole } from './render.ts'
export { buildReport, type DecisionRead, type DigestRead, MAX_DAYS, MAX_PROJECTS, periodOf, type Period, type Recorded, type Report, ReportError, type ReportInput, runsOf, type Scope, type Sources, type UnknownRead, within } from './report.ts'

export const name = 'report'
export const inject = ['artifacts', 'eventLog']

/** Event-log entries one report reads per query at most (INV-9): more refuses the report, never truncates it. */
export const MAX_EVENTS = 100_000
const PAGE = 1000
/** The entries a report counts in its period, beside the task reports and digests it reads whole. */
const PERIOD_EVENTS = ['workflow.graph.grown', 'workflow.gate.opened', 'workflow.gate.closed', 'approvals.batched', ...LIVENESS_EVENTS] as const
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
  const body = envelope.body as { decisionType: string; decider: { type: string; id: string }; outcome: { option: string; detail?: Record<string, unknown> } }
  const checks = body.outcome.detail?.['checks']
  return {
    createdAt: envelope.createdAt, decisionType: body.decisionType, deciderType: body.decider.type, deciderId: body.decider.id, option: body.outcome.option,
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
export async function report(ctx: Context, input: ReportInput, now: Date = new Date()): Promise<Report> {
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
    if (!reconciled.has(key)) reconciled.set(key, (await resources.usage({ runId: fact.runId, pool: fact.pool })).records.length > 0)
    unknowns.push({ at: e.at, ...(e.runId !== undefined ? { runId: e.runId } : {}), fact, reconciled: reconciled.get(key)! })
  }
  if (invalid) notes.push(`${invalid} ${USAGE_UNKNOWN_EVENT} entr${invalid === 1 ? 'y is' : 'ies are'} not a valid usage-unknown@1.0 record: not counted`)
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
  // An event log trimmed by retention holds nothing before its first entry.
  const [first] = ctx.eventLog.query({ limit: 1 })
  if (first && first.seq > 1 && Date.parse(first.at) > since) notes.push(`the event log keeps entries from ${first.at} on (retention): attempts, remediation, batches, and digests before then are not counted`)

  return buildReport(period, { asOf, projects, tasks, requests, usage, events, decisions, ...(digests ? { digests } : {}), unknowns, notes }, projectId)
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
const INPUT: ToolSpec['inputSchema'] = {
  projectId: zod.string().regex(ID).optional().describe('One project; absent: every project on the board'),
  since: zod.string().max(64).optional().describe('The period\'s start, ISO 8601 (inclusive); not with days'),
  until: zod.string().max(64).optional().describe('The period\'s end, ISO 8601 (exclusive); default now'),
  days: zod.number().int().min(1).max(MAX_DAYS).optional().describe('The period as the days before until (default 7: the weekly investor report)'),
}
const DESCRIPTION = 'The baseline report, from recorded data only (no model writes it): for a period (default the 7 days before now: the weekly investor report) and one project or every one, the board\'s progress and tasks, the attempts and the reviews of their results, remediation, the approval requests asked and answered and how long your verdicts took, what asked for the operator per day against the charter\'s attention budget, the resource ledger\'s usage per pool, the digests of task results, and the baseline: accepted results, interruptions, and what each accepted result cost. Answers with the report and its one-screen rendering.'

const refused = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] })

/** The `report` tool: input and output checked against `mcp-report@1.2`; the text is the rendering. */
export function registerTool(ctx: Context): void {
  ctx.mcp.tool('report', { scope: 'client', description: DESCRIPTION, inputSchema: INPUT }, async (args) => {
    try {
      schemas.assertDef('mcp-report@1.2', 'report-input', args)
    } catch (error) {
      return refused(`invalid input, nothing read: ${(error as Error).message}`)
    }
    let made: Report
    try {
      made = await report(ctx, args as ReportInput)
    } catch (error) {
      return refused(error instanceof ReportError ? `${error.failure}: ${error.message}` : `report: ${(error as Error).message}`)
    }
    try {
      schemas.assertDef('mcp-report@1.2', 'report-output', made)
    } catch (error) {
      return refused(`report: the report made an output its schema refuses (a defect): ${(error as Error).message}`)
    }
    return { content: [{ type: 'text' as const, text: renderReport(made) }], structuredContent: { ...made } }
  })
}

export function apply(ctx: Context): void {
  ctx.inject(['mcp'], (c) => registerTool(c))
}
