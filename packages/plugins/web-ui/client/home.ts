// Home: what waits for the operator, by project (T253), the Workers at a glance, the decisions themselves, and the latest runs.
import type { ApprovalRequest, Batch, Known, ProjectCard, ProjectsResponse, ReviewCard, RosterResponse, RunSummary, RunsResponse } from '../src/api.js'
import { ago, capped, chip, copyId, el, fold, keptFold, labelled, qty, relative, shortId, type Child } from './dom.js'
import { dailyOf, dailyView, dispatchOf, goView, startedView } from './dispatch.js'
import { pageHead } from './glossary.js'
import { anchor, filterHome, focusOn, jump, pageLink, reportsLink, runLink } from './router.js'
import { capacityLine, capacityText, accountsOf, availabilityChips, glanceView, isKnown, readyNow } from './roster.js'
import { approvals, queue } from './queue.js'
import { reviews } from './reviews.js'
import { lookOf, needsLook, runChip, stepsText } from './runwords.js'
import { sinceView } from './since.js'
import { api, app, readWaiting, report, show } from './state.js'

const HOUR = 3600000
const RECENT = 15
const RECENT_HEAD = ['Run', 'Status', 'Progress', 'Started']
// Things "Waiting for you" names one per line; past them it says how many more, and where.
const WAITING_NAMED = 5

interface Group { key: string; slug: string; name: string; batches: Batch[]; loose: ApprovalRequest[]; requests: ApprovalRequest[]; reviews: ReviewCard[]; held: ReviewCard[]; runs: RunSummary[] }
const earliestOf = (items: Array<{ expiresAt?: string }>) => items.reduce<string | undefined>((min, r) => !min || (r.expiresAt ?? '') < min ? r.expiresAt : min, undefined)
const expiry = (iso: string) => el('span', { class: Date.parse(iso) - Date.now() < HOUR ? 'soon' : 'muted' }, ' · expires ' + relative(iso))
const runCard = (run: RunSummary, title: string) => {
  const look = lookOf(run) as [string, string]
  return el('article', { class: 'panel request', 'aria-label': title },
    el('div', { class: 'line' }, el('h4', {}, title), chip(look[0], run.status === 'failed' ? 'bad' : 'warn')),
    el('p', { class: 'meta' }, look[1] ? look[1] + ' · ' : '', 'started ', ago(run.createdAt)),
    el('div', { class: 'actions' }, runLink(run.runId, 'Open run'), copyId('Copy run ID', run.runId)))
}

