// A run's page: its state, what it waits on, its answer, its change and reviews, its steps as a timeline, and what happened to it.
import type { Decision, ProjectsResponse, RosterResponse, RunBlocked, RunDetailResponse, RunNode, StepTiming } from '../src/api.js'
import { absolute, ago, chip, clockOf, decision, duration, el, elapsedView, expandedLists, expires, fold, keptFold, qty, relative, shortId, tookView, type Child } from './dom.js'
import { carryLine, evidenceView, landingLine, reviewOf } from './evidence.js'
import { pageHead, whatIs } from './glossary.js'
import { isKnown, workerNames } from './roster.js'
import { decideLink } from './router.js'
import { failureText, lastText, liveOf, liveRun, needsLook, runChip, stalledOf, stepName, stepStart, stepWords } from './runwords.js'
import { api, app, quiet, refusal, report, saySoftly, show } from './state.js'

const STEP: Record<string, [string, string]> = {
  COMPLETED: ['done', 'completed'], RUNNING: ['running', 'running'], FAILED: ['failed', 'failed'], BLOCKED: ['waiting for you', 'running'],
  WAITING: ['waiting for earlier steps', 'unknown'], READY: ['ready to start', 'ready'], RETIRED: ['dropped from the plan', 'unknown'],
}
// A deferred tool call's chatter (its wait, then its continue or deny) is one line per call.
const REQUEST_NAMED = /\b(?:approval )?request ([A-Za-z0-9][A-Za-z0-9._:-]*[A-Za-z0-9])/
interface CallLine { requestId: string; decisions: Decision[] }
const decisionsView = (made: Decision[]) => {
  const lines: Array<{ decision: Decision } | CallLine> = [], calls = new Map<string, CallLine>()
  for (const d of made) {
    const named = d.type === 'recovery' && ['wait', 'continue', 'deny'].includes(d.outcome) ? REQUEST_NAMED.exec(d.reasons.join(' '))?.[1] : undefined
    if (!named) { lines.push({ decision: d }); continue }
    let call = calls.get(named)
    if (!call) { call = { requestId: named, decisions: [] }; calls.set(named, call); lines.push(call) }
    call.decisions.push(d)
  }
  const when = (iso?: string) => iso ? [' · ', el('time', { datetime: iso, title: absolute(iso) }, relative(iso))] : null
  const body = (d: Decision) => [el('ul', { class: 'reasons' }, d.reasons.map((r) => el('li', {}, r))), el('div', { class: 'muted' }, 'decision ', shortId(d.id, 'Copy decision ID'), d.at ? ' · ' + absolute(d.at) : '')]
  return el('ul', { class: 'decisions', 'aria-label': 'How it was decided' }, lines.map((line) => {
    if ('decision' in line) {
      const d = line.decision
      return el('li', {}, el('details', { class: 'decision' }, el('summary', {}, el('strong', {}, d.type), ' · ' + d.outcome, when(d.at)), body(d)))
    }
    const said = line.decisions.map((d) => d.outcome), first = line.decisions[0] as Decision, last = line.decisions[line.decisions.length - 1] as Decision, text = last.reasons.join(' ')
    const verdict = said.includes('deny') ? 'denied' : said.includes('continue') ? 'approved' + (/\bthe lead approved\b/.test(text) ? ' by the lead' : /\bthe operator approved\b/.test(text) ? ' by you' : '') : 'waiting for a verdict'
    const waited = first.at && last.at && last !== first ? ' · ' + duration(Date.parse(last.at) - Date.parse(first.at)) : ''
    return el('li', {}, el('details', { class: 'decision call' }, el('summary', {}, el('strong', {}, '1 tool call'), ' ' + verdict + waited, waited ? null : when(last.at)),
      el('div', { class: 'muted' }, 'request ', shortId(line.requestId, 'Copy request ID')),
      line.decisions.map((d) => el('div', {}, el('strong', {}, d.type + ' · ' + d.outcome), when(d.at), body(d)))))
  }))
}
const answerView = (text: string, runId: string) => {
  const key = 'answer-' + runId, long = text.split('\n').length > 6 || text.length > 480
  const pre = el('pre', { class: 'answer' + (long && !expandedLists.has(key) ? ' clamped' : ''), id: key }, text)
  if (!long) return [pre]
  const label = () => expandedLists.has(key) ? 'Show less' : 'Show all'
  const all = el('button', { type: 'button', class: 'show-all', 'aria-controls': key, 'aria-expanded': String(expandedLists.has(key)) }, label())
  all.addEventListener('click', () => {
    const open = !expandedLists.has(key)
    if (open) expandedLists.add(key); else expandedLists.delete(key)
    pre.classList.toggle('clamped', !open); all.textContent = label(); all.setAttribute('aria-expanded', String(open))
  })
  return [pre, all]
}
const blockedIds = (runId: string, b: RunBlocked, ...more: Child[]) => keptFold('blocked-' + runId, 'Details', el('div', {}, 'step ' + stepName(b.nodeId) + (stepWords(b.nodeId) ? ' (' + b.nodeId + ')' : '')),
  b.approvalRequest ? el('div', {}, 'request ', shortId(b.approvalRequest, 'Copy request ID')) : null, b.until ? el('div', {}, 'until ' + absolute(b.until)) : null, more)

