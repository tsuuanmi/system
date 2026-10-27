// A run's page: its state, what it waits on, its answer, its change and reviews, its steps as a timeline, and what happened to it.
import type { Decision, ProjectsResponse, RosterResponse, RunBlocked, RunDetailResponse, RunNode, StepTiming } from '../src/api.js'
import { absolute, ago, chip, clockOf, decision, duration, el, elapsedView, expandedLists, expires, fold, keptFold, qty, relative, shortId, tookView, type Child } from './dom.js'
import { carryLine, evidenceView, landingLine, reviewOf } from './evidence.js'
import { pageHead, whatIs } from './glossary.js'
import { isKnown } from './roster.js'
import { decideLink } from './router.js'
import { failureText, lastText, liveOf, liveRun, needsLook, runChip, stalledOf, stepName, stepStart, stepWords } from './runwords.js'
import { api, app, refusal, report, saySoftly, show } from './state.js'

// A step's state in words, and what it means for the run.
const STEP: Record<string, [string, string]> = {
  COMPLETED: ['done', 'completed'], RUNNING: ['running', 'running'], FAILED: ['failed', 'failed'], BLOCKED: ['waiting for you', 'running'],
  WAITING: ['waiting for earlier steps', 'unknown'], READY: ['ready to start', 'ready'], RETIRED: ['dropped from the plan', 'unknown'],
}
// A deferred tool call's chatter (its wait, then its continue or deny) is one line per call, naming its verdict and how long it waited.
const REQUEST_NAMED = /\b(?:approval )?request ([A-Za-z0-9][A-Za-z0-9._:-]*[A-Za-z0-9])/
interface CallLine { requestId: string; decisions: Decision[] }
const decisionsView = (made: Decision[]) => {
  const lines: Array<{ decision: Decision } | CallLine> = []
  const calls = new Map<string, CallLine>()
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
    const said = line.decisions.map((d) => d.outcome)
    const first = line.decisions[0] as Decision
    const last = line.decisions[line.decisions.length - 1] as Decision
    const text = last.reasons.join(' ')
    const verdict = said.includes('deny') ? 'denied' : said.includes('continue') ? 'approved' + (/\bthe lead approved\b/.test(text) ? ' by the lead' : /\bthe operator approved\b/.test(text) ? ' by you' : '') : 'waiting for a verdict'
    const waited = first.at && last.at && last !== first ? ' · ' + duration(Date.parse(last.at) - Date.parse(first.at)) : ''
    return el('li', {}, el('details', { class: 'decision call' }, el('summary', {}, el('strong', {}, '1 tool call'), ' ' + verdict + waited, waited ? null : when(last.at)),
      el('div', { class: 'muted' }, 'request ', shortId(line.requestId, 'Copy request ID')),
      line.decisions.map((d) => el('div', {}, el('strong', {}, d.type + ' · ' + d.outcome), when(d.at), body(d)))))
  }))
}
// A long answer shows its first lines, then "Show all", kept through the refresh (T239).
const answerView = (text: string, runId: string) => {
  const key = 'answer-' + runId
  const long = text.split('\n').length > 6 || text.length > 480
  const pre = el('pre', { class: 'answer' + (long && !expandedLists.has(key) ? ' clamped' : ''), id: key }, text)
  if (!long) return [pre]
  const label = () => expandedLists.has(key) ? 'Show less' : 'Show all'
  const all = el('button', { type: 'button', class: 'show-all', 'aria-controls': key, 'aria-expanded': String(expandedLists.has(key)) }, label())
  all.addEventListener('click', () => {
    const open = !expandedLists.has(key)
    if (open) expandedLists.add(key); else expandedLists.delete(key)
    pre.classList.toggle('clamped', !open)
    all.textContent = label()
    all.setAttribute('aria-expanded', String(open))
  })
  return [pre, all]
}
const blockedIds = (runId: string, b: RunBlocked, ...more: Child[]) => keptFold('blocked-' + runId, 'Details', el('div', {}, 'step ' + stepName(b.nodeId) + (stepWords(b.nodeId) ? ' (' + b.nodeId + ')' : '')),
  b.approvalRequest ? el('div', {}, 'request ', shortId(b.approvalRequest, 'Copy request ID')) : null, b.until ? el('div', {}, 'until ' + absolute(b.until)) : null, more)