export async function list(): Promise<void> {
  const { runs } = await api<RunsResponse>('runs')
  const q = await queue()
  const reviewed = await reviews()
  const okQueue = q && !('error' in q) ? q : undefined
  const okReviews = reviewed && !('failed' in reviewed) ? reviewed : undefined
  let roster: RosterResponse | null = null
  try { roster = await api<RosterResponse>('roster') } catch {}
  let projects: ProjectCard[] | undefined
  try { ({ projects } = await api<ProjectsResponse>('projects')) } catch {}
  const ready = projects?.reduce((n, p) => n + (p.open.ready || 0), 0)
  const allTasks = (projects ?? []).flatMap((p) => (p.tasks ?? []).map((t) => ({ p, t })))
  // A run's task by its title, from the Board's cards; each board task's project, for the group of a run that serves it.
  const titles = new Map(allTasks.map(({ t }) => [t.taskId, t.title]))
  const taskProject = new Map(allTasks.map(({ p, t }) => [t.taskId, p.projectId]))
  const projectTitles = new Map((projects ?? []).map((p) => [p.projectId, p.title]))
  for (const [id, p] of okQueue?.projects ?? []) if (!projectTitles.has(id) && p.title) projectTitles.set(id, p.title)
  for (const r of [...(okReviews?.listed ?? []), ...(okReviews?.accepted ?? [])]) if (!projectTitles.has(r.project.projectId) && r.project.title) projectTitles.set(r.project.projectId, r.project.title)
  const names = new Map(roster && isKnown(roster.workers) ? roster.workers.value.map((w) => [w.worker, w.name]) : [])
  const dispatch = await dispatchOf()
  const daily = await dailyOf()
  const waits = app.waits = await readWaiting()
  const part = (name: 'requests' | 'reviews' | 'runs'): Known<unknown> & { more?: boolean } => 'unknown' in waits ? { unknown: waits.unknown } : waits[name]
  const look: RunSummary[] = 'unknown' in waits ? [] : isKnown(waits.runs) ? waits.runs.value : []
  const unread = (['requests', 'reviews', 'runs'] as const).filter((name) => 'unknown' in part(name))
  const since = await sinceView(roster, titles)
  const homeProject = app.homeProject
  // A run by its task's title, else its template.
  const runTitle = (run: RunSummary, article = false) => (run.task && titles.get(run.task.taskId)) || (article ? (/^[aeiou]/.test(run.template) ? 'an ' : 'a ') : '') + run.template + ' run'
  // What needs the operator, by project (T253): each request (a batch whole, in its first request's project), each review, and each
  // run needing attention in its project's group; what is in no project in a group of its own.
  const groups = new Map<string, Group>()
  const groupOf = (key: string): Group => {
    let g = groups.get(key)
    if (!g) groups.set(key, g = { key, slug: key ? 'p-' + key : 'other', name: key ? projectTitles.get(key) || key : 'Other', batches: [], loose: [], requests: [], reviews: [], held: [], runs: [] })
    return g
  }
  for (const batch of okQueue?.batches ?? []) {
    const homeOf = (r: ApprovalRequest) => okQueue?.described.get(r.requestId)?.project || ''
    if (batch.batchId) { const g = groupOf(homeOf(batch.requests[0] as ApprovalRequest)); g.batches.push(batch); g.requests.push(...batch.requests) }
    else for (const r of batch.requests) { const g = groupOf(homeOf(r)); g.loose.push(r); g.requests.push(r) }
  }
  for (const r of okReviews?.listed ?? []) {
    const g = groupOf(r.project.projectId)
    g.reviews.push(r)
    if (r.heldFor === 'operator' && r.expiresAt) g.held.push(r)
  }
  for (const run of look) groupOf((run.task && taskProject.get(run.task.taskId)) || '').runs.push(run)
  // Every project not closed has its group, whatever waits in it, so its reports stay reachable from it; one with nothing waiting
  // sorts after those that need you.
  for (const p of projects ?? []) if (p.state !== 'closed') groupOf(p.projectId)
  // The most urgent first: what expires within the hour, then the most that waits, then the earliest deadline, then by name.
  const deadlines = (g: Group) => [...g.requests, ...g.held].flatMap((x) => x.expiresAt ? [x.expiresAt] : []).sort()
  const total = (g: Group) => g.requests.length + g.held.length + g.runs.length
  const soonOf = (g: Group) => deadlines(g).filter((d) => Date.parse(d) - Date.now() < HOUR).length
  const ordered = [...groups.values()].sort((a, b) => soonOf(b) - soonOf(a) || total(b) - total(a)
    || (deadlines(a)[0] || '~').localeCompare(deadlines(b)[0] || '~') || Number(!a.key) - Number(!b.key) || a.name.localeCompare(b.name))
  // Filtered to one project (?project=<id>): only its group, said even when nothing of it waits.
  const shownGroups = homeProject ? [groups.get(homeProject) ?? groupOf(homeProject)] : ordered
  // Each thing that waits, by name under its count, one link from where it is decided (T141); the count in sight, the names folded
  // under it and kept open through the refresh (T239). At most WAITING_NAMED names a group.
  const nameList = (key: string, items: Child[][], count: number, more: Child) => items.length ? keptFold('names-' + key, 'Names', el('ul', { class: 'named' }, items.slice(0, WAITING_NAMED).map((line) => el('li', {}, line)),
    count > Math.min(items.length, WAITING_NAMED) ? el('li', { class: 'muted' }, 'and ' + (count - Math.min(items.length, WAITING_NAMED)) + ' more: ', more) : null)) : null
  // Each group headed by its project's name, which filters Home to it, and its own counts as tiles: a label and its count (T171),
  // its names folded under it (T239), each linked to its card.
  const tilesOf = (g: Group) => {
    const s = g.slug
    const requestNames = [...g.requests].sort((a, b) => (a.expiresAt < b.expiresAt ? -1 : 1)).map((r) => [jump('request-' + r.requestId, okQueue?.described.get(r.requestId)?.title ?? r.requestId), expiry(r.expiresAt)])
    const reviewNames = g.held.map((r) => [jump('review-' + r.taskId, r.title), expiry(r.expiresAt as string)])
    const runNames = g.runs.map((run) => [runLink(run.runId, runTitle(run, true)), el('span', { class: 'muted' }, ' · ' + needsLook(run))])
    const firstReview = earliestOf(g.held)
    return [
      g.requests.length ? el('li', {}, jump('approvals-' + s, 'Approvals · ' + g.requests.length), nameList('requests-' + s, requestNames, g.requests.length, jump('approvals-' + s, 'See all'))) : null,
      g.held.length ? el('li', {}, jump('reviews-' + s, 'Reviews · ' + g.held.length),
        // When the first expires: in sight within the hour, else beside each name under Names (T239, T256).
        firstReview && Date.parse(firstReview) - Date.now() < HOUR ? el('div', { class: 'soon' }, 'first expires ' + relative(firstReview)) : null,
        nameList('reviews-' + s, reviewNames, g.held.length, jump('reviews-' + s, 'See all'))) : null,
      g.runs.length ? el('li', {}, jump('needs-look-' + s, 'Runs needing attention · ' + g.runs.length + (part('runs').more ? '+' : '')), nameList('runs-' + s, runNames, g.runs.length, jump('needs-look-' + s, 'See all'))) : null,
    ].filter(Boolean)
  }
  const groupTitle = (g: Group) => g.key ? anchor('/ui/?project=' + encodeURIComponent(g.key), g.name, () => filterHome(g.key), { 'aria-label': 'Show only ' + g.name }) : g.name
  const waiting = shownGroups.filter((g) => total(g) || homeProject).map((g) => el('section', { class: 'group', 'aria-label': 'Needs you in ' + (g.key ? g.name : 'no project') },
    el('h4', {}, groupTitle(g)),
    total(g) ? el('ul', { class: 'tiles' }, tilesOf(g)) : el('p', { class: 'muted' }, 'Nothing needs you here.')))
  const unknownWaits = unread.length ? el('p', { class: 'unknown' }, 'What else needs you is unknown: ' + unread.map((name) => { const p = part(name); return 'unknown' in p ? p.unknown : '' }).join('; ')) : null
  const counts = roster?.counts
  // A source still describing its Workers for the first time: the counts are incomplete.
  const describing = roster && isKnown(roster.sources) ? roster.sources.value.filter((s) => s.describing).map((s) => s.source) : []
  // The Worker a run is on now (the running step's, else the last that had one).
  const workerOf = (run: RunSummary) => { const w = (run.nodes.find((x) => x.state === 'RUNNING' && x.worker) ?? [...run.nodes].reverse().find((x) => x.worker))?.worker; return w ? names.get(w) || w : undefined }
  const availability = roster && counts ? availabilityChips(roster, describing) : el('p', { class: 'unknown' }, 'Workers unknown: the roster could not be read.')
  // Recent runs: the newest 5 rows, then "Show all N" (T239). Filtered to one project (T253), only the runs of its board tasks.
  const recent = homeProject ? runs.filter((run) => run.task && taskProject.get(run.task.taskId) === homeProject) : runs
  const [recentBody, recentMore] = capped('recent', el('tbody', { id: 'recent-list' }), recent.slice(0, RECENT), (run) => labelled(RECENT_HEAD, el('tr', {},
    el('td', {}, runLink(run.runId, runTitle(run))),
    el('td', { class: 'nowrap' }, runChip(run)),
    el('td', {}, el('div', {}, stepsText(run), workerOf(run) ? el('span', { class: 'muted' }, ' · ' + workerOf(run)) : null),
      fold('Steps', run.nodes.filter((n) => n.worker).map((n) => el('div', { class: 'muted' }, n.nodeId + ': ' + (names.get(n.worker as string) || n.worker))), el('div', { class: 'muted' }, 'template ' + run.template + ' · run ', shortId(run.runId, 'Copy run ID')))),
    el('td', { class: 'nowrap muted' }, ago(run.createdAt)))))
  // Right now by name, from the same capacity summary the Workers page renders (T152), by the same function.
  const rightNow = roster?.now && isKnown(roster.workers) && roster.workers.value.length ? glanceView(roster.now, readyNow(roster.now) ?? ready, roster.workers.value) : null
  const breakerNotes = (key: string) => (projects?.find((x) => x.projectId === key)?.autoAcceptBreakers ?? []).map((b) => el('p', { class: 'state failed', role: 'status', 'aria-label': 'Auto-accept is off on ' + b.branch },
    'Auto-accept is off on ' + b.branch + ': ' + qty(b.escapes.length, 'escaped defect') + ' counted (the line is ' + b.line.escapes + ' in ' + b.line.days + ' days). Results are held for you. It turns on again only by you or the lead, once the line holds' + (b.now?.lineHolds ? ' (it holds now).' : '.'),
    el('span', { class: 'muted' }, ' ' + b.escapes.map((e) => e.taskId).join(', '))))
  // Each group's cards (T253), headed by its project's name: its approvals, its reviews, its runs needing attention, and, for a
  // project, its weekly report and its metrics, under Reports.
  const cardGroups: HTMLElement[] = []
  for (const g of shownGroups) {
    const calm = !g.requests.length && !g.reviews.length && !g.runs.length
    // What is in no project has a group only while something of it waits; a project's group stays, its Reports with it.
    if (calm && !g.key) continue
    const s = g.slug
    cardGroups.push(el('section', { class: 'group', id: 'group-' + s, tabindex: '-1', 'aria-label': g.key ? 'Project ' + g.name : 'Not in a project' },
      g.key ? el('div', { class: 'line group-head' }, el('h2', { class: 'group-title' }, g.name), reportsLink(g.key, g.name)) : el('h2', { class: 'group-title' }, g.name),
      // Auto-accept turned off by its circuit breaker (D93): each branch, the escaped defects it counted, and who turns it on again.
      g.key ? breakerNotes(g.key) : null,
      calm ? el('p', { class: 'muted' }, 'Nothing needs you here.') : null,
      g.requests.length ? approvals(q, [...g.batches, ...(g.loose.length ? [{ requests: g.loose }] : [])], 'approvals-' + s, 'h3') : null,
      g.reviews.length ? okReviews?.sectionOf(g.reviews, 'reviews-' + s, 'h3', false) : null,
      g.runs.length ? el('section', { id: 'needs-look-' + s, tabindex: '-1', 'aria-label': 'Runs needing attention' }, el('h3', { class: 'kind' }, 'Runs needing attention'),
        capped('needs-look-' + s, el('div', { id: 'needs-look-list-' + s }), g.runs, (run) => runCard(run, runTitle(run)))) : null))
  }
  const shownIn = (kind: 'requests' | 'reviews') => shownGroups.some((g) => g[kind].length)
  // A kind with nothing in any group shown keeps its own short line (or why it is unknown); filtered to one project, its group says
  // when nothing of it waits. The accepted results on their way in after the groups.
  const queueAlone = !q ? null : 'error' in q ? approvals(q) : shownIn('requests') || homeProject ? null : approvals(q, [])
  const accepted = okReviews ? okReviews.accepted.filter((a) => !homeProject || a.project.projectId === homeProject) : []
  const reviewsAlone = !reviewed ? null : 'failed' in reviewed ? reviewed.failed
    : shownIn('reviews') || homeProject ? reviewed.acceptedView(accepted, 'h2') : (() => { const s = reviewed.sectionOf([], 'reviews', 'h2', false); const a = reviewed.acceptedView(accepted, 'h3'); if (a) s.append(a); return s })()
  const capacity = el('section', { class: 'panel', 'aria-label': 'Workers at a glance' }, el('h3', {}, 'Capacity'),
    counts ? null : el('p', { class: 'unknown' }, 'Workers unknown: the roster could not be read.'),
    // Each account's capacity in one line, its 5 h bar beside it (the CEO's view of what is left).
    roster && isKnown(roster.workers) && accountsOf(roster.workers.value).some((g) => g.account)
      ? el('ul', { class: 'capacities', 'aria-label': 'Capacity of each account' }, accountsOf(roster.workers.value).filter((g) => g.account).map(capacityLine)) : null,
    rightNow,
    // Without Right now, the free Workers and the ready tasks in numbers.
    !rightNow && ready !== undefined ? el('p', { 'aria-label': 'Capacity' }, capacityText(counts ? counts.ready ?? 0 : undefined, ready), ' ', pageLink('board', 'Open Board')) : null)
  // On the page's grid (T256): what needs the operator and its cards in the main column; the Workers' availability beside it; the
  // starts awaiting approval, what happened, the Workers in full, and the recent runs below the cards (a third column on a wide
  // screen); what dispatch started by itself at the page's bottom.
  show(pageHead('home'),
    el('div', { class: 'page-grid three' },
      el('div', { class: 'col-main overview' },
        el('section', { class: 'panel', 'aria-label': 'Needs your attention' },
          el('div', { class: 'head' }, el('h3', {}, 'Needs your attention'), homeProject ? anchor('/ui/', 'All projects', () => filterHome(null)) : null),
          waiting.length ? el('div', { class: 'groups' }, waiting) : unknownWaits ? null : el('p', { class: 'muted' }, 'You’re all caught up.'), unknownWaits),
        cardGroups, queueAlone, reviewsAlone),
      el('div', { class: 'col-side overview' },
        el('section', { class: 'panel', 'aria-label': 'Workers availability' }, el('div', { class: 'head' }, el('h3', {}, 'Workers'), pageLink('workers', 'Open Workers')), availability),
        el('div', { class: 'side-extra' }, capacity)),
      el('div', { class: 'col-more' },
        goView(dispatch, q, names), dailyView(daily), since,
        // Each run by its task's title (else its template), its state, its progress and current Worker; every step's Worker, its template, and its id folded (T124, T171).
        el('section', { 'aria-label': 'Recent runs' }, el('h2', {}, 'Recent runs'),
          recent.length ? [el('table', {}, el('thead', {}, el('tr', {}, RECENT_HEAD.map((h) => el('th', {}, h)))), recentBody), recentMore]
            : el('p', { class: 'muted' }, 'No runs yet · ', pageLink('board', 'Open Board')),
          recent.length > RECENT ? el('p', { class: 'muted' }, qty(recent.length - RECENT, 'older run') + ' not listed; open one by its link, or ask with system status.') : null))),
    startedView(dispatch, names, runs))
  if (app.focusRequest) {
    const id = app.focusRequest
    app.focusRequest = null
    setTimeout(() => { if (!focusOn('request-' + id)) report(false, 'Request ' + id + ' no longer waits', ['It was decided, withdrawn, or expired since the link was made: nothing waits for your verdict on it.']) }, 0)
  }
}
