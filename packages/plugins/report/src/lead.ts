/**
 * What the lead's digest and health table read (PROP-0019 section 2.10): the board, the queue, the
 * event log, the decisions, and each seam the table joins, through their definitions only. It
 * writes nothing but the record of a finished day's digest, which it stores once. A seam that is not
 * loaded or fails to answer makes its figure `unknown`, never a default (INV-2).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalRequest } from '@tsuuanmi/system-approvals-core'
import type { BoardTask } from '@tsuuanmi/system-board-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { type BranchCommit, buildDigest, type DailyCheckRead, dayPeriod, DIGEST_SCHEMA, type Digest, type LeadDecision, type Read } from './digest.ts'
import { buildHealth, type DispatchRead, type EnforceRead, type Health, type LandingQueueRead, type LiveUpdateRead, type PoolRead, SINK_WINDOW_HOURS, type SinkRead, type WorkerRead, type WorktreesRead } from './health.ts'
import { MAX_RUNS_READ } from './metrics.ts'
import { LIVENESS_EVENTS, ReportError, type Recorded, runsOf, within } from './report.ts'

const run = promisify(execFile)
const schemas = new SchemaRegistry()
const DECISIONS_PAGE = 1000
/** Daily-check runs one digest reads at most (the newest, INV-9). */
const CHECK_RUNS_READ = 100
/** Commits of one branch in one day the digest reads at most (INV-9). */
const MAX_COMMITS = 2000
/** The landing states in progress (docs/design/workflow-engine.md#the-landing-queue). */
const OPEN_LANDINGS = new Set(['watch', 'commit', 'queued', 'stacked', 'rebase', 'resolving', 'returning', 'recheck', 'committed', 'asked', 'merging'])
const REQUEST_STATES: ApprovalRequest['state'][] = ['open', 'batched', 'approved', 'rejected']

/** The reads both tools share: the event log's pages, and the one decision a record names. */
interface LeadReads {
  events(filter: { type: string; since?: string }): Recorded[]
}

const failure = (error: unknown): string => ((error as Error)?.message ?? String(error)).slice(0, 300)
/** One read that may throw, as `unknown`: a source that cannot answer never reads as healthy. */
async function attempt<T>(read: () => T | Promise<T>): Promise<Read<T>> {
  try {
    return { value: await read() }
  } catch (error) {
    return { unknown: failure(error) }
  }
}
const missing = <T>(what: string): Read<T> => ({ unknown: `${what} is not loaded` })

/** The first-parent commits of `branch` in `repository` committed in `[since, until)`. */
async function commitsOf(repository: string, branch: string, since: string, until: string): Promise<BranchCommit[]> {
  const { stdout } = await run('git', ['-C', repository, 'log', '--first-parent', `--since=${since}`, `--until=${until}`, `--max-count=${MAX_COMMITS}`, '--format=%H%x09%cI%x09%s', `refs/heads/${branch}`], { timeout: 20_000, maxBuffer: 4_000_000 })
  return stdout.split('\n').filter(Boolean).map((line) => {
    const [sha = '', at = '', ...subject] = line.split('\t')
    return { sha, at: new Date(at).toISOString(), subject: subject.join('\t') }
  })
}

