/** The UI's static shell, script, and styles. The script builds the page with DOM methods and textContent only. */

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>system: runs</title>
<link rel="stylesheet" href="/ui/app.css">
</head>
<body>
<header><h1><a href="/ui/" id="home">system</a></h1><span id="status" role="status"></span></header>
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
header h1 { margin: 0; font-size: 18px; } header a { color: inherit; text-decoration: none; }
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
@media (max-width: 640px) { th:nth-child(n+4), td:nth-child(n+4) { display: none; } }
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
    if (!response.ok) throw new Error(value.error || response.statusText)
    return value
  }
  // replaceChildren turns null into the text "null": absent sections are dropped first.
  const show = (...parts) => main.replaceChildren(...parts.filter((part) => part !== null && part !== undefined))
  const table = (head, rows) => el('table', {}, el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))), el('tbody', {}, rows))

  async function list() {
    const { runs } = await api('runs')
    show(el('h2', {}, 'Runs'), table(['Run', 'Template', 'Status', 'Steps', 'Created'], runs.map((run) => el('tr', {},
      el('td', {}, el('a', { href: '?run=' + encodeURIComponent(run.runId), onclick: (e) => { e.preventDefault(); go(run.runId) } }, run.runId)),
      el('td', {}, run.template),
      el('td', { class: 'state ' + run.status }, run.status + (run.blocked ? ' (waiting for approval)' : '')),
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
    const decisions = new Map((explain ? explain.nodes : []).map((n) => [n.nodeId, n.decisions]))
    show(
      el('p', {}, el('a', { href: '/ui/', onclick: (e) => { e.preventDefault(); go() } }, '← all runs')),
      el('h2', {}, run.runId + ' ', el('span', { class: 'state ' + run.status }, run.status)),
      el('p', { class: 'muted' }, run.template + ' · spec ', el('code', {}, run.specHash)),
      run.error ? el('p', { class: 'state failed' }, run.error.kind + ': ' + run.error.message) : null,
      run.blocked ? el('div', { class: 'panel' },
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

  let current = new URLSearchParams(location.search).get('run')
  function go(runId) {
    current = runId || null
    history.pushState(null, '', runId ? '?run=' + encodeURIComponent(runId) : '/ui/')
    refresh()
  }
  window.addEventListener('popstate', () => { current = new URLSearchParams(location.search).get('run'); refresh() })
  async function refresh() {
    if (!token) { show(el('p', {}, 'Open the link that ', el('code', {}, 'system ui'), ' prints.')); return }
    try { await (current ? detail(current) : list()); status.textContent = 'updated ' + new Date().toLocaleTimeString() } catch (error) { status.textContent = error.message }
  }
  refresh()
  setInterval(() => { if (!document.hidden && !main.contains(document.activeElement)) refresh() }, 5000)
})()
`
