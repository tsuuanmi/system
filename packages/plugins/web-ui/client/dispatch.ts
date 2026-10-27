// Home's dispatch panels: "Starts awaiting approval" (ADR-0064), "Daily run" (T305b), and "Started by itself" (PROP-0014 D2, T256).
import type { ApprovalRequest, DailyResponse, DispatchResponse, DispatchWindow, RunSummary } from '../src/api.js'
import { ago, capped, chip, clockOf, el, elapsedView, expires, fold, keptFold, labelled, qty, relative, span, tookView, verdictButtons, when, type Child } from './dom.js'
import { DISPATCH_DENY } from './describe.js'
import { jump, runLink } from './router.js'
import type { Queue, QueueRead } from './queue.js'
import { optional, type ApiError } from './state.js'

export type Dispatch = DispatchResponse | { error: ApiError } | null
export type Daily = DailyResponse | { error: ApiError } | null
export const dispatchOf = (): Promise<Dispatch> => optional<DispatchResponse>('dispatch', [404, 503])
export const dailyOf = (): Promise<Daily> => optional<DailyResponse>('daily-check', [404, 503])

const windowName = (w: DispatchWindow) => w.seconds ? span(w.seconds) : w.window
const goWindow = (w: DispatchWindow) => windowName(w) + ' · used ' + (w.used === undefined ? 'unknown' : w.used + ' %') + ' · reserve ' + w.reserve + ' %' + (w.resets ? ' · resets ' + clockOf(w.resets) : '')
const panel = (label: string, title: string, ...parts: Child[]) => el('section', { class: 'panel', 'aria-label': label }, el('h3', {}, title), ...parts)

/** Each start System proposes, with its Worker and quota, decided by the queue's verdict on the request's exact subject (INV-5); whether dispatch is off or paused; why each ready task did not start. */
export function goView(dispatch: Dispatch, q: QueueRead, names: Map<string, string>): HTMLElement | null {
  if (!dispatch) return null
  const wrap = (...parts: Child[]) => panel('Starts awaiting approval', 'Starts awaiting approval', ...parts)
  if ('error' in dispatch) return wrap(el('p', { class: 'state failed' }, 'The starts System proposes could not be read: ' + dispatch.error.message + '.'))
  const queue: Queue | undefined = q && !('error' in q) ? q : undefined
  const requests = new Map<string, ApprovalRequest>((queue?.requests ?? []).map((r) => [r.requestId, r]))
  const asked = dispatch.asks.filter((a) => a.state === 'asked' && a.requestId && requests.has(a.requestId))
  // Without the queue no verdict can be given here: the starts it waits on are named, never shown as none.
  const unread = queue ? [] : dispatch.asks.filter((a) => a.state === 'asked'), approved = dispatch.asks.filter((a) => a.state === 'approved' || a.state === 'starting')
  const name = (worker: string) => names.get(worker) || worker, ask =(a: { title: string; worker: string }) => '"' + a.title + '" on ' + name(a.worker)
  const state = !dispatch.enabled ? [el('p', { class: 'muted' }, 'Automatic starts off'), fold('How to turn them on', 'Dispatch is off (dispatch.enabled: false) in the configuration: System proposes no start by itself.')]
    : dispatch.paused ? [el('p', { class: 'soon' }, 'Automatic starts paused' + (dispatch.paused.reason ? ' · ' + dispatch.paused.reason : '') + ' · since ' + when(dispatch.paused.since)),
      fold('How to resume', 'System proposes no start until you resume it: system dispatch resume.')]
    : (dispatch.pausedProjects ?? []).map((p) => el('p', { class: 'soon' }, 'Automatic starts paused in project ' + (p.projectId ?? '') + (p.reason ? ' · ' + p.reason : '') + ' · since ' + when(p.since) + ' · resume: system dispatch resume --project ' + (p.projectId ?? '')))
  const item = (a: (typeof asked)[number]) => {
    const r = requests.get(a.requestId as string) as ApprovalRequest
    // A Deny is final for this attempt (T197): its description says so, and a note beside the buttons keeps it in sight.
    const buttons = verdictButtons('starts it on ' + name(a.worker), DISPATCH_DENY, (verdict, pair, clicked) => void queue?.decide([{ requestId: r.requestId, subject: r.subject, verdict }], undefined, undefined, pair, clicked))
    const read = a.windows.filter((w) => w.observedAt).map((w) => windowName(w) + ' read ' + clockOf(w.observedAt as string))
    return el('li', { class: 'go', 'aria-label': 'Start of ' + a.title },
      el('div', {}, el('strong', {}, a.title), el('span', { class: 'muted' }, ' · attempt ' + a.attempt + ' · ' + name(a.worker))),
      a.windows.map((w) => el('div', { class: 'window' }, w.used !== undefined ? el('meter', { min: '0', max: '100', low: '60', high: '85', optimum: '0', value: String(w.used), 'aria-hidden': 'true' }) : null, el('span', {}, goWindow(w)))),
      fold('Why this Worker?', el('div', {}, a.why), read.length ? el('div', { class: 'muted' }, read.join(' · ')) : null, el('div', { class: 'muted' }, 'project ' + a.projectId)),
      el('div', { class: 'actions' }, buttons, expires(r.expiresAt, 'denied'), ' ', jump('request-' + r.requestId, 'Review request')),
      el('p', { class: 'muted deny-note' }, 'Deny is final for attempt ' + a.attempt + ': it is not asked again.'))
  }
  const last = dispatch.lastPass
  const reasons = last?.tasks.length ? fold('Why ready tasks did not start (' + relative(last.at) + ')',
    el('ul', {}, last.tasks.map((t) => el('li', {}, '"' + t.title + '": ' + t.reason))), last.more ? el('p', { class: 'muted' }, qty(last.more, 'more ready task') + ' not listed.') : null)
    : last?.reason ? keptFold('dispatch-last', 'Last look, ' + relative(last.at), last.reason + '.') : null
  return wrap(state,
    unread.length ? el('p', { class: 'state failed' }, 'Approvals unreadable, so these starts cannot be decided here now: ' + unread.map(ask).join(', ') + '.')
      : asked.length ? el('ul', { class: 'goes plain' }, asked.map(item))
      : el('p', { class: 'muted' }, 'No starts awaiting approval.'),
    approved.length ? el('p', {}, qty(approved.length, 'approved start') + ' waiting for a free Worker: ' + approved.map(ask).join(', ') + '.') : null,
    reasons)
}

