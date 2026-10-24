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
button:disabled { opacity: 0.6; cursor: progress; } button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
textarea { font: 12px/1.4 ui-monospace, monospace; width: 100%; min-height: 320px; padding: 8px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; }
select { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; }
pre.diff { font-size: 12px; overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; padding: 8px; margin: 8px 0; }
pre.diff .add { color: var(--ok); } pre.diff .del { color: var(--bad); }
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
    el('p', { class: 'muted' }, 'Set ', el('code', {}, change.hash), ', proposed on ', el('code', {}, change.baseHash)),
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
      const subject = 'task ' + taskId + projectText + ', attempt ' + (Number(attempt) + 1)
      d = reason.startsWith('funding') || r.action.class === 'funding' ? {
        title: 'Raise the budget of a task: ' + what.split('; ')[0], subject,
        yes: 'Approve: raise the budget', no: 'Deny: keep the budget',
        next: 'The board applies it to task ' + taskId + ' on its next sweep, within a minute.',
      } : reason === 'reconciliation-failed' ? {
        title: 'Go on after a failed reconciliation: ' + what, subject,
        approve: 'Task ' + taskId + ' tries again: its next attempt goes through the autonomy policy for ' + r.action.class + '.',
        deny: 'Task ' + taskId + ' does not go on: it waits for your input until it is cancelled or its wait expires.',
        yes: 'Approve: try again', no: 'Deny: hold the task',
        next: 'The board applies it to task ' + taskId + ' on its next sweep, within a minute.',
      } : {
        title: 'Allow a ' + r.action.class + ' step: ' + what, subject,
        approve: 'Task ' + taskId + ' may do this ' + r.action.class + ' step: it becomes ready on the board\\'s next sweep (within a minute), for a Worker to claim.',
        deny: 'Task ' + taskId + ' does not do it: it waits for your input until it is cancelled or its wait expires.',
        yes: 'Approve: allow this ' + r.action.class, no: 'Deny: hold the task',
        next: 'The board moves task ' + taskId + ' on its next sweep, within a minute.',
      }
    } else if (call) {
      d = { title: 'Allow a tool call: ' + r.action.summary, subject: 'the exact ' + call[2] + ' call of agent run ' + call[1], yes: 'Approve: allow this call', no: 'Deny: refuse this call',
        next: 'The agent run gets your answer the next time it asks.' }
    } else if (r.action.class === 'policy-change') {
      d = { title: r.action.summary, subject: 'the policy set with hash ' + (r.subject.version || ''),
        approve: 'The proposed policy set comes into force at once; open requests are judged again under it.', deny: 'Nothing changes: the policy in force stays.',
        yes: 'Approve: put the change in force', no: 'Deny: keep the policy in force', next: 'See the Autonomy policy page.' }
    } else if (r.action.class === 'remediation' && r.requester.component === 'workflow') {
      d = { title: 'Run a fix: ' + r.action.summary, subject: 'plan ' + ref + ' of run ' + (r.requester.runId || '?'), yes: 'Approve: run the fix', no: 'Deny: do not run it',
        next: 'The run goes on with your answer: see it under Runs.' }
    } else {
      d = { title: r.action.summary, subject: r.subject.type + ' ' + ref }
    }
    const by = r.requester.component === 'board' ? 'the board' + (r.requester.taskId ? ', for task ' + r.requester.taskId : '') + projectText
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
          d.title === r.action.summary ? null : [el('dt', {}, 'Request'), el('dd', {}, r.action.summary)],
          el('dt', {}, 'About'), el('dd', {}, d.subject, el('details', {}, el('summary', {}, 'Exact subject'), el('code', {}, subjectText(r.subject)))),
          r.action.consequences ? [el('dt', {}, 'What a verdict does'), el('dd', {}, r.action.consequences)]
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

  // The board's tasks in review: the operator's Accept or Reject names the exact result shown (INV-5). Absent when no board runs.
  async function reviews() {
    let listed
    try { ({ reviews: listed } = await api('reviews')) } catch (error) { return error.status === 503 ? null : el('p', { class: 'state failed' }, 'Reviews: ' + error.message) }
    const note = el('input', { placeholder: 'note (optional)', 'aria-label': 'Note for a review verdict' })
    const decide = (r, verdict) => async () => {
      try {
        const { task, decision } = await api('reviews/' + encodeURIComponent(r.taskId) + '/decide', { verdict, subject: r.subject, note: note.value })
        report(true, (verdict === 'accept' ? 'Accepted: ' : 'Rejected: ') + r.title, ['Recorded as your acceptance decision ' + decision + '. Task ' + r.taskId + ' is now ' + task.state + '.'])
      } catch (error) {
        report(false, 'Not recorded: your ' + (verdict === 'accept' ? 'acceptance' : 'rejection') + ' of ' + r.title, ['The server refused it (' + (error.status || 'no answer') + '): ' + error.message + '. Nothing was decided: the task is still in review.'])
      }
      await refresh()
    }
    return el('section', { 'aria-label': 'Reviews' }, el('h2', {}, 'Reviews'),
      listed.length ? null : el('p', { class: 'muted' }, 'No task waits for your review.'),
      listed.length ? table(['Task', 'Project', 'Subject', 'Result', 'Checks pending', 'Run', 'Until', 'Verdict'], listed.map((r) => el('tr', {},
        el('td', {}, el('strong', {}, r.title), el('div', { class: 'muted' }, r.taskId + ' · ' + r.actionClass)),
        el('td', {}, r.project.title || r.project.projectId),
        el('td', {}, el('code', {}, subjectText(r.subject))),
        el('td', {}, r.artifacts.map((a) => el('div', {}, el('code', {}, a)))),
        el('td', {}, r.pendingChecks.length ? r.pendingChecks.join(', ') : '-'),
        el('td', {}, r.run ? el('a', { href: '?run=' + encodeURIComponent(r.run.runId), onclick: (e) => { e.preventDefault(); go(r.run.runId) } }, r.run.runId) : '-'),
        el('td', { class: 'muted' }, (r.heldFor === 'operator' ? 'yours until ' : 'reviewer until ') + (r.expiresAt ? new Date(r.expiresAt).toLocaleString() : '-')),
        el('td', {}, el('button', { class: 'primary', onclick: decide(r, 'accept'), 'aria-label': 'Accept ' + r.taskId }, 'Accept'), el('button', { onclick: decide(r, 'reject'), 'aria-label': 'Reject ' + r.taskId }, 'Reject')),
      )), 'queue') : null,
      listed.length ? note : null)
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

  async function list() {
    const { runs } = await api('runs')
    show(pageHead('home'), await approvals(), await reviews(), el('h2', {}, 'Runs'), runs.length ? table(['Run', 'Template', 'Status', 'Steps', 'Started'], runs.map((run) => el('tr', {},
      el('td', { class: 'nowrap' }, el('a', { href: '?run=' + encodeURIComponent(run.runId), onclick: (e) => { e.preventDefault(); go(run.runId) } }, run.runId)),
      el('td', { class: 'nowrap' }, run.template),
      el('td', { class: 'nowrap state ' + run.status }, run.status, run.blocked ? el('div', { class: 'muted' }, run.blocked.kind === 'tie' ? 'tied: waits for your vote' : 'waits for approval') : null),
      el('td', {}, stepsText(run)),
      el('td', { class: 'nowrap muted' }, ago(run.createdAt)),
    ))) : el('p', { class: 'muted' }, 'No run yet.'))
    if (focusRequest) {
      const id = focusRequest
      focusRequest = null
      setTimeout(() => { if (!focusCard(id)) report(false, 'Request ' + id + ' no longer waits', ['It was decided, withdrawn, or expired since the link was made: nothing waits for your verdict on it.']) }, 0)
    }
  }

  async function detail(runId) {
    const { run, explain } = await api('runs/' + encodeURIComponent(runId))
    const act = (action, body) => async () => {
      try { await api('runs/' + encodeURIComponent(runId) + '/' + action, body()) } catch (error) {
        report(false, 'Not done: ' + action + ' of run ' + runId, ['The server refused it (' + (error.status || 'no answer') + '): ' + error.message + '. Nothing changed.'])
      }
      await detail(runId).catch((error) => { status.textContent = 'could not refresh: ' + error.message })
    }
    const note = el('input', { placeholder: 'note (optional)', 'aria-label': 'Note' })
    const rationale = el('input', { placeholder: 'rationale (required)', 'aria-label': 'Rationale' })
    const tie = run.blocked && run.blocked.kind === 'tie' ? run.blocked : null
    const vote = (option) => act('vote', () => ({ decision: tie.decision, option, rationale: rationale.value }))
    const decisions = new Map((explain ? explain.nodes : []).map((n) => [n.nodeId, n.decisions]))
    show(
      pageHead('run', 'Run ' + run.runId),
      el('p', {}, el('span', { class: 'state ' + run.status }, run.status)),
      el('p', { class: 'muted' }, run.template + ' · spec ', el('code', {}, run.specHash)),
      run.error ? el('p', { class: 'state failed' }, run.error.kind + ': ' + run.error.message) : null,
      tie ? el('div', { class: 'panel' },
        el('p', {}, 'The team tied at ', tie.nodeId, '; until ' + new Date(tie.until).toLocaleString() + ' it waits for a deciding vote, then ends inconclusive.'),
        el('ul', {}, tie.options.map((o) => el('li', {}, el('strong', {}, o.option + ': '), o.summary))),
        rationale,
        tie.options.map((o) => el('button', { onclick: vote(o.option) }, 'Vote ' + o.option)),
        el('button', { onclick: vote('inconclusive') }, 'Leave inconclusive')) : null,
      run.blocked && !tie && run.blocked.approvalRequest ? el('div', { class: 'panel' },
        el('p', {}, 'The fix at ', run.blocked.nodeId, ' waits for your verdict on approval request ', el('code', {}, run.blocked.approvalRequest),
          run.blocked.until ? ', until ' + relative(run.blocked.until) + ' (' + absolute(run.blocked.until) + ')' : '', '. '),
        el('p', {}, decideLink(run.blocked.approvalRequest, 'Decide it'))) : null,
      run.blocked && !tie && !run.blocked.approvalRequest ? el('div', { class: 'panel' },
        el('p', {}, 'Waiting for your approval of plan ', el('code', {}, run.blocked.plan), ' at ', run.blocked.nodeId, '.'),
        note,
        el('button', { class: 'primary', onclick: act('approve', () => ({ verdict: 'approved', note: note.value, plan: run.blocked.plan })) }, 'Approve plan'),
        el('button', { onclick: act('approve', () => ({ verdict: 'rejected', note: note.value, plan: run.blocked.plan })) }, 'Reject plan')) : null,
      el('p', {},
        run.status === 'running' ? el('button', { onclick: act('stop', () => ({ reason: 'stopped from the web UI' })) }, 'Stop run') : null,
        run.status === 'failed' ? el('button', { onclick: act('continue', () => ({})) }, 'Continue run') : null),
      run.answer ? el('div', { class: 'panel' }, el('h3', {}, 'Answer'), el('pre', { class: 'answer' }, run.answer)) : null,
      el('h3', {}, 'Steps'),
      table(['Step', 'State', 'Tier', 'Quota', 'Worker', 'Decisions'], run.nodes.map((n) => el('tr', {},
        el('td', {}, n.nodeId), el('td', { class: 'state ' + n.state }, n.state + (n.error ? ' · ' + n.error.kind : '')),
        el('td', {}, n.tier || n.minTier), el('td', {}, n.quotaClass || '-'), el('td', {}, n.worker || '-'),
        el('td', {}, (decisions.get(n.nodeId) || []).map((d) => el('div', {}, el('strong', {}, d.type + ': '), d.outcome, el('span', { class: 'muted' }, ' — ' + d.reasons.join('; '))))),
      ))),
    )
  }

  // The board's projects, and the operator's pause, resume, and close: each behind a confirmation
  // that says what the move does, sent with the project revision shown, so a project changed since
  // is refused and nothing moves. The page does not refresh while a confirmation is open.
  const OPEN = ['proposed', 'ready', 'claimed', 'running', 'review', 'waiting-for-input', 'waiting-for-approval']
  let confirming = false
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
      return el('span', {}, p.state + (p.closure ? ' (' + p.closure.outcome + ')' : ''),
        charter ? el('div', {}, p.state === 'proposed' ? 'Its charter waits for your verdict: ' : 'Its amendment waits for your verdict: ', decideLink(charter.requestId, 'decide it')) : null,
        asksOf(p).length ? el('div', {}, asksOf(p).length + ' task(s) wait for your approval: ', asksOf(p).flatMap((r, i) => [i ? ', ' : '', decideLink(r.requestId, q.described.get(r.requestId).title)])) : null)
    }
    show(
      pageHead('board'),
      projects.length ? null : el('p', { class: 'muted' }, 'No project is on the board yet.'),
      projects.length ? table(['Project', 'State', 'Charter', 'Open tasks', 'Move'], projects.map((p) => el('tr', {},
        el('td', {}, el('strong', {}, p.title), el('div', { class: 'muted' }, p.projectId)),
        el('td', { class: 'state' }, stateOf(p)),
        el('td', {}, 'version ' + p.charter.version + (p.amendment ? '; amendment ' + p.amendment + ' waits' : '')),
        el('td', {}, OPEN.filter((s) => p.open[s]).map((s) => s + ' ' + p.open[s]).join(', ') || '-'),
        el('td', {}, moves(p).map((m) => el('button', { onclick: confirm(p, m), 'aria-label': label[m] + ' ' + p.projectId }, label[m] + '…'))),
      )), 'queue') : null,
      shown)
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
  // A time as "in 2 h (11:40)": relative, then the clock time, with the day when it is not today.
  const when = (iso) => {
    const d = new Date(iso), today = new Date()
    const clock = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    return relative(iso) + ' (' + (d.toDateString() === today.toDateString() ? clock : absolute(iso)) + ')'
  }
  async function workersView() {
    const roster = await api('roster')
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
      return 'Quarantined: its account ' + ({ changed: 'signed in as someone else', ambiguous: 'could not be told apart from another', duplicate: 'is the same person as another', unverified: 'is not verified' }[a.reason] || a.reason) + ', since ' + when(a.since)
    }
    const accountOf = (w) => known(w.account, (a) => el('span', {},
      isKnown(a.record) && a.record.value.label ? text(a.record.value.label) + ' ' : '',
      el('span', { class: 'muted' }, a.id + (isKnown(a.record) ? ' · ' + a.record.value.kind + ' account, ' + a.record.value.status + (a.record.value.slot !== undefined ? ', slot ' + a.record.value.slot : '') : ' · its record is unknown (' + a.record.unknown + ')')),
      isKnown(a.record) && a.record.value.sameAs ? el('div', { class: 'state failed' }, 'signed in as the same person as ' + a.record.value.sameAs.join(', ')) : null))
    const doing = (w) => known(w.work, (work) => el('div', {},
      work.items.length ? el('ul', {}, work.items.map((i) => el('li', {}, i.summary, ' ',
        el('a', { href: '?run=' + encodeURIComponent(i.runId), onclick: (e) => { e.preventDefault(); go(i.runId) }, 'aria-label': 'Open run ' + i.runId }, 'open run')))) : el('span', { class: 'muted' }, 'Nothing now.'),
      work.more ? el('div', { class: 'muted' }, work.more + ' more step(s) not listed') : null,
      work.unread ? el('div', { class: 'unknown' }, work.unread) : null))
    const limitsOf = (w) => {
      const lines = w.limits.map((l) => l.capability + ' held off until ' + when(l.until))
      if (isKnown(w.account) && w.account.value.limitUntil) lines.unshift('its account is back ' + when(w.account.value.limitUntil))
      return el('div', {},
        lines.map((line) => el('div', {}, line)),
        known(w.pools, (pools) => pools.length ? el('div', {}, pools.map((p) => el('div', {},
          el('strong', {}, p.pool), ' ' + (p.available ? 'open' : 'closed' + (p.until ? ', back ' + when(p.until) : '')),
          p.windows.map((win) => el('div', { class: 'muted' }, win.id + ': ' + text(win.used, (n) => n + ' % used') + ', resets ' + text(win.resets, when))),
          isKnown(p.unknownUsage) ? (p.unknownUsage.value.runs ? el('div', { class: 'unknown' }, p.unknownUsage.value.runs + ' run(s) with usage it could not count') : null) : el('div', { class: 'unknown' }, 'usage not counted: unknown (' + p.unknownUsage.unknown + ')')))) : (lines.length ? null : el('span', { class: 'muted' }, 'No pool on its account.'))))
    }
    const card = (w) => el('article', { class: 'panel request', 'aria-labelledby': 'worker-' + w.worker },
      el('h4', { id: 'worker-' + w.worker }, w.worker),
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
      el('p', { class: 'muted' }, 'Read ', ago(roster.asOf), '; the page refreshes every 5 seconds.'),
      isKnown(roster.sources) ? null : el('p', { class: 'unknown' }, 'Worker sources: unknown (' + roster.sources.unknown + ')'),
      unheard.length ? el('div', {}, unheard.map((s) => el('p', { class: 'state failed' }, 'The Worker source ' + s.source + ' was ' + s.state + ' ' + relative(s.at) + (s.detail ? ': ' + s.detail : '') + '. Its Workers are not listed.'))) : null,
      known(roster.workers, (workers) => workers.length
        ? el('div', {}, ['busy', 'ready', 'resting', 'unavailable', 'quarantined'].map((state) => {
          const group = workers.filter((w) => w.availability.state === state)
          return group.length ? el('section', { 'aria-label': STATUS[state].group }, el('h3', {}, STATUS[state].group + ' (' + group.length + ')'), group.map(card)) : null
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
    const editor = el('textarea', { 'aria-label': 'Proposed policy record (JSON)', spellcheck: 'false' })
    const note = el('input', { placeholder: 'why (optional)', 'aria-label': 'Note for the proposed change' })
    const preview = el('div', {})
    const NEW = '(a new project policy)'
    const pick = el('select', { 'aria-label': 'Policy to change' }, policies.map((p) => el('option', { value: p.id }, p.id)), el('option', { value: NEW }, NEW))
    const selected = () => policies.find((p) => p.id === pick.value)
    const fill = () => {
      const p = selected()
      const draft = p ? Object.assign({}, p, { version: p.version + 1 })
        : { schema: 'autonomy-policy@1.0', id: 'project-id.policy', version: 1, scope: 'project', projectId: 'project-id', narrows: policies[0].id, rules: [{ actionClass: 'merge', mode: 'ask' }], default: 'ask', expiry: { defaultSeconds: 86400, maxSeconds: 1209600 } }
      editor.value = pretty(draft)
      preview.replaceChildren()
    }
    pick.addEventListener('change', fill)
    const parsed = () => {
      try { return JSON.parse(editor.value) } catch (error) { preview.replaceChildren(el('p', { class: 'state failed' }, 'Not JSON: ' + error.message)); return undefined }
    }
    const showDiff = () => {
      const draft = parsed()
      if (draft !== undefined) preview.replaceChildren(el('p', { class: 'muted' }, selected() ? 'Changes to ' + selected().id + ' version ' + selected().version + ':' : 'A new policy:'), diffView(selected(), draft))
    }
    const propose = async () => {
      const draft = parsed()
      if (draft === undefined) return
      try {
        const { change, request } = await api('policy/propose', { policy: draft, note: note.value })
        status.textContent = 'proposed ' + change.changeId + ': decide request ' + request.requestId + ' in the approval queue'
        report(true, 'Proposed: ' + change.policy.id + ' version ' + change.policy.version, ['Recorded as change ' + change.changeId + '. Nothing changes yet: it waits for your verdict on request ' + request.requestId + ', shown at the top of this page and on Home.'])
        await policyView()
      } catch (error) { preview.replaceChildren(el('p', { class: 'state failed' }, error.message)) }
    }
    const when = (t) => t ? new Date(t).toLocaleString() : '-'
    show(
      pageHead('policy'),
      askedCards.length ? el('section', { 'aria-label': 'Changes waiting for your verdict' },
        el('h3', {}, askedCards.length === 1 ? 'A change waits for your verdict' : askedCards.length + ' changes wait for your verdict'),
        el('p', { class: 'muted' }, 'A change applies only once you approve it, here or on Home.'),
        askedCards) : null,
      set ? el('p', {}, 'In force: ', el('code', {}, set.hash), set.source === 'store'
        ? ' — the change ' + set.changeId + ' the operator approved, kept while the configuration it came from is unchanged (' + set.configHash + ').'
        : ' — the configuration.') : null,
      table(['Action class'].concat(columns), classes.map((c) => el('tr', {}, el('td', {}, c), effective.map((e) => el('td', {}, (e.effective.find((x) => x.actionClass === c) || {}).mode || '-')))), 'queue'),
      el('h3', {}, 'Policies'),
      table(['Policy', 'Scope', 'Version'], policies.map((p) => el('tr', {}, el('td', {}, el('code', {}, p.id)), el('td', {}, p.scope + (p.projectId ? ' ' + p.projectId : '')), el('td', {}, String(p.version))))),
      proposals ? el('div', { class: 'panel' },
        el('h3', {}, 'Propose a change'),
        el('p', { class: 'muted' }, 'Raise the version. The whole set must load as a configuration would; the change is asked in the approval queue on its exact hash, and applies only when you approve it there.'),
        el('p', {}, pick),
        editor, el('p', {}, note),
        el('button', { onclick: showDiff }, 'Show diff'),
        el('button', { class: 'primary', onclick: propose }, 'Propose'),
        preview) : el('p', { class: 'muted' }, 'This approval queue changes its policy by configuration and a restart only.'),
      changes ? el('h3', {}, 'History') : null,
      changes && !changes.length ? el('p', { class: 'muted' }, 'No change was proposed yet.') : null,
      changes && changes.length ? table(['Change', 'Policy', 'State', 'Proposed', 'In force from', 'Effect'], changes.map((c) => el('tr', {},
        el('td', {}, el('code', {}, c.changeId)),
        el('td', {}, c.policy.id + ' ' + (c.previous ? c.previous.version + ' → ' : '') + c.policy.version + (c.origin ? ' (proposed by the queue)' : '')),
        el('td', { class: 'state' }, c.state === 'asked' ? decideLink(c.requestId, 'waiting for your verdict') : c.state + (c.declined ? ' (' + c.declined.cause + ')' : '')),
        el('td', { class: 'muted' }, when(c.proposedAt)),
        el('td', { class: 'muted' }, c.applied ? when(c.applied.at) + (c.retired ? ' until ' + when(c.retired.at) : '') : '-'),
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
