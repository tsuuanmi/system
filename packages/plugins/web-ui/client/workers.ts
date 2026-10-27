// The Workers by account (docs/design/roster.md): each account once, with its quota, then its Workers (its roles); every unknown, derived, or technical fact folded under a card's details, never dropped.
import type { AccountInfo, Pool, ProjectsResponse, RosterResponse, RosterWorker, WorkItem } from '../src/api.js'
import { ago, chip, clockOf, el, fold, keepOpen, keptFold, qty, relative, shortId, span, type Child } from './dom.js'
import { pageHead, whatIs } from './glossary.js'
import { pageLink } from './router.js'
import { api, quiet, show } from './state.js'
import { accountsOf, availabilityChips, cut, glanceView, isKnown, meter, poolsOf, readyNow, restingText, runOpen, shortestOf, statusOf, textOf, unknownSpan, type Group } from './roster.js'
import { stepWords } from './runwords.js'

const ISO_TIME = /\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)/g
const clocked = (text: string) => text.replace(ISO_TIME, (iso) => Number.isNaN(Date.parse(iso)) ? iso : clockOf(iso))
type Window = Pool['windows'][number]
const noReading = (win: Window) => !isKnown(win.used) && win.used.unknown.startsWith('no reading yet') ? win.used.unknown : undefined
const windowLine = (win: Window, label: string) => {
  const none = noReading(win)
  if (none) return label + ' · ' + clocked(none)
  return label + ' · ' + (win.state === 'limited' ? 'at its limit · ' : '') + (isKnown(win.used) ? 'used ' + win.used.value + ' %' : 'used unknown (' + win.used.unknown + ')')
    + ' · resets ' + (isKnown(win.resets) ? clockOf(win.resets.value) : 'unknown (' + win.resets.unknown + ')')
}
const readTimes = (pools: Pool[]) => pools.flatMap((p) => p.windows.filter((w) => w.observedAt).map((w) => (pools.length > 1 ? p.pool + ' ' : '') + (w.seconds ? span(w.seconds) : w.id) + ' read ' + clockOf(w.observedAt as string))).join('; ')
// A pool's windows, the ones at their limit first; windows with no reading yet for the same reason read as one line.
const windowsView = (p: Pool) => {
  const named = (win: Window) => win.seconds ? span(win.seconds) + (p.windows.filter((w) => w.seconds === win.seconds).length > 1 ? ' (' + win.id + ')' : '') : win.id
  const lines: Array<{ none: string | undefined; windows: Window[] }> = []
  for (const win of [...p.windows].sort((x, y) => Number(y.state === 'limited') - Number(x.state === 'limited'))) {
    const none = noReading(win), same = none ? lines.find((l) => l.none === none) : undefined
    if (same) same.windows.push(win); else lines.push({ none, windows: [win] })
  }
  return lines.map(({ windows }) => {
    const [win] = windows as [Window, ...Window[]]
    return el('div', { class: 'window' + (win.state === 'limited' ? ' limited' : ''), 'aria-label': 'window ' + windows.map((w) => w.id).join(', ') + ' of ' + p.pool },
      isKnown(win.used) ? meter(win.used.value) : null, el('span', {}, windowLine(win, windows.map(named).join(', '))))
  })
}
const poolsView = (pools: Pool[], rested: boolean) => [...pools].sort((x, y) => Number(x.available) - Number(y.available)).map((p) => el('div', { class: 'pool' },
  pools.length > 1 || (!p.available && !rested) ? el('div', {}, pools.length > 1 ? el('strong', {}, p.pool + ' ') : null, p.available || rested ? null : el('span', { class: 'state resting' }, p.until ? restingText(p.until) : 'resting; no reset is known')) : null,
  windowsView(p),
  p.unknownUsage && isKnown(p.unknownUsage) && p.unknownUsage.value.runs ? el('div', { class: 'unknown' }, p.unknownUsage.value.runs + ' run(s) with usage it could not count') : null))
