/**
 * A local stand-in for gemini.google.com/app, built from the signed-in page read live on
 * 2026-10-12 (read-only, Temporary-chat prompts, and one Deep research run). It reproduces what
 * the driver depends on, including the traps seen live:
 * - two tabs, Chat (`data-test-id="app-tab-chat"`) and Spark (`app-tab-agent`, the agent); the
 *   active one has the class `app-tab--active`, and nothing else marks it;
 * - "Temporary chat" is an icon button with no pressed state: only its notice ("Temporary chats
 *   don't appear in recent chats ...") shows it is on, and the URL stays `/app`. A normal chat
 *   moves to `/app/<16 hex>` once sent, and reopens there; an unknown one is sent to `/app`, as
 *   the live site does (2026-10-16);
 * - the mode picker (`data-test-id="bard-mode-menu-button"`, "Open mode picker, currently Flash")
 *   opens one menu holding the models (`data-test-id="bard-mode-option-…"`, "3.8 Flash\nAll-around
 *   help") and the thinking levels under a "Thinking level" item, each with its note on the same
 *   line ("Low Quick and efficient", since 2026-10-16); the chosen model and level have
 *   the class `selected`. Here, choosing an item closes the menu;
 * - turns are `user-query` around its bubble `user-query-content`; the outer element draws no box
 *   (live 2026-10-17). Inside: a heading "You said" with a shortened copy, then the prompt's
 *   paragraphs) and `model-response` (heading "Gemini said", then
 *   `message-content`); a finished answer gets "Copy" and "Redo"; Stop is "Stop response";
 * - the answer's Copy gives its Markdown, with a blank line before a code block's closing fence;
 * - Deep research is under "Upload & tools" → "More tools" (not offered in a Temporary chat) and
 *   shows a "Deselect Deep research" chip, still selected when its conversation is reopened.
 *   Its first reply is a plan, already with Copy, and "Start research". Started, a user turn
 *   "Start research" follows, then a reply holds a card (`gem-processing-card`, class
 *   `processing`, then `completed`) while Stop shows, and the report opens in a panel
 *   (`deep-research-immersive-panel`): its title, the report, then "Sources used in the report".
 * - deleting one conversation (NOT yet verified live, PROP-0004 Phase 5): its own menu button
 *   ("Open menu for conversation actions") → "Delete" → a "Delete chat?" dialog → "Delete", which
 *   POSTs a batchexecute call (`rpcids=GzXR5e`, the chat as `c_<id>`) and goes to `/app`; a
 *   deleted chat's URL then shows "Unable to load this conversation".
 * - with `deviceBound`, a session works only in the browser profile that signed in, as Gemini's
 *   did live (2026-10-16, ADR-0030): a copy of the portable state is signed out.
 * No private data from the live account is included.
 */
import { randomBytes } from 'node:crypto'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'

