// The board's projects, and the operator's pause, resume, and close: each behind a confirmation, sent with the project revision
// shown, so a project changed since is refused and nothing moves.
import type { ApprovalRequest, LeadResponse, ProjectCard, ProjectMoveResponse, ProjectsResponse, RosterResponse, StartPreview, StartResponse, StartStep, TaskCard } from '../src/api.js'
import { ago, chip, copyId, decision, el, elapsedView, expires, fold, keptFold, qty, span, verdictButtons, clockOf, type Child } from './dom.js'
import { landingLine } from './evidence.js'
import { pageHead, whatIs } from './glossary.js'
import { anchor, decideLink, go, pageLink, reportsLink, runLink, toReview } from './router.js'
import { isKnown, capacityText } from './roster.js'
import { queue, type Queue } from './queue.js'
import { lastText, liveOf, liveRun, stalledOf } from './runwords.js'
import { api, app, asApiError, errorState, quiet, refusal, report, saySoftly, show } from './state.js'

const OPEN = ['proposed', 'ready', 'claimed', 'running', 'review', 'waiting-for-input', 'waiting-for-approval']
const READY_PREVIEWS = 8
const count = (p: ProjectCard, states: string[]) => states.reduce((n, s) => n + (p.open[s] || 0), 0)
const MOVES: Record<string, { label: string; does: string }> = {
  pause: { label: 'Pause', does: 'asks you to confirm, then no task of it starts until you resume it' },
  resume: { label: 'Resume', does: 'asks you to confirm, then its tasks may start again' },
  close: { label: 'Close', does: 'asks you to confirm, then ends the project and cancels its open tasks' },
}
const WAITS: Record<string, string> = {
  'approval-needed': 'Approval needed', 'budget-spent': 'Approval needed — budget spent', 'reconciliation-failed': 'Approval needed — run not settled',
  'retries-spent': 'Input needed — attempts used up', question: 'Input needed — it asked a question', rejected: 'Input needed — sent back', 'review-expired': 'Input needed — review expired', 'operator-review': 'Review needed',
}
const moveLines = (p: ProjectCard, action: string, busy: number, refused: boolean): string[] => {
  const asked = [p.open['waiting-for-approval'] ? p.open['waiting-for-approval'] + ' task(s) waiting for approval' : null, p.amendment ? 'the pending amendment (charter version ' + p.amendment + ')' : null].filter(Boolean)
  return action === 'pause' ? [
    'Until you resume it, no task of it is claimed or started, and no proposed task is put to the policy.',
    busy ? busy + ' task(s) running or in review go on to their outcome.' : 'No task of it is running or in review.',
    'Every wait keeps its expiry, and a request you answer meanwhile still applies.',
  ] : action === 'resume' ? ['Its proposed tasks go through the gate on the next sweep of the board, and its ready tasks may be claimed again.']
    : refused ? ['It cannot close while a task runs or is in review: ' + busy + ' do. Stop the run, or decide the review, first.']
    : [
      count(p, OPEN) + ' open task(s) are cancelled (project-closed)' + (p.open.claimed ? ', and the lease of ' + p.open.claimed + ' claimed one(s) released' : '') + '.',
      asked.length ? 'The approval requests of ' + asked.join(' and of ') + ' are withdrawn.' : 'No approval request waits on it.',
      'A closed project takes no task again. This cannot be undone.',
    ]
}
const needs = (step: StartStep) => step.source ? 'read by the system, on no Worker'
  : (step.team ? 'team of ' + step.team.members + ', each of another provider · ' : '') + step.tier + '+ · ' + step.capabilities.join(', ') + (step.kind ? ' · ' + step.kind : '') + (step.plans ? ' · plans further steps, which may ask for your approval' : '')