const detailsOf = (rows: Array<[string, Child] | null>) => el('details', { class: 'facts' }, el('summary', {}, 'Details'), el('dl', {}, rows.flatMap((row) => row ? [el('dt', {}, row[0]), el('dd', {}, row[1])] : [])))
const recordText = (a: AccountInfo) => a.id + (isKnown(a.record) ? ' · ' + a.record.value.kind + ' account, ' + a.record.value.status + (a.record.value.slot !== undefined ? ', slot ' + a.record.value.slot : '') : ' · its record is unknown (' + a.record.unknown + ')')
const doingText = (i: WorkItem) => {
  const task = i.task && isKnown(i.task.board) ? i.task.board.value : undefined, long = isKnown(i.since) ? ', for ' + relative(i.since.value).replace(/ ago$/, '') : ''
  return task ? 'Working on "' + task.title + '"' + long : 'Running ' + (stepWords(i.nodeId) ? stepWords(i.nodeId) + ' in a team run' : 'step ' + i.nodeId + ' of a ' + i.template + ' run') + long
}
// Which project a step's run is for (T253): its board task's; a run outside the board is in none; a task the roster could not read leaves it unknown.
const projectTag = (i: WorkItem, projectName: (id: string) => string) => !i.task ? el('span', { class: 'tag project' }, 'no project')
  : isKnown(i.task.board) ? el('span', { class: 'tag project', title: 'project ' + i.task.board.value.projectId }, projectName(i.task.board.value.projectId))
  : el('span', { class: 'tag project unknown' }, 'project unknown')
