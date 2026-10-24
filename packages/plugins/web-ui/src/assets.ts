/** The UI's static shell, script, and styles. The script builds the page with DOM methods and textContent only. */

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>system: runs, approvals, reviews, board, Workers, and policy</title>
<link rel="stylesheet" href="/ui/app.css">
</head>
<body>
<header><h1><a href="/ui/" id="home">system</a></h1><nav aria-label="Pages"><a href="/ui/" id="home-link">Home</a> <a href="/ui/?view=board" id="board-link">Board</a> <a href="/ui/?view=workers" id="workers-link">Workers</a> <a href="/ui/?view=policy" id="policy-link">Autonomy policy</a></nav><span id="status" role="status"></span></header>
<div id="outcome"></div>
<main id="main"></main>
<script src="/ui/app.js"></script>
</body>
</html>
`

export const APP_CSS = `
:root { --fg: #1d1d1f; --bg: #fff; --muted: #6e6e73; --line: #e5e5ea; --accent: #0a66c2; --bad: #b3261e; --ok: #1e7d32; --wait: #8a6d00; }
@media (prefers-color-scheme: dark) { :root { --fg: #f2f2f7; --bg: #111113; --muted: #a1a1a6; --line: #2c2c2e; --accent: #64a8ff; --bad: #ff6b60; --ok: #5fd068; --wait: #e2c044; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
header { display: flex; align-items: baseline; gap: 16px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
header h1 { margin: 0; font-size: 18px; } header a { color: inherit; text-decoration: none; } header nav a { margin-right: 12px; padding-bottom: 2px; }
header nav a[aria-current="page"] { font-weight: 600; border-bottom: 2px solid var(--accent); } header nav a:hover { color: var(--accent); }
h2.page { margin-bottom: 0; } p.lead { color: var(--muted); margin-top: 4px; }
#status { color: var(--muted); }
main { padding: 16px; max-width: 1100px; margin: 0 auto; }
table { width: 100%; border-collapse: collapse; margin: 8px 0 24px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
th { color: var(--muted); font-weight: 500; }
a { color: var(--accent); }
.state { font-weight: 600; } .COMPLETED, .completed { color: var(--ok); } .FAILED, .failed { color: var(--bad); } .BLOCKED, .RUNNING, .running { color: var(--wait); }
.ready { color: var(--ok); } .busy, .resting { color: var(--wait); } .unavailable, .quarantined { color: var(--bad); } .unknown { color: var(--muted); font-style: italic; }
.panel, .request dd, .request p { overflow-wrap: anywhere; }
.panel { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin: 12px 0; }
button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; margin-right: 8px; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
input { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; min-width: 240px; }
.muted { color: var(--muted); } code { font-size: 12px; } .answer { white-space: pre-wrap; }
table.queue td:last-child { white-space: nowrap; }
th, td.nowrap { white-space: nowrap; }
#outcome { max-width: 1100px; margin: 0 auto; padding: 0 16px; }
#outcome .panel { margin-top: 16px; } .panel.ok { border-color: var(--ok); } .panel.bad { border-color: var(--bad); }
.panel h3, .panel h4 { margin: 0 0 4px; font-size: 16px; } .panel p { margin: 6px 0; }
.request .meta, .request .tag { color: var(--muted); } .request .tag { border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; font-size: 12px; margin-right: 6px; }
.request dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 8px 0; } .request dt { color: var(--muted); } .request dd { margin: 0; }
.request .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; } .request .actions button { margin-right: 0; }
.request label, .batch-actions label { display: flex; flex-direction: column; gap: 2px; color: var(--muted); font-size: 12px; }
.batch-actions { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; margin: 8px 0; }
.soon { color: var(--wait); font-weight: 600; } details summary { cursor: pointer; color: var(--muted); }
ol.timeline { list-style: none; padding: 0; margin: 8px 0; border-left: 2px solid var(--line); } ol.timeline li.step { padding: 4px 0 8px 12px; position: relative; overflow-wrap: anywhere; }
ol.timeline li.step::before { content: ''; position: absolute; left: -6px; top: 10px; width: 10px; height: 10px; border-radius: 50%; background: var(--line); }
.actions .muted { margin-right: 12px; } .state.ready { color: var(--ok); }
.kanban { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; align-items: start; margin: 12px 0; }
.column h3 { font-size: 14px; margin: 0 0 8px; } .card { border: 1px solid var(--line); border-radius: 8px; padding: 8px; margin: 0 0 8px; overflow-wrap: anywhere; }
.card > * { margin: 2px 0; } .folded details { margin: 8px 0; } .folded .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; margin-top: 8px; }
@media (max-width: 900px) { .kanban { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) { .kanban { grid-template-columns: 1fr; } }
button:disabled { opacity: 0.6; cursor: progress; } button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
textarea { font: 12px/1.4 ui-monospace, monospace; width: 100%; min-height: 320px; padding: 8px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; }
select { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; }
pre.diff { font-size: 12px; overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; padding: 8px; margin: 8px 0; }
pre.diff .add { color: var(--ok); } pre.diff .del { color: var(--bad); }
code.exact { display: block; overflow-wrap: anywhere; } input.number { min-width: 0; width: 9em; } textarea.lines { min-height: 96px; } table.modes select { min-width: 12em; } details.advanced { margin: 8px 0; }
@media (max-width: 640px) { table:not(.queue) th:nth-child(n+4), table:not(.queue) td:nth-child(n+4) { display: none; } table.queue th:nth-child(4), table.queue td:nth-child(4) { display: none; } .request dl { grid-template-columns: 1fr; } .request dt { margin-top: 4px; } }
`

export const APP_JS = `'use strict'
;(() => {
  const main = document.getElementById('main')
  const status = document.getElementById('status')
  const hash = new URLSearchParams(location.hash.slice(1))
  if (hash.get('token')) {
    try { sessionStorage.setItem('system.token', hash.get('token')) } catch {}
    history.replaceState(null, '', location.pathname + location.search)
  }
  let token = null
  try { token = sessionStorage.getItem('system.token') } catch {}

  const el = (tag, props, ...children) => {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props || {})) {
      if (key === 'class') node.className = value
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
      else node.setAttribute(key, value)
    }
    for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child instanceof Node ? child : String(child))
    return node
  }
  const api = async (path, body) => {
    const response = await fetch('/ui/api/' + path, body === undefined
      ? { headers: { authorization: 'Bearer ' + token } }
      : { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const value = await response.json().catch(() => ({}))
    if (!response.ok) throw Object.assign(new Error(value.error || response.statusText), { status: response.status })
    return value
  }
  // A line diff of two texts (longest common subsequence), as lines prefixed '+ ', '- ', or '  '. Bounded by the policy body (128 KiB).
  const lineDiff = (before, after) => {
    const a = before.split('\\n'), b = after.split('\\n')
    const n = a.length, m = b.length
    const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    const out = []
    let i = 0, j = 0
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push(['same', a[i]]); i++; j++ }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(['del', a[i++]])
      else out.push(['add', b[j++]])
    }
    while (i < n) out.push(['del', a[i++]])
    while (j < m) out.push(['add', b[j++]])
    return out
  }
  const subjectText = (s) => s.type + ' ' + s.ref + (s.version ? ' @ ' + s.version : '')
  // A text as a person reads it first: the proposed set for a policy set's hash, a hash in
  // parentheses left out, any other long hash cut to its first 8 characters. The exact text stays folded beside it.
  const LONG_HASH = /(?:sha256:)?[0-9a-f]{16,}/
  const plainly = (text) => text
    .replace(/the set (?:sha256:)?[0-9a-f]{16,}/g, 'the proposed set')
    .replace(/\\s*\\((?:at )?(?:sha256:)?[0-9a-f]{16,}\\)/g, '')
    .replace(/(?:sha256:)?[0-9a-f]{16,}/g, (hash) => hash.replace(/^sha256:/, '').slice(0, 8) + '…')
  const folded = (text, summary) => LONG_HASH.test(text) ? [plainly(text), el('details', {}, el('summary', {}, summary), el('code', { class: 'exact' }, text))] : [text]
  const pretty = (value) => value === undefined ? '' : JSON.stringify(value, null, 2)
  const diffView = (before, after) => el('pre', { class: 'diff' }, lineDiff(pretty(before), pretty(after)).map(([kind, line]) =>
    el('span', kind === 'same' ? {} : { class: kind }, (kind === 'add' ? '+ ' : kind === 'del' ? '- ' : '  ') + line + '\\n')))
  const effectView = (effect) => effect.length
    ? el('ul', {}, effect.map((e) => el('li', {}, (e.projectId ? 'project ' + e.projectId : 'studio') + ': ' + e.actionClass + ' ', el('span', { class: 'state' }, e.from + ' → ' + e.to))))
    : el('p', { class: 'muted' }, 'No effective mode moves: only expiry, batching, commands, or required checks change.')
  const windowText = (seconds) => seconds % 86400 === 0 ? seconds / 86400 + (seconds === 86400 ? ' day' : ' days')
    : seconds % 3600 === 0 ? seconds / 3600 + (seconds === 3600 ? ' hour' : ' hours') : seconds + ' seconds'
  const changeView = (change) => el('div', { class: 'panel' },
    el('p', {}, el('strong', {}, change.policy.id + (change.previous ? ' version ' + change.previous.version + ' → ' + change.policy.version : ' (new, version ' + change.policy.version + ')')),
      el('span', { class: 'muted' }, ' · ' + change.changeId + ' · request ' + change.requestId)),
    change.note ? el('p', {}, change.note) : null,
    // A change the queue proposed itself says so, and why: never the operator's own proposal (INV-6).
    change.origin ? el('p', {}, el('strong', {}, 'Proposed by the queue, not by you: '), 'you approved ', el('code', {}, change.origin.shape.command),
      ' ' + change.origin.approved + ' times among the requests of the last ' + windowText(change.origin.windowSeconds) + ', and rejected none; decision ', el('code', {}, change.origin.decision)) : null,
    el('details', {}, el('summary', {}, 'Hashes of both sets'), el('p', { class: 'muted' }, 'Set ', el('code', {}, change.hash), ', proposed on ', el('code', {}, change.baseHash))),
    effectView(change.effect),
    diffView(change.previous, change.policy))
  // replaceChildren turns null into the text "null": absent sections are dropped first. A render
  // that lands while a pointer or key is pressed waits for its release: replacing the button under
  // a press would drop the click, and with it the operator's verdict (T84).
  let pressed = false
  let pending = null
  const show = (...parts) => {
    const kept = parts.flat().filter((part) => part !== null && part !== undefined)
    if (pressed) pending = kept
    else { pending = null; main.replaceChildren(...kept) }
  }
  const press = () => { pressed = true }
  // After the click the release dispatches, so a deferred render never takes the target away first.
  const release = () => setTimeout(() => {
    pressed = false
    if (pending) { const parts = pending; pending = null; main.replaceChildren(...parts) }
  }, 0)
  document.addEventListener('pointerdown', press, true)
  document.addEventListener('pointerup', release, true)
  document.addEventListener('pointercancel', release, true)
  document.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') press() }, true)
  document.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') release() }, true)
  // Every page opens with its title and, in one line, what it is for.
  const PAGES = {
    home: ['Home', 'What waits for your verdict, what needs a look, how the Workers are doing, and the latest runs.'],
    board: ['Board', 'Every project and its open tasks, and who works on them; pause, resume, or close a project.'],
    workers: ['Workers', 'Every Worker: what it is for, what it does now, and when it is back if it rests at a limit.'],
    policy: ['Autonomy policy', 'Which actions run on their own, which ask you first, and the changes proposed to that.'],
    run: ['Run', 'One run: what it answered, its steps in order, and what you can do with it.'],
  }
  // Idle capacity, and the step that puts it to work.
  const capacityText = (idle, ready) => (idle === undefined ? 'How many Workers are idle is unknown now' : idle + (idle === 1 ? ' Worker idle' : ' Workers idle')) + ' · ' + ready + (ready === 1 ? ' task ready' : ' tasks ready')
    + (ready ? '. A ready task starts when you press Start on its card or the lead runs it: the run claims the task, and a Worker that can do it takes it.' : '.')
  const pageHead = (page, title) => [el('h2', { class: 'page' }, title || PAGES[page][0]), el('p', { class: 'lead' }, PAGES[page][1])]
  const table = (head, rows, cls) => el('table', cls ? { class: cls } : {}, el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))), el('tbody', {}, rows))

  // What the operator's last verdict did, outside the refreshed page: it stays until dismissed.
  // A verdict that was not recorded is an alert, never only a line a refresh overwrites (INV-2).
  const outcome = document.getElementById('outcome')
  const report = (ok, title, lines) => {
    const dismiss = el('button', { onclick: () => outcome.replaceChildren() }, 'Dismiss')
    outcome.replaceChildren(el('div', { class: 'panel ' + (ok ? 'ok' : 'bad'), role: ok ? 'status' : 'alert' },
      el('h3', { class: ok ? 'state completed' : 'state failed' }, title),
      lines.filter(Boolean).map((line) => el('p', {}, line)),
      dismiss))
    outcome.scrollIntoView({ block: 'nearest' })
  }

  // Times as the operator reads them: relative first, the absolute time beside it.
  const absolute = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const relative = (iso) => {
    const ms = Date.parse(iso) - Date.now()
    const past = ms < 0, m = Math.round(Math.abs(ms) / 60000)
    const span = m < 1 ? 'less than a minute' : m < 60 ? m + ' min' : m < 48 * 60 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' days'
    return past ? span + ' ago' : 'in ' + span
  }
  const ago = (iso) => el('time', { datetime: iso, title: absolute(iso) }, relative(iso))

  // Every pending decision links to the card it is decided on (an approval request's, on Home).
  let focusRequest = new URLSearchParams(location.search).get('request')
  const focusCard = (requestId) => {
    const card = document.getElementById('request-' + requestId)
    if (!card) return false
    card.scrollIntoView({ block: 'start' })
    card.focus({ preventScroll: true })
    return true
  }
  const decideLink = (requestId, text) => el('a', { href: '/ui/?request=' + encodeURIComponent(requestId), onclick: (e) => { e.preventDefault(); if (!focusCard(requestId)) openRequest(requestId) } }, text)

  const VERB = { approved: 'Approved', rejected: 'Denied' }
  const NOUN = { approved: 'approval', rejected: 'denial' }
  // Why a verdict was not applied, in plain words: each leaves its request as it was.
  const REFUSED = {
    'unknown-request': 'the queue does not know this request any more. Nothing was decided.',
    'already-resolved': 'it was already decided, withdrawn, or expired before your verdict arrived. Your verdict was not applied.',
    expired: 'it expired before your verdict arrived; an unanswered request counts as denied. Your verdict was not applied.',
    'subject-changed': 'what it asks about changed since the page showed it. Nothing was decided: read it again, then decide.',
    failed: 'the queue could not store your verdict, and nothing of it changed. Try again.',
  }

  // A request in plain words: what is asked, who asked, and what each verdict does. A request's own
  // consequences, when its requester gave them, are shown as given; otherwise the page says what
  // the board does with a verdict on its own kinds of request (docs/design/board.md).
  const describe = (r, projects) => {
    const ref = r.subject.ref
    const project = (id) => projects.get(id)
    const name = (id) => (project(id) && project(id).title) || id
    const charter = /^project:(.+):charter:(\\d+)$/.exec(ref)
    const task = /^board-task:(.+):attempt:(\\d+)$/.exec(ref)
    const call = /^agent-tool-call:([^:]+):(.+)$/.exec(ref)
    const projectText = r.requester.projectId ? ' of project ' + name(r.requester.projectId) : ''
    // A board task by its title when the board lists it, else by its id.
    const titleOf = (taskId) => { for (const p of projects.values()) { const t = (p.tasks || []).find((x) => x.taskId === taskId); if (t) return t.title } return undefined }
    const taskOf = (taskId) => titleOf(taskId) ? 'the task "' + titleOf(taskId) + '"' : 'task ' + taskId
    const Task = (taskId) => { const t = taskOf(taskId); return t.charAt(0).toUpperCase() + t.slice(1) }
    let d
    if (r.action.class === 'charter' && charter) {
      const [, id, v] = charter
      const version = Number(v)
      const founding = r.action.summary.startsWith('Found ') || version === 1
      const p = project(id)
      const proposed = p ? p.open.proposed : undefined
      const open = p ? Object.values(p.open).reduce((a, b) => a + b, 0) : undefined
      d = founding ? {
        title: 'Found project ' + name(id) + ' (charter version 1)',
        subject: 'charter version 1 of project ' + id,
        approve: 'Project ' + name(id) + ' becomes active with this charter. On the board\\'s next sweep (within a minute) '
          + (proposed === undefined ? 'its proposed tasks go' : proposed + ' proposed task(s) go') + ' through the autonomy policy: the ones it allows become ready for a Worker to claim, the others are asked here. Nothing runs by itself.',
        deny: 'Project ' + name(id) + ' is closed as abandoned, and ' + (open === undefined ? 'its open tasks are' : open + ' open task(s) are') + ' cancelled. This cannot be undone.',
        yes: 'Approve: activate project ' + id, no: 'Deny: abandon project ' + id,
        next: 'The board activates project ' + name(id) + ' on its next sweep, within a minute: see it on the Board page.',
      } : {
        title: 'Amend the charter of project ' + name(id) + ' to version ' + version,
        subject: 'charter version ' + version + ' of project ' + id,
        approve: 'Charter version ' + version + ' replaces version ' + (version - 1) + ' of project ' + name(id) + '.',
        deny: 'The amendment is dropped: charter version ' + (version - 1) + ' stays in force.',
        yes: 'Approve: adopt charter version ' + version, no: 'Deny: keep version ' + (version - 1),
        next: 'The board applies it on its next sweep, within a minute.',
      }
    } else if (task) {
      const [, taskId, attempt] = task
      const reason = r.subject.version || ''
      const what = r.action.summary.replace(/^(approval-needed|budget-spent|reconciliation-failed): /, '')
      const subject = taskOf(taskId) + projectText + ', attempt ' + (Number(attempt) + 1)
      d = reason.startsWith('funding') || r.action.class === 'funding' ? {
        title: 'Raise the budget of a task: ' + what.split('; ')[0], subject,
        yes: 'Approve: raise the budget', no: 'Deny: keep the budget',
        next: 'The board applies it to ' + taskOf(taskId) + ' on its next sweep, within a minute.',
      } : reason === 'reconciliation-failed' ? {
        title: 'Go on after a failed reconciliation: ' + what, subject,
        approve: Task(taskId) + ' tries again: its next attempt goes through the autonomy policy for ' + r.action.class + '.',
        deny: Task(taskId) + ' does not go on: it waits for your input until it is cancelled or its wait expires.',
        yes: 'Approve: try again', no: 'Deny: hold the task',
        next: 'The board applies it to ' + taskOf(taskId) + ' on its next sweep, within a minute.',
      } : {
        title: 'Allow a ' + r.action.class + ' step: ' + what, subject,
        approve: Task(taskId) + ' may do this ' + r.action.class + ' step: it becomes ready on the board\\'s next sweep (within a minute), for a Worker to claim.',
        deny: Task(taskId) + ' does not do it: it waits for your input until it is cancelled or its wait expires.',
        yes: 'Approve: allow this ' + r.action.class, no: 'Deny: hold the task',
        next: 'The board moves ' + taskOf(taskId) + ' on its next sweep, within a minute.',
      }
    } else if (call) {
      d = { title: 'Allow a tool call: ' + r.action.summary, subject: 'the exact ' + call[2] + ' call of agent run ' + call[1], yes: 'Approve: allow this call', no: 'Deny: refuse this call',
        next: 'The agent run gets your answer the next time it asks.' }
    } else if (r.action.class === 'policy-change') {
      d = { title: r.action.summary, subject: 'the policy set this change would put in force',
        approve: 'The proposed policy set comes into force at once; open requests are judged again under it.', deny: 'Nothing changes: the policy in force stays.',
        yes: 'Approve: put the change in force', no: 'Deny: keep the policy in force', next: 'See the Autonomy policy page.' }
    } else if (r.action.class === 'merge' && r.requester.component === 'workflow') {
      const landing = /^landing:merge:([0-9a-f]+):([0-9a-f]+)$/.exec(r.subject.version || '')
      d = { title: r.action.summary, subject: 'branch ' + ref + (landing ? ' at ' + landing[2].slice(0, 12) + ', onto the base at ' + landing[1].slice(0, 12) : ''),
        yes: 'Approve: merge it', no: 'Deny: do not merge',
        next: 'The run\\'s branch is merged within a few seconds, as one merge commit; a conflict or a moved branch changes nothing. Nothing is pushed: see the task on the Board page.' }
    } else if (r.action.class === 'remediation' && r.requester.component === 'workflow') {
      d = { title: 'Run a fix: ' + r.action.summary, subject: 'plan ' + ref + ' of run ' + (r.requester.runId || '?'), yes: 'Approve: run the fix', no: 'Deny: do not run it',
        next: 'The run goes on with your answer: see it under Runs.' }
    } else {
      d = { title: r.action.summary, subject: r.subject.type + ' ' + ref }
    }
    const by = r.requester.component === 'board' ? 'the board' + (r.requester.taskId ? ', for ' + taskOf(r.requester.taskId) : '') + projectText
      : r.requester.component === 'worker' ? 'agent run ' + (r.requester.runId || '?') + (r.requester.sessionId ? ' (session ' + r.requester.sessionId + ')' : '')
      : r.requester.component === 'workflow' ? 'run ' + (r.requester.runId || '?') + (r.requester.nodeId ? ', step ' + r.requester.nodeId : '')
      : r.requester.component === 'approvals' ? 'the approval queue, for policy change ' + (r.requester.policyChangeId || '?') + ' (Show change says who proposed it)'
      : r.requester.component + projectText
    return Object.assign({ yes: 'Approve', no: 'Deny', next: '' }, d, { by })
  }

  // The approval queue, by batch: each verdict names the exact subject shown (INV-5). Absent when no queue runs.
  const notes = new Map()
  // The open requests, each as a card the operator decides in place: on the home page, and on the
  // page of what a request is about (a policy change on the policy page). Null when no queue runs;
  // {error} when it could not be read.
  async function queue() {
    let batches
    try { ({ batches } = await api('approvals')) } catch (error) { return error.status === 503 ? null : { error } }
    const requests = batches.flatMap((b) => b.requests)
    // The board's projects name what a charter or a task request is about; without a board, ids only.
    const projects = new Map()
    if (requests.some((r) => r.requester.component === 'board')) {
      try { for (const p of (await api('projects')).projects) projects.set(p.projectId, p) } catch {}
    }
    const described = new Map(requests.map((r) => [r.requestId, describe(r, projects)]))
    const noteFor = (key, label) => {
      const input = el('input', { id: 'note-' + key, value: notes.get(key) || '', oninput: () => notes.set(key, input.value) })
      return el('label', { for: 'note-' + key }, label, input)
    }
    const noteOf = (key) => (notes.get(key) || '').trim()
    // One call for the verdicts shown; each result is reported, recorded or not, until dismissed.
    const decide = async (verdicts, note, batchId, buttons, clicked) => {
      const labels = buttons.map((b) => b.textContent)
      buttons.forEach((b) => { b.disabled = true })
      clicked.textContent = 'Recording…'
      const many = verdicts.length > 1
      const what = (v) => VERB[v.verdict] + ': ' + described.get(v.requestId).title
      const lost = (v) => 'your ' + NOUN[v.verdict] + ' of ' + described.get(v.requestId).title
      try {
        const { results } = await api('approvals/decide', { verdicts, ...(note ? { note } : {}), ...(batchId ? { batchId } : {}) })
        const refused = results.filter((r) => r.refused)
        const recorded = results.filter((r) => !r.refused)
        for (const v of verdicts) notes.delete(v.requestId)
        if (batchId && !refused.length) notes.delete(batchId)
        const lines = results.map((r) => {
          const v = verdicts.find((x) => x.requestId === r.requestId)
          return r.refused ? 'Not recorded: ' + lost(v) + ' (request ' + r.requestId + '): ' + (REFUSED[r.refused] || r.refused)
            : (many ? what(v) + '. ' : '') + 'Recorded as your verdict on request ' + r.requestId + ' (approval record ' + r.approval + '). ' + (v.verdict === 'approved' ? described.get(r.requestId).next : 'Nothing of it goes ahead.')
        })
        report(!refused.length, refused.length ? (many ? recorded.length + ' recorded, ' + refused.length + ' not recorded' : 'Not recorded: ' + lost(verdicts[0]))
          : many ? recorded.length + ' verdicts recorded' : what(verdicts[0]), lines)
      } catch (error) {
        report(false, 'Not recorded: ' + (many ? 'your ' + verdicts.length + ' verdicts' : lost(verdicts[0])),
          ['The server refused the call (' + (error.status || 'no answer') + '): ' + error.message + '.', 'Nothing was decided: ' + (many ? 'the requests are' : 'the request is') + ' still open in the queue.'])
      }
      buttons.forEach((b, i) => { b.disabled = false; b.textContent = labels[i] })
      await refresh()
    }
    const card = (r) => {
      const d = described.get(r.requestId)
      const soon = Date.parse(r.expiresAt) - Date.now() < 3600000
      const yes = el('button', { class: 'primary' }, d.yes)
      const no = el('button', {}, d.no)
      const verdict = (v, clicked) => () => decide([{ requestId: r.requestId, subject: r.subject, verdict: v, ...(noteOf(r.requestId) ? { note: noteOf(r.requestId) } : {}) }], undefined, undefined, [yes, no], clicked)
      yes.addEventListener('click', verdict('approved', yes))
      no.addEventListener('click', verdict('rejected', no))
      // The request id names each button for assistive technology, after its visible label.
      yes.setAttribute('aria-describedby', 'title-' + r.requestId)
      no.setAttribute('aria-describedby', 'title-' + r.requestId)
      // A policy change shows what it changes: its effective modes and the record's diff (INV-5: the subject is its set's hash).
      const shown = el('div', {})
      const showChange = async () => {
        try {
          const { changes } = await api('policy')
          const change = (changes || []).find((c) => c.requestId === r.requestId)
          shown.replaceChildren(change ? changeView(change) : el('p', { class: 'muted' }, 'The change of ' + r.requestId + ' is not among the latest.'))
        } catch (error) { shown.replaceChildren(el('p', { class: 'state failed' }, 'The change could not be read: ' + error.message)) }
      }
      return el('article', { class: 'panel request', id: 'request-' + r.requestId, tabindex: '-1', 'aria-labelledby': 'title-' + r.requestId },
        el('h3', { id: 'title-' + r.requestId }, d.title),
        el('p', { class: 'meta' }, el('span', { class: 'tag' }, r.action.class), ' Asked by ' + d.by + ' · request ' + r.requestId + ' · ',
          el('span', { class: soon ? 'soon' : '' }, (Date.parse(r.expiresAt) > Date.now() ? 'expires ' : 'expired ') + relative(r.expiresAt) + ' — ' + absolute(r.expiresAt)), '; unanswered by then, it counts as denied.'),
        el('dl', {},
          d.title === r.action.summary ? null : [el('dt', {}, 'Request'), el('dd', {}, folded(r.action.summary, 'details'))],
          el('dt', {}, 'About'), el('dd', {}, d.subject, el('details', {}, el('summary', {}, 'Exact subject'), el('code', {}, subjectText(r.subject)))),
          r.action.consequences ? [el('dt', {}, 'What a verdict does'), el('dd', {}, folded(r.action.consequences, 'details'))]
            : d.approve ? [el('dt', {}, 'If you approve'), el('dd', {}, d.approve), el('dt', {}, 'If you deny'), el('dd', {}, d.deny)]
            : [el('dt', {}, 'What a verdict does'), el('dd', { class: 'muted' }, 'The requester did not say. Approving lets it go ahead with exactly what is shown; denying refuses it.')],
          r.action.recommendation ? [el('dt', {}, 'Recommended'), el('dd', {}, r.action.recommendation === 'approve' ? 'approve' : 'deny')] : null),
        r.action.class === 'policy-change' && r.requester.policyChangeId ? el('p', {}, el('button', { onclick: showChange, 'aria-label': 'Show the change of ' + r.requestId }, 'Show change')) : null,
        shown,
        el('div', { class: 'actions' }, noteFor(r.requestId, 'Note with your verdict on this request (optional)'), yes, no))
    }
    return { batches, requests, described, card, decide, noteFor, noteOf }
  }

  async function approvals() {
    const q = await queue()
    if (!q) return null
    if (q.error) return el('section', { 'aria-label': 'Approval queue' }, el('h2', {}, 'Approvals'),
      el('p', { class: 'state failed' }, 'The approval queue could not be read: ' + q.error.message + '. What waits for you is unknown; the page tries again every 5 seconds.'))
    const { batches, requests, card, decide, noteFor, noteOf } = q
    const earliest = requests.reduce((min, r) => !min || r.expiresAt < min ? r.expiresAt : min, undefined)
    return el('section', { 'aria-label': 'Approval queue' }, el('h2', {}, 'Approvals'),
      requests.length ? el('p', {}, requests.length + (requests.length === 1 ? ' request waits' : ' requests wait') + ' for your verdict; the first expires ' + relative(earliest) + '.')
        : el('p', { class: 'muted' }, 'Nothing waits for your verdict.'),
      batches.map((batch) => {
        if (!batch.batchId) return el('div', {}, batches.length > 1 ? el('h3', {}, 'Decided one by one') : null, batch.requests.map((r) => card(r)))
        const yes = el('button', { class: 'primary' }, 'Approve all ' + batch.requests.length + ' in this batch')
        const no = el('button', {}, 'Deny all ' + batch.requests.length + ' in this batch')
        const all = (v, clicked) => () => decide(batch.requests.map((r) => ({ requestId: r.requestId, subject: r.subject, verdict: v, ...(noteOf(r.requestId) ? { note: noteOf(r.requestId) } : {}) })), noteOf(batch.batchId), batch.batchId, [yes, no], clicked)
        yes.addEventListener('click', all('approved', yes))
        no.addEventListener('click', all('rejected', no))
        return el('section', { class: 'panel', 'aria-label': 'Batch ' + batch.batchId },
          el('h3', {}, 'Batch ' + batch.batchId + ': ' + batch.requests.length + ' related requests'),
          el('p', { class: 'muted' }, 'Decide them together with the buttons below, or each on its own.'),
          el('div', { class: 'batch-actions' }, noteFor(batch.batchId, 'Note for every request of this batch (optional)'), yes, no),
          batch.requests.map((r) => card(r)))
      }))
  }

  // The board's tasks in review, one card each: the operator's Accept or Reject names the exact
  // result shown (INV-5). Absent when no board runs.
  async function reviews() {
    let listed
    try { ({ reviews: listed } = await api('reviews')) } catch (error) {
      return error.status === 503 ? null : el('section', { id: 'reviews', 'aria-label': 'Reviews' }, el('h2', {}, 'Reviews'), el('p', { class: 'state failed' }, 'The reviews could not be read: ' + error.message + '. The page tries again every 5 seconds.'))
    }
    const decide = (r, verdict, buttons, clicked) => async () => {
      const labels = buttons.map((b) => b.textContent)
      buttons.forEach((b) => { b.disabled = true })
      clicked.textContent = 'Recording…'
      const key = 'review-' + r.taskId
      try {
        const { task, decision } = await api('reviews/' + encodeURIComponent(r.taskId) + '/decide', { verdict, subject: r.subject, note: (notes.get(key) || '').trim() })
        notes.delete(key)
        report(true, (verdict === 'accept' ? 'Accepted: ' : 'Rejected: ') + r.title, ['Recorded as your acceptance decision ' + decision + '. The task is now ' + task.state + (verdict === 'accept' ? '; tasks that depend on it become ready on the board\\'s next sweep. When its result is a run\\'s worktree, the system commits it on the run\\'s branch and asks you here to merge it.' : '; it goes back for another attempt if it has one left.')])
      } catch (error) {
        report(false, 'Not recorded: your ' + (verdict === 'accept' ? 'acceptance' : 'rejection') + ' of ' + r.title, ['The server refused it (' + (error.status || 'no answer') + '): ' + error.message + '. Nothing was decided: the task is still in review.'])
      }
      buttons.forEach((b, i) => { b.disabled = false; b.textContent = labels[i] })
      await refresh()
    }
    const card = (r) => {
      const yes = el('button', { class: 'primary', 'aria-describedby': 'review-title-' + r.taskId }, 'Accept: mark it done')
      const no = el('button', { 'aria-describedby': 'review-title-' + r.taskId }, 'Reject: send it back')
      yes.addEventListener('click', decide(r, 'accept', [yes, no], yes))
      no.addEventListener('click', decide(r, 'reject', [yes, no], no))
      const key = 'review-' + r.taskId
      const input = el('input', { id: 'note-' + key, value: notes.get(key) || '', oninput: () => notes.set(key, input.value) })
      return el('article', { class: 'panel request', 'aria-labelledby': 'review-title-' + r.taskId },
        el('h3', { id: 'review-title-' + r.taskId }, r.title),
        el('p', { class: 'meta' }, el('span', { class: 'tag' }, r.actionClass), ' Project ' + (r.project.title || r.project.projectId) + ' · task ' + r.taskId + ' · ',
          r.expiresAt ? (r.heldFor === 'operator' ? 'yours until ' : 'its reviewer\\'s until ') + relative(r.expiresAt) + ' (' + absolute(r.expiresAt) + ')' : 'no expiry known'),
        el('dl', {},
          r.goal ? [el('dt', {}, 'Asked'), el('dd', {}, r.goal)] : null,
          el('dt', {}, 'Checks not run'), el('dd', {}, r.pendingChecks.length ? r.pendingChecks.join(', ') + ': nothing has run them. Your Accept counts them as passed, so run them on the result first.' : 'none: every required check passed'),
          el('dt', {}, 'Result'), el('dd', {}, r.run ? el('a', { href: '?run=' + encodeURIComponent(r.run.runId), onclick: (e) => { e.preventDefault(); go(r.run.runId) } }, 'open the run that made it') : 'no run is named',
            el('details', {}, el('summary', {}, 'Exact result (' + r.artifacts.length + ' artifact(s))'), el('div', {}, el('code', {}, subjectText(r.subject))), r.artifacts.map((a) => el('div', {}, el('code', {}, a)))))),
        el('div', { class: 'actions' }, el('label', { for: 'note-' + key }, 'Note with your verdict (optional)', input), yes, no))
    }
    // A review held for the operator expires unseen, and its task then waits for input that nothing revives: say when the first does.
    const mine = listed.filter((r) => r.heldFor === 'operator' && r.expiresAt)
    const first = mine.reduce((min, r) => !min || r.expiresAt < min ? r.expiresAt : min, undefined)
    const section = el('section', { id: 'reviews', 'aria-label': 'Reviews' }, el('h2', {}, 'Reviews'),
      first ? el('p', {}, mine.length + (mine.length === 1 ? ' review is' : ' reviews are') + ' held for you; the first expires ',
        el('span', { class: Date.parse(first) - Date.now() < 3600000 ? 'soon' : '' }, relative(first) + ' — ' + absolute(first)), '. Unanswered by then, its task waits for input, which nothing revives.') : null,
      listed.length ? listed.map(card) : el('p', { class: 'muted' }, 'No task waits for your review.'))
    if (first) section.dataset.firstExpires = first
    return section
  }

  // A run's steps in one line: how many completed, and the steps that failed, wait, or run, by name.
  const stepsText = (run) => {
    const named = (state) => run.nodes.filter((n) => n.state === state).map((n) => n.nodeId)
    const list = (ids) => ids.slice(0, 2).join(', ') + (ids.length > 2 ? ' and ' + (ids.length - 2) + ' more' : '')
    const done = named('COMPLETED').length
    const parts = [done + ' of ' + run.nodes.length + ' completed']
    for (const [state, word] of [['FAILED', 'failed'], ['BLOCKED', 'waiting'], ['RUNNING', 'running']]) if (named(state).length) parts.push(word + ': ' + list(named(state)))
    return parts.join('; ')
  }
  // What a failure asks of the operator, in words.
  const DISPOSITION = { USER_ACTION: 'it needs you', BACKOFF: 'it is tried again later', CODE_FIX: 'it needs a fix in the code or configuration', NONE: 'nothing more happens' }
  const failureText = (error) => error.message + (DISPOSITION[error.disposition] ? ' (' + DISPOSITION[error.disposition] + ')' : '')
  const runLink = (run, text) => el('a', { href: '?run=' + encodeURIComponent(run.runId), onclick: (e) => { e.preventDefault(); go(run.runId) } }, text || run.runId)
  // Why a run needs the operator's look, or nothing when it does not.
  const needsLook = (run) => run.blocked ? (run.blocked.kind === 'tie' ? 'its team tied and waits for your deciding vote' : run.blocked.kind === 'tool-call' ? 'a Worker\\'s tool call waits for your verdict' : run.blocked.approvalRequest ? 'its fix waits for your verdict' : 'its plan waits for your approval')
    : run.status === 'failed' ? 'it failed: ' + (run.error ? failureText(run.error) : 'no reason was recorded') : null
  const RECENT = 15

  // Home: what waits for the operator, the Workers at a glance, the decisions themselves, and the latest runs.
  async function list() {
    const { runs } = await api('runs')
    const queued = await approvals()
    const reviewed = await reviews()
    let roster = null
    try { roster = await api('roster') } catch {}
    const ready = await readyTasks()
    const asked = queued ? queued.querySelectorAll('article.request').length : 0
    const toReview = reviewed ? reviewed.querySelectorAll('article.request').length : 0
    const look = runs.filter(needsLook)
    const jump = (id) => (e) => { e.preventDefault(); const target = document.getElementById(id); if (target) { target.scrollIntoView({ block: 'start' }); target.focus({ preventScroll: true }) } }
    const waiting = [
      asked ? el('li', {}, el('a', { href: '#approvals', onclick: jump('approvals') }, asked + (asked === 1 ? ' request waits' : ' requests wait') + ' for your verdict')) : null,
      toReview ? el('li', {}, el('a', { href: '#reviews', onclick: jump('reviews') }, toReview + (toReview === 1 ? ' task waits' : ' tasks wait') + ' for your review'
        + (reviewed.dataset.firstExpires ? '; the first held for you expires ' + relative(reviewed.dataset.firstExpires) : ''))) : null,
      look.length ? el('li', {}, el('a', { href: '#needs-look', onclick: jump('needs-look') }, look.length + (look.length === 1 ? ' run needs' : ' runs need') + ' a look')) : null,
    ].filter(Boolean)
    const c = roster && roster.counts
    // A source still describing its Workers for the first time: the counts are so far.
    const describing = roster && roster.sources && 'value' in roster.sources ? roster.sources.value.filter((s) => s.describing).map((s) => s.source) : []
    show(pageHead('home'),
      el('section', { class: 'panel', 'aria-label': 'Waiting for you' }, el('h3', {}, 'Waiting for you'),
        waiting.length ? el('ul', {}, waiting) : el('p', { class: 'muted' }, 'Nothing waits for you now.')),
      el('section', { class: 'panel', 'aria-label': 'Workers at a glance' }, el('h3', {}, 'Workers'),
        c ? el('p', {}, c.busy + ' working · ' + c.ready + ' idle · ' + c.resting + ' at a limit · ' + c.unavailable + ' unavailable' + (c.quarantined ? ' · ' + c.quarantined + ' quarantined' : '')
          + (describing.length ? ' (so far: ' + describing.join(', ') + ' still describing its Workers)' : '') + ' ',
          el('a', { href: '/ui/?view=workers', onclick: (e) => { e.preventDefault(); document.getElementById('workers-link').click() } }, 'see each Worker'))
          : el('p', { class: 'muted' }, 'The Workers could not be read now.'),
        ready !== undefined ? el('p', { 'aria-label': 'Capacity' }, capacityText(c ? c.ready : undefined, ready), ' ', el('a', { href: '/ui/?view=board', onclick: (e) => { e.preventDefault(); document.getElementById('board-link').click() } }, 'see the board')) : null),
      queued ? (queued.id = 'approvals', queued.setAttribute('tabindex', '-1'), queued) : null,
      reviewed ? (reviewed.setAttribute('tabindex', '-1'), reviewed) : null,
      look.length ? el('section', { id: 'needs-look', tabindex: '-1', 'aria-label': 'Runs that need a look' }, el('h2', {}, 'Runs that need a look'),
        look.map((run) => el('article', { class: 'panel request', 'aria-label': 'Run ' + run.runId },
          el('h3', {}, run.template + ' run ', runLink(run)),
          el('p', {}, 'Started ', ago(run.createdAt), ': ' + needsLook(run) + '.'),
          el('p', {}, runLink(run, run.status === 'failed' ? 'Open it to continue it or let it be' : 'Open it to decide'))))) : null,
      el('h2', {}, 'Recent runs'),
      runs.length ? table(['Run', 'Template', 'Status', 'Steps', 'Started'], runs.slice(0, RECENT).map((run) => el('tr', {},
        el('td', { class: 'nowrap' }, runLink(run)),
        el('td', { class: 'nowrap' }, run.template),
        el('td', { class: 'nowrap state ' + run.status }, run.status, run.blocked ? el('div', { class: 'muted' }, run.blocked.kind === 'tie' ? 'tied: waits for your vote' : 'waits for approval') : null),
        el('td', {}, stepsText(run)),
        el('td', { class: 'nowrap muted' }, ago(run.createdAt)),
      ))) : el('p', { class: 'muted' }, 'No run yet. A run starts when the lead or a client asks for one.'),
      runs.length > RECENT ? el('p', { class: 'muted' }, (runs.length - RECENT) + ' older run(s) are not listed here; open one by its link, or ask with system status.') : null)
    if (focusRequest) {
      const id = focusRequest
      focusRequest = null
      setTimeout(() => { if (!focusCard(id)) report(false, 'Request ' + id + ' no longer waits', ['It was decided, withdrawn, or expired since the link was made: nothing waits for your verdict on it.']) }, 0)
    }
  }

  // A step's state in words, and what it means for the run.
  const STEP = {
    COMPLETED: ['done', 'completed'], RUNNING: ['running', 'running'], FAILED: ['failed', 'failed'], BLOCKED: ['waiting for you', 'running'],
    WAITING: ['waiting for earlier steps', 'unknown'], READY: ['ready to start', 'ready'], RETIRED: ['dropped from the plan', 'unknown'],
  }
  async function detail(runId) {
    const { run, explain } = await api('runs/' + encodeURIComponent(runId))
    let roster = null
    try { roster = await api('roster') } catch {}
    const names = new Map(roster && 'value' in roster.workers ? roster.workers.value.map((w) => [w.worker, w.name]) : [])
    const nameOf = (worker) => names.get(worker) || worker
    const act = (action, body) => async () => {
      try { await api('runs/' + encodeURIComponent(runId) + '/' + action, body()) } catch (error) {
        report(false, 'Not done: ' + action + ' of run ' + runId, ['The server refused it (' + (error.status || 'no answer') + '): ' + error.message + '. Nothing changed.'])
      }
      await detail(runId).catch((error) => { status.textContent = 'could not refresh: ' + error.message })
    }
    const note = el('input', { id: 'plan-note' })
    const rationale = el('input', { id: 'vote-rationale' })
    const tie = run.blocked && run.blocked.kind === 'tie' ? run.blocked : null
    const vote = (option) => act('vote', () => ({ decision: tie.decision, option, rationale: rationale.value }))
    const decisions = new Map((explain ? explain.nodes : []).map((n) => [n.nodeId, n.decisions]))
    const failed = run.nodes.find((n) => n.state === 'FAILED')
    const running = run.nodes.filter((n) => n.state === 'RUNNING')
    // The run in one sentence: what it is, when it started, and where it is.
    const sentence = run.status === 'completed' ? 'It finished: every step is done.'
      : run.status === 'failed' ? 'It failed' + (failed ? ' at step ' + failed.nodeId : '') + ': ' + (run.error ? failureText(run.error) : failed && failed.error ? failureText(failed.error) : 'no reason was recorded') + '.'
      : run.blocked ? 'It waits for you: ' + needsLook(run) + '.'
      : running.length ? 'It is running: ' + running.map((n) => 'step ' + n.nodeId + (n.worker ? ' on ' + nameOf(n.worker) : '')).join(', ') + '.'
      : 'It is ' + run.status + '.'
    show(
      pageHead('run', 'Run ' + run.runId),
      el('p', {}, el('span', { class: 'state ' + run.status }, run.status), ' · ' + run.template + ' run, started ', ago(run.createdAt), ', last changed ', ago(run.updatedAt), '. ' + sentence),
      tie ? el('div', { class: 'panel' },
        el('p', {}, 'The team tied at ', tie.nodeId, '; until ' + relative(tie.until) + ' (' + absolute(tie.until) + ') it waits for your deciding vote, then ends inconclusive.'),
        el('ul', {}, tie.options.map((o) => el('li', {}, el('strong', {}, o.option + ': '), o.summary))),
        el('div', { class: 'actions' }, el('label', { for: 'vote-rationale' }, 'Why (required)', rationale),
          tie.options.map((o) => el('button', { onclick: vote(o.option) }, 'Vote ' + o.option)),
          el('button', { onclick: vote('inconclusive') }, 'Leave inconclusive'))) : null,
      run.blocked && run.blocked.kind === 'tool-call' ? el('div', { class: 'panel' },
        el('p', {}, 'Step ', run.blocked.nodeId, '\\'s Worker stopped at a tool call that waits for your verdict on approval request ', el('code', {}, run.blocked.approvalRequest),
          ', until ' + relative(run.blocked.until) + ' (' + absolute(run.blocked.until) + '). Approved, the step goes on in the same session and makes that call once; rejected or unanswered, this attempt ends.'),
        el('p', {}, decideLink(run.blocked.approvalRequest, 'Decide it'))) : null,
      run.blocked && !tie && run.blocked.kind !== 'tool-call' && run.blocked.approvalRequest ? el('div', { class: 'panel' },
        el('p', {}, 'The fix at ', run.blocked.nodeId, ' waits for your verdict on approval request ', el('code', {}, run.blocked.approvalRequest),
          run.blocked.until ? ', until ' + relative(run.blocked.until) + ' (' + absolute(run.blocked.until) + ')' : '', '. '),
        el('p', {}, decideLink(run.blocked.approvalRequest, 'Decide it'))) : null,
      run.blocked && !tie && !run.blocked.approvalRequest ? el('div', { class: 'panel' },
        el('p', {}, 'Step ', run.blocked.nodeId, ' waits for your approval of its plan before it runs. ', el('details', {}, el('summary', {}, 'Plan id'), el('code', {}, run.blocked.plan))),
        el('div', { class: 'actions' }, el('label', { for: 'plan-note' }, 'Note (optional)', note),
          el('button', { class: 'primary', onclick: act('approve', () => ({ verdict: 'approved', note: note.value, plan: run.blocked.plan })) }, 'Approve plan'),
          el('button', { onclick: act('approve', () => ({ verdict: 'rejected', note: note.value, plan: run.blocked.plan })) }, 'Reject plan'))) : null,
      run.status === 'running' || run.status === 'failed' ? el('div', { class: 'actions' },
        run.status === 'running' ? [el('button', { onclick: act('stop', () => ({ reason: 'stopped from the web UI' })) }, 'Stop run'), el('span', { class: 'muted' }, 'ends it now: nothing more of it runs')] : null,
        run.status === 'failed' ? [el('button', { class: 'primary', onclick: act('continue', () => ({})) }, 'Continue run'), el('span', { class: 'muted' }, 'runs its failed step again as a new attempt; the steps that are done are kept')] : null) : null,
      run.answer ? el('div', { class: 'panel' }, el('h3', {}, 'Answer'), el('pre', { class: 'answer' }, run.answer))
        : el('p', { class: 'muted' }, run.status === 'completed' ? 'It gave no answer text.' : 'No answer yet: it comes when the last step is done.'),
      el('h3', {}, 'Steps'),
      el('ol', { class: 'timeline' }, run.nodes.map((n) => {
        const [word, cls] = STEP[n.state] || [n.state.toLowerCase(), 'unknown']
        const made = decisions.get(n.nodeId) || []
        return el('li', { class: 'step' },
          el('div', {}, el('strong', {}, n.nodeId), ' ', el('span', { class: 'state ' + cls }, word),
            n.worker ? el('span', { class: 'muted' }, ' · ' + nameOf(n.worker) + (names.has(n.worker) ? '' : ' · ' + (n.tier || n.minTier) + ' tier') + (n.attempt > 1 ? ' · attempt ' + n.attempt : '')) : el('span', { class: 'muted' }, ' · needs ' + (/^[aeiou]/.test(n.minTier) ? 'an ' : 'a ') + n.minTier + ' tier Worker')),
          n.error ? el('div', { class: 'state failed' }, failureText(n.error)) : null,
          made.length ? el('details', {}, el('summary', {}, 'How it was decided (' + made.length + ')'),
            made.map((d) => el('div', {}, el('strong', {}, d.type + ': '), d.outcome, el('span', { class: 'muted' }, ' — ' + d.reasons.join('; '))))) : null)
      })),
      el('details', {}, el('summary', {}, 'Technical details'), el('p', { class: 'muted' }, 'Template ' + run.template + ' · spec ', el('code', {}, run.specHash), run.sessionId ? ' · session ' + run.sessionId : '')),
    )
  }

  // The board's projects, and the operator's pause, resume, and close: each behind a confirmation
  // that says what the move does, sent with the project revision shown, so a project changed since
  // is refused and nothing moves. The page does not refresh while a confirmation is open.
  const OPEN = ['proposed', 'ready', 'claimed', 'running', 'review', 'waiting-for-input', 'waiting-for-approval']
  let confirming = false
  let boardProject = 'all'
  async function boardView() {
    let projects
    try { ({ projects } = await api('projects')) } catch (error) {
      show(pageHead('board'), el('p', { class: error.status === 503 ? 'muted' : 'state failed' }, error.status === 503 ? 'The board is not running, so there are no projects to show.' : 'The board could not be read: ' + error.message + '. The page tries again every 5 seconds.'))
      return
    }
    const count = (p, states) => states.reduce((n, s) => n + (p.open[s] || 0), 0)
    const shown = el('div', {})
    const settle = async () => { confirming = false; await boardView().catch((error) => { status.textContent = 'could not refresh: ' + error.message }) }
    const send = (p, action, body) => async () => {
      try {
        const { project, decision } = await api('projects/' + encodeURIComponent(p.projectId) + '/' + action, Object.assign({ revision: p.revision }, body()))
        report(true, p.title + ' is ' + project.state, ['Recorded as board decision ' + decision + '.'])
      } catch (error) {
        report(false, 'Not done: ' + action + ' of ' + p.title, ['The board refused it (' + (error.status || 'no answer') + '): ' + error.message + '. Nothing moved.'])
      }
      await settle()
    }
    const confirm = (p, action) => () => {
      confirming = true
      const busy = count(p, ['running', 'review'])
      const refused = action === 'close' && busy > 0
      const outcome = el('select', { 'aria-label': 'Outcome of ' + p.projectId }, el('option', { value: 'achieved' }, 'achieved: its criteria are met'), el('option', { value: 'stopped' }, 'stopped: it ends without them'))
      const asked = [p.open['waiting-for-approval'] ? p.open['waiting-for-approval'] + ' task(s) waiting for approval' : null, p.amendment ? 'the pending amendment (charter version ' + p.amendment + ')' : null].filter(Boolean)
      const what = action === 'pause' ? [
        'Until you resume it, no task of it is claimed or started, and no proposed task is put to the policy.',
        busy ? busy + ' task(s) running or in review go on to their outcome.' : 'No task of it is running or in review.',
        'Every wait keeps its expiry, and a request you answer meanwhile still applies.',
      ] : action === 'resume' ? [
        'Its proposed tasks go through the gate on the next sweep of the board, and its ready tasks may be claimed again.',
      ] : refused ? [
        'It cannot close while a task runs or is in review: ' + busy + ' do. Stop the run, or decide the review, first.',
      ] : [
        count(p, OPEN) + ' open task(s) are cancelled (project-closed)' + (p.open.claimed ? ', and the lease of ' + p.open.claimed + ' claimed one(s) released' : '') + '.',
        asked.length ? 'The approval requests of ' + asked.join(' and of ') + ' are withdrawn.' : 'No approval request waits on it.',
        'A closed project takes no task again. This cannot be undone.',
      ]
      const confirmButton = el('button', { class: 'primary', onclick: send(p, action, () => (action === 'close' ? { outcome: outcome.value } : {})) }, 'Confirm ' + action)
      const cancelButton = el('button', { onclick: () => { confirming = false; shown.replaceChildren() } }, 'Cancel')
      shown.replaceChildren(el('div', { class: 'panel', role: 'group', 'aria-label': 'Confirm ' + action + ' of ' + p.projectId },
        el('h3', {}, (action === 'pause' ? 'Pause ' : action === 'resume' ? 'Resume ' : 'Close ') + p.title),
        el('ul', {}, what.map((line) => el('li', {}, line))),
        action === 'close' && !refused ? el('p', {}, 'Outcome: ', outcome) : null,
        refused ? null : confirmButton,
        cancelButton))
      ;(refused ? cancelButton : confirmButton).focus()
    }
    const moves = (p) => p.state === 'active' ? ['pause', 'close'] : p.state === 'paused' ? ['resume', 'close'] : []
    const label = { pause: 'Pause', resume: 'Resume', close: 'Close' }
    // What waits for the operator in each project, each linked to the card it is decided on.
    const q = await queue()
    const open = q && !q.error ? q.requests : []
    const charterOf = (p) => open.find((r) => r.action.class === 'charter' && r.subject.ref.startsWith('project:' + p.projectId + ':charter:'))
    const asksOf = (p) => open.filter((r) => r.requester.component === 'board' && r.requester.projectId === p.projectId && r.requester.taskId)
    const stateOf = (p) => {
      const charter = charterOf(p)
      return el('div', {},
        charter ? el('div', {}, p.state === 'proposed' ? 'Its charter waits for your verdict: ' : 'Its amendment waits for your verdict: ', decideLink(charter.requestId, 'decide it')) : null,
        asksOf(p).length ? el('div', {}, asksOf(p).length + ' task(s) wait for your approval: ', asksOf(p).flatMap((r, i) => [i ? ', ' : '', decideLink(r.requestId, q.described.get(r.requestId).title)])) : null)
    }
    // Who works on a task: the Worker the engine runs its run's step on, by its name, and since when.
    let roster = null
    try { roster = await api('roster') } catch {}
    const working = new Map()
    if (roster && 'value' in roster.workers) for (const w of roster.workers.value) if ('value' in w.work) for (const i of w.work.value.items) working.set(i.runId, { name: w.name, worker: w.worker, since: i.since })
    const shownProjects = boardProject === 'all' ? projects : projects.filter((p) => p.projectId === boardProject)
    const pick = el('select', { id: 'board-project', onchange: () => { boardProject = pick.value; boardView() } },
      el('option', { value: 'all' }, 'All projects (' + projects.length + ')'), projects.map((p) => el('option', { value: p.projectId }, p.title)))
    pick.value = shownProjects.length === projects.length ? 'all' : boardProject
    const ready = shownProjects.reduce((n, p) => n + (p.open.ready || 0), 0)
    const head = (p) => el('article', { class: 'panel request', 'aria-labelledby': 'project-' + p.projectId },
      el('h3', { id: 'project-' + p.projectId }, p.title),
      el('p', { class: 'meta' }, el('span', { class: 'tag' }, p.state), ' project ' + p.projectId + ' · charter version ' + p.charter.version + (p.amendment ? ', amendment ' + p.amendment + ' waits' : '') + ' · ' + count(p, OPEN) + ' open task(s)' + (p.closure ? ' · closed (' + p.closure.outcome + ')' : '')),
      stateOf(p),
      moves(p).length ? el('div', { class: 'actions' }, moves(p).map((m) => el('button', { onclick: confirm(p, m), 'aria-label': label[m] + ' ' + p.projectId }, label[m] + '…'))) : null)
    const WAITS = {
      'approval-needed': 'waits for your approval', 'budget-spent': 'its budget is spent: waits for your funding verdict', 'reconciliation-failed': 'its run could not be settled: waits for your verdict',
      'retries-spent': 'used all its attempts: waits for input', question: 'asked a question: waits for an answer', rejected: 'was rejected: waits for input', 'review-expired': 'its review expired', 'operator-review': 'waits for your review',
    }
    // Where a done task's accepted result stands on its way into the repository (ADR-0060).
    const landingLine = (l) => l.state === 'asked' && l.requestId ? el('div', {}, 'Accepted — waiting to merge into ' + (l.base || 'its base') + ': ', decideLink(l.requestId, 'approve'))
      : l.state === 'merged' ? el('div', {}, 'Accepted and merged into ' + (l.base || 'its base') + (l.commit ? ' as ' : ''), l.commit ? el('code', {}, l.commit.slice(0, 12)) : null, el('span', { class: 'muted' }, ' · not pushed'))
        : l.state === 'refused' ? el('div', {}, 'Accepted — not merged: ' + (l.reason || 'refused'))
          : l.state === 'rejected' ? el('div', {}, 'Accepted — the merge was not approved; ' + (l.branch || 'its branch') + ' keeps the commit')
            : el('div', {}, 'Accepted — being committed on ' + (l.branch || 'its run\\'s branch') + ' to be merged')
    // The operator starts a ready task's run, as the lead does (MCP run with task): behind a
    // confirmation that says what runs and on which kind of Worker, bound to the task and template shown.
    const needs = (step) => step.source ? 'the system reads it itself, on no Worker'
      : (step.team ? 'a team of ' + step.team.members + ' Workers, each of another provider, each' : 'a Worker') + ' of ' + step.tier + ' tier or above that can ' + step.capabilities.join(', ')
        + (step.kind ? ', for ' + step.kind + ' work' : '') + (step.plans ? '; it plans further steps, which may ask for your approval' : '')
    const start = (t) => async () => {
      confirming = true
      const close = el('button', { onclick: () => { confirming = false; shown.replaceChildren() } }, 'Cancel')
      let preview
      try { preview = await api('tasks/' + encodeURIComponent(t.taskId) + '/start') } catch (error) {
        shown.replaceChildren(el('div', { class: 'panel bad', role: 'alert', 'aria-label': 'Cannot start ' + t.title },
          el('h3', {}, 'It cannot start from here: ' + t.title), el('p', {}, error.message.replace(/^[a-z_]+: /, '')), close))
        close.focus()
        return
      }
      const { task, steps } = preview
      const yes = el('button', { class: 'primary' }, 'Confirm start')
      yes.addEventListener('click', async () => {
        yes.disabled = true
        close.disabled = true
        yes.textContent = 'Starting…'
        try {
          const { run } = await api('tasks/' + encodeURIComponent(t.taskId) + '/start', { revision: task.revision, template: task.template })
          report(true, 'Started: ' + t.title, [['Run ', runLink(run), ' of the ' + task.template + ' template claimed the task: it is under Working on the Board, and its page shows each step as it runs.']])
        } catch (error) {
          report(false, 'Not started: ' + t.title, ['The server refused it (' + (error.status || 'no answer') + '): ' + error.message + '. Nothing was started: the task is still ready.'])
        }
        await settle()
      })
      shown.replaceChildren(el('div', { class: 'panel', role: 'group', 'aria-label': 'Confirm start of ' + t.title },
        el('h3', {}, 'Start ' + t.title),
        el('ul', {},
          el('li', {}, 'It runs the ' + task.template + ' template for this task, its attempt ' + (task.attempts.count + 1) + ' of ' + task.attempts.max + ': the run claims the task, which moves to Working.'),
          el('li', {}, steps.length === 1 ? 'Its step, and the kind of Worker it runs on:' : 'Its ' + steps.length + ' steps, in order, and the kind of Worker each runs on:',
            el('ol', {}, steps.map((step) => el('li', {}, step.objective + ': ' + needs(step) + '.')))),
          el('li', {}, (idle === undefined ? 'How many Workers are idle is unknown now' : idle + (idle === 1 ? ' Worker is' : ' Workers are') + ' idle now') + '; a step no free Worker can take waits for one.'),
          el('li', {}, 'Nothing runs until you confirm. Once it runs, its page has Stop run.')),
        yes, close))
      yes.focus()
    }
    const cardOf = (p, t) => {
      const run = t.run ? working.get(t.run.runId) : undefined
      const since = t.updatedAt || t.createdAt
      return el('article', { class: 'card', 'aria-label': t.title },
        el('strong', {}, t.title),
        boardProject === 'all' && projects.length > 1 ? el('div', { class: 'muted' }, p.title) : null,
        el('div', { class: 'muted' }, el('span', { class: 'tag' }, t.actionClass), ' ', ago(since)),
        t.state === 'proposed' ? el('div', {}, 'Waits for its dependencies and the autonomy policy') : null,
        t.state === 'ready' ? el('div', {}, t.template ? 'Ready to start: a ' + t.template + ' run' : 'Ready; it names no template, so the lead starts it') : null,
        t.state === 'ready' ? el('div', { class: 'actions' }, el('button', { onclick: start(t), 'aria-label': 'Start ' + t.title }, 'Start…')) : null,
        t.state === 'claimed' || t.state === 'running' ? el('div', {}, run ? [run.name + ', ', 'value' in run.since ? 'for ' + relative(run.since.value).replace(/ ago$/, '') : 'since an unknown time'] : t.state === 'claimed' ? 'Claimed; no step runs yet' : 'Running; its Worker is not known now') : null,
        t.state === 'review' ? el('div', {}, 'Waits for a review: ', el('a', { href: '/ui/', onclick: (e) => { e.preventDefault(); go(); setTimeout(() => { const r = document.getElementById('reviews'); if (r) { r.scrollIntoView({ block: 'start' }); r.focus({ preventScroll: true }) } }, 300) } }, 'review it')) : null,
        t.waiting && t.state.startsWith('waiting') ? el('div', {}, (WAITS[t.waiting.reason] || t.waiting.reason) + ' ', t.waiting.approvalRequest ? decideLink(t.waiting.approvalRequest, 'decide its approval') : null, el('span', { class: 'muted' }, ' · until ' + relative(t.waiting.expiresAt))) : null,
        t.landing ? landingLine(t.landing) : null,
        t.run ? el('div', {}, el('a', { href: '?run=' + encodeURIComponent(t.run.runId), onclick: (e) => { e.preventDefault(); go(t.run.runId) }, 'aria-label': 'Open the run of ' + t.title }, 'open its run')) : null)
    }
    // A done task whose merge waits for the operator is also shown where the operator looks for what waits (ADR-0060).
    const waitsToMerge = (t) => t.state === 'done' && t.landing && t.landing.state === 'asked'
    const tasksIn = (states) => shownProjects.flatMap((p) => (p.tasks || []).filter((t) => states.includes(t.state) || (states.includes('waiting-for-approval') && waitsToMerge(t))).map((t) => [p, t]))
    const moreIn = (states) => shownProjects.reduce((n, p) => n + states.reduce((m, s) => m + ((p.more || {})[s] || 0), 0), 0)
    const column = (name, states, hint) => {
      const cards = tasksIn(states)
      return el('section', { class: 'column', 'aria-label': name },
        el('h3', {}, name + ' (' + (cards.length + moreIn(states)) + ')'),
        cards.length ? cards.map(([p, t]) => cardOf(p, t)) : el('p', { class: 'muted' }, hint),
        moreIn(states) ? el('p', { class: 'muted' }, moreIn(states) + ' older not shown') : null)
    }
    const folded = (name, states) => {
      const cards = tasksIn(states)
      return el('details', { class: 'column' }, el('summary', {}, name + ' (' + (cards.length + moreIn(states)) + ')'),
        cards.length ? el('div', { class: 'cards' }, cards.map(([p, t]) => cardOf(p, t))) : el('p', { class: 'muted' }, 'None.'))
    }
    const idle = roster ? roster.counts.ready : undefined
    show(
      pageHead('board'),
      projects.length ? null : el('p', { class: 'muted' }, 'No project is on the board yet. A project starts when the lead proposes its charter and you approve it.'),
      projects.length ? el('p', {}, el('label', { for: 'board-project' }, 'Show ', pick)) : null,
      projects.length ? el('p', { 'aria-label': 'Capacity' }, capacityText(idle, ready)) : null,
      shownProjects.map(head),
      shown,
      projects.length ? el('div', { class: 'kanban' },
        column('Proposed', ['proposed'], 'None proposed.'),
        column('Ready', ['ready'], 'None ready.'),
        column('Working', ['claimed', 'running'], 'Nothing runs now.'),
        column('Review', ['review'], 'Nothing to review.'),
        column('Waiting for you', ['waiting-for-input', 'waiting-for-approval'], 'Nothing waits for you.')) : null,
      projects.length ? el('div', { class: 'folded' }, folded('Done', ['done']), folded('Cancelled', ['cancelled'])) : null)
  }

  // The Workers (the roster, docs/design/roster.md): one card per Worker, grouped by what it does
  // now, each saying what it is for, its status and why, what it works on, its account, limits, and
  // load. A fact its source could not give shows as unknown with why, never a default.
  const STATUS = {
    busy: { group: 'Working', word: 'working' },
    ready: { group: 'Idle', word: 'idle' },
    resting: { group: 'At a limit', word: 'at a limit' },
    unavailable: { group: 'Unavailable', word: 'unavailable' },
    quarantined: { group: 'Quarantined', word: 'quarantined' },
  }
  // A time as its clock time ("14:20"), with the day when it is not today.
  const clockOf = (iso) => {
    const d = new Date(iso)
    return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : absolute(iso)
  }
  // Tasks ready across the board's projects, or undefined when the board cannot be read.
  const readyTasks = async () => {
    try { return (await api('projects')).projects.reduce((n, p) => n + (p.open.ready || 0), 0) } catch { return undefined }
  }
  // A time as "in 2 h (11:40)": relative, then the clock time, with the day when it is not today.
  const when = (iso) => relative(iso) + ' (' + clockOf(iso) + ')'
  // A window's length as "5 h" or "7 d" (ADR-0059's "used 42 % of 5 h").
  const span = (seconds) => seconds % 86400 === 0 ? seconds / 86400 + ' d' : seconds % 3600 === 0 ? seconds / 3600 + ' h' : seconds % 60 === 0 ? seconds / 60 + ' min' : seconds + ' s'
  // One window of a pool: "five-hour: used 42 % of 5 h, resets 14:20 (read 14:05)", from its latest
  // reading (an account's usage report, or a run's own); what that reading does not give stays unknown, with why.
  const windowLine = (win) => win.id + ': ' + ('value' in win.used ? 'used ' + win.used.value + ' %' + (win.seconds ? ' of ' + span(win.seconds) : '') : 'used unknown (' + win.used.unknown + ')')
    + ', resets ' + ('value' in win.resets ? clockOf(win.resets.value) : 'unknown (' + win.resets.unknown + ')')
    + (win.observedAt ? ' (read ' + clockOf(win.observedAt) + ')' : '')
    + (win.state === 'limited' ? '; at its limit' : '')
  async function workersView() {
    const roster = await api('roster')
    const ready = await readyTasks()
    const isKnown = (k) => 'value' in k
    const known = (k, render) => isKnown(k) ? render(k.value) : el('span', { class: 'unknown' }, 'unknown (' + k.unknown + ')')
    const text = (k, render) => isKnown(k) ? (render ? render(k.value) : String(k.value)) : 'unknown (' + k.unknown + ')'
    // Its status in plain words, with the reason.
    const statusOf = (w) => {
      const a = w.availability
      if (a.state === 'busy') return a.slots !== undefined ? 'Working: ' + a.running + ' of ' + a.slots + ' slot(s) in use' + (a.running < a.slots ? '; it still takes work' : '; it takes no more until one ends') : 'Working (how many of its slots are in use is unknown)'
      if (a.state === 'ready') return 'Idle: it takes work now'
      if (a.state === 'resting') return 'At a limit: ' + (isKnown(a.until) ? 'back ' + when(a.until.value) : 'no reset is known (' + a.until.unknown + ')')
      if (a.state === 'unavailable') return 'Unavailable: ' + text(a.reason)
      return 'Quarantined: its account ' + ({ changed: 'signed in as someone else', ambiguous: 'could not be told apart from another', duplicate: 'is the same person as another', unverified: 'is not verified' }[a.reason] || a.reason) + (a.detail ? ' (' + a.detail + ')' : '') + ', since ' + when(a.since)
    }
    const accountOf = (w) => known(w.account, (a) => el('span', {},
      isKnown(a.record) && a.record.value.label ? text(a.record.value.label) + ' ' : '',
      el('span', { class: 'muted' }, a.id + (isKnown(a.record) ? ' · ' + a.record.value.kind + ' account, ' + a.record.value.status + (a.record.value.slot !== undefined ? ', slot ' + a.record.value.slot : '') : ' · its record is unknown (' + a.record.unknown + ')')),
      isKnown(a.record) && a.record.value.sameAs ? el('div', { class: 'state failed' }, 'signed in as the same person as ' + a.record.value.sameAs.join(', ')) : null))
    // Its runs whose liveness needs a look (PROP-0013): a held one is the operator's to free, a stalled or looked-at one is only said.
    const livenessOf = (w) => !w.liveness ? null : known(w.liveness, (runs) => el('ul', { 'aria-label': 'Runs whose liveness needs a look' }, runs.map((r) => el('li', { class: r.state === 'unknown' ? 'state failed' : 'unknown' }, r.summary,
      r.runId ? el('span', {}, ' ', el('a', { href: '?run=' + encodeURIComponent(r.runId), onclick: (e) => { e.preventDefault(); go(r.runId) }, 'aria-label': 'Open run ' + r.runId }, 'open run')) : null))))
    const doing = (w) => el('div', {}, known(w.work, (work) => el('div', {},
      work.items.length ? el('ul', {}, work.items.map((i) => el('li', {}, i.summary, ' ',
        el('a', { href: '?run=' + encodeURIComponent(i.runId), onclick: (e) => { e.preventDefault(); go(i.runId) }, 'aria-label': 'Open run ' + i.runId }, 'open run')))) : el('span', { class: 'muted' }, 'Nothing now.'),
      work.more ? el('div', { class: 'muted' }, work.more + ' more step(s) not listed') : null,
      work.unread ? el('div', { class: 'unknown' }, work.unread) : null)), livenessOf(w))
    const limitsOf = (w) => {
      const lines = w.limits.map((l) => l.capability + ' held off until ' + when(l.until))
      if (isKnown(w.account) && w.account.value.limitUntil) lines.unshift('its account is back ' + when(w.account.value.limitUntil))
      return el('div', {},
        lines.map((line) => el('div', {}, line)),
        known(w.pools, (pools) => pools.length ? el('div', {}, pools.map((p) => el('div', {},
          el('strong', {}, p.pool), ' ' + (p.available ? 'open' : 'closed' + (p.until ? ', back ' + when(p.until) : '')),
          p.windows.map((win) => el('div', { class: 'muted', 'aria-label': 'window ' + win.id + ' of ' + p.pool }, windowLine(win))),
          isKnown(p.unknownUsage) ? (p.unknownUsage.value.runs ? el('div', { class: 'unknown' }, p.unknownUsage.value.runs + ' run(s) with usage it could not count') : null) : el('div', { class: 'unknown' }, 'usage not counted: unknown (' + p.unknownUsage.unknown + ')')))) : (lines.length ? null : el('span', { class: 'muted' }, 'No pool on its account.'))))
    }
    // Its display name heads the card; the id, the key every record uses, stays under it.
    const card = (w) => el('article', { class: 'panel request', 'aria-labelledby': 'worker-' + w.worker + ' worker-id-' + w.worker },
      el('h4', { id: 'worker-' + w.worker }, w.name),
      el('p', { class: 'muted', id: 'worker-id-' + w.worker }, 'Worker id ', el('code', {}, w.worker)),
      isKnown(w.description) ? el('p', {}, w.description.value)
        : el('p', { class: 'muted' }, el('span', { class: 'tag' }, 'derived'), ' ' + w.derived + ' (no description is configured)'),
      el('p', { class: 'state ' + w.availability.state }, statusOf(w)),
      el('dl', {},
        el('dt', {}, 'Doing now'), el('dd', {}, doing(w)),
        el('dt', {}, 'Account'), el('dd', {}, accountOf(w)),
        el('dt', {}, 'Serves'), el('dd', {}, w.tier + ' tier, ' + w.quotaClass + ', ' + w.locality + '; provider ' + w.provider + ', family ' + text(w.family) + ', role ' + text(w.role, (r) => r === null ? 'none' : r)),
        el('dt', {}, 'Limits'), el('dd', {}, limitsOf(w)),
        el('dt', {}, 'Load'), el('dd', {}, text(w.load, (l) => l.running + ' of ' + l.slots + ' running, ' + l.queued + ' queued, ' + l.pending + ' routed and not started')))
    )
    const c = roster.counts
    const resting = isKnown(roster.workers) ? roster.workers.value.filter((w) => w.availability.state === 'resting' && isKnown(w.availability.until)).map((w) => w.availability.until.value).sort()[0] : undefined
    const counts = [c.busy + ' working', c.ready + ' idle', c.resting + ' at a limit' + (resting ? ' (the first back ' + when(resting) + ')' : ''), c.unavailable + ' unavailable'].concat(c.quarantined ? [c.quarantined + ' quarantined'] : [])
    const unheard = isKnown(roster.sources) ? roster.sources.value.filter((s) => s.state !== 'described') : []
    show(
      pageHead('workers'),
      el('p', { 'aria-label': 'Worker counts' }, counts.join(' · ') + (roster.unlisted ? ' · ' + roster.unlisted + ' more not listed' : '')),
      ready === undefined ? null : el('p', { 'aria-label': 'Capacity' }, capacityText(c.ready, ready)),
      el('p', { class: 'muted' }, 'Read ', ago(roster.asOf), '; the page refreshes every 5 seconds.'),
      isKnown(roster.sources) ? null : el('p', { class: 'unknown' }, 'Worker sources: unknown (' + roster.sources.unknown + ')'),
      unheard.length ? el('div', {}, unheard.map((s) => s.describing
        ? el('p', { class: 'muted' }, 'The Worker source ' + s.source + ' is still describing its Workers: its first read since it started has not landed (' + relative(s.at) + '). Its Workers are not listed yet, so the counts above are so far.')
        : el('p', { class: 'state failed' }, 'The Worker source ' + s.source + ' was ' + s.state + ' ' + relative(s.at) + (s.detail ? ': ' + s.detail : '') + '. Its Workers are not listed.'))) : null,
      known(roster.workers, (workers) => workers.length
        ? el('div', {}, ['busy', 'ready', 'resting', 'unavailable', 'quarantined'].map((state) => {
          const group = workers.filter((w) => w.availability.state === state)
          return group.length ? el('section', { 'aria-label': STATUS[state].group }, el('h3', {}, STATUS[state].group + ' (' + group.length + ')' + (state === 'ready' ? ': each takes work as soon as a run is routed to it' : '')), group.map(card)) : null
        }))
        : el('p', { class: 'muted' }, 'No Worker is configured.')))
  }

  // The autonomy policy in force, its history, and a proposed change with its diff. A proposal is
  // asked in the approval queue as a policy-change request; only the operator's approval there applies it.
  async function policyView() {
    let value
    try { value = await api('policy') } catch (error) {
      show(pageHead('policy'), el('p', { class: error.status === 503 ? 'muted' : 'state failed' }, error.status === 503 ? 'The approval queue is not running, so there is no autonomy policy to show.' : 'The policy could not be read: ' + error.message + '. Reload the page to try again.'))
      return
    }
    const { set, policies, effective, changes, proposals } = value
    // An asked change is decided here, on its own card, as on Home (T95).
    const q = await queue()
    const askedCards = (changes || []).filter((c) => c.state === 'asked').flatMap((c) => {
      const r = q && !q.error ? q.requests.find((x) => x.requestId === c.requestId) : undefined
      return r ? [q.card(r)] : []
    })
    const columns = effective.map((e) => e.projectId ? 'project ' + e.projectId : 'studio')
    const classes = effective[0].effective.map((e) => e.actionClass)
    // The proposed record, edited as a form (a mode per action class, the commands as lines, the
    // expiry and batch numbers) or, folded under Advanced, as JSON; both edit one draft. The queue
    // validates the proposal as it always did: the page refuses nothing the queue would take.
    const fixed = new Set(value.alwaysAsk || [])
    const editor = el('textarea', { 'aria-label': 'Proposed policy record (JSON)', spellcheck: 'false' })
    const note = el('input', { placeholder: 'why (optional)', 'aria-label': 'Note for the proposed change' })
    const preview = el('div', {})
    const form = el('div', {})
    const NEW = '(a new project policy)'
    const pick = el('select', { 'aria-label': 'Policy to change' }, policies.map((p) => el('option', { value: p.id }, p.id)), el('option', { value: NEW }, NEW))
    const selected = () => policies.find((p) => p.id === pick.value)
    let draft
    // The JSON shown under Advanced follows the form; an edit there that is not JSON leaves the form as it was.
    const sync = () => { editor.value = pretty(draft); preview.replaceChildren() }
    const edit = (change) => { change(draft); sync() }
    const hours = (seconds) => String(Math.round(seconds / 36) / 100)
    const minutes = (seconds) => String(Math.round(seconds / 0.6) / 100)
    const number = (label, id, shown, onvalue, extra) => {
      const input = el('input', Object.assign({ id, type: 'number', value: shown, min: '0', step: 'any', class: 'number' }, extra || {}))
      input.addEventListener('input', () => onvalue(input.value === '' ? undefined : Number(input.value)))
      return el('label', { for: id }, label, input)
    }
    const modeText = { auto: 'auto: it runs on its own', notify: 'notify: it runs, then tells you', ask: 'ask: it waits for your approval', forbid: 'forbid: it never runs' }
    const WHY = { merge: 'an accepted result lands only on your approval', 'external-send': 'it cannot be undone', deploy: 'it cannot be undone', 'delete-data': 'it cannot be undone', spend: 'it is your decision', charter: 'it is your decision', funding: 'it is your decision', 'policy-change': 'it is your decision', remediation: 'a fix that writes, or a lost run going on, is yours to allow', promotion: 'the system never approves its own change' }
    const buildForm = () => {
      const p = draft
      const studio = p.scope !== 'project'
      const ruleOf = (c) => (p.rules || []).find((r) => r.actionClass === c)
      const modeRow = (c) => {
        const rule = ruleOf(c)
        if (fixed.has(c)) return el('tr', {}, el('td', {}, c), el('td', {}, el('strong', {}, rule && rule.mode === 'forbid' ? 'forbid' : 'ask')),
          el('td', { class: 'muted' }, 'always asks, whatever a rule says: ' + (WHY[c] || 'the queue always asks for it') + (rule && rule.mode === 'forbid' ? '; forbidden here (change it under Advanced)' : '')))
        const select = el('select', { id: 'mode-' + c, 'aria-label': 'Mode of ' + c },
          el('option', { value: '' }, studio ? 'not named: the default (' + p.default + ')' : 'not named: as the studio'),
          ['auto', 'notify', 'ask', 'forbid'].map((m) => el('option', { value: m }, m)))
        select.value = rule ? rule.mode : ''
        select.addEventListener('change', () => edit((d) => {
          const kept = (d.rules || []).filter((r) => r.actionClass !== c)
          const old = ruleOf(c)
          d.rules = select.value ? (old ? d.rules.map((r) => r.actionClass === c ? Object.assign({}, r, { mode: select.value }) : r) : kept.concat([{ actionClass: c, mode: select.value }])) : kept
          buildForm()
          document.getElementById('mode-' + c).focus()
        }))
        return el('tr', {}, el('td', {}, el('label', { for: 'mode-' + c }, c)), el('td', {}, select),
          el('td', { class: 'muted' }, rule ? modeText[rule.mode] + (rule.requires && rule.requires.length ? ', once ' + rule.requires.join(', ') + ' pass' : '') + (rule.expiresSeconds ? '; its requests wait ' + hours(rule.expiresSeconds) + ' h' : '') : studio ? 'no rule: ' + modeText[p.default] : 'no rule: the studio policy decides'))
      }
      const fallback = el('select', { id: 'policy-default', 'aria-label': 'Mode of a class no rule names' }, el('option', { value: 'ask' }, 'ask'), el('option', { value: 'forbid' }, 'forbid'))
      fallback.value = p.default
      fallback.addEventListener('change', () => edit((d) => { d.default = fallback.value; buildForm(); document.getElementById('policy-default').focus() }))
      const commands = el('textarea', { id: 'policy-commands', class: 'lines', 'aria-label': 'Commands judged as workspace writes, one per line', spellcheck: 'false' })
      commands.value = (p.commands || []).join('\\n')
      commands.addEventListener('input', () => edit((d) => {
        const lines = commands.value.split('\\n').map((l) => l.trim()).filter(Boolean)
        if (lines.length) d.commands = lines
        else delete d.commands
      }))
      const project = studio ? null : el('input', { id: 'policy-project', value: p.projectId || '', 'aria-label': 'Project of the new policy' })
      if (project) project.addEventListener('input', () => edit((d) => { d.projectId = project.value.trim(); if (!selected()) d.id = project.value.trim() + '.policy' }))
      const batch = p.batch || {}
      form.replaceChildren(
        el('p', {}, el('strong', {}, p.id), ' · ' + (selected() ? 'version ' + selected().version + ' → ' + p.version + ' (the next version, raised for you)' : 'a new project policy, version ' + p.version),
          project ? el('span', {}, ' · ', el('label', { for: 'policy-project' }, 'project ', project)) : null),
        table(['Action class', 'Mode', 'What it means'], (classes).map(modeRow), 'queue modes'),
        el('div', { class: 'batch-actions' },
          studio ? el('label', { for: 'policy-default' }, 'A class no rule names', fallback) : null,
          number('Requests wait (hours)', 'policy-expiry', hours(p.expiry.defaultSeconds), (h) => edit((d) => { d.expiry = Object.assign({}, d.expiry, { defaultSeconds: h === undefined ? undefined : Math.round(h * 3600) }) })),
          number('At most (hours)', 'policy-expiry-max', hours(p.expiry.maxSeconds), (h) => edit((d) => { d.expiry = Object.assign({}, d.expiry, { maxSeconds: h === undefined ? undefined : Math.round(h * 3600) }) })),
          number('Batch: at most (requests)', 'policy-batch-size', batch.maxSize === undefined ? '' : String(batch.maxSize), (n) => edit((d) => {
            const next = Object.assign({}, d.batch, { maxSize: n })
            if (next.maxSize === undefined && next.maxWaitSeconds === undefined) delete d.batch; else d.batch = next
          }), { step: '1' }),
          number('Batch: shown after (minutes)', 'policy-batch-wait', batch.maxWaitSeconds === undefined ? '' : minutes(batch.maxWaitSeconds), (m) => edit((d) => {
            const next = Object.assign({}, d.batch, { maxWaitSeconds: m === undefined ? undefined : Math.round(m * 60) })
            if (next.maxSize === undefined && next.maxWaitSeconds === undefined) delete d.batch; else d.batch = next
          }))),
        el('label', { for: 'policy-commands' }, 'Commands judged as workspace writes, one per line, matched word for word', commands))
    }
    const fill = () => {
      const p = selected()
      draft = p ? Object.assign({}, p, { version: p.version + 1 })
        : { schema: 'autonomy-policy@1.0', id: 'project-id.policy', version: 1, scope: 'project', projectId: 'project-id', narrows: policies[0].id, rules: [{ actionClass: 'merge', mode: 'ask' }], default: 'ask', expiry: { defaultSeconds: 86400, maxSeconds: 1209600 } }
      sync()
      buildForm()
    }
    pick.addEventListener('change', fill)
    const parsed = () => {
      try { return JSON.parse(editor.value) } catch (error) { preview.replaceChildren(el('p', { class: 'state failed' }, 'Not JSON: ' + error.message)); return undefined }
    }
    // An edit of the JSON that parses to a record is the draft, and the form shows it.
    editor.addEventListener('input', () => {
      let next
      try { next = JSON.parse(editor.value) } catch { return }
      if (next && typeof next === 'object' && !Array.isArray(next) && Array.isArray(next.rules) && next.expiry && typeof next.expiry === 'object') { draft = next; buildForm() }
    })
    const showDiff = () => {
      const proposed = parsed()
      if (proposed !== undefined) preview.replaceChildren(el('p', { class: 'muted' }, selected() ? 'Changes to ' + selected().id + ' version ' + selected().version + ':' : 'A new policy:'), diffView(selected(), proposed))
    }
    const propose = async () => {
      const proposed = parsed()
      if (proposed === undefined) return
      try {
        const { change, request } = await api('policy/propose', { policy: proposed, note: note.value })
        status.textContent = 'proposed ' + change.changeId + ': decide request ' + request.requestId + ' in the approval queue'
        report(true, 'Proposed: ' + change.policy.id + ' version ' + change.policy.version, ['Recorded as change ' + change.changeId + '. Nothing changes yet: it waits for your verdict on request ' + request.requestId + ', shown at the top of this page and on Home.'])
        await policyView()
      } catch (error) { preview.replaceChildren(el('p', { class: 'state failed', role: 'alert' }, 'Not proposed: ' + error.message)) }
    }
    const when = (t) => t ? ago(t) : '-'
    show(
      pageHead('policy'),
      askedCards.length ? el('section', { 'aria-label': 'Changes waiting for your verdict' },
        el('h3', {}, askedCards.length === 1 ? 'A change waits for your verdict' : askedCards.length + ' changes wait for your verdict'),
        el('p', { class: 'muted' }, 'A change applies only once you approve it, here or on Home.'),
        askedCards) : null,
      set ? el('p', {}, set.source === 'store' ? 'In force: the change ' + set.changeId + ' you approved, kept while the configuration it came from is unchanged.' : 'In force: the configuration.',
        el('details', {}, el('summary', {}, 'Exact set'), el('code', {}, set.hash), set.configHash ? el('div', { class: 'muted' }, 'configuration ', el('code', {}, set.configHash)) : null)) : null,
      el('p', { class: 'muted' }, 'auto: it runs on its own · notify: it runs, then tells you · ask: it waits for your approval on Home · forbid: it never runs.'),
      table(['Action class'].concat(columns), classes.map((c) => el('tr', {}, el('td', {}, c), effective.map((e) => el('td', {}, (e.effective.find((x) => x.actionClass === c) || {}).mode || '-')))), 'queue'),
      el('h3', {}, 'Policies'),
      table(['Policy', 'Scope', 'Version'], policies.map((p) => el('tr', {}, el('td', {}, el('code', {}, p.id)), el('td', {}, p.scope + (p.projectId ? ' ' + p.projectId : '')), el('td', {}, String(p.version))))),
      proposals ? el('section', { class: 'panel', 'aria-label': 'Propose a change' },
        el('h3', {}, 'Propose a change'),
        el('p', { class: 'muted' }, 'Change the modes, commands, or numbers below, see the change, then propose it. Nothing changes until you approve it in the approval queue; the whole set must load as a configuration would.'),
        el('p', {}, el('label', {}, 'Policy ', pick)),
        form,
        el('details', { class: 'advanced' }, el('summary', {}, 'Advanced: the record as JSON'), el('p', { class: 'muted' }, 'Every field of the record, as the form edits it; an edit here shows in the form once it is valid JSON.'), editor),
        el('p', {}, note),
        el('div', { class: 'actions' }, el('button', { onclick: showDiff }, 'Show change'), el('button', { class: 'primary', onclick: propose }, 'Propose')),
        preview) : el('p', { class: 'muted' }, 'This approval queue changes its policy by configuration and a restart only.'),
      changes ? el('h3', {}, 'History') : null,
      changes && !changes.length ? el('p', { class: 'muted' }, 'No change was proposed yet.') : null,
      changes && changes.length ? table(['Change', 'Policy', 'State', 'Proposed', 'In force from', 'Effect'], changes.map((c) => el('tr', {},
        el('td', {}, el('code', {}, c.changeId)),
        el('td', {}, c.policy.id + ' ' + (c.previous ? c.previous.version + ' → ' : '') + c.policy.version + (c.origin ? ' (proposed by the queue)' : '')),
        el('td', { class: 'state' }, c.state === 'asked' ? decideLink(c.requestId, 'waiting for your verdict') : c.state + (c.declined ? ' (' + c.declined.cause + ')' : '')),
        el('td', { class: 'muted' }, when(c.proposedAt)),
        el('td', { class: 'muted' }, c.applied ? [when(c.applied.at), c.retired ? [' until ', when(c.retired.at)] : null] : '-'),
        el('td', {}, c.effect.length ? c.effect.map((e) => (e.projectId || 'studio') + ' ' + e.actionClass + ' ' + e.from + '→' + e.to).join('; ') : '-'),
      ))) : null,
      changes && changes.length ? el('details', {}, el('summary', {}, 'Diffs'), changes.map(changeView)) : null)
    fill()
  }

  let current = new URLSearchParams(location.search).get('run')
  let view = new URLSearchParams(location.search).get('view')
  function go(runId) {
    current = runId || null
    view = null
    confirming = false
    history.pushState(null, '', runId ? '?run=' + encodeURIComponent(runId) : '/ui/')
    refresh()
  }
  // Home, scrolled to one request's card, which takes the focus.
  function openRequest(requestId) {
    focusRequest = requestId
    current = null
    view = null
    confirming = false
    history.pushState(null, '', '?request=' + encodeURIComponent(requestId))
    refresh()
  }
  const nav = (id, name) => document.getElementById(id).addEventListener('click', (e) => {
    e.preventDefault()
    current = null
    view = name
    confirming = false
    history.pushState(null, '', '?view=' + name)
    refresh()
  })
  document.getElementById('home-link').addEventListener('click', (e) => { e.preventDefault(); go() })
  nav('board-link', 'board')
  nav('workers-link', 'workers')
  nav('policy-link', 'policy')
  window.addEventListener('popstate', () => { const query = new URLSearchParams(location.search); current = query.get('run'); view = query.get('view'); confirming = false; refresh() })
  // The page shown is marked in the navigation and named in the window's title.
  const mark = () => {
    const page = view === 'policy' || view === 'board' || view === 'workers' ? view : current ? 'run' : 'home'
    for (const [id, name] of [['home-link', 'home'], ['board-link', 'board'], ['workers-link', 'workers'], ['policy-link', 'policy']]) {
      const link = document.getElementById(id)
      if (name === page || (page === 'run' && name === 'home')) link.setAttribute('aria-current', 'page')
      else link.removeAttribute('aria-current')
    }
    document.title = 'system: ' + PAGES[page][0] + (current ? ' ' + current : '')
  }
  async function refresh() {
    mark()
    if (!token) { show(el('p', {}, 'Open the link that ', el('code', {}, 'system ui'), ' prints.')); return }
    try { await (view === 'policy' ? policyView() : view === 'board' ? boardView() : view === 'workers' ? workersView() : current ? detail(current) : list()); status.textContent = 'updated ' + new Date().toLocaleTimeString() } catch (error) { status.textContent = 'could not refresh: ' + error.message + '; the page tries again every 5 seconds' }
  }
  refresh()
  // The policy page holds an edit in progress, and an open confirmation a move not yet made: neither is refreshed away.
  setInterval(() => { if (view !== 'policy' && !confirming && !document.hidden && !main.contains(document.activeElement)) refresh() }, 5000)
})()
`