/** The lead's digest of `day` for `projectId`: a finished day's is stored once and read back; today's is read now and not stored. */
export async function leadDigest(ctx: Context, reads: LeadReads, input: { projectId: string; day?: string }, now: Date = new Date()): Promise<{ digest: Digest; artifact?: string }> {
  const day = input.day ?? now.toISOString().slice(0, 10)
  const period = dayPeriod(day)
  if (!period) throw new ReportError('invalid', `day ${day} is not a date (YYYY-MM-DD, UTC)`)
  if (Date.parse(period.since) > now.getTime()) throw new ReportError('invalid', `day ${day} has not begun`)
  const board = ctx.get('board')
  const approvals = ctx.get('approvals')
  if (!board || !approvals) throw new ReportError('unavailable', `${[board ? '' : 'the board', approvals ? '' : 'the approval queue'].filter(Boolean).join(', ')} not loaded: a digest reads the board and the approval queue, so none is made`)
  const { projectId } = input
  if (!await board.project(projectId)) throw new ReportError('unknown-project', `no project ${projectId} on the board`)

  const finished = Date.parse(period.until) <= now.getTime()
  if (finished) {
    // Yesterday's, as it was stored: a day's record does not change once it is made. Found by its key, never by scanning.
    const kept = storedDigest(ctx, projectId, day)
    if (kept) return kept
  }

  const asOf = now.toISOString()
  const tasks: BoardTask[] = await board.tasks({ projectId })
  const taskIds = new Set(tasks.map((t) => t.taskId))
  const events = [...['workflow.task.landing', 'workflow.task.reported', 'workflow.run.started'].flatMap((type) => reads.events({ type })), ...[...LIVENESS_EVENTS, 'host.live-update'].flatMap((type) => reads.events({ type, since: period.since }))]
  const taskOfRun = new Map<string, string>()
  for (const e of events) if (e.runId && typeof e.data?.['taskId'] === 'string' && taskIds.has(e.data['taskId'])) taskOfRun.set(e.runId, e.data['taskId'])
  const scope = { projectId, tasks: taskIds, runs: new Set([...taskOfRun.keys(), ...runsOf(tasks, [])]) }
  const requests = (await approvals.list({ states: REQUEST_STATES })).filter((r) => within.request(scope, r))
  const notes: string[] = []

  // The lead's own decisions: verdicts in the queue and the decisions on the project's runs whose decider is a client (the lead-touch metric's sources).
  const decisions: LeadDecision[] = []
  const decisionBody = (id: string): { decisionType: string; option: string; decider: string; at: string; runId?: string } | undefined => {
    const envelope = ctx.artifacts.get(id)
    if (envelope?.kind !== 'decision') return undefined
    const body = envelope.body as { decisionType: string; decider: { type: string }; outcome: { option: string } }
    return { decisionType: body.decisionType, option: body.outcome.option, decider: body.decider.type, at: envelope.createdAt, ...(envelope.runId ? { runId: envelope.runId } : {}) }
  }
  for (const r of requests) {
    if (r.resolution?.cause !== 'verdict') continue
    const read = decisionBody(r.resolution.decision)
    if (read?.decider === 'client') decisions.push({ id: r.resolution.decision, at: r.resolution.at, decisionType: 'verdict', option: read.option, requestId: r.requestId, ...(r.requester.taskId ? { taskId: r.requester.taskId } : {}) })
  }
  // Each run's own decisions, by run (never the latest of all: a day long past is read as well as today), the newest page of each.
  if (scope.runs.size > MAX_RUNS_READ) throw new ReportError('overloaded', `more than ${MAX_RUNS_READ} runs' decisions to read: the project has too many runs for one digest`)
  for (const runId of [...scope.runs].sort()) {
    const page = ctx.artifacts.list({ kind: 'decision', runId, newest: true, limit: DECISIONS_PAGE })
    for (const envelope of page) {
      const body = envelope.body as { decisionType: string; decider: { type: string }; outcome: { option: string } } | undefined
      if (body?.decider.type !== 'client') continue
      const taskId = taskOfRun.get(runId)
      decisions.push({ id: envelope.id, at: envelope.createdAt, decisionType: body.decisionType, option: body.outcome.option, runId, ...(taskId ? { taskId } : {}) })
    }
    if (page.length === DECISIONS_PAGE && Date.parse(page.at(-1)!.createdAt) > Date.parse(period.since)) notes.push(`run ${runId} has more than ${DECISIONS_PAGE} decisions (the oldest read ${page.at(-1)!.createdAt}): the lead's decisions on it before then are not read`)
  }

  // The branches the project landed on, and their commits in the day.
  const workflow = ctx.get('workflow' as never) as { landing?: (runId: string) => { repository?: string; base?: { branch: string } } | undefined; dailyCheckReport?: (limit?: number) => { enabled: boolean; runs: Array<{ checkId: string; state: string; startedAt: string; commit: string; taskId?: string; problem?: string }> } } | undefined
  const branch = await attempt(async (): Promise<BranchCommit[]> => {
    if (!workflow?.landing) throw new Error('the workflow engine is not loaded, so the repositories the project landed on are not known')
    const targets = new Map<string, { repository: string; branch: string }>()
    for (const e of events) {
      if (e.type !== 'workflow.task.landing' || e.data?.['state'] !== 'merged' || !e.runId || !taskIds.has(String(e.data['taskId']))) continue
      const landing = workflow.landing(e.runId)
      if (landing?.repository && landing.base?.branch) targets.set(`${landing.repository}#${landing.base.branch}`, { repository: landing.repository, branch: landing.base.branch })
    }
    if (!targets.size) throw new Error('no landing of the project names a repository and branch to read')
    const commits = new Map<string, BranchCommit>()
    for (const t of targets.values()) for (const c of await commitsOf(t.repository, t.branch, period.since, period.until)) commits.set(c.sha, c)
    return [...commits.values()]
  })
  const dailyChecks = await attempt((): DailyCheckRead[] => {
    const report = workflow?.dailyCheckReport?.(CHECK_RUNS_READ)
    if (!report) throw new Error('the workflow engine is not loaded')
    if (!report.enabled) throw new Error('the daily check of the branch tip is not enabled, so no check run is recorded')
    // The newest runs only: a full page whose oldest run is after the day's start may not hold the whole day.
    const oldest = report.runs.at(-1)
    if (report.runs.length >= CHECK_RUNS_READ && oldest && Date.parse(oldest.startedAt) > Date.parse(period.since)) throw new Error(`more than ${CHECK_RUNS_READ} check runs since the day began: the day's are not all read`)
    return report.runs.map((c) => ({ checkId: c.checkId, state: c.state, at: c.startedAt, commit: c.commit, ...(c.taskId ? { taskId: c.taskId } : {}), ...(c.problem ? { problem: c.problem } : {}) }))
  })

  const digest = buildDigest({ asOf, projectId, day, tasks, events, requests, decisions, branch, dailyChecks, notes })
  try {
    schemas.assert(DIGEST_SCHEMA, digest)
  } catch (error) {
    throw new ReportError('invalid', `the digest made a record its schema refuses (a defect): ${failure(error)}`)
  }
  if (!finished) return { digest }
  // Written once the day is over, as a `report` artifact, so the operator can read yesterday's. Its key (project, day) is a row
  // of the store naming the artifact: the row keeps it from collection, and a second call finds it. The reads above awaited, so a
  // call that began at the same time may have stored the day since: looked for again here, and no await lies between this look,
  // the put, and the row, so one artifact is made per day.
  const won = storedDigest(ctx, projectId, day)
  if (won) return won
  const stored = ctx.artifacts.put({ kind: 'report', bodySchema: DIGEST_SCHEMA, body: digest, classification: 'operator-shared', producer: { type: 'system', ref: 'report' } })
  ctx.store.db.prepare(`INSERT INTO report_lead_digests (project_id, day, artifact) VALUES (?, ?, ?)
    ON CONFLICT (project_id, day) DO UPDATE SET artifact = excluded.artifact WHERE NOT EXISTS (SELECT 1 FROM artifacts WHERE id = report_lead_digests.artifact)`).run(projectId, day, stored.id)
  return storedDigest(ctx, projectId, day) ?? { digest, artifact: stored.id }
}