const doingOf = (w: RosterWorker, projectName: (id: string) => string) => {
  const items = isKnown(w.work) ? w.work.value.items : [], live = w.liveness && isKnown(w.liveness) ? w.liveness.value : []
  if (!items.length && !live.length) return null
  return el('div', { class: 'doing' },
    items.length ? el('ul', { 'aria-label': 'Doing now' }, items.map((i) => el('li', { 'data-project': i.task && isKnown(i.task.board) ? i.task.board.value.projectId : '' }, doingText(i), ' ', projectTag(i, projectName), ' ', i.startedBy === 'dispatch' ? [chip('started by itself', 'info'), ' '] : null, runOpen(i.runId)))) : null,
    isKnown(w.work) && w.work.value.more ? el('div', { class: 'muted' }, w.work.value.more + ' more step(s) not listed') : null,
    live.length ? el('ul', { 'aria-label': 'Runs whose liveness needs a look' }, live.map((r) => el('li', { class: r.state === 'unknown' ? 'state failed' : 'unknown' }, r.summary, r.runId ? [' ', runOpen(r.runId)] : null, whatIs(r.state === 'unknown' ? 'held' : 'stalled')))) : null)
}
const TONE: Record<string, [string, string]> = { ready: ['free', 'ok'], busy: ['working', 'info'], resting: ['resting', 'warn'], unavailable: ['unavailable', 'bad'], quarantined: ['quarantined', 'bad'] }
const LIVE: Record<string, string> = { stalled: 'Stalled', looking: 'Being looked at', unknown: 'Not known to be gone' }
const heldOff = (l: { capability: string; until: string }) => l.capability + ' is held off until ' + clockOf(l.until) + ' (' + relative(l.until) + ')'
// What blocks work (unavailable, quarantined, a capability held off) and each run whose liveness needs a look (PROP-0013) is never folded.
const alarmsOf = (workers: RosterWorker[], inAccount: boolean) => {
  const lines = workers.flatMap((w) => {
    const who = el('strong', {}, (inAccount ? cut(w.name)[1] : w.name) + ': '), a = w.availability
    return [
      a.state === 'unavailable' || a.state === 'quarantined' ? el('li', {}, who, chip(statusOf(w), 'bad')) : null,
      ...w.limits.map((l) => el('li', { class: 'state resting' }, who, heldOff(l))),
      ...(w.liveness && isKnown(w.liveness) ? w.liveness.value : []).map((r) => el('li', {}, who, chip(LIVE[r.state] ?? r.state, r.state === 'unknown' ? 'bad' : 'warn'),
        r.runId ? [' ', runOpen(r.runId)] : null, whatIs(r.state === 'unknown' ? 'held' : 'stalled'), keptFold('live-' + r.execution, 'What to do', r.summary))),
    ].filter(Boolean)
  })
  return lines.length ? el('ul', { class: 'plain alarms', 'aria-label': 'Needs a look' }, lines) : null
}
const workersFold = (key: string, workers: RosterWorker[], render: (w: RosterWorker) => HTMLElement) => {
  const by = new Map<string, number>()
  for (const w of workers) by.set(w.availability.state, (by.get(w.availability.state) || 0) + 1)
  const details = el('details', { class: 'workers-fold' },
    el('summary', {}, workers.length === 1 ? 'Worker' : 'Workers', [...by].map(([state, n]) => [' ', chip(n + ' ' + (TONE[state]?.[0] ?? state), TONE[state]?.[1] ?? 'idle')])),
    el('div', { class: 'workers-grid' }, workers.map(render)))
  keepOpen(details, 'workers-' + key, false)
  return details
}
const workerCard = (w: RosterWorker, inAccount: boolean, projectName: (id: string) => string) => el('article', { class: 'panel request worker', 'aria-label': w.name + ' (' + w.worker + ')' },
  el('h4', {}, inAccount ? cut(w.name)[1] : w.name),
  w.description && isKnown(w.description) ? el('p', {}, w.description.value) : null,
  el('p', { class: 'status-line' }, chip(statusOf(w), TONE[w.availability.state]?.[1] ?? 'idle'), w.availability.state === 'resting' ? whatIs('resting') : w.availability.state === 'quarantined' ? whatIs('quarantine') : null),
  doingOf(w, projectName),
  w.limits.length ? el('div', {}, w.limits.map((l) => el('div', { class: 'state resting' }, heldOff(l)))) : null,
  w.teams && isKnown(w.teams) ? el('p', { class: 'teams' }, chip('Excluded from teams', 'info'), whatIs('team')) : null,
  detailsOf([
    ['Worker id', shortId(w.worker, 'Copy Worker ID')],
    isKnown(w.work) && w.work.value.items.length ? ['Steps, as recorded', el('div', {}, w.work.value.items.map((i) => el('div', {}, i.summary)))] : null,
    w.teams && isKnown(w.teams) ? ['Teams', w.teams.value.summary] : w.teams ? ['Teams', unknownSpan(w.teams.unknown)] : null,
    w.description && isKnown(w.description) ? null : ['What it is', el('span', {}, el('span', { class: 'tag' }, 'derived'), ' ' + w.derived + ' (no description is configured)', whatIs('derived'))],
    isKnown(w.work) ? (w.work.value.unread ? ['Doing now', el('span', { class: 'unknown' }, w.work.value.unread)] : null) : ['Doing now', unknownSpan(w.work.unknown)],
    w.liveness && !isKnown(w.liveness) ? ['Liveness', unknownSpan(w.liveness.unknown)] : null,
    ['Account', isKnown(w.account) ? recordText(w.account.value) : unknownSpan(w.account.unknown)],
    ['Serves', w.tier + ' tier, ' + w.quotaClass + ', ' + w.locality + '; provider ' + w.provider + ', family ' + textOf(w.family) + ', role ' + textOf(w.role, (r) => r === null ? 'none' : r)],
    inAccount ? null : ['Quota', isKnown(w.pools) ? (w.pools.value.length ? el('div', {}, poolsView(w.pools.value, false)) : 'no pool on its account') : unknownSpan(w.pools.unknown)],
    !inAccount && isKnown(w.pools) && readTimes(w.pools.value) ? ['Quota read', readTimes(w.pools.value)] : null,
    ['Load', textOf(w.load, (l) => l.running + ' of ' + l.slots + ' running, ' + l.queued + ' queued, ' + l.pending + ' routed and not started')],
  ]))