export interface FakeOptions {
  /** The open chat's pane has its own menu button (default true); the history rows always have theirs. */
  paneMenu?: boolean
  /** The delete dialog deletes this chat instead of the one whose menu opened it (a wrong-chat test). */
  dialogTarget?: string
  /** The delete request also carries a second call naming the chat whose menu opened it (a guard bypass test). */
  dialogExtraCall?: boolean
  /** Start on the Spark tab (the trap the driver must avoid). Default true. */
  startOnSpark?: boolean
  /** The app shows only an interstitial dialog: neither signed in nor signed out can be told. */
  interstitial?: boolean
  /** Google's unusual-traffic check instead of the app: a form holding a reCAPTCHA (seen live 2026-10-16). */
  captcha?: boolean
  /**
   * The session is bound to the browser profile that signed in (ADR-0030). `/signin` sets a session
   * cookie and keeps a device key in the profile's Cache Storage, which a copy of the portable state
   * (cookies, localStorage, IndexedDB) does not carry. The app checks the key before it shows the
   * account, and shows a "Sign in" page instead when the cookie or the key is missing.
   */
  deviceBound?: boolean
  /** A prompt this long or longer is dropped on Send, as the live site drops a long paste: the composer empties, nothing is asked (0: never). */
  dropOver?: number
  /** Clicking Chat does nothing (the driver must refuse to send). */
  chatTabBroken?: boolean
  /** A sent prompt gets its conversation id and then nothing more: the answer never comes (a stall). */
  holdAnswer?: boolean
  /** A prompt's bubble renders this long before its text does (0: at once), as a loaded page does. */
  promptLagMs?: number
  /** The composer rewrites a paste: it drops backticks (a readback test). */
  rewritePaste?: boolean
  /**
   * The composer keeps an unsent draft across page loads, per conversation (as the live site did
   * in a login profile, 2026-10-17); a send clears it.
   */
  draftPersist?: boolean
  /**
   * A notice of updated terms over the input, as seen live on 2026-10-17: a banner inside the input
   * container covering the textbox and the mode switcher, until its button is pressed.
   */
  termsNotice?: boolean
  /** Clicking Temporary chat does nothing (the driver must refuse to send). */
  temporaryBroken?: boolean
  /** A "Sign in" control shows beside the account's button (an offer to add an account): still signed in. */
  signInOffer?: boolean
  /** Whether the account has a mode picker (default true). */
  modePicker?: boolean
  /** Whether prompts render their text in paragraphs (default true; false is drift). */
  promptParagraphs?: boolean
  /** Whether the account offers Deep research (default true). */
  deepResearch?: boolean
  /** Models in the mode menu, as the site names them. */
  models?: string[]
  /** Thinking levels in the mode menu. */
  levels?: string[]
  /**
   * The thinking levels as seen live on 2026-10-16 (default true): under a "Thinking level" item,
   * each with its note on the same line ("Medium Balanced depth"). False: each note on its own line.
   */
  levelsInline?: boolean
  /**
   * The thinking levels sit in a submenu that opens from the "Thinking level" item (seen live on
   * 2026-10-16, default true with `levelsInline`): hidden until that item is clicked.
   */
  levelsSubmenu?: boolean
  /** The "Thinking level" item opens nothing (drift: the levels cannot be reached). */
  submenuBroken?: boolean
  /** Deep research's plan is not rendered in the page that sent it, only once the page is loaded again (live 2026-10-19). */
  planHangs?: boolean
  /** With Deep research chosen, the mode menu shows the models only, with no thinking level (default false). */
  researchHidesLevels?: boolean
  /** Answer Markdown, streamed word by word; or computed from the prompt. */
  answer?: string | ((prompt: string, sent: Sent) => string)
  /** Deep research answers with this instead of a plan (a clarifying question). */
  clarify?: string
  /** Deep research: time from Start research to the finished report, in ms. */
  researchMs?: number
  /** Deep research stays running, however long, until a test sets this back to false. */
  researchHeld?: boolean
  /** While it works, the report panel lists its thoughts, one more every 300 ms (seen live on 2026-10-18). */
  researchActivity?: boolean
  /** The finished report's text, and the sources it used. */
  report?: string
  sources?: Array<{ title: string; url: string }>
}

export interface Sent {
  prompt: string
  tab: 'chat' | 'spark'
  temporary: boolean
  model: string
  level: string
  deepResearch: boolean
  conversationId?: string
}

type Turn =
  | { role: 'user'; text: string }
  | { role: 'answer'; text: string }
  | { role: 'plan'; title: string; started: boolean }
  | { role: 'research'; title: string; startedAt: number }

const NOTES: Record<string, string> = { 'Flash-Lite': 'Fastest answers', Flash: 'All-around help', Pro: 'Advanced reasoning', Low: 'Quick and efficient', Medium: 'Balanced depth', High: 'Extra thorough' }

