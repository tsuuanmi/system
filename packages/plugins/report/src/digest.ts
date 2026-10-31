/**
 * The lead's daily digest, computed (PROP-0019 section 2.10, D108 "measure daily"): a pure function
 * from what was read to the `lead-digest@1.0` record (`schemas/lead-digest.v1.json`). The same
 * records and day give the same digest: everything is sorted before it is counted, and no model
 * takes part. What a source could not give is `{ unknown: why }`, never 0 (INV-2).
 */
import type { ApprovalRequest } from '@tsuuanmi/system-approvals-core'
import type { BoardTask } from '@tsuuanmi/system-board-core'
import type { Recorded } from './report.ts'

export const DIGEST_SCHEMA = 'lead-digest@1.0'
/** Entries of each list one digest holds (`lead-digest@1.0` bounds them, INV-9); the rest are counted in `notes`. */
const MAX_LISTED = 64
const DAY_MS = 86_400_000

/** A fact a source gave, or why it is not known. */
export type Read<T> = { value: T } | { unknown: string }

/** A decision of the lead's own token (a `client` decider), as the digest reads it. */
export interface LeadDecision { id: string; at: string; decisionType: string; option: string; runId?: string; taskId?: string; requestId?: string }

/** A commit on a branch the project landed on, as `git log --first-parent` gives it. */
export interface BranchCommit { sha: string; at: string; subject: string }

/** One run of the daily check of the branch tip, as the workflow engine records it. */
export interface DailyCheckRead { checkId: string; state: string; at: string; commit: string; taskId?: string; problem?: string }

export interface DigestSources {
  asOf: string
  projectId: string
  /** The UTC day, `YYYY-MM-DD`. */
  day: string
  tasks: BoardTask[]
  /** `workflow.task.landing`, `workflow.task.reported`, `workflow.run.started`, and the liveness and live-update entries, whenever recorded. */
  events: Recorded[]
  requests: ApprovalRequest[]
  decisions: LeadDecision[]
  /** The first-parent commits of the branches the project landed on, in the day; unknown when git could not be read. */
  branch: Read<BranchCommit[]>
  dailyChecks: Read<DailyCheckRead[]>
  notes: string[]
}

interface LandedItem { taskId: string; title?: string; runId: string; commit?: string; at: string }
interface DecidedItem { at: string; what: string; option?: string; taskId?: string; runId?: string; id: string }
interface WaitingItem { kind: 'review' | 'request'; id: string; title: string; expiresAt: string; brief: string; pendingChecks?: string[] }
interface FailedItem { kind: 'attempt' | 'daily-check'; at: string; status: string; taskId?: string; runId?: string; reason?: string; filedTask?: string }
interface ByHandItem { commit: string; at: string; subject: string }

export interface Digest {
  schema: typeof DIGEST_SCHEMA
  projectId: string
  day: string
  period: { since: string; until: string }
  asOf: string
  landed: LandedItem[]
  decided: DecidedItem[]
  waiting: WaitingItem[]
  failed: FailedItem[]
  byHand: ByHandItem[]
  measures: {
    landedBySystem: number
    landedByHand: Read<number>
    leadTouches: number
    reruns: number
    redDev: Read<number>
    incidents: number
  }
  notes: string[]
}

const ms = (at: string): number => Date.parse(at)
const byAt = <T extends { at: string }>(a: T, b: T): number => ms(a.at) - ms(b.at)
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined)

/** The UTC day `day` (`YYYY-MM-DD`) as the period it covers, or undefined when it is not a date. */
export function dayPeriod(day: string): { since: string; until: string } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined
  const start = Date.parse(`${day}T00:00:00.000Z`)
  if (Number.isNaN(start) || new Date(start).toISOString().slice(0, 10) !== day) return undefined
  return { since: new Date(start).toISOString(), until: new Date(start + DAY_MS).toISOString() }
}

/** The liveness entries that count as incidents: an agent run stalled, or ended with its liveness unknown. */
const INCIDENT_EVENTS = ['agent-workers.run.stalled', 'agent-workers.run.unknown']