/** The migrations of the table that keys a stored digest by project and day. */
export const MIGRATIONS = [{
  version: 1,
  sql: 'CREATE TABLE report_lead_digests (project_id TEXT NOT NULL, day TEXT NOT NULL, artifact TEXT NOT NULL, PRIMARY KEY (project_id, day));',
}]

/** The digest stored for `day` of `projectId`, by its key; undefined when none is stored (or its artifact is gone: it is made again and keyed anew). */
function storedDigest(ctx: Context, projectId: string, day: string): { digest: Digest; artifact: string } | undefined {
  const row = ctx.store.db.prepare('SELECT artifact FROM report_lead_digests WHERE project_id = ? AND day = ?').get(projectId, day) as { artifact: string } | undefined
  const envelope = row ? ctx.artifacts.get(row.artifact) : undefined
  if (!row || !envelope?.body) return undefined
  if (envelope.bodySchema !== DIGEST_SCHEMA) throw new ReportError('invalid', `the digest keyed ${projectId} ${day} names ${row.artifact}, which is not a ${DIGEST_SCHEMA} record`)
  return { digest: envelope.body as Digest, artifact: row.artifact }
}

/** The health table of `projectId` as of `now`: one row per source, `unknown` where a source could not be read. */
export async function leadHealth(ctx: Context, reads: LeadReads, input: { projectId: string }, now: Date = new Date()): Promise<Health> {
  const board = ctx.get('board')
  if (!board) throw new ReportError('unavailable', 'the board is not loaded: a health table is read per project, so none is made')
  const { projectId } = input
  if (!await board.project(projectId)) throw new ReportError('unknown-project', `no project ${projectId} on the board`)
  const taskIds = new Set((await board.tasks({ projectId })).map((t) => t.taskId))
  const since = new Date(now.getTime() - SINK_WINDOW_HOURS * 3_600_000).toISOString()

  const workflow = ctx.get('workflow' as never) as { dispatchStatus?: () => { enabled: boolean; paused?: { reason?: string }; pausedProjects: Array<{ projectId?: string }>; bounds: { running: { used: number; max: number }; openAsks: { used: number; max: number }; engine: { active: number; max: number }; hour: { used: number; max: number }; projects: Array<{ projectId: string; used: number; max: number }>; hourProjects: Array<{ projectId: string; used: number; max: number }> } } } | undefined
  const dispatch: Read<DispatchRead> = workflow?.dispatchStatus ? await attempt((): DispatchRead => {
    const d = workflow.dispatchStatus!()
    const own = d.bounds.projects.find((p) => p.projectId === projectId)
    const ownHour = d.bounds.hourProjects.find((p) => p.projectId === projectId)
    return {
      enabled: d.enabled, ...(d.paused ? { paused: d.paused.reason ? { reason: d.paused.reason } : {} } : {}), pausedProjects: d.pausedProjects.map((p) => p.projectId).filter((p): p is string => p !== undefined),
      bounds: [{ name: 'running', ...d.bounds.running }, { name: 'open asks', ...d.bounds.openAsks }, { name: 'engine', used: d.bounds.engine.active, max: d.bounds.engine.max }, { name: 'starts per hour', ...d.bounds.hour },
        ...(own ? [{ name: `project ${projectId} running`, used: own.used, max: own.max }] : []), ...(ownHour ? [{ name: `project ${projectId} starts per hour`, used: ownHour.used, max: ownHour.max }] : [])],
    }
  }) : missing('the workflow engine')

  const registry = ctx.get('workers' as never) as { list?: () => Promise<Array<{ worker: string; state: string; unavailableReason?: string; cooldowns?: Array<{ until: string }> }>> } | undefined
  const workers: Read<WorkerRead[]> = registry?.list ? await attempt(async () => (await registry.list!()).map((w): WorkerRead => {
    const cooldownUntil = (w.cooldowns ?? []).map((c) => c.until).sort().at(-1)
    return { worker: w.worker, state: w.state, ...(w.unavailableReason ? { unavailableReason: w.unavailableReason } : {}), ...(cooldownUntil ? { cooldownUntil } : {}) }
  })) : missing('the Worker registry')

  const resources = ctx.get('resources') as { pools?: () => Promise<Array<{ pool: string; available: boolean; until?: string; readings: Array<{ state: string; usedPercentage?: number }> }>> } | undefined
  const pools: Read<PoolRead[]> = resources?.pools ? await attempt(async () => (await resources.pools!()).map((p): PoolRead => {
    const used = Math.max(-1, ...p.readings.map((r) => r.usedPercentage ?? -1))
    return { pool: p.pool, available: p.available, ...(p.until ? { until: p.until } : {}), ...(used >= 0 ? { usedPercentage: used } : {}) }
  })) : missing('the resource ledger')

  const lastPerSink = (type: string, scoped: boolean): Read<SinkRead[]> => {
    try {
      const last = new Map<string, SinkRead>()
      for (const e of reads.events({ type, since })) {
        if (scoped && e.data?.['project'] !== projectId) continue
        const sink = typeof e.data?.['sink'] === 'string' ? e.data['sink'] : '(queue)'
        last.set(sink, { sink, at: e.at, outcome: String(e.data?.['outcome']), ...(typeof e.data?.['reason'] === 'string' ? { reason: e.data['reason'].slice(0, 200) } : {}) })
      }
      return { value: [...last.values()].sort((a, b) => (a.sink < b.sink ? -1 : 1)) }
    } catch (error) {
      return { unknown: failure(error) }
    }
  }

  const liveUpdate = await attempt((): LiveUpdateRead | undefined => {
    const last = reads.events({ type: 'host.live-update' }).filter((e) => e.data?.['outcome'] === 'done' || e.data?.['outcome'] === 'failed' ).filter((e) => e.data?.['projectId'] === undefined || e.data['projectId'] === projectId).at(-1)
    const reason = last?.data?.['reason']
    return last ? { at: last.at, outcome: String(last.data?.['outcome']), ...(typeof reason === 'string' ? { reason: reason.slice(0, 200) } : {}) } : undefined
  })

  const landingQueue = await attempt((): LandingQueueRead => {
    const latest = new Map<string, Recorded>()
    for (const e of reads.events({ type: 'workflow.task.landing' })) if (e.runId && taskIds.has(String(e.data?.['taskId']))) latest.set(e.runId, e)
    const open = [...latest.values()].filter((e) => OPEN_LANDINGS.has(String(e.data?.['state'])))
    const oldest = open.map((e) => e.at).sort()[0]
    return { depth: open.length, ...(oldest ? { oldestAt: oldest } : {}) }
  })

  const agents = ctx.get('agentWorkers' as never) as { runWorktrees?: () => Promise<{ total: number; worktrees: Array<{ runId: string; state: string; changes: string }> }> } | undefined
  const worktrees: Read<WorktreesRead> = agents?.runWorktrees ? await attempt(async () => {
    const listing = await agents.runWorktrees!()
    if (listing.total > listing.worktrees.length) throw new Error(`${listing.total} worktrees, only the oldest ${listing.worktrees.length} read`)
    return { total: listing.total, inUse: listing.worktrees.filter((w) => w.state === 'in-use').length, held: listing.worktrees.filter((w) => w.state === 'held').length, uncommitted: listing.worktrees.filter((w) => w.changes === 'uncommitted' || w.changes === 'not-intact').length }
  }) : missing('the agent Workers')

  const host = ctx.get('pluginHost' as never) as { enforcement?: () => Array<{ mechanism: string; mode: string }> } | undefined
  const enforcement: Read<EnforceRead[]> = host?.enforcement ? await attempt(() => host.enforcement!().map((m) => ({ mechanism: m.mechanism, mode: m.mode }))) : missing('the plugin host')

  return buildHealth({
    projectId, asOf: now.toISOString(), dispatch, workers, pools, notifySinks: lastPerSink('notify.delivery', false), leadSinks: lastPerSink('lead-inbox.delivery', true),
    liveUpdate, landingQueue, worktrees, enforcement,
  })
}
