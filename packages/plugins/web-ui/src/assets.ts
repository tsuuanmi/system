/** The UI's static shell, script, and styles. The script builds the page with DOM methods and textContent only. */

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>system: runs, approvals, reviews, board, and policy</title>
<link rel="stylesheet" href="/ui/app.css">
</head>
<body>
<header><h1><a href="/ui/" id="home">system</a></h1><nav><a href="/ui/?view=board" id="board-link">Board</a> <a href="/ui/?view=policy" id="policy-link">Autonomy policy</a></nav><span id="status" role="status"></span></header>
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
header h1 { margin: 0; font-size: 18px; } header a { color: inherit; text-decoration: none; } header nav a { margin-right: 12px; }
#status { color: var(--muted); }
main { padding: 16px; max-width: 1100px; margin: 0 auto; }
table { width: 100%; border-collapse: collapse; margin: 8px 0 24px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
th { color: var(--muted); font-weight: 500; }
a { color: var(--accent); }
.state { font-weight: 600; } .COMPLETED, .completed { color: var(--ok); } .FAILED, .failed { color: var(--bad); } .BLOCKED, .RUNNING, .running { color: var(--wait); }
.panel { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin: 12px 0; }
button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; margin-right: 8px; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
input { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; min-width: 240px; }
.muted { color: var(--muted); } code { font-size: 12px; } .answer { white-space: pre-wrap; }
table.queue td:last-child { white-space: nowrap; }
textarea { font: 12px/1.4 ui-monospace, monospace; width: 100%; min-height: 320px; padding: 8px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; }
select { font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: inherit; }
pre.diff { font-size: 12px; overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; padding: 8px; margin: 8px 0; }
pre.diff .add { color: var(--ok); } pre.diff .del { color: var(--bad); }
@media (max-width: 640px) { table:not(.queue) th:nth-child(n+4), table:not(.queue) td:nth-child(n+4) { display: none; } table.queue th:nth-child(4), table.queue td:nth-child(4) { display: none; } }
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
  const pretty = (value) => value === undefined ? '' : JSON.stringify(value, null, 2)
  const diffView = (before, after) => el('pre', { class: 'diff' }, lineDiff(pretty(before), pretty(after)).map(([kind, line]) =>
    el('span', kind === 'same' ? {} : { class: kind }, (kind === 'add' ? '+ ' : kind === 'del' ? '- ' : '  ') + line + '\\n')))
  const effectView = (effect) => effect.length
    ? el('ul', {}, effect.map((e) => el('li', {}, (e.projectId ? 'project ' + e.projectId : 'studio') + ': ' + e.actionClass + ' ', el('span', { class: 'state' }, e.from + ' → ' + e.to))))
    : el('p', { class: 'muted' }, 'No effective mode moves: only expiry, batching, commands, or required checks change.')
  const changeView = (change) => el('div', { class: 'panel' },
    el('p', {}, el('strong', {}, change.policy.id + (change.previous ? ' version ' + change.previous.version + ' → ' + change.policy.version : ' (new, version ' + change.policy.version + ')')),
      el('span', { class: 'muted' }, ' · ' + change.changeId + ' · request ' + change.requestId)),
    change.note ? el('p', {}, change.note) : null,
    el('p', { class: 'muted' }, 'Set ', el('code', {}, change.hash), ', proposed on ', el('code', {}, change.baseHash)),
    effectView(change.effect),
    diffView(change.previous, change.policy))
  // replaceChildren turns null into the text "null": absent sections are dropped first.
  const show = (...parts) => main.replaceChildren(...parts.filter((part) => part !== null && part !== undefined))
  const table = (head, rows, cls) => el('table', cls ? { class: cls } : {}, el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))), el('tbody', {}, rows))

  // The approval queue, by batch: each verdict names the exact subject shown (INV-5). Absent when no queue runs.
  async function approvals() {
    let batches
    try { ({ batches } = await api('approvals')) } catch (error) { return error.status === 503 ? null : el('p', { class: 'state failed' }, 'Approval queue: ' + error.message) }
    const decide = (verdicts, note, batchId) => async () => {
      try {
        const { results } = await api('approvals/decide', { verdicts, note: note.value, ...(batchId ? { batchId } : {}) })
        const refused = results.filter((r) => r.refused).map((r) => r.requestId + ' (' + r.refused + ')')
        status.textContent = 'decided ' + (results.length - refused.length) + (refused.length ? '; refused: ' + refused.join(', ') : '')
        await list()
      } catch (error) { status.textContent = error.message }
    }
    const subject = (s) => s.type + ' ' + s.ref + (s.version ? ' @ ' + s.version : '')
    return el('section', { 'aria-label': 'Approval queue' }, el('h2', {}, 'Approvals'),
      batches.length ? null : el('p', { class: 'muted' }, 'Nothing waits for your verdict.'),
      batches.map((batch) => {
        const note = el('input', { placeholder: 'note (optional)', 'aria-label': 'Note for ' + (batch.batchId || 'unbatched requests') })
        const one = (r, verdict) => decide([{ requestId: r.requestId, subject: r.subject, verdict }], note)
        const all = (verdict) => decide(batch.requests.map((r) => ({ requestId: r.requestId, subject: r.subject, verdict })), note, batch.batchId)
        // A policy change shows what it changes: its effective modes and the record's diff (INV-5: the subject is its set's hash).
        const shown = el('div', {})
        const showChange = (r) => async () => {
          try {
            const { changes } = await api('policy')
            const change = (changes || []).find((c) => c.requestId === r.requestId)
            shown.replaceChildren(change ? changeView(change) : el('p', { class: 'muted' }, 'The change of ' + r.requestId + ' is not among the latest.'))
          } catch (error) { status.textContent = error.message }
        }
        return el('div', { class: 'panel' },
          el('h3', {}, batch.batchId ? 'Batch ' + batch.batchId : 'Not yet batched'),
          table(['Class', 'Subject', 'Summary', 'Consequences', 'Expires', 'Verdict'], batch.requests.map((r) => el('tr', {},
            el('td', {}, r.action.class, r.action.class === 'policy-change' && r.requester.policyChangeId
              ? el('div', {}, el('button', { onclick: showChange(r), 'aria-label': 'Show the change of ' + r.requestId }, 'Show change')) : null),
            el('td', {}, el('code', {}, subject(r.subject))),
            el('td', {}, r.action.summary),
            el('td', {}, r.action.consequences || '-'),
            el('td', { class: 'muted' }, new Date(r.expiresAt).toLocaleString()),
            el('td', {}, el('button', { onclick: one(r, 'approved'), 'aria-label': 'Approve ' + r.requestId }, 'Approve'), el('button', { onclick: one(r, 'rejected'), 'aria-label': 'Deny ' + r.requestId }, 'Deny')),
          )), 'queue'),
          shown,
          note,
          batch.batchId ? el('button', { class: 'primary', onclick: all('approved') }, 'Approve batch') : null,
          batch.batchId ? el('button', { onclick: all('rejected') }, 'Deny batch') : null)
      }))
  }

  // The board's tasks in review: the operator's Accept or Reject names the exact result shown (INV-5). Absent when no board runs.
  async function reviews() {
    let listed
    try { ({ reviews: listed } = await api('reviews')) } catch (error) { return error.status === 503 ? null : el('p', { class: 'state failed' }, 'Reviews: ' + error.message) }
    const subject = (s) => s.type + ' ' + s.ref + (s.version ? ' @ ' + s.version : '')
    const note = el('input', { placeholder: 'note (optional)', 'aria-label': 'Note for a review verdict' })
    const decide = (r, verdict) => async () => {
      try {
        const { task } = await api('reviews/' + encodeURIComponent(r.taskId) + '/decide', { verdict, subject: r.subject, note: note.value })
        status.textContent = r.taskId + ' is ' + task.state
        await list()
      } catch (error) { status.textContent = error.message }
    }
    return el('section', { 'aria-label': 'Reviews' }, el('h2', {}, 'Reviews'),
      listed.length ? null : el('p', { class: 'muted' }, 'No task waits for your review.'),
      listed.length ? table(['Task', 'Project', 'Subject', 'Result', 'Checks pending', 'Run', 'Until', 'Verdict'], listed.map((r) => el('tr', {},
        el('td', {}, el('strong', {}, r.title), el('div', { class: 'muted' }, r.taskId + ' · ' + r.actionClass)),
        el('td', {}, r.project.title || r.project.projectId),
        el('td', {}, el('code', {}, subject(r.subject))),
        el('td', {}, r.artifacts.map((a) => el('div', {}, el('code', {}, a)))),
        el('td', {}, r.pendingChecks.length ? r.pendingChecks.join(', ') : '-'),
        el('td', {}, r.run ? el('a', { href: '?run=' + encodeURIComponent(r.run.runId), onclick: (e) => { e.preventDefault(); go(r.run.runId) } }, r.run.runId) : '-'),
        el('td', { class: 'muted' }, (r.heldFor === 'operator' ? 'yours until ' : 'reviewer until ') + (r.expiresAt ? new Date(r.expiresAt).toLocaleString() : '-')),
        el('td', {}, el('button', { class: 'primary', onclick: decide(r, 'accept'), 'aria-label': 'Accept ' + r.taskId }, 'Accept'), el('button', { onclick: decide(r, 'reject'), 'aria-label': 'Reject ' + r.taskId }, 'Reject')),
      )), 'queue') : null,
      listed.length ? note : null)
  }

  async function list() {
    const { runs } = await api('runs')
    show(await approvals(), await reviews(), el('h2', {}, 'Runs'), table(['Run', 'Template', 'Status', 'Steps', 'Created'], runs.map((run) => el('tr', {},
      el('td', {}, el('a', { href: '?run=' + encodeURIComponent(run.runId), onclick: (e) => { e.preventDefault(); go(run.runId) } }, run.runId)),
      el('td', {}, run.template),
      el('td', { class: 'state ' + run.status }, run.status + (run.blocked ? (run.blocked.kind === 'tie' ? ' (tied: waiting for a deciding vote)' : ' (waiting for approval)') : '')),
      el('td', {}, run.nodes.map((n) => n.nodeId + ' ' + n.state).join(', ')),
      el('td', { class: 'muted' }, new Date(run.createdAt).toLocaleString()),
    ))))
  }

  async function detail(runId) {
    const { run, explain } = await api('runs/' + encodeURIComponent(runId))
    const act = (action, body) => async () => {
      try { await api('runs/' + encodeURIComponent(runId) + '/' + action, body()); await detail(runId) } catch (error) { status.textContent = error.message }
    }
    const note = el('input', { placeholder: 'note (optional)', 'aria-label': 'Note' })
    const rationale = el('input', { placeholder: 'rationale (required)', 'aria-label': 'Rationale' })
    const tie = run.blocked && run.blocked.kind === 'tie' ? run.blocked : null
    const vote = (option) => act('vote', () => ({ decision: tie.decision, option, rationale: rationale.value }))
    const decisions = new Map((explain ? explain.nodes : []).map((n) => [n.nodeId, n.decisions]))
    show(
      el('p', {}, el('a', { href: '/ui/', onclick: (e) => { e.preventDefault(); go() } }, '← all runs')),
      el('h2', {}, run.runId + ' ', el('span', { class: 'state ' + run.status }, run.status)),
      el('p', { class: 'muted' }, run.template + ' · spec ', el('code', {}, run.specHash)),
      run.error ? el('p', { class: 'state failed' }, run.error.kind + ': ' + run.error.message) : null,
      tie ? el('div', { class: 'panel' },
        el('p', {}, 'The team tied at ', tie.nodeId, '; until ' + new Date(tie.until).toLocaleString() + ' it waits for a deciding vote, then ends inconclusive.'),
        el('ul', {}, tie.options.map((o) => el('li', {}, el('strong', {}, o.option + ': '), o.summary))),
        rationale,
        tie.options.map((o) => el('button', { onclick: vote(o.option) }, 'Vote ' + o.option)),
        el('button', { onclick: vote('inconclusive') }, 'Leave inconclusive')) : null,
      run.blocked && !tie && run.blocked.approvalRequest ? el('div', { class: 'panel' },
        el('p', {}, 'The fix at ', run.blocked.nodeId, ' waits on approval request ', el('code', {}, run.blocked.approvalRequest), ' for plan ', el('code', {}, run.blocked.plan),
          '. Decide it in the approval queue' + (run.blocked.until ? ', by ' + new Date(run.blocked.until).toLocaleString() : '') + '.')) : null,
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
      show(el('h2', {}, 'Board'), el('p', { class: error.status === 503 ? 'muted' : 'state failed' }, error.status === 503 ? 'The board is not running.' : error.message))
      return
    }
    const count = (p, states) => states.reduce((n, s) => n + (p.open[s] || 0), 0)
    const shown = el('div', {})
    const settle = async (text) => { confirming = false; await boardView(); status.textContent = text }
    const send = (p, action, body) => async () => {
      try {
        const { project } = await api('projects/' + encodeURIComponent(p.projectId) + '/' + action, Object.assign({ revision: p.revision }, body()))
        await settle(p.projectId + ' is ' + project.state)
      } catch (error) { await settle(error.message) }
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
    const stateOf = (p) => p.state + (p.closure ? ' (' + p.closure.outcome + ')' : p.state === 'proposed' ? ' (its charter waits in the approval queue)' : '')
    show(
      el('p', {}, el('a', { href: '/ui/', onclick: (e) => { e.preventDefault(); go() } }, '← runs and approvals')),
      el('h2', {}, 'Board'),
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

  // The autonomy policy in force, its history, and a proposed change with its diff. A proposal is
  // asked in the approval queue as a policy-change request; only the operator's approval there applies it.
  async function policyView() {
    let value
    try { value = await api('policy') } catch (error) {
      show(el('h2', {}, 'Autonomy policy'), el('p', { class: error.status === 503 ? 'muted' : 'state failed' }, error.status === 503 ? 'The approval queue is not running.' : error.message))
      return
    }
    const { set, policies, effective, changes, proposals } = value
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
        await policyView()
      } catch (error) { preview.replaceChildren(el('p', { class: 'state failed' }, error.message)) }
    }
    const when = (t) => t ? new Date(t).toLocaleString() : '-'
    show(
      el('p', {}, el('a', { href: '/ui/', onclick: (e) => { e.preventDefault(); go() } }, '← runs and approvals')),
      el('h2', {}, 'Autonomy policy'),
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
        el('td', {}, c.policy.id + ' ' + (c.previous ? c.previous.version + ' → ' : '') + c.policy.version),
        el('td', { class: 'state' }, c.state + (c.declined ? ' (' + c.declined.cause + ')' : '')),
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
  const nav = (id, name) => document.getElementById(id).addEventListener('click', (e) => {
    e.preventDefault()
    current = null
    view = name
    confirming = false
    history.pushState(null, '', '?view=' + name)
    refresh()
  })
  nav('board-link', 'board')
  nav('policy-link', 'policy')
  window.addEventListener('popstate', () => { const query = new URLSearchParams(location.search); current = query.get('run'); view = query.get('view'); confirming = false; refresh() })
  async function refresh() {
    if (!token) { show(el('p', {}, 'Open the link that ', el('code', {}, 'system ui'), ' prints.')); return }
    try { await (view === 'policy' ? policyView() : view === 'board' ? boardView() : current ? detail(current) : list()); status.textContent = 'updated ' + new Date().toLocaleTimeString() } catch (error) { status.textContent = error.message }
  }
  refresh()
  // The policy page holds an edit in progress, and an open confirmation a move not yet made: neither is refreshed away.
  setInterval(() => { if (view !== 'policy' && !confirming && !document.hidden && !main.contains(document.activeElement)) refresh() }, 5000)
})()
`