/** The page script: no backticks or template holes, so it can sit in a raw string. */
const CLIENT = String.raw`
const options = JSON.parse(document.getElementById('options').textContent)
let tab = options.startOnSpark ? 'spark' : 'chat'
let temporary = false
let running = false
let deepResearch = false
let conversationId = (/^\/app\/([0-9a-f]{16})$/.exec(location.pathname) || [])[1]
let model = options.models[1] ?? options.models[0]
let levelsOpen = false
let level = options.levels[0]
const $ = (id) => document.getElementById(id)
const short = (name) => name.replace(/^\d[\d.]*\s+/, '')
const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function render() {
  $('tab-chat').classList.toggle('app-tab--active', tab === 'chat')
  $('tab-spark').classList.toggle('app-tab--active', tab === 'spark')
  $('notice').hidden = !temporary
  const empty = !$('input').textContent.trim()
  const researching = !!document.querySelector('gem-processing-card.processing')
  $('send').hidden = running || researching || empty
  $('stop').hidden = !running && !researching
  $('picker').hidden = !options.modePicker
  $('picker').setAttribute('aria-label', 'Open mode picker, currently ' + short(model))
  $('picker').textContent = short(model)
  $('chip').hidden = !deepResearch
  if ($('conv-options')) $('conv-options').hidden = !conversationId || !!$('missing')
  // The history lists the other chats, as the live side navigation does.
  for (const row of document.querySelectorAll('.row-options')) row.parentElement.hidden = row.dataset.id === conversationId
}
function renderMenu() {
  const item = (name, kind, i) => '<div role="menuitem" tabindex="0" data-kind="' + kind + '" data-name="' + name + '"'
    + (kind === 'model' ? ' data-test-id="bard-mode-option-' + i + '"' : '')
    + ' class="' + ((kind === 'model' ? name === model : name === level) ? 'selected' : '') + '">' + name
    + (kind === 'level' && options.levelsInline ? ' <span>' : '<br><span>') + (options.notes[short(name)] ?? '') + '</span></div>'
  const submenu = options.levelsInline && options.levelsSubmenu
  const levels = !(deepResearch && options.researchHidesLevels)
  $('menu').innerHTML = options.models.map((m, i) => item(m, 'model', i)).join('') + (!levels ? '' : ''
    + (options.levelsInline ? '<div role="menuitem" tabindex="0" id="levels-open"' + (submenu ? ' aria-haspopup="true"' : '') + '>Thinking level</div>' : '')
    + (submenu ? '<div id="levels"' + (levelsOpen ? '' : ' hidden') + '>' : '') + options.levels.map((l, i) => item(l, 'level', i)).join('') + (submenu ? '</div>' : ''))
  if (levels && submenu && !options.submenuBroken) $('levels-open').onclick = () => { levelsOpen = !levelsOpen; renderMenu() }
  for (const el of $('menu').querySelectorAll('[data-kind]')) el.onclick = () => {
    if (el.dataset.kind === 'model') model = el.dataset.name
    else level = el.dataset.name
    $('menu').hidden = true
    levelsOpen = false
    render()
  }
}
// What the composer held each time the picker opened, for tests (a DOM attribute: page.evaluate runs in another world).
$('picker').onclick = () => { document.body.dataset.pickerOpenedWith = (document.body.dataset.pickerOpenedWith ? document.body.dataset.pickerOpenedWith + ',' : '') + $('input').textContent.length; levelsOpen = false; renderMenu(); $('menu').hidden = !$('menu').hidden }
$('tools').onclick = () => { $('more').hidden = true; $('tools-menu').hidden = !$('tools-menu').hidden }
$('more-tools').onclick = () => { $('more').hidden = false; $('dr').hidden = temporary || !options.deepResearch }
// A checkbox, like the live entry: choosing it again turns Deep research off.
$('dr').onclick = () => { deepResearch = !deepResearch; $('tools-menu').hidden = true; render() }
$('chip').onclick = () => { deepResearch = false; render() }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('menu').hidden = true; $('tools-menu').hidden = true; $('conv-menu').hidden = true; levelsOpen = false } })
// The menu acts on the chat whose button opened it: the open one's, or a history row's.
let menuFor = null
if ($('conv-options')) $('conv-options').onclick = () => { menuFor = conversationId; $('conv-menu').hidden = !$('conv-menu').hidden }
for (const row of document.querySelectorAll('.row-options')) row.onclick = () => { menuFor = row.dataset.id; $('conv-menu').hidden = false }
$('conv-delete').onclick = () => { $('conv-menu').hidden = true; $('conv-dialog').hidden = false }
$('conv-cancel').onclick = () => { $('conv-dialog').hidden = true }
$('conv-confirm').onclick = async () => {
  // Like the app's own calls: one batchexecute RPC naming the chat, then the app goes to a new chat.
  const calls = [['GzXR5e', JSON.stringify(['c_' + (options.dialogTarget || menuFor)]), null, 'generic']]
  if (options.dialogExtraCall) calls.push(['MaZiqc', JSON.stringify(['c_' + menuFor]), null, 'generic'])
  const req = JSON.stringify([calls])
  const res = await fetch('/_/BardChatUi/data/batchexecute?rpcids=GzXR5e', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'f.req=' + encodeURIComponent(req) })
  $('conv-dialog').hidden = true
  if (res.ok) location.assign('/app')
}
$('tab-chat').onclick = () => { if (!options.chatTabBroken) tab = 'chat'; render() }
$('tab-spark').onclick = () => { tab = 'spark'; render() }
$('temp').onclick = () => { if (!options.temporaryBroken) temporary = true; render() }
$('input').addEventListener('input', render)
$('send').onclick = send
$('stop').onclick = () => { running = false; render() }
// Drops backticks inside each line's text, keeping the lines (as a composer that rewrites a paste would).
if (options.rewritePaste) $('input').addEventListener('input', () => { const walker = document.createTreeWalker($('input'), NodeFilter.SHOW_TEXT); for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent.includes('\x60')) n.textContent = n.textContent.replace(/\x60/g, '') })
function renderMarkdown(text) {
  const inline = (s) => escape(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  const blocks = []
  const fence = /\x60\x60\x60([^\n]*)\n([\s\S]*?)\n\x60\x60\x60/g
  let at = 0
  for (const m of text.matchAll(fence)) {
    blocks.push(['text', text.slice(at, m.index)])
    blocks.push(['code', m[1], m[2]])
    at = m.index + m[0].length
  }
  blocks.push(['text', text.slice(at)])
  return blocks.map((b) => b[0] === 'code'
    ? '<code-block><div class="code-block-decoration"><span>' + (b[1] ? b[1][0].toUpperCase() + b[1].slice(1) : 'Code') + '</span><button aria-label="Download code"></button><button aria-label="Copy code"></button></div><pre><code class="code-container">' + escape(b[2]) + '\n</code></pre></code-block>'
    : b[1].split(/\n{2,}/).filter((p) => p.trim()).map((p) => {
      const h = /^(#{1,6})\s+(.*)$/.exec(p)
      if (h) return '<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'
      if (/^[*-]\s/.test(p)) return '<ul>' + p.split('\n').map((l) => '<li>' + inline(l.replace(/^[*-]\s+/, '')) + '</li>').join('') + '</ul>'
      return '<p>' + inline(p) + '</p>'
    }).join('')).join('')
}
const ACTIONS = '<div class="actions"><button aria-label="Copy">c</button><button aria-label="Redo">r</button><button aria-label="Show more options">m</button></div>'
function userTurn(text) {
  const user = document.createElement('user-query')
  // Like the live site (2026-10-17): user-query draws no box of its own, its bubble does; the
  // heading repeats the prompt, shortened, before its full text.
  user.style.display = 'contents'
  user.innerHTML = '<user-query-content class="user-query-container"><h5 class="sr-only"><span>You said</span> <span class="short"></span></h5>' + (options.promptParagraphs ? '<p class="query-text"></p>' : '<div class="query-text"></div>') + '</user-query-content>'
  user.querySelector('.short').textContent = text.length > 20 ? text.slice(0, 20) + '…' : text
  const fill = () => { user.querySelector('.query-text').textContent = text }
  if (options.promptLagMs) setTimeout(fill, options.promptLagMs)
  else fill()
  return user
}
function modelTurn(inner, done, copy) {
  const answer = document.createElement('model-response')
  answer.innerHTML = '<div class="model-response-label-announcer" aria-live="polite"><h6 class="sr-only">Gemini said</h6></div><message-content><div class="markdown"></div></message-content>'
  answer.querySelector('.markdown').innerHTML = inner
  if (done) {
    answer.insertAdjacentHTML('beforeend', ACTIONS)
    // Like the live site: Copy gives the Markdown, with a blank line before a closing fence.
    answer.querySelector('[aria-label="Copy"]').addEventListener('click', () => navigator.clipboard.writeText(copy.replace(/\n(\x60\x60\x60)(\s*)$/gm, '\n\n$1$2')))
  }
  return answer
}
function planTurn(turn) {
  const inner = '<p>Here\'s the plan I\'ve put together. Let me know if you need any changes before I start researching.</p>'
    + '<div class="plan"><span>' + escape(turn.title) + '</span><p>Research Websites</p><p>Analyze Results</p><p>Create Report</p><p>Ready in a few mins</p>'
    + '<button aria-label="Edit the research plan">Edit plan</button><button aria-label="Start research"' + (turn.started ? ' disabled' : '') + '>Start research</button></div>'
  const el = modelTurn(inner, true, 'Here is the plan: ' + turn.title)
  el.querySelector('[aria-label="Start research"]').onclick = startResearch
  return el
}
function researchTurn(turn) {
  const status = turn.done ? 'Oct 12, 6:40 PM' : 'Writing your report...'
  const card = '<immersive-entry-chip><gem-processing-card role="status" class="selected ' + (turn.done ? 'completed' : 'processing') + '"><span class="card-title">' + escape(turn.title) + '</span><span class="current-step">' + status + '</span></gem-processing-card></immersive-entry-chip>'
  const el = modelTurn((turn.done ? '<p>I\'ve completed your research. Feel free to ask me follow-up questions or request changes.</p>' : '') + card, turn.done, 'I\'ve completed your research.')
  el.querySelector('gem-processing-card').onclick = () => openPanel(turn)
  return el
}
function openPanel(turn) {
  // While it works, the live panel grows its thinking in place: one more thought, never a new panel.
  const thinking = document.querySelector('#panel thinking-panel')
  if (!turn.done && turn.thoughts !== undefined && thinking) {
    while (thinking.children.length < turn.thoughts) thinking.insertAdjacentHTML('beforeend', '<thought-item>Read a source and noted it.</thought-item>')
    return
  }
  const sources = (turn.sources ?? []).map((s) => '<browse-web-item><a data-test-id="browse-web-item-link" href="' + s.url + '"><div data-test-id="sub-title">' + escape(s.title) + '</div></a></browse-web-item>').join('')
  $('panel').innerHTML = '<deep-research-immersive-panel><toolbar><h2 class="title-text">' + escape(turn.title) + '</h2><button aria-label="Table of contents menu">Contents</button><button>Share &amp; Export</button><button aria-label="Close panel">x</button></toolbar>'
    + (turn.done ? '<message-content id="extended-response-message-content"><div class="markdown">' + renderMarkdown(turn.report) + '</div></message-content>'
      + '<deep-research-source-lists><collapsible-button data-test-id="used-sources-button"><button>Sources used in the report</button></collapsible-button><div>' + sources + '</div>'
      + '<collapsible-button data-test-id="unused-sources-button"><button>Sources read but not used in the report</button></collapsible-button><div><browse-web-item><a data-test-id="browse-web-item-link" href="https://unused.example/">'
      + '<div data-test-id="sub-title">Read, not used</div></a></browse-web-item></div></deep-research-source-lists>'
      : turn.thoughts !== undefined ? '<thinking-panel>' + '<thought-item>Read a source and noted it.</thought-item>'.repeat(turn.thoughts) + '</thinking-panel>' : '<p>Researching...</p>')
    + '</deep-research-immersive-panel>'
}
function renderLog(turns) {
  $('log').innerHTML = ''
  for (const turn of turns) {
    if (turn.role === 'user') $('log').append(userTurn(turn.text))
    else if (turn.role === 'answer') $('log').append(modelTurn(renderMarkdown(turn.text), true, turn.text))
    else if (turn.role === 'plan') $('log').append(planTurn(turn))
    else {
      $('log').append(researchTurn(turn))
      openPanel(turn)
    }
  }
  render()
}
// Like the live site, a running research keeps updating: a failed or slow read never ends it.
let researching = false
async function refresh() {
  let again = researching
  try {
    const res = await fetch('/_/c/' + conversationId, { signal: AbortSignal.timeout(2000) })
    const state = await res.json()
    const turns = state.turns
    // Like the live site, a conversation reopens with Deep research still chosen if it was.
    deepResearch = state.deepResearch
    renderLog(turns)
    again = researching = turns.some((t) => t.role === 'research' && !t.done)
  } finally {
    if (again) setTimeout(refresh, 200)
  }
}
async function startResearch() {
  await fetch('/_/research/' + conversationId, { method: 'POST' })
  await refresh()
}
async function send() {
  const prompt = $('input').innerText.trim()
  $('input').textContent = ''
  if (options.draftPersist) localStorage.removeItem(draftKey())
  if (options.dropOver && prompt.length >= options.dropOver) { render(); return }
  $('log').append(userTurn(prompt))
  running = true
  render()
  const res = await fetch('/_/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, tab, temporary, model, level, deepResearch, conversationId }) })
  const reader = res.body.getReader()
  const answer = modelTurn('', false, '')
  $('log').append(answer)
  let raw = ''
  const decoder = new TextDecoder()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    for (const line of decoder.decode(value).split('\n')) {
      if (!line.startsWith('data: ')) continue
      const event = JSON.parse(line.slice(6))
      // Like the live site, a normal chat moves to its own URL as soon as it is sent.
      if (event.conversationId && !conversationId) {
        conversationId = event.conversationId
        history.pushState({}, '', '/app/' + conversationId)
      }
      if (event.delta !== undefined) {
        raw += event.delta
        answer.querySelector('.markdown').textContent = raw
      }
      if (event.done && event.plan && options.planHangs) {
        // The intro stays, unfinished: the plan card never comes in this page.
        answer.querySelector('.markdown').textContent = 'Here is a research plan for that.'
        running = false
        render()
      } else if (event.done) {
        answer.replaceWith(event.plan ? planTurn(event.plan) : modelTurn(renderMarkdown(raw), true, raw))
        running = false
        render()
      }
    }
  }
}
if (conversationId && !$('missing')) refresh()
render()
// An unsent draft, kept per conversation across page loads.
function draftKey() { return 'draft:' + (conversationId || 'home') }
if (options.draftPersist) {
  const saved = localStorage.getItem(draftKey())
  if (saved) $('input').innerText = saved
  $('input').addEventListener('input', () => localStorage.setItem(draftKey(), $('input').innerText))
}
`