export async function detail(runId: string): Promise<void> {
  const { run, explain, timings } = await api<RunDetailResponse>('runs/' + encodeURIComponent(runId))
  // When each step started and ended (T256), from the event log; none when it could not be read (its step lines say only their state).
  const timed: Record<string, StepTiming> = timings && isKnown(timings) ? timings.value : {}
  // Its change, its reviewers' verdicts, and its report, read again only when the run moved (T122).
  const evidence = run.status === 'running' ? undefined : await reviewOf(runId, run.updatedAt)
  const landing = evidence && !('error' in evidence) ? evidence.landing : undefined
  const moving = run.status === 'running' ? await liveOf() : undefined
  const now = liveRun(moving, runId)
  let roster: RosterResponse | null = null
  try { roster = await api<RosterResponse>('roster') } catch {}
  const names = new Map(roster && isKnown(roster.workers) ? roster.workers.value.map((w) => [w.worker, w.name]) : [])
  const nameOf = (worker: string) => names.get(worker) || worker
  // The board task it serves, by title and project, from the Board's cards (T141).
  let served: { title: string; project: string; attempts: { max: number } } | undefined
  if (run.task) {
    const taskId = run.task.taskId
    try { for (const p of (await api<ProjectsResponse>('projects')).projects) { const t = (p.tasks ?? []).find((x) => x.taskId === taskId); if (t) served = { title: t.title, project: p.title, attempts: t.attempts } } } catch {}
  }
  const act = (action: string, body: () => object) => async () => {
    try { await api('runs/' + encodeURIComponent(runId) + '/' + action, body()) } catch (error) {
      report(false, 'Not done: ' + action + ' of run ' + runId, ['The server refused it ' + refusal(error) + '. Nothing changed.'])
    }
    await detail(runId).catch(saySoftly)
  }
  const note = el('input', { id: 'plan-note' })
  const rationale = el('input', { id: 'vote-rationale' })
  const tie = run.blocked?.kind === 'tie' ? run.blocked : null
  const vote = (option: string) => act('vote', () => ({ decision: tie?.decision, option, rationale: rationale.value }))
  const decisions = new Map((explain?.nodes ?? []).map((n) => [n.nodeId, n.decisions]))
  const failed = run.nodes.find((n) => n.state === 'FAILED')
  const running = run.nodes.filter((n) => n.state === 'RUNNING')
  // Where it is, after its state chip: the current step and Worker, a failure's reason in plain words, or what it waits on.
  const where = run.status === 'completed' ? 'every step done'
    : run.status === 'failed' ? (failed ? 'at ' + stepName(failed.nodeId) + ': ' : '') + (run.error ? failureText(run.error) : failed?.error ? failureText(failed.error) : 'no reason was recorded')
    : run.blocked ? needsLook(run)
    : running.length ? running.map((n) => stepName(n.nodeId) + (n.worker ? ' on ' + nameOf(n.worker) : '')).join(', ')
    : run.status
  // Stop ends the run: behind a confirmation, the one destructive move on this page (T170). Its confirmation is Confirm / Cancel,
  // as every confirmation's (T191).
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
  // What happened to it, in plain words (T141): where its worktree started (ADR-0061), a step sent again after a site's own error
  // (ADR-0062), and where its accepted result stands (ADR-0060).
  const carry = run.task?.carry
  const decided = (type: string, outcome: string) => (explain?.nodes ?? []).filter((n) => n.decisions.some((d) => d.type === type && d.outcome === outcome))
  const resent = decided('recovery', 'resend').flatMap((n) => n.decisions.filter((d) => d.type === 'recovery' && d.outcome === 'resend').map(() => n.nodeId))
  // A step that ran on the family it should differ from, for want of another (D89): a chip beside its state, never folded.
  const singleFamily = decided('admission', 'single-family').map((n) => n.nodeId)
  // Its risk tier, by the paths its change touches, and why (ADR-0071): light, normal, or heavy.
  const risk = explain?.risk
  const taskLanding = run.task?.landing
  const landingCard = taskLanding && taskLanding.state !== 'none' ? (({ base, ...rest }) => ({ ...rest, ...(base ? { base: base.branch } : {}) }))(taskLanding) : undefined
  const happened = [
    risk ? el('li', {}, 'Risk tier: ' + risk.tier + (risk.tier === 'heavy' ? ' (a second review by another provider family; never accepted automatically)' : risk.tier === 'light' ? ' (may skip its validation once its required checks pass)' : '') + '.',
      fold('Why', el('ul', {}, risk.reasons.map((r) => el('li', {}, r))), el('div', {}, 'decision ', shortId(risk.decision, 'Copy decision ID')))) : null,
    // The handbook slice each step was given (docs/design/handbook.md): its size against the bound, each layer's version, and what its Worker source rendered.
    ...(explain?.nodes ?? []).flatMap((n) => n.handbook ? [{ n, h: n.handbook }] : []).map(({ n, h }) => el('li', {}, 'Handbook at ' + stepName(n.nodeId) + ': ' + h.tokens + ' of ' + h.bound.tokens + ' tokens (' + h.bound.mode + ' mode), for role ' + h.selection.role + ', tier ' + h.selection.tier + '.',
      fold('Layers', el('ul', {}, h.layers.map((l) => el('li', {}, 'Layer ' + l.layer + ' by ' + l.renderedBy + ': ' + (l.atMost ? 'at most ' : '') + l.tokens + ' tokens, version ', el('code', {}, l.version), l.parts.length ? ', parts ' + l.parts.join(', ') : '')),
        (h.source ?? []).map((s) => el('li', {}, 'Rendered by its Worker source, ' + s.part + ': ' + s.tokens + ' tokens, version ', el('code', {}, s.version), s.lessons !== undefined ? ', ' + s.lessons + ' lesson(s)' : '')))))),
    carry ? carryLine(carry) : null,
    ...resent.map((nodeId) => el('li', {}, stepStart(nodeId) + ': retried once after a service error.' + (run.nodes.find((x) => x.nodeId === nodeId)?.state === 'FAILED' ? ' Retry failed; no further automatic resend.' : ''), whatIs('resend'),
      fold('Details', 'The site answered with its own error instead of an answer, so it was sent again once, in a new conversation on the same Worker; never a third time.'))),
    // The run view's landing names its base as {branch, sha}; a card's names the branch.
    landingCard ? el('li', {}, landingLine(landingCard)) : null,
  ].filter(Boolean)
  const planWaits = run.blocked && !tie && !run.blocked.approvalRequest
  // Its run time (T256): from its start to its last change once it ended; while it runs, so far.
  const ended = run.status !== 'running' ? run.updatedAt : undefined
  // A step's timing (T256): how long it ran, and when it ended ("14 min · done 07:42"); a running step's time ticks.
  const timingOf = (n: RunNode) => {
    const t = timed[n.nodeId]
    if (!t) return null
    return { t, took: t.endedAt ? tookView(t.startedAt, t.endedAt) : n.state === 'RUNNING' ? elapsedView(t.startedAt) : null, at: t.endedAt ? el('time', { datetime: t.endedAt, title: absolute(t.endedAt) }, clockOf(t.endedAt)) : null }
  }
  // The run's timeline (T256): one bar, a segment per step that ran, placed by when it ran; its words its accessible name.
  const timelineBar = () => {
    const start = Date.parse(run.createdAt), end = ended ? Date.parse(ended) : Date.now()
    const ran = run.nodes.flatMap((n) => timed[n.nodeId] ? [{ n, t: timed[n.nodeId] as StepTiming }] : [])
    if (!ran.length || end <= start) return null
    const share = (ms: number) => Math.max(0, Math.min(100, (ms - start) / (end - start) * 100))
    const said = ({ n, t }: (typeof ran)[number]) => stepName(n.nodeId) + ' ' + duration((t.endedAt ? Date.parse(t.endedAt) : end) - Date.parse(t.startedAt))
    return el('div', { class: 'runbar', role: 'img', 'aria-label': 'Timeline: ' + ran.map(said).join(', ') + '; ' + duration(end - start) + (ended ? ' in all' : ' so far') },
      ran.map((r) => {
        const from = share(Date.parse(r.t.startedAt)), to = share(r.t.endedAt ? Date.parse(r.t.endedAt) : end)
        // Placed through the style object: the page's content security policy refuses a style attribute.
        const segment = el('span', { class: r.n.state, title: said(r) })
        segment.style.left = from.toFixed(2) + '%'
        segment.style.width = Math.max(0, to - from).toFixed(2) + '%'
        return segment
      }))
  }
  // The run's summary and where its decisions sit, beside its steps on a wide screen (T274): the steps counted by state, and each
  // step that was decided as a link to it, never the steps or their decisions said twice.
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
      // An earlier attempt's error on a step that goes on is history, never shown as its failure now.
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
    blocked?.kind === 'tool-call' && blocked.approvalRequest ? el('div', { class: 'panel' },
      el('p', {}, chip('Tool call awaiting approval', 'warn'), blocked.until ? [' · ', expires(blocked.until)] : null, ' · ', decideLink(blocked.approvalRequest, 'Review request')),
      el('p', { class: 'muted' }, 'Approve: continue; deny or expire: end this attempt.'),
      fold('How it works', 'The step\'s Worker stopped at a tool call. Approved, the step goes on in the same session and makes that call once.'), blockedIds(runId, blocked)) : null,
    blocked && !tie && blocked.kind !== 'tool-call' && blocked.approvalRequest ? el('div', { class: 'panel' },
      el('p', {}, chip('Fix awaiting approval', 'warn'), blocked.until ? [' · ', expires(blocked.until)] : null, ' · ', decideLink(blocked.approvalRequest, 'Review request')),
      blockedIds(runId, blocked)) : null,
    // A card: what it waits on as its title, Approve / Deny (T191); its step, the plan id, and an optional note under Details (T239).
    planWaits && blocked ? el('section', { class: 'panel request', 'aria-label': 'Plan awaiting approval' },
      el('h3', {}, 'Plan awaiting approval'),
      el('div', { class: 'actions bar' },
        decision('Approve', 'the step goes on with this plan', { class: 'primary', onclick: () => void act('approve', () => ({ verdict: 'approved', note: note.value, plan: blocked.plan }))() }),
        decision('Deny', 'this plan does not run', { onclick: () => void act('approve', () => ({ verdict: 'rejected', note: note.value, plan: blocked.plan }))() })),
      blockedIds(runId, blocked, el('div', {}, 'plan ', shortId(blocked.plan ?? '', 'Copy plan ID')),
        el('div', { class: 'actions' }, el('label', { for: 'plan-note' }, 'Note (optional)', note)))) : null,
  ]
  const readEvidence = evidence && ('error' in evidence || (isKnown(evidence.change) && (evidence.change.value.changes.length || evidence.change.value.unread.length)) || (isKnown(evidence.assessments) && evidence.assessments.value.length) || landing)
  const web = explain?.webCalls
  const queued = explain?.landing
  show(
    // Headed by its task's title (else its template); its project and attempt below, its id under Technical details (T171, T239).
    pageHead('run', served ? served.title : run.template + ' run', run.runId),
    served ? el('p', { class: 'muted' }, served.project + (carry?.from ? ' · Attempt ' + (carry.from.attempt + 1) + ' of ' + served.attempts.max : '')) : null,
    // Its state as a chip, where it is (unless a card below says what it waits on), when it started, how long it took once it ended
    // (T256), and Stop run or Retry.
    el('div', { class: 'status-line' }, runChip(run), singleFamily.length ? [' ', el('span', { title: singleFamily.map(stepName).join(', ') + ': on one provider family, no Worker of another could take it' }, chip('single family', 'warn'))] : null,
      run.blocked ? null : el('span', {}, where), el('span', { class: 'muted' }, 'started ', ago(run.createdAt)),
      ended ? el('span', { class: 'muted' }, 'took ', tookView(run.createdAt, ended)) : null),
    // Stop run or Retry failed step under it; on a phone the page's primary action is a bar at the bottom of the screen, in reach of a thumb (T240).
    run.status === 'running' || run.status === 'failed' ? el('div', { class: 'actions run-actions' + (planWaits ? '' : ' bar') },
      run.status === 'running' ? [stop, stopDoes, stopping] : null, run.status === 'failed' ? [retry, retryDoes] : null) : null,
    // On the page's grid (T256): what it waits on, its answer, its change, and its steps in the main column; where it is now and what happened to it beside them.
    el('div', { class: 'page-grid' }, el('div', { class: 'col-main' },
      blockedCards,
      run.answer ? el('section', { class: 'panel', 'aria-label': 'Answer' }, el('h3', {}, 'Answer'), answerView(run.answer, runId))
        : run.status === 'completed' ? el('p', { class: 'muted' }, 'No answer text.') : null,
      evidence && readEvidence ? el('section', { class: 'panel request', 'aria-label': 'Changes and reviews' }, el('h3', {}, 'Changes and reviews'), landing && !run.task?.landing ? landingLine(landing) : null, evidenceView(evidence, false)) : null,
      el('section', { 'aria-label': 'Steps' }, el('h2', {}, 'Steps'),
        // Step times that could not be read are said, in two words, why folded under them (INV-2): never just absent.
        timings && !isKnown(timings) ? keptFold('timings-' + runId, 'Times unknown', el('span', { class: 'unknown' }, timings.unknown)) : null,
        timelineBar(),
        // Each step by its readable name, how long it ran and when it ended (a running one's time ticking, T256), its state, and its Worker (T171, T239).
        el('ol', { class: 'timeline' }, run.nodes.map(stepItem))),
      keptFold('tech-' + runId, 'Technical details', el('p', { class: 'muted' }, 'Template ' + run.template + ' · last changed ', ago(run.updatedAt), ' · spec ', shortId(run.specHash, 'Copy spec hash'), run.sessionId ? [' · session ', shortId(run.sessionId, 'Copy session ID')] : null),
        el('p', { class: 'muted' }, 'run ', shortId(run.runId, 'Copy run ID')))),
    el('div', { class: 'col-side' },
      // Where it is now, refreshed with the page: each running step on its Worker and for how long, its last event, and a stall.
      now ? el('section', { class: 'panel', 'aria-label': 'Now' }, el('h3', {}, 'Now', whatIs('step')),
        now.steps.map((st) => el('div', {}, stepStart(st.nodeId) + (st.worker ? ' on ' + nameOf(st.worker) : '') + (st.since ? ', for ' + relative(st.since).replace(/ ago$/, '') : '') + (st.attempt > 1 ? ' (attempt ' + st.attempt + ')' : ''))),
        // Its last event; one that cannot be told says so, why folded (T239).
        isKnown(now.lastEvent) ? el('div', { class: 'muted' }, lastText(now)) : el('div', { class: 'muted' }, 'Last event unknown', keptFold('last-event-' + runId, 'Why', now.lastEvent.unknown)),
        stalledOf(now) ? [stalledOf(now), whatIs('stalled')] : null) : null,
      moving && 'unknown' in moving ? el('p', { class: 'unknown' }, 'Where it is now is unknown (' + moving.unknown + ').') : null,
      summaryPanel(),
      happened.length ? el('section', { class: 'panel', 'aria-label': 'What happened' }, el('h3', {}, 'What happened'), el('ul', {}, happened)) : null,
      // A check of its result that printed nothing for its bound: told now, long before its deadline (T235).
      explain?.stalledChecks?.length ? el('section', { class: 'panel', 'aria-label': 'Checks' }, el('h3', {}, 'Checks'),
        explain.stalledChecks.map((c) => el('div', {}, chip('Check stalled', 'warn'), ' ' + c.check + ': no output since ', ago(c.quietSince),
          el('span', { class: 'muted' }, ' · it goes on until its deadline'),
          fold('Details', el('div', {}, 'command ', el('code', {}, c.command)), el('div', {}, 'stalled at ' + absolute(c.since) + ', after ' + c.stallSeconds + ' s with no output'))))) : null,
      // Where its accepted result stands in its target's landing queue (PROP-0016 I3): its place, who holds the target, its stack.
      queued ? el('section', { class: 'panel', 'aria-label': 'Landing queue' }, el('h3', {}, 'Landing queue'),
        el('p', {}, queued.position ? 'Place ' + queued.position + ' of ' + queued.length + ' waiting to land on ' + queued.key.slice(queued.key.lastIndexOf('#') + 1) : queued.length + ' in the queue'),
        queued.holder ? el('p', { class: 'muted' }, 'Behind task ' + queued.holder.taskId + ', which lands now') : null,
        queued.batch ? el('p', { class: 'muted' }, 'Result ' + queued.batch.index + ' of a stack of ' + queued.batch.size + ' (up to ' + queued.batch.limit + '): rebased in order, checked once, merged together') : null) : null,
      // A research Worker's web calls (T262): how many, unasked, asked, or denied, and each query or URL with its egress verdict.
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