export async function detail(runId: string): Promise<void> {
  const { run, explain, timings } = await api<RunDetailResponse>('runs/' + encodeURIComponent(runId))
  const timed: Record<string, StepTiming> = timings && isKnown(timings) ? timings.value : {}
  const evidence = run.status === 'running' ? undefined : await reviewOf(runId, run.updatedAt)
  const landing = evidence && !('error' in evidence) ? evidence.landing : undefined
  const moving = run.status === 'running' ? await liveOf() : undefined
  const now = liveRun(moving, runId)
  const names = workerNames(await quiet<RosterResponse>('roster'))
  const nameOf = (worker: string) => names.get(worker) || worker
  const served = run.task ? (await quiet<ProjectsResponse>('projects'))?.projects.flatMap((p) => (p.tasks ?? []).filter((t) => t.taskId === run.task?.taskId).map((t) => ({ title: t.title, project: p.title, attempts: t.attempts })))[0] : undefined
  const act = (action: string, body: () => object) => async () => {
    try { await api('runs/' + encodeURIComponent(runId) + '/' + action, body()) } catch (error) { report(false, 'Not done: ' + action + ' of run ' + runId, ['The server refused it ' + refusal(error) + '. Nothing changed.']) }
    await detail(runId).catch(saySoftly)
  }
  const note = el('input', { id: 'plan-note' }), rationale = el('input', { id: 'vote-rationale' })
  const tie = run.blocked?.kind === 'tie' ? run.blocked : null
  const vote = (option: string) => act('vote', () => ({ decision: tie?.decision, option, rationale: rationale.value }))
  const judge = (verdict: string) => act('approve', () => ({ verdict, note: note.value, plan: run.blocked?.plan }))
  const decisions = new Map((explain?.nodes ?? []).map((n) => [n.nodeId, n.decisions]))
  const failed = run.nodes.find((n) => n.state === 'FAILED'), running = run.nodes.filter((n) => n.state === 'RUNNING')
  const where = run.status === 'completed' ? 'every step done'
    : run.status === 'failed' ? (failed ? 'at ' + stepName(failed.nodeId) + ': ' : '') + (run.error ? failureText(run.error) : failed?.error ? failureText(failed.error) : 'no reason was recorded')
    : run.blocked ? needsLook(run)
    : running.length ? running.map((n) => stepName(n.nodeId) + (n.worker ? ' on ' + nameOf(n.worker) : '')).join(', ')
    : run.status
  const stopping = el('span', {})
  const [stop, stopDoes] = decision('Stop run', 'ends this run, after you confirm')
  stop.addEventListener('click', () => {
    app.confirming = true
    const [cancel, cancelDoes] = decision('Cancel', 'the run goes on', { onclick: () => { app.confirming = false; stopping.replaceChildren(); stop.focus() } })
    const [sure, sureDoes] = decision('Confirm', 'stops this run: nothing more of it runs', { class: 'primary', onclick: () => { app.confirming = false; void act('stop', () => ({ reason: 'stopped from the web UI' }))() } })
    stopping.replaceChildren(el('span', { role: 'group', 'aria-label': 'Confirm stop' }, ' Stop this run? ', sure, sureDoes, cancel, cancelDoes))
    sure.focus()
  })
  const [retry, retryDoes] = decision('Retry failed step', 'runs the failed step again; completed steps are kept', { class: 'primary', onclick: () => void act('continue', () => ({}))() })
  const carry = run.task?.carry, decided = (type: string, outcome: string) => (explain?.nodes ?? []).filter((n) => n.decisions.some((d) => d.type === type && d.outcome === outcome))
  const resent = decided('recovery', 'resend').flatMap((n) => n.decisions.filter((d) => d.type === 'recovery' && d.outcome === 'resend').map(() => n.nodeId))
  const singleFamily = decided('admission', 'single-family').map((n) => n.nodeId)
  const risk = explain?.risk, taskLanding = run.task?.landing
  const landingCard = taskLanding && taskLanding.state !== 'none' ? (({ base, ...rest }) => ({ ...rest, ...(base ? { base: base.branch } : {}) }))(taskLanding) : undefined
  const happened = [
    risk ? el('li', {}, 'Risk tier: ' + risk.tier + (risk.tier === 'heavy' ? ' (a second review by another provider family; never accepted automatically)' : risk.tier === 'light' ? ' (may skip its validation once its required checks pass)' : '') + '.',
      fold('Why', el('ul', {}, risk.reasons.map((r) => el('li', {}, r))), el('div', {}, 'decision ', shortId(risk.decision, 'Copy decision ID')))) : null,
    ...(explain?.nodes ?? []).flatMap((n) => n.handbook ? [{ n, h: n.handbook }] : []).map(({ n, h }) => el('li', {}, 'Handbook at ' + stepName(n.nodeId) + ': ' + h.tokens + ' of ' + h.bound.tokens + ' tokens (' + h.bound.mode + ' mode), for role ' + h.selection.role + ', tier ' + h.selection.tier + '.',
      fold('Layers', el('ul', {}, h.layers.map((l) => el('li', {}, 'Layer ' + l.layer + ' by ' + l.renderedBy + ': ' + (l.atMost ? 'at most ' : '') + l.tokens + ' tokens, version ', el('code', {}, l.version), l.parts.length ? ', parts ' + l.parts.join(', ') : '')),
        (h.source ?? []).map((s) => el('li', {}, 'Rendered by its Worker source, ' + s.part + ': ' + s.tokens + ' tokens, version ', el('code', {}, s.version), s.lessons !== undefined ? ', ' + s.lessons + ' lesson(s)' : '')))))),
    carry ? carryLine(carry) : null,
    ...resent.map((nodeId) => el('li', {}, stepStart(nodeId) + ': retried once after a service error.' + (run.nodes.find((x) => x.nodeId === nodeId)?.state === 'FAILED' ? ' Retry failed; no further automatic resend.' : ''), whatIs('resend'),
      fold('Details', 'The site answered with its own error instead of an answer, so it was sent again once, in a new conversation on the same Worker; never a third time.'))),
    landingCard ? el('li', {}, landingLine(landingCard)) : null,
  ].filter(Boolean)
  const planWaits = run.blocked && !tie && !run.blocked.approvalRequest, ended = run.status !== 'running' ? run.updatedAt : undefined
  const timingOf = (n: RunNode) => { const t = timed[n.nodeId]; return t ? { t, took: t.endedAt ? tookView(t.startedAt, t.endedAt) : n.state === 'RUNNING' ? elapsedView(t.startedAt) : null, at: t.endedAt ? el('time', { datetime: t.endedAt, title: absolute(t.endedAt) }, clockOf(t.endedAt)) : null } : null }
  const timelineBar = () => {
    const start = Date.parse(run.createdAt), end = ended ? Date.parse(ended) : Date.now()
    const ran = run.nodes.flatMap((n) => timed[n.nodeId] ? [{ n, t: timed[n.nodeId] as StepTiming }] : [])
    if (!ran.length || end <= start) return null
    const share = (ms: number) => Math.max(0, Math.min(100, (ms - start) / (end - start) * 100))
    const said = ({ n, t }: (typeof ran)[number]) => stepName(n.nodeId) + ' ' + duration((t.endedAt ? Date.parse(t.endedAt) : end) - Date.parse(t.startedAt))
    return el('div', { class: 'runbar', role: 'img', 'aria-label': 'Timeline: ' + ran.map(said).join(', ') + '; ' + duration(end - start) + (ended ? ' in all' : ' so far') },
      ran.map((r) => {
        const from = share(Date.parse(r.t.startedAt)), to = share(r.t.endedAt ? Date.parse(r.t.endedAt) : end)
        // Placed through the style object: the content security policy refuses a style attribute.
        const segment = el('span', { class: r.n.state, title: said(r) })
        Object.assign(segment.style, { left: from.toFixed(2) + '%', width: Math.max(0, to - from).toFixed(2) + '%' })
        return segment
      }))
  }
  const summaryPanel = () => {
    const counts = new Map<string, number>()
    for (const n of run.nodes) { const word = (STEP[n.state] ?? [n.state.toLowerCase()])[0] as string; counts.set(word, (counts.get(word) || 0) + 1) }
    const decidedNodes = run.nodes.filter((n) => (decisions.get(n.nodeId) ?? []).length)
    return el('section', { class: 'panel summary', 'aria-label': 'Summary' }, el('h3', {}, 'Summary'),
      el('p', {}, qty(run.nodes.length, 'step') + ': ' + [...counts].map(([word, n]) => n + ' ' + word).join(', ')),
      decidedNodes.length ? el('ul', { class: 'plain decided', 'aria-label': 'Decisions by step' }, decidedNodes.map((n) => el('li', {},
        el('a', { href: '#step-' + n.nodeId, onclick: (e) => { e.preventDefault(); const li = document.getElementById('step-' + n.nodeId); if (li) { li.scrollIntoView({ block: 'center' }); li.focus() } } }, stepName(n.nodeId)),
        el('span', { class: 'muted' }, ' · ' + qty((decisions.get(n.nodeId) ?? []).length, 'decision'))))) : el('p', { class: 'muted' }, 'No decisions recorded.'))
  }
  const stepItem = (n: RunNode) => {
    const [word, cls] = STEP[n.state] ?? [n.state.toLowerCase(), 'unknown']
    const made = decisions.get(n.nodeId) ?? []
    const time = timingOf(n)
    return el('li', { class: 'step ' + n.state, 'data-step': n.nodeId, id: 'step-' + n.nodeId, tabindex: '-1' },
      el('div', {}, el('strong', {}, stepName(n.nodeId)), time?.took ? [' · ', time.took, ' · '] : ' ', el('span', { class: 'state ' + cls }, word),
        time?.at ? [' ', time.at] : null,
        n.worker ? el('span', { class: 'muted' }, ' · ' + nameOf(n.worker) + (n.attempt > 1 ? ' · attempt ' + n.attempt : '')) : null),
      n.error && n.state === 'FAILED' ? el('div', { class: 'state failed' }, failureText(n.error)) : null,
      n.error && n.state !== 'FAILED' ? fold('Attempt history', el('div', { class: 'muted' }, 'An earlier attempt failed: ' + failureText(n.error))) : null,
      keptFold('step-' + runId + '-' + n.nodeId, 'Details', stepWords(n.nodeId) ? el('div', {}, 'step ', el('code', {}, n.nodeId)) : null,
        time ? el('div', { class: 'muted' }, 'started ' + absolute(time.t.startedAt) + (time.t.endedAt ? ' · ended ' + absolute(time.t.endedAt) : '')) : null,
        el('div', { class: 'muted' }, n.worker ? (n.tier || n.minTier) + ' tier' + (n.model ? ', model ' + n.model : '') : 'needs ' + (/^[aeiou]/.test(n.minTier) ? 'an ' : 'a ') + n.minTier + ' tier Worker'),
        made.length ? [el('div', {}, 'How it was decided (' + made.length + ')'), decisionsView(made)] : null))
  }
  const blocked = run.blocked
  const blockedCards: Child[] = [
    tie ? el('div', { class: 'panel' },
      el('p', {}, chip('Team vote tied', 'warn'), ' · Decide within ' + relative(tie.until ?? '').replace(/^in /, ''), el('span', { class: 'muted' }, ' · No response: inconclusive')),
      el('ul', {}, (tie.options ?? []).map((o) => el('li', {}, el('strong', {}, o.option + ': '), o.summary))),
      el('div', { class: 'actions' }, el('label', { for: 'vote-rationale' }, 'Why (required)', rationale),
        (tie.options ?? []).map((o) => el('button', { onclick: () => void vote(o.option)() }, 'Vote ' + o.option)),
        el('button', { onclick: () => void vote('inconclusive')() }, 'Leave inconclusive')),
      fold('Details', 'The team tied at ' + stepName(tie.nodeId) + ' (' + tie.nodeId + '); it waits for your deciding vote until ' + absolute(tie.until ?? '') + ', then ends inconclusive.')) : null,
    blocked && !tie && blocked.approvalRequest ? el('div', { class: 'panel' },
      el('p', {}, chip(blocked.kind === 'tool-call' ? 'Tool call awaiting approval' : 'Fix awaiting approval', 'warn'), blocked.until ? [' · ', expires(blocked.until)] : null, ' · ', decideLink(blocked.approvalRequest, 'Review request')),
      blocked.kind === 'tool-call' ? [el('p', { class: 'muted' }, 'Approve: continue; deny or expire: end this attempt.'),
        fold('How it works', 'The step\'s Worker stopped at a tool call. Approved, the step goes on in the same session and makes that call once.')] : null,
      blockedIds(runId, blocked)) : null,
    planWaits && blocked ? el('section', { class: 'panel request', 'aria-label': 'Plan awaiting approval' },
      el('h3', {}, 'Plan awaiting approval'),
      el('div', { class: 'actions bar' },
        decision('Approve', 'the step goes on with this plan', { class: 'primary', onclick: () => void judge('approved')() }),
        decision('Deny', 'this plan does not run', { onclick: () => void judge('rejected')() })),
      blockedIds(runId, blocked, el('div', {}, 'plan ', shortId(blocked.plan ?? '', 'Copy plan ID')),
        el('div', { class: 'actions' }, el('label', { for: 'plan-note' }, 'Note (optional)', note)))) : null,
  ]
  const readEvidence = evidence && ('error' in evidence || (isKnown(evidence.change) && (evidence.change.value.changes.length || evidence.change.value.unread.length)) || (isKnown(evidence.assessments) && evidence.assessments.value.length) || landing)
  const web = explain?.webCalls, queued = explain?.landing
  show(
    pageHead('run', served ? served.title : run.template + ' run', run.runId),
    served ? el('p', { class: 'muted' }, served.project + (carry?.from ? ' · Attempt ' + (carry.from.attempt + 1) + ' of ' + served.attempts.max : '')) : null,
    el('div', { class: 'status-line' }, runChip(run), singleFamily.length ? [' ', el('span', { title: singleFamily.map(stepName).join(', ') + ': on one provider family, no Worker of another could take it' }, chip('single family', 'warn'))] : null,
      run.blocked ? null : el('span', {}, where), el('span', { class: 'muted' }, 'started ', ago(run.createdAt)),
      ended ? el('span', { class: 'muted' }, 'took ', tookView(run.createdAt, ended)) : null),
    run.status === 'running' || run.status === 'failed' ? el('div', { class: 'actions run-actions' + (planWaits ? '' : ' bar') },
      run.status === 'running' ? [stop, stopDoes, stopping] : null, run.status === 'failed' ? [retry, retryDoes] : null) : null,
    el('div', { class: 'page-grid' }, el('div', { class: 'col-main' },
      blockedCards,
      run.answer ? el('section', { class: 'panel', 'aria-label': 'Answer' }, el('h3', {}, 'Answer'), answerView(run.answer, runId))
        : run.status === 'completed' ? el('p', { class: 'muted' }, 'No answer text.') : null,
      evidence && readEvidence ? el('section', { class: 'panel request', 'aria-label': 'Changes and reviews' }, el('h3', {}, 'Changes and reviews'), landing && !run.task?.landing ? landingLine(landing) : null, evidenceView(evidence, false)) : null,
      el('section', { 'aria-label': 'Steps' }, el('h2', {}, 'Steps'),
        timings && !isKnown(timings) ? keptFold('timings-' + runId, 'Times unknown', el('span', { class: 'unknown' }, timings.unknown)) : null,
        timelineBar(), el('ol', { class: 'timeline' }, run.nodes.map(stepItem))),
      keptFold('tech-' + runId, 'Technical details', el('p', { class: 'muted' }, 'Template ' + run.template + ' · last changed ', ago(run.updatedAt), ' · spec ', shortId(run.specHash, 'Copy spec hash'), run.sessionId ? [' · session ', shortId(run.sessionId, 'Copy session ID')] : null),
        el('p', { class: 'muted' }, 'run ', shortId(run.runId, 'Copy run ID')))),
    el('div', { class: 'col-side' },
      now ? el('section', { class: 'panel', 'aria-label': 'Now' }, el('h3', {}, 'Now', whatIs('step')),
        now.steps.map((st) => el('div', {}, stepStart(st.nodeId) + (st.worker ? ' on ' + nameOf(st.worker) : '') + (st.since ? ', for ' + relative(st.since).replace(/ ago$/, '') : '') + (st.attempt > 1 ? ' (attempt ' + st.attempt + ')' : ''))),
        isKnown(now.lastEvent) ? el('div', { class: 'muted' }, lastText(now)) : el('div', { class: 'muted' }, 'Last event unknown', keptFold('last-event-' + runId, 'Why', now.lastEvent.unknown)),
        stalledOf(now) ? [stalledOf(now), whatIs('stalled')] : null) : null,
      moving && 'unknown' in moving ? el('p', { class: 'unknown' }, 'Where it is now is unknown (' + moving.unknown + ').') : null,
      summaryPanel(),
      happened.length ? el('section', { class: 'panel', 'aria-label': 'What happened' }, el('h3', {}, 'What happened'), el('ul', {}, happened)) : null,
      explain?.stalledChecks?.length ? el('section', { class: 'panel', 'aria-label': 'Checks' }, el('h3', {}, 'Checks'),
        explain.stalledChecks.map((c) => el('div', {}, chip('Check stalled', 'warn'), ' ' + c.check + ': no output since ', ago(c.quietSince),
          el('span', { class: 'muted' }, ' · it goes on until its deadline'),
          fold('Details', el('div', {}, 'command ', el('code', {}, c.command)), el('div', {}, 'stalled at ' + absolute(c.since) + ', after ' + c.stallSeconds + ' s with no output'))))) : null,
      queued ? el('section', { class: 'panel', 'aria-label': 'Landing queue' }, el('h3', {}, 'Landing queue'),
        el('p', {}, queued.position ? 'Place ' + queued.position + ' of ' + queued.length + ' waiting to land on ' + queued.key.slice(queued.key.lastIndexOf('#') + 1) : queued.length + ' in the queue'),
        queued.holder ? el('p', { class: 'muted' }, 'Behind task ' + queued.holder.taskId + ', which lands now') : null, queued.batch ? el('p', { class: 'muted' }, 'Result ' + queued.batch.index + ' of a stack of ' + queued.batch.size + ' (up to ' + queued.batch.limit + '): rebased in order, checked once, merged together') : null) : null,
      web?.count ? el('section', { class: 'panel', 'aria-label': 'Web calls' },
        el('h3', {}, 'Web calls (' + web.count + ')'),
        el('p', { class: 'muted' }, web.auto + ' ran unasked under the web access grant, ' + web.asked + ' asked you' + (web.denied ? ', ' + web.denied + ' denied in their session' : '')),
        fold('Queries and URLs', el('table', { class: 'web-calls' },
          el('thead', {}, el('tr', {}, ['When', 'Tool', 'Query or URL', 'Verdict', 'Egress'].map((h) => el('th', {}, h)))),
          el('tbody', {}, web.calls.map((c) => el('tr', {},
            el('td', {}, ago(c.at)), el('td', {}, c.tool), el('td', {}, el('code', {}, c.target)),
            el('td', {}, c.verdict === 'auto' ? chip('Unasked', 'ok') : c.verdict === 'deny' ? chip('Denied in its session', 'bad') : chip('Asked' + (c.reason ? ' (' + c.reason + ')' : ''), 'warn')),
            el('td', {}, c.egress === 'allow' ? 'passed' : c.egress === 'deny' ? 'refused' : 'not checked'))))))) : null)))
}