const SIGNED_OUT = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gemini</title></head><body><header><a href="/signin">Sign in</a></header><main><h1>Meet Gemini</h1></main></body></html>'

/**
 * The app stays hidden until the profile's device key checks out; without it the page becomes
 * the signed-out page, as a copied session does live.
 */
const DEVICE_CHECK = `<style>html.binding body{visibility:hidden}</style><script>
document.documentElement.classList.add('binding')
caches.open('device').then((c) => c.match('/device-key')).then((r) => (r ? r.text() : '')).then((key) => fetch('/_/device', { method: 'POST', body: key })).then((r) => {
  if (!r.ok) document.body.innerHTML = '<header><a href="/signin">Sign in</a></header><main><h1>Meet Gemini</h1></main>'
  document.documentElement.classList.remove('binding')
})
</script>`

function html(options: Required<FakeOptions>, missing = false, history: string[] = []): string {
  const data = JSON.stringify({ ...options, notes: NOTES }).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gemini</title>
<style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}[hidden]{display:none}</style></head>
<body>
<header><a href="#" aria-label="Google Account: Test User (test@example.test)">T</a>${options.signInOffer ? '<button>Sign in</button>' : ''}</header>
<bard-sidenav><ol aria-label="Recent chats">${history.map((id) => `<li><a href="/app/${id}">chat</a><button class="row-options" data-id="${id}" aria-label="Open menu for conversation actions" aria-haspopup="menu">⋮</button></li>`).join('')}</ol></bard-sidenav>
<bard-sidenav-content>
<nav><button aria-label="Temporary chat" id="temp">t</button>${options.paneMenu ? '<button aria-label="Open menu for conversation actions" aria-haspopup="menu" id="conv-options" hidden>⋮</button>' : ''}</nav>
${missing ? '<div role="alert" id="missing">Unable to load this conversation</div>' : ''}
<div role="menu" id="conv-menu" hidden><div role="menuitem" tabindex="0">Share conversation</div><div role="menuitem" tabindex="0">Pin</div><div role="menuitem" tabindex="0" id="conv-delete">Delete</div></div>
<div role="dialog" aria-label="Delete chat?" id="conv-dialog" hidden><p>You'll no longer see this chat here.</p><button id="conv-cancel">Cancel</button><button id="conv-confirm">Delete</button></div>
<div><button data-test-id="app-tab-chat" class="app-tab" id="tab-chat">Chat</button><button data-test-id="app-tab-agent" class="app-tab" id="tab-spark">Spark<br>BETA</button></div>
<chat-window>
<main>
  <div class="description" id="notice" hidden> <a href="#">Temporary chats</a> don't appear in recent chats <a href="#">and</a> aren't used to improve Google AI.</div>
  <section id="log"></section>
  ${options.termsNotice ? '<input-container><condensed-tos-disclaimer><gem-banner class="variant-overlay has-title"><div class="title">Terms update</div><div class="body">We updated our terms. Review them to keep using Gemini.</div><button class="banner-action-button" onclick="this.closest(\'input-container\').remove();document.querySelector(\'rich-textarea\').hidden=false">Got it</button></gem-banner></condensed-tos-disclaimer></input-container>' : ''}
  <div class="input-area">
    <rich-textarea${options.termsNotice ? ' hidden' : ''}><div contenteditable="true" role="textbox" aria-label="Enter a prompt for Gemini" id="input"></div></rich-textarea>
    <button type="button" aria-label="Upload &amp; tools" aria-haspopup="menu" id="tools">+</button>
    <button type="button" aria-label="Deselect Deep research" id="chip" hidden>Deep research</button>
    <button type="button" data-test-id="bard-mode-menu-button" aria-haspopup="true" id="picker">Flash</button>
    <button type="button" aria-label="Send message" id="send">↑</button>
    <button type="button" aria-label="Stop response" id="stop">■</button>
  </div>