const accountView = (g: Group, projectName: (id: string) => string) => {
  const a = g.account as AccountInfo, pools = poolsOf(g), unknownPools = g.workers.find((w) => !isKnown(w.pools))
  const record = isKnown(a.record) ? a.record.value : undefined, shortest = pools?.length ? shortestOf(g) : undefined
  return el('section', { class: 'panel account', 'aria-label': 'Account ' + g.name },
    el('div', { class: 'line' }, el('h3', {}, g.name, el('span', { class: 'muted' }, ' · ' + qty(g.workers.length, 'Worker')), whatIs('account')),
      a.limitUntil ? chip('Resting until ' + clockOf(a.limitUntil) + ' (' + relative(a.limitUntil) + ')', 'warn') : null),
    record && record.status !== 'ready' ? el('p', { class: 'state ' + (record.status === 'quarantined' || record.status === 'signed-out' ? 'unavailable' : 'unknown') }, 'Its account is ' + record.status.replace('-', ' ') + (record.quarantine ? ' (' + record.quarantine.reason + (record.quarantine.detail ? ': ' + record.quarantine.detail : '') + ')' : '')) : null,
    record?.sameAs ? el('p', { class: 'state failed' }, 'Signed in as the same person as ' + record.sameAs.join(', ')) : null,
    shortest ? el('div', { class: 'quota-line' }, shortest.bar, shortest.text || 'quota not tracked', whatIs('quota')) : null,
    pools && !pools.length ? el('p', { class: 'muted' }, 'Quota not tracked') : null,
    detailsOf([
      pools?.length ? ['Quota', el('div', { class: 'quota' }, poolsView(pools, !!a.limitUntil))] : null,
      ['Account', recordText(a)],
      ['Roles', g.workers.map((w) => cut(w.name)[1]).join(', ')],
      pools ? (pools.length ? null : ['Quota', 'no pool on its account']) : ['Quota', unknownSpan(unknownPools && !isKnown(unknownPools.pools) ? unknownPools.pools.unknown : 'not read')],
      pools && readTimes(pools) ? ['Quota read', readTimes(pools)] : null,
    ]),
    alarmsOf(g.workers, true),
    workersFold(g.key, g.workers, (w) => workerCard(w, true, projectName)))
}
export async function workersView(): Promise<void> {
  const roster = await api<RosterResponse>('roster'), { now } = roster
  const projects = (await quiet<ProjectsResponse>('projects'))?.projects
  const ready = readyNow(now) ?? projects?.reduce((n, p) => n + (p.open.ready || 0), 0)
  const projectName = (id: string) => projects?.find((p) => p.projectId === id)?.title || id
  const unheard = isKnown(roster.sources) ? roster.sources.value.filter((s) => s.state !== 'described') : []
  const accounts = !isKnown(roster.workers) ? el('p', { class: 'unknown' }, 'The Workers are unknown (' + roster.workers.unknown + ').')
    : !roster.workers.value.length ? el('p', { class: 'muted' }, 'No Workers set up yet · ', pageLink('help', 'How Workers work'))
    : (() => {
      const groups = accountsOf(roster.workers.value), lone = groups.filter((g) => !g.account)
      return el('section', { 'aria-label': 'Accounts' }, el('h2', {}, 'Accounts'), el('div', { class: 'accounts-grid' }, groups.filter((g) => g.account).map((g) => accountView(g, projectName)),
        lone.length ? el('section', { class: 'panel account', 'aria-label': 'Workers of no account' }, el('h3', {}, 'Workers of no account'),
          alarmsOf(lone.map((g) => g.workers[0] as RosterWorker), false), workersFold('lone', lone.map((g) => g.workers[0] as RosterWorker), (w) => workerCard(w, false, projectName))) : null))
    })()
  show(
    pageHead('workers'),
    availabilityChips(roster, []),
    el('div', { class: 'page-grid' }, el('div', { class: 'col-main' }, accounts), el('div', { class: 'col-side' },
      now && isKnown(roster.workers) && roster.workers.value.length ? glanceView(now, ready, roster.workers.value, true, roster.asOf) : fold('Roster read', ago(roster.asOf)),
      isKnown(roster.sources) ? null : el('p', { class: 'unknown' }, 'Worker sources: unknown (' + roster.sources.unknown + ')'),
      unheard.length ? el('div', {}, unheard.map((s) => s.describing
        ? el('div', { class: 'muted' }, s.source + ' loading — counts incomplete', fold('Details', 'Its first read since it started has not landed (' + relative(s.at) + '); its Workers are not listed yet.'))
        : el('div', { class: 'state failed' }, s.source + ' unavailable — counts incomplete' + (s.detail ? ': ' + s.detail : ''), fold('Details', 'It was ' + s.state + ' ' + relative(s.at) + '; its Workers are not listed.')))) : null)))
}
