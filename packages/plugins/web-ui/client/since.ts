// "Since you last looked" (T124): what happened to runs, tasks, Workers, and requests since the operator marked Home as seen.
import type { ActivityResponse, RosterResponse } from '../src/api.js'
import { capped, clockOf, el, fold, relative, type Child } from './dom.js'
import { decideLink, runLink, toReview, anchor } from './router.js'
import { api, asApiError, markSeen, refresh, seenOf, type Seen } from './state.js'
import { failureReason } from './runwords.js'
import { isKnown } from './roster.js'

interface Item { at: string; line: HTMLElement; link: Child; fold?: HTMLElement }
const statusSnapshot = (roster?: RosterResponse): Record<string, string> =>
  roster && isKnown(roster.workers) ? Object.fromEntries(roster.workers.value.map((w) => [w.worker, w.availability.state])) : {}
const back = (s: string) => s === 'ready' || s === 'busy'
// One line each, newest first: what happened to runs, tasks, Workers, and requests since then.
const sinceItems = (activity: ActivityResponse, roster: RosterResponse | undefined, seen: Seen, titles: Map<string, string>): Item[] => {
  const items: Item[] = []
  if (isKnown(activity.runs)) for (const r of activity.runs.value) {
    const title = r.taskId ? titles.get(r.taskId) : undefined
    const what = title ? '"' + title + '"' : 'a ' + r.template + ' run'
    const reason = r.status === 'failed' && r.error ? failureReason(r.failure ?? {}) || 'no reason in words is known for it' : null
    items.push({ at: r.at, line: el('span', { class: r.status === 'failed' ? 'state failed' : '' }, r.status === 'failed' ? 'Failed: ' + what + (reason ? ' — ' + reason : '') + ' ' : 'Finished: ' + what + ' '), link: runLink(r.runId, 'open the run'),
      ...(reason ? { fold: fold('What the system said', el('div', { class: 'muted' }, r.error)) } : {}) })
  }
  if (isKnown(activity.tasks)) for (const t of activity.tasks.value) {
    const l = t.landing, q = '"' + t.title + '"'
    const line = t.state === 'done' ? (l?.state === 'merged' ? 'Merged into ' + (l.base || 'its base') + ': ' + q : l?.state === 'asked' ? 'Accepted, waiting for you to merge: ' + q : l?.state === 'refused' ? 'Accepted, not merged (' + (l.reason || 'refused') + '): ' + q : 'Accepted: ' + q)
      : t.state === 'review' ? 'Waits for your review: ' + q
      : t.state === 'waiting-for-approval' ? 'Waits for your approval: ' + q
      : t.state === 'waiting-for-input' ? 'Waits for input: ' + q + (t.waiting ? ' (' + t.waiting.reason + ')' : '')
      : 'Cancelled: ' + q
    const request = l?.state === 'asked' && l.requestId ? l.requestId : t.waiting?.approvalRequest
    items.push({ at: t.at, line: el('span', {}, line + ' '), link: request ? decideLink(request, 'decide it') : t.state === 'review' ? anchor('#review-' + t.taskId, 'review it', () => { toReview(t.taskId) }) : t.run ? runLink(t.run.runId, 'open its run') : null })
  }
  if (isKnown(activity.expired)) for (const x of activity.expired.value) items.push({ at: x.at, line: el('span', { class: 'soon' }, 'Expired unanswered, so counted as denied: ' + (x.summary || 'request ' + x.requestId)), link: null })
  if (roster && isKnown(roster.workers)) for (const w of roster.workers.value) {
    const then = seen.workers[w.worker], a = w.availability
    if (!then || then === a.state) continue
    const line = a.state === 'resting' ? w.name + ' started resting' + (isKnown(a.until) ? ' until ' + clockOf(a.until.value) : '')
      : then === 'resting' && back(a.state) ? w.name + ' is back from its rest: ' + (a.state === 'ready' ? 'free' : 'working')
      : a.state === 'unavailable' || a.state === 'quarantined' ? w.name + ' became ' + a.state + ': ' + a.summary
      : back(a.state) && (then === 'unavailable' || then === 'quarantined') ? w.name + ' is available again' : null
    if (line) items.push({ at: roster.asOf, line: el('span', {}, line), link: null })
  }
  return items.sort((a, b) => b.at.localeCompare(a.at))
}
const PARTS = [['runs', 'runs that ended', 'runs ended'], ['tasks', 'tasks that moved', 'tasks moved'], ['expired', 'requests that expired', 'requests may have expired']] as const
export async function sinceView(roster: RosterResponse | undefined, titles: Map<string, string>): Promise<HTMLElement> {
  const seen = seenOf(), snapshot = statusSnapshot(roster)
  const wrap = (...parts: Child[]) => el('section', { class: 'panel', 'aria-label': 'Since you last looked' }, ...parts)
  if (!seen) {
    markSeen(snapshot)
    return wrap(el('h3', {}, 'Since you last looked'), el('p', { class: 'muted' }, 'This is your first look from this browser: from now on, what happens while you are away is listed here.'))
  }
  let activity: ActivityResponse
  try { activity = await api<ActivityResponse>('activity?since=' + encodeURIComponent(seen.at)) } catch (error) {
    return wrap(el('h3', {}, 'Since you last looked'), el('p', { class: 'state failed' }, 'What happened since could not be read: ' + asApiError(error).message + '.'))
  }
  const items = sinceItems(activity, roster, seen, titles)
  const mark = el('button', { onclick: () => { markSeen(snapshot); void refresh() } }, 'Mark as seen')
  const unread = PARTS.filter(([k]) => !('value' in activity[k]))
  return wrap(
    el('h3', {}, 'Since you last looked ', el('span', { class: 'muted' }, relative(seen.at) + ' (' + clockOf(seen.at) + ')')),
    items.length ? capped('since', el('ul', { class: 'since', id: 'since-list' }), items, (i) => el('li', {}, i.line, i.link, ' ', el('span', { class: 'muted' }, relative(i.at)), i.fold ?? null))
      : el('p', { class: 'muted' }, 'Nothing happened that needs you.'),
    unread.length ? el('p', { class: 'muted unread', title: unread.map(([k, w]) => { const part = activity[k]; return w + ': ' + ('unknown' in part ? part.unknown : '') }).join('; ') }, 'Not shown, unreadable now: ' + unread.map(([, w]) => w).join(', ') + '.') : null,
    PARTS.filter(([k]) => activity[k].more).map(([k, , words]) => { const part = activity[k]; return el('p', { class: 'muted' }, 'More ' + words + ' than the ' + ('value' in part ? part.value.length : 0) + ' read here.') }),
    el('div', { class: 'actions' }, mark, el('span', { class: 'muted' }, 'kept in this browser only')))
}
