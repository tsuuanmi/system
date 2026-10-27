// The roster as Home and the Workers page both read it (docs/design/roster.md): accounts, quota, a Worker's status, and Right now, rendered as the server made it (T152).
import type { AccountInfo, Known, NowRows, Pool, Quota, RosterNow, RosterResponse, RosterWorker } from '../src/api.js'
import { ago, chip, clockOf, el, fold, keepOpen, keptFold, qty, relative, span, when, type Child } from './dom.js'
import { whatIs } from './glossary.js'
import { pageLink, runLink } from './router.js'

export const isKnown = <T>(k: Known<T>): k is { value: T } => 'value' in k
export const textOf = <T>(k: Known<T>, render?: (value: T) => string): string => isKnown(k) ? (render ? render(k.value) : String(k.value)) : 'unknown (' + k.unknown + ')'
export const unknownSpan = (why: string) => el('span', { class: 'unknown' }, 'unknown (' + why + ')')
/** A display name is "<runtime> · <account> · <work>". */
export const cut = (name: string): [account: string, work: string] => { const i = name.lastIndexOf(' · '); return i > 0 ? [name.slice(0, i), name.slice(i + 3)] : [name, name] }
export const workerNames = (roster?: RosterResponse | null): Map<string, string> => new Map(roster && isKnown(roster.workers) ? roster.workers.value.map((w) => [w.worker, w.name]) : [])
export const runOpen = (runId: string) => runLink(runId, 'open run', 'Open run ' + runId)
export const meter = (used: number) => el('meter', { min: '0', max: '100', low: '60', high: '85', optimum: '0', value: String(used), 'aria-hidden': 'true' })
export interface Group { key: string; name: string; account: AccountInfo | undefined; workers: RosterWorker[] }
/** Each account once, with its Workers in roster order; the Workers of no account last, each on its own. */
export const accountsOf = (workers: RosterWorker[]): Group[] => {
  const groups = new Map<string, Group>()
  for (const w of workers) {
    const account = isKnown(w.account) ? w.account.value : undefined, key = account ? 'account:' + account.id : 'worker:' + w.worker
    let g = groups.get(key)
    if (!g) groups.set(key, g = { key, name: account ? cut(w.name)[0] : w.name, account, workers: [] })
    g.workers.push(w)
    if (g.account && !g.account.limitUntil && account?.limitUntil) g.account = account // the account rests when any of its Workers says it does
  }
  const all = [...groups.values()]
  return all.filter((g) => g.account).concat(all.filter((g) => !g.account))
}
export const poolsOf = (g: Group): Pool[] | undefined => { for (const w of g.workers) if (isKnown(w.pools)) return w.pools.value; return undefined }
export const restingText = (until: string) => 'resting until ' + clockOf(until) + ' (' + relative(until) + ')'
/** An account's shortest window (the 5 h one) as a small bar and a few words. */
export const shortestOf = (g: Group) => {
  const pick = (poolsOf(g) ?? []).flatMap((p) => p.windows.filter((win) => win.seconds).map((win) => ({ win, seconds: win.seconds as number }))).sort((x, y) => x.seconds - y.seconds)[0]
  const used = pick && isKnown(pick.win.used) ? pick.win.used.value : undefined, bar = used !== undefined ? meter(used) : el('span', { class: 'no-bar', 'aria-hidden': 'true' })
  const text = !pick ? null : span(pick.seconds) + ' ' + (pick.win.state === 'limited' ? 'at its limit, ' : '')
    + (used !== undefined ? 'used ' + used + ' %' + (isKnown(pick.win.resets) ? ', resets ' + clockOf(pick.win.resets.value) : '')
      : !isKnown(pick.win.used) && pick.win.used.unknown.startsWith('no reading yet') ? 'no reading yet' : 'used unknown')
  return { bar, text }
}
/** An account's capacity in one line: its shortest window with a small bar, and, when it rests at a limit, until when. */
export const capacityLine = (g: Group) => {
  const pools = poolsOf(g) ?? [], { bar, text } = shortestOf(g)
  const resting = g.account?.limitUntil ?? pools.filter((p) => !p.available && p.until).map((p) => p.until as string).sort().at(-1)
  return el('li', { class: 'capacity', 'aria-label': 'Capacity of ' + g.name }, bar,
    el('span', {}, g.name + ': ' + ([resting ? restingText(resting) : null, text].filter(Boolean).join('; ') || (poolsOf(g) ? 'quota not tracked' : 'quota unknown'))))
}
/** Idle capacity in numbers. */
export const capacityText = (free: number | undefined, ready: number) => (free === undefined ? 'Free Workers unknown' : qty(free, 'Worker') + ' free') + ' · ' + qty(ready, 'task') + ' ready'
// The Workers' availability as chips, the same on Home and on Workers: free always, the others when there are any.
const AVAILABLE = [['ready', 'free', 'ok'], ['busy', 'working', 'info'], ['resting', 'resting', 'warn'], ['unavailable', 'unavailable', 'bad'], ['quarantined', 'quarantined', 'bad']] as const
export const availabilityChips = (roster: RosterResponse, describing: string[]) => {
  const c = roster.counts
  return el('ul', { class: 'chips availability', 'aria-label': 'Worker counts' },
    AVAILABLE.filter(([k]) => k === 'ready' || c[k]).map(([k, word, tone]) => el('li', {}, chip((c[k] ?? 0) + ' ' + word, c[k] ? tone : 'idle'))),
    roster.unlisted ? el('li', { class: 'muted' }, roster.unlisted + ' more not listed') : null,
    describing.length ? el('li', { class: 'unknown' }, 'counts incomplete: ' + describing.join(', ') + ' loading') : null)
}
const QUARANTINE: Record<string, string> = { changed: 'signed in as someone else', ambiguous: 'could not be told apart from another', duplicate: 'is the same person as another', unverified: 'is not verified' }
/** A Worker's status in the cross-page words: Free, Working · 1/2 slots, Resting until 14:20, Unavailable — why, Quarantined — why. */
export const statusOf = (w: RosterWorker): string => {
  const a = w.availability
  switch (a.state) {
    case 'busy': { const running = a.running ?? 0; return a.slots !== undefined ? 'Working · ' + running + '/' + a.slots + ' slots' + (running < a.slots ? ' · ' + qty(a.slots - running, 'slot') + ' free' : '') : 'Working' }
    case 'ready': return 'Free'
    case 'resting': return isKnown(a.until) ? 'Resting until ' + clockOf(a.until.value) + ' (' + relative(a.until.value) + ')' : 'Resting: no reset is known (' + a.until.unknown + ')'
    case 'unavailable': return 'Unavailable — ' + textOf(a.reason)
    case 'quarantined': return 'Quarantined — its account ' + (QUARANTINE[a.reason] ?? a.reason) + (a.detail ? ' (' + a.detail + ')' : '') + ', since ' + when(a.since)
  }
}
/** The ready tasks as capacity now read them, when it could read every active project; else undefined. */
export const readyNow = (now: RosterNow | undefined): number | undefined => now && isKnown(now.ready) && !now.ready.value.unread ? now.ready.value.items.length + (now.ready.value.more ?? 0) : undefined
const SHOWN = 3, rowsOf = <T>(k: NowRows<T>) => isKnown(k) ? k.value : undefined
const has = (k: NowRows<unknown>) => (rowsOf(k)?.items.length ?? 0) > 0
const countOf = (k: NowRows<unknown>) => { const v = rowsOf(k); return v ? v.items.length + (v.more ?? 0) : 0 }
/** "Label: N — a; b; c": a count first, then the names past the first three folded; what could not be read is unknown with why, never 0. */
function row<T>(label: string, k: NowRows<T>, line: (x: T) => Child, extra?: Child): HTMLElement {
  if (!isKnown(k)) return el('li', {}, el('strong', {}, label + ': '), unknownSpan(k.unknown), extra)
  const { items, more } = k.value
  const named = (list: T[]) => list.map((x, i) => [i ? '; ' : '', line(x)])
  return el('li', {}, el('strong', {}, label + ': '), String(items.length + (more ?? 0)),
    items.length ? [' — ', named(items.slice(0, SHOWN)), items.length > SHOWN ? fold((items.length - SHOWN) + ' more', named(items.slice(SHOWN))) : null, more ? ' · ' + more + ' not listed' : null] : null, extra)
}
const quotaText = (q: Quota | null) => q
  ? q.left + ' % of ' + (q.seconds ? span(q.seconds) : q.window) + ' left' + (q.headroom !== undefined ? ' (headroom ' + q.headroom + ' above the reserve)' : '') + (q.resetsAt ? ', resets ' + clockOf(q.resetsAt) : ', reset unknown') : 'quota not tracked'