export function buildDigest(s: DigestSources): Digest {
  const period = dayPeriod(s.day)!
  const inDay = (at: string): boolean => ms(at) >= ms(period.since) && ms(at) < ms(period.until)
  const titles = new Map(s.tasks.map((t) => [t.taskId, t.title.slice(0, 200)]))
  const mine = (e: Recorded): boolean => typeof e.data?.['taskId'] === 'string' && titles.has(e.data['taskId'])
  const notes = [...s.notes]
  const truncated = (what: string, n: number): void => {
    if (n > MAX_LISTED) notes.push(`${n} ${what} in the day: the first ${MAX_LISTED} are listed, and the measures count every one`)
  }

  // What landed: each result merged in the day, once (a landing's merged entry is recorded once per run).
  const mergedAll = s.events.filter((e) => e.type === 'workflow.task.landing' && e.data?.['state'] === 'merged' && mine(e))
  const landedAll: LandedItem[] = []
  const seenRuns = new Set<string>()
  for (const e of [...mergedAll].sort((a, b) => a.seq - b.seq)) {
    if (!inDay(e.at) || !e.runId || seenRuns.has(e.runId)) continue
    seenRuns.add(e.runId)
    const taskId = String(e.data!['taskId'])
    const commit = text(e.data!['commit'])
    landedAll.push({ taskId, ...(titles.get(taskId) ? { title: titles.get(taskId)! } : {}), runId: e.runId, ...(commit ? { commit } : {}), at: e.at })
  }
  landedAll.sort(byAt)
  truncated('landings', landedAll.length)

  // A landing outside System: a commit on the branch with no landing decision (a commit no merged landing names).
  const systemCommits = new Set(mergedAll.map((e) => text(e.data!['commit'])).filter((c): c is string => c !== undefined))
  let byHandAll: ByHandItem[] = []
  let landedByHand: Read<number>
  if ('value' in s.branch) {
    byHandAll = s.branch.value.filter((c) => inDay(c.at) && !systemCommits.has(c.sha)).map((c) => ({ commit: c.sha, at: c.at, subject: c.subject.slice(0, 200) })).sort(byAt)
    landedByHand = { value: byHandAll.length }
    truncated('commits on the branch with no landing decision', byHandAll.length)
  } else {
    landedByHand = { unknown: s.branch.unknown }
  }

  // What the lead decided, from its own recorded decisions and the runs it started: the lead-touch metric's sources.
  const decidedAll: DecidedItem[] = []
  const seenDecisions = new Set<string>()
  for (const d of s.decisions) {
    if (!inDay(d.at) || seenDecisions.has(d.id)) continue
    seenDecisions.add(d.id)
    decidedAll.push({ at: d.at, what: d.decisionType, option: d.option, ...(d.taskId ? { taskId: d.taskId } : {}), ...(d.runId ? { runId: d.runId } : {}), id: d.id })
  }
  const started = s.events.filter((e) => e.type === 'workflow.run.started' && mine(e) && e.runId)
  for (const e of started) {
    if (e.data?.['startedBy'] === 'lead' && inDay(e.at)) decidedAll.push({ at: e.at, what: 'start', taskId: String(e.data['taskId']), runId: e.runId!, id: e.runId! })
  }
  decidedAll.sort((a, b) => byAt(a, b) || (a.id < b.id ? -1 : 1))
  truncated('lead decisions', decidedAll.length)

  // What waits on the operator now: the reviews held and the open requests, the soonest to expire first.
  const waitingAll: WaitingItem[] = [
    ...s.tasks.filter((t) => t.state === 'review' && t.waiting?.reason === 'operator-review').map((t): WaitingItem => ({
      kind: 'review', id: t.taskId, title: t.title.slice(0, 200), expiresAt: t.waiting!.expiresAt, brief: `board_brief ${t.taskId}`, ...(t.waiting!.pendingChecks?.length ? { pendingChecks: [...t.waiting!.pendingChecks] } : {}),
    })),
    ...s.requests.filter((r) => r.state === 'open' || r.state === 'batched').map((r): WaitingItem => ({ kind: 'request', id: r.requestId, title: r.action.summary.slice(0, 200), expiresAt: r.expiresAt, brief: `system approvals show ${r.requestId}` })),
  ].sort((a, b) => ms(a.expiresAt) - ms(b.expiresAt) || (a.id < b.id ? -1 : 1))
  truncated('items waiting on the operator', waitingAll.length)

  // What failed in the day: attempts that did not reach acceptance or the board, and failed runs of the daily check.
  const failedAll: FailedItem[] = []
  for (const e of s.events) {
    if (e.type !== 'workflow.task.reported' || !mine(e) || !inDay(e.at)) continue
    const status = String(e.data!['status'])
    if (status !== 'rejected' && status !== 'refused' && status !== 'not-started') continue
    failedAll.push({ kind: 'attempt', at: e.at, status, taskId: String(e.data!['taskId']), ...(e.runId ? { runId: e.runId } : {}), ...(text(e.data!['reason']) ? { reason: text(e.data!['reason'])!.slice(0, 300) } : {}) })
  }
  let redDev: Read<number>
  if ('value' in s.dailyChecks) {
    const red = s.dailyChecks.value.filter((c) => c.state === 'failed' && inDay(c.at) && (c.taskId === undefined || titles.has(c.taskId)))
    redDev = { value: red.length }
    for (const c of red) failedAll.push({ kind: 'daily-check', at: c.at, status: 'failed', ...(c.problem ? { reason: c.problem.slice(0, 300) } : {}), ...(c.taskId ? { filedTask: c.taskId } : {}) })
  } else {
    redDev = { unknown: s.dailyChecks.unknown }
  }
  failedAll.sort(byAt)
  truncated('failures', failedAll.length)

  // Reruns: a run of a task that already had one before it (a retry), started in the day.
  const firstStart = new Map<string, number>()
  const startedOrdered = [...started].sort((a, b) => a.seq - b.seq)
  let reruns = 0
  for (const e of startedOrdered) {
    const taskId = String(e.data!['taskId'])
    if (firstStart.has(taskId)) {
      if (inDay(e.at)) reruns += 1
    } else {
      firstStart.set(taskId, e.seq)
    }
  }

  // Incidents: a stall, or a run that ended without being known to be gone, of the project's runs; and a live update that failed.
  const runs = new Set(s.events.filter((e) => e.runId && mine(e)).map((e) => e.runId!))
  const incidents = s.events.filter((e) => inDay(e.at) && ((INCIDENT_EVENTS.includes(e.type) && ((e.runId !== undefined && runs.has(e.runId)) || mine(e))) || (e.type === 'host.live-update' && e.data?.['outcome'] === 'failed'))).length

  return {
    schema: DIGEST_SCHEMA, projectId: s.projectId, day: s.day, period, asOf: s.asOf,
    landed: landedAll.slice(0, MAX_LISTED), decided: decidedAll.slice(0, MAX_LISTED), waiting: waitingAll.slice(0, MAX_LISTED), failed: failedAll.slice(0, MAX_LISTED), byHand: byHandAll.slice(0, MAX_LISTED),
    measures: { landedBySystem: landedAll.length, landedByHand, leadTouches: decidedAll.length, reruns, redDev, incidents },
    notes: notes.slice(0, 16),
  }
}