// The last daily run of every browser spec on dev's tip, its state, commit, last green commit, and the task a failure proposed; shown only when the daily run is on or has run.
const DAILY_TONE: Record<string, string> = { passed: 'ok', failed: 'bad', error: 'warn', running: 'info' }
export function dailyView(daily: Daily): HTMLElement | null {
  if (!daily || (!('error' in daily) && !daily.enabled && !daily.last)) return null
  const wrap = (...parts: Child[]) => panel('Daily run', 'Daily run of every browser spec', ...parts)
  if ('error' in daily) return wrap(el('p', { class: 'state failed' }, 'The daily run could not be read: ' + daily.error.message + '.'))
  const l = daily.last
  if (!l) return wrap(el('p', { class: 'muted' }, 'No daily run yet: it runs once a day on ' + daily.ref + ', from ' + String(daily.hourUtc).padStart(2, '0') + ':00 UTC.'))
  return wrap(
    el('p', {}, chip(l.state, DAILY_TONE[l.state] ?? 'idle'), ' ', l.ref + ' at ' + l.commit.slice(0, 12) + ' · ', ago(l.startedAt)),
    l.problem ? el('p', { class: 'muted' }, l.problem) : null,
    l.taskId ? el('p', {}, (l.duplicate ? 'Open already: task ' : 'Proposed task ') + l.taskId + '.') : null,
    el('p', { class: 'muted' }, daily.lastGreen ? 'Last green: ' + daily.lastGreen.commit.slice(0, 12) + ' on ' + daily.lastGreen.day : 'No daily run has passed yet.'))
}

// What dispatch started in the last 24 h, as a table: one row per task (its newest attempt), every attempt, with how it was let start, folded into the row.
const STARTED_HOW: Record<string, string> = { auto: 'by policy (auto)', notify: 'by policy (notify)', ask: 'on your approval', board: 'approved on the board' }
const STARTED_TONE: Record<string, string> = { running: 'info', completed: 'ok', failed: 'bad', cancelled: 'idle' }
const STARTED_HEAD = ['Task', 'State', 'Worker', 'Run time', 'Started']
export function startedView(dispatch: Dispatch, names: Map<string, string>, runs: RunSummary[]): HTMLElement | null {
  if (!dispatch || 'error' in dispatch || !dispatch.started?.length) return null
  type Started = NonNullable<DispatchResponse['started']>[number]
  const byRun = new Map(runs.map((r) => [r.runId, r])), tasks = new Map<string, Started[]>()
  for (const s of [...dispatch.started].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) tasks.set(s.taskId, [...(tasks.get(s.taskId) ?? []), s])
  const name = (worker: string) => names.get(worker) || worker, runTime = (s: Started) => {
    const run = byRun.get(s.runId)
    if (!run) return el('span', { class: 'muted', title: 'its run is not among the latest read' }, '—')
    return run.status === 'running' ? elapsedView(run.createdAt) : tookView(run.createdAt, run.updatedAt)
  }
  const row = ([, attempts]: [string, Started[]]) => {
    const s = attempts[0] as Started
    return labelled(STARTED_HEAD, el('tr', { 'aria-label': 'Started by itself: ' + s.title },
      el('td', {}, runLink(s.runId, s.title), ' ',
        el('details', { class: 'fold inline' }, el('summary', {}, attempts.length === 1 ? 'attempt ' + s.attempt : qty(attempts.length, 'attempt')),
          attempts.map((a) => el('div', { class: 'muted' }, 'attempt ' + a.attempt + ' · ' + a.runStatus + ' · ' + name(a.worker) + ' · ' + (STARTED_HOW[a.mode] ?? a.mode) + ' · ', ago(a.startedAt), ' ', runLink(a.runId, 'open run'))))),
      el('td', { class: 'nowrap' }, chip(s.runStatus, STARTED_TONE[s.runStatus] ?? 'idle')),
      el('td', {}, name(s.worker)),
      el('td', { class: 'num' }, runTime(s)),
      el('td', { class: 'nowrap muted' }, ago(s.startedAt))))
  }
  const [body, more] = capped('started', el('tbody', { id: 'started-list' }), [...tasks.entries()], row)
  return el('section', { class: 'page-bottom', 'aria-label': 'Started by itself' }, el('h2', {}, 'Started by itself'),
    el('table', { class: 'started' }, el('thead', {}, el('tr', {}, STARTED_HEAD.map((h) => el('th', {}, h)))), body), more)
}