/** Right now, by name (T141): who is free, whose quota is unknown, who is stuck, who has no quota left, who cannot work, and the ready tasks with their likely Worker; `folded` is the Workers page's. */
export function glanceView(now: RosterNow, ready: number | undefined, workers: RosterWorker[], folded = false, asOf?: string): HTMLElement {
  const keptOut = new Set(workers.filter((w) => w.teams && isKnown(w.teams)).map((w) => w.worker)), { stalled } = now
  const rows = el('ul', {},
    row('Free', now.free, (f) => f.name + ' (' + quotaText(f.quota) + (keptOut.has(f.worker) ? '; excluded from teams: free for other steps, not team work' : '') + ')', has(now.free) && ready ? [' · ' + qty(ready, 'task') + ' ready: ', pageLink('board', 'Open Board')] : null),
    has(now.quotaUnknown) ? row('Quota unknown', now.quotaUnknown, (u) => u.name, keptFold('quota-unknown', 'Why', 'Not counted free: ', (rowsOf(now.quotaUnknown)?.items ?? []).map((u, i) => [i ? '; ' : '', u.name + ' (' + u.why + ')']))) : null,
    row('Stalled', stalled, (s) => [s.name + ' ', s.runId ? runOpen(s.runId) : null], [has(stalled) ? whatIs('stalled') : null, rowsOf(stalled)?.unread ? el('span', { class: 'unknown' }, ' ' + rowsOf(stalled)?.unread) : null]),
    row('No quota left', now.noQuota, (n) => n.name + (isKnown(n.until) ? ' until ' + clockOf(n.until.value) + ' (' + relative(n.until.value) + ')' : ', no reset known')),
    has(now.cannotWork) ? row('Cannot work', now.cannotWork, (w) => w.name + ' (' + w.reason + ')') : null,
    has(now.ready) ? row('Ready', now.ready, (t) => '"' + t.title + '": ' + (isKnown(t.likely) ? (t.likely.value ? 'likely ' + t.likely.value.name : 'no Worker that takes work now can take it') : 'its Worker is unknown (' + t.likely.unknown + ')')) : null)
  if (!folded) return el('section', { class: 'right-now', 'aria-label': 'Right now' }, el('h3', {}, 'Right now'), rows)
  // Folded under its heading, a chip each; open while someone is stalled or cannot work.
  const chips = ([[stalled, 'stalled', 'bad'], [now.cannotWork, 'cannot work', 'bad'], [now.quotaUnknown, 'quota unknown', 'warn'], [now.ready, 'ready', 'info']] as const)
    .filter(([k]) => countOf(k)).map(([k, word, tone]) => [' ', chip(countOf(k) + ' ' + word, tone)])
  const details = el('details', { class: 'right-now' }, el('summary', {}, el('h3', {}, 'Right now'), chips), rows, asOf ? el('p', { class: 'muted' }, 'Roster read ', ago(asOf)) : null)
  keepOpen(details, 'right-now', has(stalled) || has(now.cannotWork))
  return el('section', { class: 'panel', 'aria-label': 'Right now' }, details)
}