/** The hours a hold has left as of the digest's time, flagged under `hours` (the lead inbox's `expiringHours`, default 4). */
const EXPIRING_HOURS = 4
function toExpiry(expiresAt: string, asOf: string, hours: number): string {
  const left = (ms(expiresAt) - ms(asOf)) / 3_600_000
  if (!Number.isFinite(left)) return ''
  const shown = `${left < 0 ? 0 : Math.round(left * 10) / 10} h to expiry`
  return ` (${shown}${left < hours ? '; EXPIRING SOON' : ''})`
}

const measure = (m: Read<number>): string => ('value' in m ? String(m.value) : `unknown (${m.unknown})`)
const when = (at: string): string => at.slice(11, 16)

/** The digest as one screen: what landed, what the lead decided, what waits, what failed, and the day's measures. */
export function renderDigest(d: Digest, expiringHours = EXPIRING_HOURS): string {
  const lines = [`# Lead digest: project ${d.projectId}, ${d.day} (UTC)`, '', `Read ${d.asOf}.`]
  const section = (title: string, items: string[], none: string): void => {
    lines.push('', `## ${title}`)
    lines.push(...(items.length ? items : [`- ${none}`]))
  }
  section(`Landed (${d.measures.landedBySystem})`, d.landed.map((l) => `- ${when(l.at)} ${l.taskId}${l.title ? ` ${l.title}` : ''}: run ${l.runId}${l.commit ? `, commit ${l.commit.slice(0, 12)}` : ''}`), 'nothing landed through System')
  section('The lead decided', d.decided.map((x) => `- ${when(x.at)} ${x.what}${x.option ? ` ${x.option}` : ''}${x.taskId ? ` on ${x.taskId}` : ''}${x.runId ? ` (run ${x.runId})` : ''}`), 'no decision of the lead recorded')
  section('Waits on the operator', d.waiting.map((w) => `- ${w.kind} ${w.id}: ${w.title}; expires ${w.expiresAt}${toExpiry(w.expiresAt, d.asOf, expiringHours)}; read it: ${w.brief}${w.pendingChecks?.length ? `; checks pending: ${w.pendingChecks.join(', ')}` : ''}`), 'nothing waits on the operator')
  section('Failed', d.failed.map((f) => `- ${when(f.at)} ${f.kind} ${f.status}${f.taskId ? ` of ${f.taskId}` : ''}${f.runId ? ` (run ${f.runId})` : ''}${f.filedTask ? `; filed as ${f.filedTask}` : ''}${f.reason ? `: ${f.reason}` : ''}`), 'nothing failed')
  if (d.byHand.length) section('On the branch with no landing decision', d.byHand.map((c) => `- ${when(c.at)} ${c.commit.slice(0, 12)} ${c.subject}`), '')
  const m = d.measures
  lines.push('', '## Measures', `- Landed by System: ${m.landedBySystem}; by hand: ${measure(m.landedByHand)}`, `- Lead touches: ${m.leadTouches}; reruns: ${m.reruns}; red dev: ${measure(m.redDev)}; incidents: ${m.incidents}`)
  if (d.notes.length) lines.push('', '## Notes', ...d.notes.map((n) => `- ${n}`))
  return `${lines.join('\n')}\n`
}