</main>
<aside id="panel"></aside>
</chat-window>
<div role="menu" id="menu" hidden></div>
<div role="menu" id="tools-menu" hidden>
  <div role="menuitem">Upload files</div>
  <div role="menuitemcheckbox" aria-checked="false">Canvas</div>
  <button aria-label="More tools" id="more-tools">More tools</button>
  <div id="more" hidden><div role="menuitemcheckbox" aria-checked="false" id="dr">Deep research</div><div role="menuitemcheckbox" aria-checked="false">Guided learning</div></div>
</div>
<script type="application/json" id="options">${data}</script>
<script>${CLIENT}</script></bard-sidenav-content>
</body></html>`
}

/** Serves the fake site; `sent` records every prompt the page sent, `started` every Start research. */
export class FakeGemini {
  readonly sent: Sent[] = []
  readonly started: string[] = []
  readonly conversations = new Map<string, Turn[]>()
  /** Conversations deleted from the history by their own menu: they no longer open. */
  readonly deleted = new Set<string>()
  /** Every deletion RPC the page made, by the chat it named (a repeated click shows twice). */
  readonly deleteRequests: string[] = []
  /** Every app page load (`/app` or `/app/<id>`), in order: what kept tabs save (ADR-0030). */
  readonly pageLoads: string[] = []
  /** Device checks of a `deviceBound` session, in order: whether each passed. */
  readonly deviceChecks: boolean[] = []
  /** Sessions signed in at `/signin` and the device key each was bound to. */
  private readonly devices = new Map<string, string>()
  /** Whether each conversation's last prompt was sent with Deep research chosen. */
  private readonly chips = new Map<string, boolean>()
  private server: Server | undefined
  options: Required<FakeOptions>
  origin = ''

  constructor(options: FakeOptions = {}) {
    this.options = {
      paneMenu: true, dialogTarget: '', dialogExtraCall: false, startOnSpark: true, interstitial: false, captcha: false, deviceBound: false, holdAnswer: false, promptLagMs: 0, rewritePaste: false, draftPersist: false, dropOver: 0, signInOffer: false, termsNotice: false, chatTabBroken: false, temporaryBroken: false, modePicker: true, promptParagraphs: true, deepResearch: true,
      models: ['3.5 Flash-Lite', '3.8 Flash', '3.1 Pro'], levels: ['Low', 'Medium', 'High'], levelsInline: true, levelsSubmenu: true, submenuBroken: false, researchHidesLevels: false, planHangs: false, answer: 'OK', clarify: '',
      researchMs: 1500, researchHeld: false, researchActivity: false, report: 'HTTP/3 runs over QUIC, not TCP.', sources: [{ title: 'RFC 9114: HTTP/3', url: 'https://www.rfc-editor.org/rfc/rfc9114' }], ...options,
    }
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.origin = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`
    return this.origin
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve())
  }

  /** A conversation's turns as the page renders them; research is done once its time has passed. */
  private view(id: string): unknown[] {
    return (this.conversations.get(id) ?? []).map((turn) => turn.role === 'research'
      ? { ...turn, done: !this.options.researchHeld && Date.now() - turn.startedAt >= this.options.researchMs, report: this.options.report, sources: this.options.sources,
        ...(this.options.researchActivity ? { thoughts: Math.floor((Date.now() - turn.startedAt) / 300) } : {}) }
      : turn)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin)
    const json = (status: number, body: unknown): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (url.pathname === '/_/chat' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += String(chunk)
      const sent = JSON.parse(body) as Sent
      this.sent.push(sent)
      const id = sent.temporary ? undefined : sent.conversationId ?? randomBytes(8).toString('hex')
      const turns = id ? this.conversations.get(id) ?? [] : []
      if (id) {
        this.conversations.set(id, turns)
        this.chips.set(id, sent.deepResearch)
      }
      turns.push({ role: 'user', text: sent.prompt })
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      if (id) res.write(`data: ${JSON.stringify({ conversationId: id })}\n\n`)
      if (this.options.holdAnswer) return
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (sent.deepResearch && !this.options.clarify) {
        const plan = { role: 'plan' as const, title: 'HTTP/2 and HTTP/3 Comparison', started: false }
        turns.push(plan)
        res.end(`data: ${JSON.stringify({ done: true, plan })}\n\n`)
        return
      }
      const answer = sent.deepResearch ? this.options.clarify : typeof this.options.answer === 'function' ? this.options.answer(sent.prompt, sent) : this.options.answer
      for (const word of answer.split(/(?<= )/)) {
        res.write(`data: ${JSON.stringify({ delta: word })}\n\n`)
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      turns.push({ role: 'answer', text: answer })
      res.end(`data: ${JSON.stringify({ done: true })}\n\n`)
      return
    }
    const research = /^\/_\/research\/([0-9a-f]{16})$/.exec(url.pathname)
    if (research && req.method === 'POST') {
      const turns = this.conversations.get(research[1]!)
      const plan = turns?.findLast((t) => t.role === 'plan')
      if (!turns || !plan || plan.role !== 'plan' || plan.started) return json(409, {})
      plan.started = true
      this.started.push(research[1]!)
      // Like the live site, starting the plan is a user turn of its own.
      turns.push({ role: 'user', text: 'Start research' }, { role: 'research', title: plan.title, startedAt: Date.now() })
      return json(200, {})
    }
    if (url.pathname === '/_/BardChatUi/data/batchexecute' && url.searchParams.get('rpcids') === 'GzXR5e' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += String(chunk)
      const rpc = JSON.parse(new URLSearchParams(body).get('f.req') ?? '[]') as Array<Array<[string, string]>>
      const id = /^c_([0-9a-f]{16})$/.exec((JSON.parse(rpc[0]?.[0]?.[1] ?? '[]') as string[])[0] ?? '')?.[1]
      this.deleteRequests.push(id ?? '')
      const known = id !== undefined && this.conversations.delete(id)
      if (known) this.deleted.add(id)
      return json(known ? 200 : 400, {})
    }
    // As the live site does: its root opens the app.
    if (url.pathname === '/') return void res.writeHead(302, { location: '/app' }).end()
    if (url.pathname === '/signin' && this.options.deviceBound) {
      const sid = randomBytes(8).toString('hex')
      const key = randomBytes(8).toString('hex')
      this.devices.set(sid, key)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `SID=${sid}; Path=/; Max-Age=86400; HttpOnly` })
      res.end(`<!doctype html><html><body><p id="bound" hidden>signed in</p><script>caches.open('device').then((c) => c.put('/device-key', new Response('${key}'))).then(() => { document.getElementById('bound').hidden = false })</script></body></html>`)
      return
    }
    if (url.pathname === '/_/device' && req.method === 'POST') {
      let key = ''
      for await (const chunk of req) key += String(chunk)
      const sid = this.sid(req)
      const ok = sid !== undefined && this.devices.get(sid) === key
      this.deviceChecks.push(ok)
      return json(ok ? 200 : 401, {})
    }
    const state = /^\/_\/c\/([0-9a-f]{16})$/.exec(url.pathname)
    if (state) return this.conversations.has(state[1]!) ? json(200, { turns: this.view(state[1]!), deepResearch: this.chips.get(state[1]!) ?? false }) : json(404, {})
    const page = /^\/app(?:\/([0-9a-f]{16}))?$/.exec(url.pathname)
    if (page) {
      this.pageLoads.push(url.pathname)
      if (page[1] && this.deleted.has(page[1])) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html(this.options, true, [...this.conversations.keys()]))
        return
      }
      if (page[1] && !this.conversations.has(page[1])) {
        res.writeHead(302, { location: '/app' }).end()
        return
      }
      if (this.options.captcha) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html><body><form action="/sorry/index" method="post"><iframe title="reCAPTCHA" src="/recaptcha/api2/anchor" style="width:304px;height:78px"></iframe><textarea class="g-recaptcha-response" style="display:none"></textarea><input type="submit" value="Submit"></form><a href="#">Why did this happen?</a></body></html>')
        return
      }
      if (this.options.deviceBound && !this.devices.has(this.sid(req) ?? '')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SIGNED_OUT)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(this.options.interstitial
        ? '<!doctype html><html><body><div role="dialog" aria-label="Before you continue"><h2>Before you continue</h2><button>Continue</button></div></body></html>'
        : this.options.deviceBound
          ? html(this.options, false, [...this.conversations.keys()]).replace('<head>', `<head>${DEVICE_CHECK}`)
          : html(this.options, false, [...this.conversations.keys()]))
      return
    }
    res.writeHead(404).end()
  }

  private sid(req: IncomingMessage): string | undefined {
    return /(?:^|; )SID=([0-9a-f]+)/.exec(req.headers.cookie ?? '')?.[1]
  }
}