const leadPanel = (data?: LeadResponse) => !data ? null : el('section', { class: 'panel', id: 'lead-panel', 'aria-label': 'Lead inbox of ' + data.project },
  el('h2', {}, 'Lead ', chip(qty(data.unread.length, 'unread notice'), data.unread.length ? 'warn' : 'idle')),
  data.unread.length ? el('ul', {}, data.unread.map((n) => el('li', {}, el('strong', {}, n.title), ' · ', clockOf(n.at), ' · ', n.text, n.act.length ? el('div', { class: 'muted' }, n.act[0]) : null)))
    : el('p', { class: 'muted' }, 'Nothing needs the lead'),
  data.digests[0] ? fold('Recent digest · ' + clockOf(data.digests[0].at), el('p', {}, data.digests[0].text)) : null,
  el('p', { class: 'muted' }, 'Handled ' + data.stats.handled + (data.stats.waitMs.median !== undefined ? ' · a notice waits ' + Math.round(data.stats.waitMs.median / 1000) + ' s (median) until handled' : '') + (data.stats.touches.median !== undefined ? ' · ' + data.stats.touches.median + ' touch(es) per task (median)' : '')))

export async function boardView(): Promise<void> {
  let projects: ProjectCard[]
  try { ({ projects } = await api<ProjectsResponse>('projects')) } catch (error) {
    const e = asApiError(error)
    show(pageHead('board'), e.status === 503 ? el('p', { class: 'muted' }, 'The board is not running, so there are no projects to show.') : errorState('The board could not be read: ' + e.message + '.'))
    return
  }
  const shown = el('div', {}), settle = async () => { app.confirming = false; await boardView().catch(saySoftly) }
  const cancelHere = () => { app.confirming = false; shown.replaceChildren() }
  const send = (p: ProjectCard, action: string, body: () => object) => async () => {
    try {
      const { project, decision: made } = await api<ProjectMoveResponse>('projects/' + encodeURIComponent(p.projectId) + '/' + action, { revision: p.revision, ...body() })
      report(true, p.title + ' is ' + project.state, ['Recorded as board decision ' + made + '.'])
    } catch (error) { report(false, 'Not done: ' + action + ' of ' + p.title, ['The board refused it ' + refusal(error) + '. Nothing moved.']) }
    await settle()
  }
  const confirm = (p: ProjectCard, action: string) => () => {
    app.confirming = true
    const busy = count(p, ['running', 'review']), refused = action === 'close' && busy > 0
    const outcome = el('select', { 'aria-label': 'Outcome of ' + p.projectId }, el('option', { value: 'achieved' }, 'achieved: its criteria are met'), el('option', { value: 'stopped' }, 'stopped: it ends without them'))
    const verb = MOVES[action]?.label ?? action
    const [confirmButton, confirmDoes] = decision('Confirm', verb.toLowerCase() + 's ' + p.title + ', as listed above', { class: 'primary', onclick: () => void send(p, action, () => (action === 'close' ? { outcome: outcome.value } : {}))() })
    const [cancelButton, cancelDoes] = decision('Cancel', 'nothing moves', { onclick: cancelHere })
    shown.replaceChildren(el('div', { class: 'panel', role: 'group', 'aria-label': 'Confirm ' + action + ' of ' + p.projectId },
      el('h3', {}, verb + ' ' + p.title),
      el('ul', {}, moveLines(p, action, busy, refused).map((line) => el('li', {}, line))),
      action === 'close' && !refused ? el('p', {}, 'Outcome: ', outcome) : null,
      refused ? null : [confirmButton, confirmDoes],
      cancelButton, cancelDoes));
    (refused ? cancelButton : confirmButton).focus()
  }
  const glanceOf = (p: ProjectCard) => {
    const merges = (p.tasks ?? []).filter((t) => t.state === 'done' && t.landing?.state === 'asked').length, yours = ([[p.open.review ?? 0, 'review'], [p.open['waiting-for-approval'] ?? 0, 'approval'], [p.open['waiting-for-input'] ?? 0, 'answer'], [merges, 'merge']] as const).filter(([n]) => n)
    const total = yours.reduce((n, [k]) => n + k, 0)
    const counted = (label: string, n: number, cls?: string) => el('span', { class: cls ?? '' }, label + ' ', el('span', { class: 'n' }, String(n)))
    return [el('div', { class: 'glance', 'aria-label': 'State of ' + p.title },
      counted('Needs you', total, total ? 'soon' : ''), ' · ', counted('Working', count(p, ['claimed', 'running'])), ' · ', counted('Ready', p.open.ready || 0), ' · ', counted('Proposed', p.open.proposed || 0)),
    total ? fold('What needs you', yours.map(([n, w]) => qty(n, w)).join(', ')) : null]
  }
  const q = await queue()
  const okQueue: Queue | undefined = q && !('error' in q) ? q : undefined
  const open = okQueue?.requests ?? []
  const titleOf = (r: ApprovalRequest) => okQueue?.described.get(r.requestId)?.title ?? r.requestId
  const roster = await quiet<RosterResponse>('roster')
  const moving = await liveOf()
  const working = new Map<string, { name: string; since: string | undefined }>()
  if (roster && isKnown(roster.workers)) for (const w of roster.workers.value) if (isKnown(w.work)) for (const i of w.work.value.items) working.set(i.runId, { name: w.name, since: isKnown(i.since) ? i.since.value : undefined })
  const chosen = app.boardProject
  const shownId = chosen === 'all' || projects.some((p) => p.projectId === chosen) ? chosen as string : projects.length === 1 ? (projects[0] as ProjectCard).projectId : 'all'
  const all = shownId === 'all'
  const shownProjects = all ? projects : projects.filter((p) => p.projectId === shownId)
  const asksOf = (p: ProjectCard) => open.filter((r) => r.requester.component === 'board' && r.requester.projectId === p.projectId && r.requester.taskId)
  const charterOf = (p: ProjectCard) => open.find((r) => r.action.class === 'charter' && r.subject.ref.startsWith('project:' + p.projectId + ':charter:'))
  const stateOf = (p: ProjectCard) => {
    const charter = charterOf(p), asks = asksOf(p)
    const links = (list: ApprovalRequest[]) => list.flatMap((r, i) => [i ? ', ' : '', decideLink(r.requestId, titleOf(r))])
    return el('div', {},
      charter ? el('div', {}, chip(p.state === 'proposed' ? 'Charter approval needed' : 'Amendment approval needed', 'warn'), ' ', decideLink(charter.requestId, 'Review request')) : null,
      asks.length ? el('div', {}, chip(qty(asks.length, 'task approval'), 'warn'), all ? null : [' ', links(asks.slice(0, 3)), asks.length > 3 ? fold((asks.length - 3) + ' more', links(asks.slice(3))) : null]) : null)
  }
  const viewProject = (id: string, replace: boolean) => { app.boardProject = id; history[replace ? 'replaceState' : 'pushState'](null, '', '?view=board&project=' + encodeURIComponent(id)); void boardView() }
  const pick = el('select', { id: 'board-project', onchange: () => viewProject(pick.value, true) }, el('option', { value: 'all' }, 'All projects (' + projects.length + ')'), projects.map((p) => el('option', { value: p.projectId }, p.title)))
  pick.value = shownId
  const ready = shownProjects.reduce((n, p) => n + (p.open.ready || 0), 0), idle = roster?.counts.ready
  const switchTo = (p: ProjectCard) => anchor('/ui/?view=board&project=' + encodeURIComponent(p.projectId), p.title, () => viewProject(p.projectId, false))
  const head = (p: ProjectCard) => {
    const moves = p.state === 'active' ? ['pause', 'close'] : p.state === 'paused' ? ['resume', 'close'] : []
    return el('article', { class: 'panel request', 'aria-labelledby': 'project-' + p.projectId },
      el('div', { class: 'line' }, el('h3', { id: 'project-' + p.projectId }, all ? switchTo(p) : p.title),
        chip(p.closure ? 'closed (' + p.closure.outcome + ')' : p.state, p.state === 'active' ? 'ok' : p.state === 'paused' ? 'warn' : 'idle')),
      el('p', { class: 'meta' }, qty(count(p, OPEN), 'open task'), p.amendment ? ' · Amendment awaiting approval' : ''),
      glanceOf(p),
      stateOf(p),
      moves.length ? el('div', { class: 'actions' }, moves.map((m) => decision((MOVES[m]?.label ?? m) + '…', MOVES[m]?.does ?? '', { onclick: confirm(p, m), 'aria-label': (MOVES[m]?.label ?? m) + ' ' + p.projectId }))) : null,
      fold('Details', 'project ' + p.projectId + ' · charter version ' + p.charter.version + (p.amendment ? ' · amendment ' + p.amendment + ' awaiting approval' : ''), copyId('Copy project ID', p.projectId),
        el('div', {}, reportsLink(p.projectId, p.title))))
  }
  const entries = new Map(roster && isKnown(roster.workers) ? roster.workers.value.map((w) => [w.worker, w]) : [])
  const quotaOf = (id: string) => {
    const w = entries.get(id)
    const win = (w && isKnown(w.pools) ? w.pools.value : []).flatMap((p) => p.windows.filter((x) => x.seconds)).sort((a, b) => (a.seconds ?? 0) - (b.seconds ?? 0))[0]
    return !win ? '' : ' — ' + span(win.seconds as number) + ' ' + (isKnown(win.used) ? 'used ' + win.used.value + ' %' : 'no reading yet')
  }
  const nameOf = (id: string) => (entries.get(id)?.name ?? id) + quotaOf(id)
  const likely = (step: StartStep): HTMLElement | null => {
    if (step.source) return null
    const w = step.workers
    if (!w || !('free' in w)) return el('div', { class: 'unknown' }, 'Who would take it is unknown (' + (w ? w.unknown : 'not read') + ')')
    if (w.free.length) return el('div', { class: 'likely' }, 'Likely: ' + w.free.slice(0, 3).map(nameOf).join('; ') + (w.free.length > 3 ? '; or ' + (w.free.length - 3) + ' more' : ''))
    return el('div', { class: 'soon' }, w.busy.length ? 'None free: it waits for ' + w.busy.slice(0, 3).map(nameOf).join('; ') : 'No Worker can take it now: it waits until one can')
  }
  const previews = new Map<string, StartPreview>()
  const readyShown = all ? [] : shownProjects.flatMap((p) => (p.tasks ?? []).filter((t) => t.state === 'ready' && t.template)).slice(0, READY_PREVIEWS)
  await Promise.all(readyShown.map(async (t) => { const p = await quiet<StartPreview>('tasks/' + encodeURIComponent(t.taskId) + '/start'); if (p) previews.set(t.taskId, p) }))
  const goesTo = (preview: StartPreview) => {
    const step = preview.steps.find((s) => !s.source), w = step?.workers
    if (!step || !w || !('free' in w) || !w.free.length) return step ? likely(step) : null
    return el('div', { class: 'likely' }, 'Likely Worker: ' + nameOf(w.free[0] as string),
      w.free.length > 1 ? el('details', { class: 'fold inline' }, el('summary', {}, '+' + qty(w.free.length - 1, 'other')), w.free.slice(1).map((id) => el('div', {}, nameOf(id)))) : null)
  }
  const decideHere = (r: ApprovalRequest, ...more: Child[]) => el('div', { class: 'actions decide' },
    verdictButtons(okQueue?.described.get(r.requestId)?.yes ?? '', okQueue?.described.get(r.requestId)?.no ?? '', (verdict, pair, clicked) => void okQueue?.decide([{ requestId: r.requestId, subject: r.subject, verdict }], undefined, undefined, pair, clicked)), more)
  const start = (t: TaskCard) => async () => {
    app.confirming = true
    const [close, closeDoes] = decision('Cancel', 'nothing starts', { onclick: cancelHere })
    let preview: StartPreview
    try { preview = await api<StartPreview>('tasks/' + encodeURIComponent(t.taskId) + '/start') } catch (error) {
      shown.replaceChildren(el('div', { class: 'panel bad', role: 'alert', 'aria-label': 'Cannot start ' + t.title },
        el('h3', {}, 'It cannot start from here: "' + t.title + '"'), el('p', {}, asApiError(error).message.replace(/^[a-z_]+: /, '')), close, closeDoes))
      close.focus()
      return
    }
    const { task, steps } = preview
    const [yes, yesDoes] = decision('Confirm', 'starts the run now', { class: 'primary' })
    yes.addEventListener('click', async () => {
      yes.disabled = close.disabled = true
      yes.textContent = 'Starting…'
      try {
        const answer = await api<StartResponse>('tasks/' + encodeURIComponent(t.taskId) + '/start', { revision: task.revision, template: task.template })
        if (answer.pending) report('pending', 'Not started yet: ' + t.title, [['Run ', runLink(answer.pending.runId), ' of the ' + task.template + ' template took the task, and the board did not answer when asked to record it, so nothing of it has run. It starts once the board shows it recorded, and the task then moves to Working; if the board never records it, the run is dropped with nothing run. Nothing more is needed from you.'], 'What the system said: ' + answer.pending.reason])
        else report(true, 'Started: ' + t.title, [['Run ', runLink(answer.run.runId), ' of the ' + task.template + ' template claimed the task: it is under Working on the Board, and its page shows each step as it runs.']])
      } catch (error) { report(false, 'Not started: ' + t.title, ['The server refused it ' + refusal(error) + '. Nothing was started: the task is still ready.']) }
      await settle()
    })
    shown.replaceChildren(el('div', { class: 'panel', role: 'group', 'aria-label': 'Confirm start of ' + t.title },
      el('h3', {}, 'Start "' + t.title + '"'),
      el('p', {}, el('span', { class: 'tag' }, task.template + ' template'), ' · attempt ' + (task.attempts.count + 1) + ' of ' + task.attempts.max + ' · ' + qty(steps.length, 'step'), whatIs('attempt'), whatIs('tier')),
      el('ol', {}, steps.map((step) => el('li', {}, step.objective + ': ' + needs(step), likely(step)))),
      el('p', { class: 'muted' }, idle === undefined ? 'Free Workers unknown' : qty(idle, 'Worker') + ' free now'),
      fold('What happens on start', el('p', {}, 'The run claims the task, which moves to Working; each step runs in order on a Worker that can do it, and a step no free Worker can take waits for one.'),
        el('p', {}, 'Routing picks each step\'s Worker when the run starts: the names above are likely, not promised.'),
        el('p', {}, 'Nothing runs until you confirm. Once it runs, its page has Stop run.')),
      yes, yesDoes, close, closeDoes))
    shown.scrollIntoView({ block: 'nearest' })
    yes.focus()
  }
  const cardOf = (p: ProjectCard, t: TaskCard) => {
    const run = t.run ? working.get(t.run.runId) : undefined
    const live = (t.state === 'running' || t.state === 'claimed') ? liveRun(moving, t.run?.runId) : undefined
    const askOf = (id: string | undefined) => id ? open.find((r) => r.requestId === id) : undefined
    const asked = askOf(t.waiting?.approvalRequest) ?? (t.landing?.state === 'asked' ? askOf(t.landing.requestId) : undefined)
    const openRun = t.run ? runLink(t.run.runId, 'Open run', 'Open the run of ' + t.title) : null
    const attempt = 'attempt ' + Math.max(1, t.attempts.count) + ' of ' + t.attempts.max
    const about = [p.title, t.actionClass, t.template ? t.template + ' template' : null, attempt].filter(Boolean).join(' · ')
    const working_ = t.state === 'claimed' || t.state === 'running'
    return el('article', { class: 'card', 'aria-label': t.title },
      el('strong', {}, t.title),
      el('div', { class: 'muted meta', title: about }, run ? [el('span', { class: 'taken' }, run.name), ' · '] : null, ago(t.updatedAt || t.createdAt)),
      t.state === 'proposed' ? el('div', { class: 'muted' }, 'Pending prerequisites') : null,
      t.state === 'ready' && !t.template ? el('div', { class: 'muted' }, 'No template: the lead starts it') : null,
      working_ && !run ? el('div', { class: 'taken' }, t.state === 'claimed' ? 'Claimed; no step runs yet' : 'Running; its Worker is not known now') : null,
      working_ && run?.since ? el('div', { class: 'muted' }, 'for ', elapsedView(run.since)) : null,
      live ? stalledOf(live) : null,
      t.waiting && t.state.startsWith('waiting') ? el('div', {}, chip(WAITS[t.waiting.reason] ?? t.waiting.reason, 'warn'), ' ', expires(t.waiting.expiresAt)) : null,
      t.landing ? (t.landing.state === 'asked' && askOf(t.landing.requestId) ?el('div', {}, chip('Merge approval needed', 'warn'), ' · into ' + (t.landing.base || 'its base')) : landingLine(t.landing)) : null,
      asked ? decideHere(asked, openRun)
        : t.state === 'ready' ? el('div', { class: 'actions' }, el('button', { type: 'button', class: 'primary', onclick: () => void start(t)(), 'aria-label': 'Start ' + t.title }, 'Start…'))
        : t.state === 'review' ? el('div', { class: 'actions' }, anchor('/ui/', 'Review', () => { app.homeProject = null; go(); setTimeout(() => toReview(t.taskId), 300) }, { 'aria-label': 'Review ' + t.title }))
        : t.waiting?.approvalRequest ? el('div', { class: 'actions' }, decideLink(t.waiting.approvalRequest, 'Review request'), openRun)
        : openRun ? el('div', { class: 'actions' }, openRun) : null,
      keptFold('task-' + t.taskId, 'Details', el('div', {}, el('span', { class: 'tag' }, t.actionClass), t.template ? [' ', el('span', { class: 'tag' }, t.template + ' template')] : null),
        el('div', { class: 'muted' }, p.title + ' · ' + attempt),
        t.state === 'review' ? el('div', {}, openRun) : null,
        t.state === 'ready' && previews.has(t.taskId) ? goesTo(previews.get(t.taskId) as StartPreview) : null,
        live ? el('div', { class: 'muted' }, lastText(live)) : null))
  }
  // A done task whose merge waits for the operator also shows where the operator looks for what waits (ADR-0060).
  const tasksIn = (states: string[]) => shownProjects.flatMap((p) => (p.tasks ?? []).filter((t) => states.includes(t.state) || (states.includes('waiting-for-approval') && t.state === 'done' && t.landing?.state === 'asked')).map((t): [ProjectCard, TaskCard] => [p, t]))
  const moreIn = (states: string[]) => shownProjects.reduce((n, p) => n + states.reduce((m, s) => m + (p.more?.[s] ?? 0), 0), 0)
  const heading = (name: string, states: string[]) => name + ' (' + (tasksIn(states).length + moreIn(states)) + ')'
  const column = (name: string, states: string[], hint: string, help?: Child) => el('section', { class: 'column' + (states.includes('waiting-for-approval') ? ' waits' : ''), 'aria-label': name },
    el('h3', {}, heading(name, states), help),
    tasksIn(states).length ? tasksIn(states).map(([p, t]) => cardOf(p, t)) : el('p', { class: 'muted' }, hint),
    moreIn(states) ? el('p', { class: 'muted' }, moreIn(states) + ' older not shown') : null)
  const folded = (name: string, states: string[]) => el('details', { class: 'column' }, el('summary', {}, heading(name, states)),
    tasksIn(states).length ? el('div', { class: 'cards' }, tasksIn(states).map(([p, t]) => cardOf(p, t))) : el('p', { class: 'muted' }, name === 'Done' ? 'None yet.' : 'None.'))
  const charters = shownProjects.filter((p) => charterOf(p)).length
  const projectsFold = Object.assign(keptFold('projects', ['Projects (' + shownProjects.length + ')', charters ? [' ', chip(qty(charters, 'charter approval'), 'warn')] : null], el('div', { class: 'projects' }, shownProjects.map(head))), { className: 'column' })
  const lead = all ? undefined : await quiet<LeadResponse>('lead?project=' + encodeURIComponent(shownId))
  show(
    pageHead('board'),
    projects.length ? null : el('p', { class: 'muted' }, 'No projects yet · ', pageLink('help', 'How projects start')),
    projects.length ? el('div', { class: 'toolbar' }, el('p', {}, el('label', { for: 'board-project' }, 'Show ', pick)),
      el('p', { 'aria-label': 'Capacity' }, capacityText(idle, ready), whatIs('task'))) : null,
    shown,
    projects.length && all ? el('section', { class: 'portfolio', 'aria-label': 'All projects' }, el('h2', {}, 'All projects', whatIs('project'), charters ? [' ', chip(qty(charters, 'charter approval'), 'warn')] : null),
      el('div', { class: 'projects' }, projects.map(head))) : null,
    projects.length && !all ? [leadPanel(lead), el('div', { class: 'kanban' },
      column('Proposed', ['proposed'], 'None'), column('Ready', ['ready'], 'None', whatIs('start')), column('Working', ['claimed', 'running'], 'None'), column('Review', ['review'], 'None'),
      column('Needs your attention', ['waiting-for-input', 'waiting-for-approval'], 'Nothing needs you')),
    el('div', { class: 'folded' }, projectsFold, folded('Done', ['done']), folded('Cancelled', ['cancelled']))] : null)
}
