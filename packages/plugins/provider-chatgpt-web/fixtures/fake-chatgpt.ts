/**
 * A local stand-in for chatgpt.com, built from the live accessibility tree recorded on
 * 2026-10-11 (docs/research/browser-interaction-and-self-healing.md#live-check-2026-10-11-signed-in-account-read-only).
 * It reproduces what the driver depends on, including the traps seen live:
 * - the composer mode can start on **Work**, and Chat/Work live in `group "Composer mode"`;
 * - Temporary chat (`?temporary-chat=true`) hides the mode group;
 * - the action slot shows Send (disabled when empty), Stop while running, and voice on an empty home page;
 * - turns are marked only by headings "You said:" / "ChatGPT said:"; a finished answer gets "Copy" and "Regenerate response";
 * - the send is `POST /backend-api/f/conversation` answered with an event stream that **stays open**;
 * - the composer form no longer carries `data-chatgpt-composer` (since 2026-10-11, from live drift);
 *   another visible form still does, without the textbox;
 * - the textbox's accessible name is no longer "Ask ChatGPT" (since 2026-10-11; the new text is a stand-in);
 * - the model menu (`menu "Select ChatGPT model"`) has two views, as checked live on 2026-10-12: view A shows
 *   the Power slider (arrow keys; `status` "Instant, 1 of 3."; levels Instant, Medium, High) and a view toggle
 *   (`[data-model-picker-view-toggle]`) labelled with the level; view B, after the toggle, shows only the model
 *   radios. Choosing a model returns to view A;
 * - the "+" popover lists tools as buttons ("Deep research Get a detailed report"); Deep research inserts a
 *   non-editable mention chip into the composer and is not offered in Temporary chat;
 * - Deep research (live runs, 2026-10-12) first answers with a short acknowledgement. Each run has an
 *   embedded app frame (a `web-sandbox` URL) after its prompt, nesting the report frame: "Researching...",
 *   "Stop research", then "Research completed in ..." (digit-reel counters), the title under Export and
 *   Expand, and the report in the title's container. A session can hold several runs. Deep research may
 *   instead ask a clarifying question (no frame).
 * No private data from the live account is included.
 */
import { randomUUID } from 'node:crypto'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { Secret, TOTP } from 'otpauth'

export interface FakeOptions {
  /** Start on the Work tab (the trap the driver must avoid). Default true. */
  startOnWork?: boolean
  /** Clicking Chat does nothing (the driver must refuse to send). */
  chatToggleBroken?: boolean
  signedIn?: boolean
  /** A "Log in" control shows beside the signed-in app (an offer to switch accounts): still signed in. */
  loginOffer?: boolean
  /** Signed in only with the `session=valid` cookie (Save-flow tests). */
  requireCookie?: boolean
  /** A signed-in page load rotates the session cookie `session_seen` (write-back tests). */
  rotateOnLoad?: boolean
  /** The conversation menu offers Delete (default true): without it a deletion fails, and nothing is deleted. */
  deleteMenu?: boolean
  /** Every page is a challenge ("Verify you are human" with its challenge frame) instead of the app. */
  captcha?: boolean
  /** Every page is an interstitial dialog: neither signed in nor signed out can be told. */
  interstitial?: boolean
  /** The open conversation's pane has its own menu button (default true); the history rows always have theirs. */
  paneMenu?: boolean
  /** The delete dialog deletes this conversation instead of the one whose menu opened it (a wrong-chat test). */
  dialogTarget?: string
  /** Account id returned by `GET /backend-api/me`. */
  userId?: string
  /** Accessible name of the send button (drift tests). */
  sendLabel?: string
  /** A `data-testid` on the Send button, so a later map candidate can find it (drift without heal). */
  sendTestId?: string
  /** Answer text, or a function of the prompt; streamed word by word. */
  answer?: string | ((prompt: string, sent: Sent) => string)
  /**
   * What the answer's Copy puts on the clipboard, from the answer's Markdown. By default, like the
   * live site, the Markdown with each code block rebuilt from the page: its language and line
   * breaks lost.
   */
  copied?: (markdown: string) => string
  /** Delay before streaming starts, in ms. */
  thinkMs?: number
  /** Model radios in the model menu. */
  models?: string[]
  /** Models shown but locked for this account. */
  lockedModels?: string[]
  /** Deep research: time from acknowledgement to the finished report, in ms. */
  researchMs?: number
  /** Deep research stays running, however long, until a test calls `finishResearch()`. */
  researchHeld?: boolean
  /** Deep research report text. */
  report?: string
  /** Whether the account has a model picker (default true); without one the driver refuses to send. */
  modelPicker?: boolean
  /** Features this account's tools popover offers (default all). */
  features?: string[]
  /** Deep research asks a clarifying question instead of starting. */
  clarify?: boolean
  /** Sign-in flow after the password (requireCookie mode): none, totp, push-first (then "Try another method"), email-code, or challenge. */
  mfa?: 'none' | 'totp' | 'push-first' | 'email-code' | 'challenge'
  /** Credentials the fake auth accepts. */
  email?: string
  password?: string
  /** Base32 TOTP secret the fake auth verifies against. */
  totpSecret?: string
}

export interface Sent {
  prompt: string
  mode: string
  temporary: boolean
  conversationId: string | undefined
  model: string
  power: string
  deepResearch: boolean
  webSearch: boolean
}

interface Conversation {
  id: string
  /** A user turn that started Deep research names its run; the run's host frame follows that turn. */
  turns: Array<{ role: 'user' | 'assistant'; text: string; research?: number }>
  researches: Array<{ done: boolean; report: string }>
}

/** The embedded app frame of one Deep research run, as the live site places it after the run's prompt. */
export function researchHost(conversationId: string, index: number): string {
  return `<iframe title="Deep research" src="/web-sandbox.oai/${conversationId}/${index}" style="display:block;width:960px;height:640px;border:0"></iframe>`
}

/**
 * The host's document: it nests the report frame, and reloads until the run is done. The
 * report layout is the live one of 2026-10-12: the summary line with digit-reel counters, the
 * title, Export and Expand, then the title as a level-1 heading whose container is the report.
 */
export function researchDocument(research: { done: boolean; report: string }): string {
  const reel = '<span>' + Array.from({ length: 30 }, (_, i) => String(i % 10)).join('<br>') + '</span>'
  const inner = research.done
    ? `<main><p>Research completed in 1m · ${reel} citations · ${reel} searches</p><p>Research findings</p>`
      + `<button aria-label="Export">e</button><button aria-label="Expand">x</button>`
      + `<div role="button" tabindex="0"><h1>Research findings</h1><div>${research.report}</div></div></main>`
    : '<main><h2>Plan</h2><ul><li>Search sources</li></ul><p>Researching...</p><button>Stop research</button></main>'
  const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return `<!doctype html><html><head><meta charset="utf-8">${research.done ? '' : '<meta http-equiv="refresh" content="1">'}</head>`
    + `<body><iframe srcdoc="${escape(inner)}" style="width:940px;height:620px;border:0"></iframe></body></html>`
}

function html(options: Required<FakeOptions>, conversation: Conversation | undefined, missing?: string, history: string[] = []): string {
  const turns = (conversation?.turns ?? []).map((t) => t.role === 'user'
    ? `<div class="turn"><h4 class="sr-only">You said:</h4><div>${t.text}</div><button aria-label="Copy message">c</button><button aria-label="Edit message">e</button></div>`
      + (t.research !== undefined ? researchHost(conversation!.id, t.research) : '')
    : `<div class="turn"><div><h4 class="sr-only">ChatGPT said:</h4><p>${t.text}</p></div><div><button aria-label="Copy">c</button><button aria-label="Regenerate response">r</button></div></div>`).join('')
  const state = JSON.stringify({ options, conversationId: conversation?.id })
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ChatGPT</title>
<style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}[hidden]{display:none}</style></head>
<body>
<nav aria-label="App navigation"><button aria-label="Open profile menu">me</button>${options.loginOffer ? '<button>Log in</button>' : ''}
  <ol aria-label="Chat history">${history.filter((id) => id !== conversation?.id).map((id) => `<li><a href="/c/${id}">chat</a><button class="row-options" data-id="${id}" aria-label="Open conversation options" aria-haspopup="menu">…</button></li>`).join('')}</ol>
</nav>
${missing ? `<div role="alert">Unable to load conversation ${missing}</div>` : ''}
<div role="menu" aria-label="Conversation options" id="conv-menu" hidden><div role="menuitem" tabindex="0">Share</div><div role="menuitem" id="conv-delete" tabindex="0"${options.deleteMenu ? '' : ' hidden'}>Delete</div></div>
<div role="dialog" aria-label="Delete chat?" id="conv-dialog" hidden><p>This will delete the chat.</p><button id="conv-cancel">Cancel</button><button id="conv-confirm">Delete</button></div>
<main>
  <header>${conversation && options.paneMenu ? '<button id="conv-options" aria-label="Open conversation options" aria-haspopup="menu">…</button>' : ''}</header>
  <button id="temp" aria-label="Temporary chat">t</button>
  <button id="temp-off" aria-label="Turn off temporary chat" hidden>x</button>
  <div role="group" aria-label="Composer mode" id="modes">
    <button id="mode-chat" aria-pressed="false">Chat</button><button id="mode-work" aria-pressed="false">Work</button>
  </div>
  <main>
    <h1 id="title">Where should we begin?</h1>
    <section role="region" aria-label="Conversation" id="log">${turns}</section>
    <form data-chatgpt-composer data-thread-find-composer><input aria-label="Find in chat" type="search"></form>
    <form data-composer-placement="home" id="composer">
      <button type="button" aria-label="Add files and more">+</button>
      <div contenteditable="true" role="textbox" aria-multiline="true" aria-label="Chat with ChatGPT" data-composer-markdown id="input"></div>
      <button type="button" aria-label="Select ChatGPT model" aria-haspopup="menu" aria-expanded="false" id="picker"${options.modelPicker === false ? ' hidden' : ''}>Instant</button>
      <button type="button" aria-label="Dictate">d</button>
      <span id="slot"></span>
    </form>
  </main>
</main>
<div role="menu" aria-label="Select ChatGPT model" id="model-menu" hidden>
  <div role="menuitem" data-model-picker-view-toggle id="power-label">Instant</div>
  <div id="view-a">
    <div role="status" id="power-status">Instant, 1 of 3.</div>
    <div role="menuitem" aria-label="Power" tabindex="0" id="power" data-reasoning-slider><span role="slider" aria-hidden="true">●──</span></div>
  </div>
  <div id="model-radios" hidden></div>
</div>
<div id="tools" hidden>
  <button type="button">Add photos &amp; files Upload from computer</button>
  <button type="button" id="tool-web">Web search Find real-time news and info</button>
  <button type="button" id="tool-dr">Deep research Get a detailed report</button>
  <button type="button" id="tool-image">Create image Visualize anything</button>
</div>
<script>
const { options, conversationId } = ${state}
let mode = options.startOnWork ? 'work' : 'chat'
const POWERS = ['Instant', 'Medium', 'High']
let power = 0
let model = options.models[0]
let temporary = new URLSearchParams(location.search).get('temporary-chat') === 'true'
let running = false
let convId = conversationId
const $ = (id) => document.getElementById(id)
function render() {
  $('mode-chat').setAttribute('aria-pressed', String(mode === 'chat'))
  $('mode-work').setAttribute('aria-pressed', String(mode === 'work'))
  $('modes').hidden = temporary
  $('temp').hidden = temporary
  $('temp-off').hidden = !temporary
  $('title').textContent = temporary ? 'Temporary chat' : 'Where should we begin?'
  const empty = !$('input').textContent.trim()
  const home = !convId && !$('log').children.length
  $('slot').innerHTML = running
    ? '<button type="button" aria-label="Stop" id="stop">s</button>'
    : (empty && home && !temporary
      ? '<button type="button" aria-label="Start Voice">v</button>'
      : '<button type="button" aria-label="' + options.sendLabel + '" id="send"' + (options.sendTestId ? ' data-testid="' + options.sendTestId + '"' : '') + (empty ? ' disabled' : '') + '>↑</button>')
  if ($('send')) $('send').onclick = send
  if ($('stop')) $('stop').onclick = () => { running = false; render() }
}
function renderMenu() {
  $('power-label').textContent = POWERS[power]
  $('power-status').textContent = POWERS[power] + ', ' + (power + 1) + ' of 3.'
  $('picker').textContent = POWERS[power]
  $('model-radios').innerHTML = options.models.map((m) => '<div role="menuitemradio" aria-checked="' + (m === model) + '"'
    + (options.lockedModels.includes(m) ? ' aria-disabled="true"' : '') + ' data-model="' + m + '">' + m + '</div>').join('')
  for (const el of document.querySelectorAll('[data-model]')) el.onclick = () => {
    if (el.getAttribute('aria-disabled') !== 'true') { model = el.dataset.model; showView('a'); renderMenu() }
  }
}
function showView(view) { $('view-a').hidden = view !== 'a'; $('model-radios').hidden = view !== 'b' }
$('power-label').onclick = () => showView($('model-radios').hidden ? 'b' : 'a')
$('picker').onclick = () => { const open = $('model-menu').hidden; $('model-menu').hidden = !open; $('picker').setAttribute('aria-expanded', String(open)); showView('a'); renderMenu() }
$('power').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') power = Math.min(2, power + 1)
  if (e.key === 'ArrowLeft') power = Math.max(0, power - 1)
  renderMenu()
})
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('model-menu').hidden = true; $('tools').hidden = true; $('picker').setAttribute('aria-expanded', 'false') } })
document.querySelector('[aria-label="Add files and more"]').onclick = () => {
  const features = options.features ?? ['deep-research', 'web-search', 'image-generation']
  $('tool-dr').hidden = temporary || !features.includes('deep-research')
  $('tool-web').hidden = !features.includes('web-search')
  $('tool-image').hidden = !features.includes('image-generation')
  $('tools').hidden = !$('tools').hidden
}
$('tool-web').onclick = () => {
  // Like the live site: an inline "Web search" pill in the composer.
  $('input').innerHTML = '<p><span contenteditable="false" data-system-hint-type="search" data-prompt-link-href="chatgpt-system-hint://search"><span>Web search</span></span>&nbsp;</p>'
  $('tools').hidden = true
  render()
}
$('tool-dr').onclick = () => {
  const chip = '<span contenteditable="false" data-prompt-link-href="app://connector_openai_deep_research" app-mention-name="deep-research"><img alt="Deep research">Deep research</span>&nbsp;'
  $('input').innerHTML = '<p>' + chip + '</p>'
  $('tools').hidden = true
  render()
}
// The menu acts on the chat whose button opened it: the open one's, or a history row's.
let menuFor = convId
if ($('conv-options')) $('conv-options').onclick = () => { menuFor = convId; $('conv-menu').hidden = false }
for (const row of document.querySelectorAll('.row-options')) row.onclick = () => { menuFor = row.dataset.id; $('conv-menu').hidden = false }
$('conv-delete').onclick = () => { $('conv-menu').hidden = true; $('conv-dialog').hidden = false }
$('conv-cancel').onclick = () => { $('conv-dialog').hidden = true }
$('conv-confirm').onclick = async () => {
  // Like the live site: the chat is hidden from the history, then the app goes home.
  const res = await fetch('/backend-api/conversation/' + (options.dialogTarget || menuFor), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ is_visible: false }) })
  $('conv-dialog').hidden = true
  if (res.ok) location.assign('/')
}
$('mode-chat').onclick = () => { if (!options.chatToggleBroken) mode = 'chat'; render() }
$('mode-work').onclick = () => { mode = 'work'; render() }
$('temp').onclick = () => { temporary = true; history.pushState({}, '', '/?temporary-chat=true'); render() }
$('temp-off').onclick = () => { temporary = false; history.pushState({}, '', '/'); render() }
$('input').addEventListener('input', render)
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!running && $('input').textContent.trim()) send() } })
async function send() {
  const deepResearch = !!$('input').querySelector('[data-prompt-link-href="app://connector_openai_deep_research"]')
  const webSearch = !!$('input').querySelector('[data-prompt-link-href="chatgpt-system-hint://search"]')
  // Like the live site: the typed text, paragraphs as lines, without mention chips.
  const chips = [...$('input').querySelectorAll('[contenteditable="false"]')].map((el) => el.innerText)
  let prompt = $('input').innerText
  for (const chip of chips) prompt = prompt.replace(chip, '')
  prompt = prompt.replace(/\u00a0/g, ' ').trim()
  $('input').textContent = ''
  const user = document.createElement('div')
  user.className = 'turn'
  user.innerHTML = '<h4 class="sr-only">You said:</h4><div></div><button aria-label="Copy message">c</button><button aria-label="Edit message">e</button>'
  user.querySelector('div').textContent = prompt
  $('log').append(user)
  running = true
  render()
  const res = await fetch('/backend-api/f/conversation', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, mode, temporary, conversationId: convId, model, power: POWERS[power], deepResearch, webSearch }) })
  const reader = res.body.getReader()
  const answer = document.createElement('div')
  answer.className = 'turn'
  answer.innerHTML = '<div><h4 class="sr-only">ChatGPT said:</h4><p></p></div>'
  let started = false
  let raw = ''
  const decoder = new TextDecoder()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    for (const line of decoder.decode(value).split('\\n')) {
      if (!line.startsWith('data: ')) continue
      const event = JSON.parse(line.slice(6))
      if (event.conversationId && !convId) {
        convId = event.conversationId
        // Like the live site, the conversation URL appears as soon as the stream starts.
        if (!temporary) history.pushState({}, '', '/c/' + convId)
      }
      if (event.delta !== undefined) {
        if (!started) { $('log').append(answer); started = true }
        raw += event.delta
        answer.querySelector('p').textContent += event.delta
      }
      if (typeof event.research === 'number') {
        // The run's embedded app goes after its prompt; it updates itself until the report is done.
        const holder = document.createElement('div')
        answer.before(holder)
        holder.outerHTML = '<iframe title="Deep research" src="/web-sandbox.oai/' + convId + '/' + event.research + '" style="display:block;width:960px;height:640px;border:0"></iframe>'
      }
      if (event.done) {
        // Like the live site: the finished answer renders its Markdown; Copy copies the Markdown itself.
        const markdown = raw
        answer.querySelector('p').innerHTML = renderMarkdown(markdown)
        const actions = document.createElement('div')
        actions.innerHTML = '<button aria-label="Copy">c</button><button aria-label="Regenerate response">r</button>'
        const copy = event.copy
        actions.firstChild.addEventListener('click', () => navigator.clipboard.writeText(copy))
        answer.append(actions)
        running = false
        history.pushState({}, '', '/c/' + convId + (temporary ? '?temporary-chat=true' : ''))
        render()
      }
    }
  }
}
function renderMarkdown(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\x60\x60\x60([^\\n]*)\\n([\\s\\S]*?)\\n\x60\x60\x60/g, (_, lang, code) => '<div>' + (lang || 'Code') + '</div><pre><code>' + code + '</code></pre>')
  return escaped.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>').replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>')
    .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>')
}
render()
fetch('/backend-api/me')
</script></body></html>`
}

/** Serves the fake site; `sent` records every conversation POST the page made. */
/** Plain HTML forms shaped like the auth pages (the email page as seen live; later steps unverified). */
function authPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`
}
const field = (label: string, name: string, type = 'text'): string =>
  `<label>${label}<input name="${name}" type="${type}" aria-label="${label}"></label>`

export class FakeChatGpt {
  /** Code submissions the fake auth received (for bounds tests). */
  readonly codeAttempts: string[] = []
  readonly sent: Sent[] = []
  readonly conversations = new Map<string, Conversation>()

  /** Finish every held Deep research run now (`researchHeld`). */
  finishResearch(): void {
    for (const c of this.conversations.values()) for (const run of c.researches) run.done = true
  }
  /** Conversations deleted from the history (PATCH is_visible false): they no longer open. */
  readonly deleted = new Set<string>()
  /** Every deletion request the page made, by conversation id (a repeated click shows twice). */
  readonly deleteRequests: string[] = []
  private server: Server | undefined
  private readonly streams = new Set<ServerResponse>()
  options: Required<FakeOptions>
  origin = ''

  constructor(options: FakeOptions = {}) {
    this.options = {
      startOnWork: true, chatToggleBroken: false, signedIn: true, loginOffer: false, requireCookie: false, rotateOnLoad: false, deleteMenu: true, captcha: false, interstitial: false, paneMenu: true, dialogTarget: '', userId: 'user-fake123', sendLabel: 'Send', sendTestId: '',
      answer: 'OK', thinkMs: 300, models: ['Latest', 'GPT-6', 'GPT-5.6 Sol', 'GPT-5.5'], lockedModels: [],
      researchMs: 1500, researchHeld: false, report: 'Deep research report body.', clarify: false, features: ['deep-research', 'web-search', 'image-generation'], modelPicker: true,
      mfa: 'totp', email: 'operator@example.test', password: 'correct horse', totpSecret: 'JBSWY3DPEHPK3PXP',
      copied: (markdown) => markdown.replace(/(```)[^\n]*\n([\s\S]*?)\n```/g, (_, fence: string, code: string) => `${fence}\n${code.split('\n').join('')}\n${fence}`), ...options,
    }
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.origin = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`
    return this.origin
  }

  async stop(): Promise<void> {
    for (const stream of this.streams) stream.destroy()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve())
  }

  /** A multi-step sign-in: email, password, then the configured second step. */
  private async auth(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    const form = new URLSearchParams(body)
    const page = (html: string): void => void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
    const signedIn = (): void => {
      res.writeHead(302, { location: '/', 'set-cookie': 'session=valid; Path=/; Max-Age=3600' })
      res.end()
    }
    const codePage = (title: string): void => page(authPage(title, `<form method="post" action="/auth/code">${field('Code', 'code')}<button type="submit">Continue</button></form>`))
    switch (url.pathname) {
      case '/auth/login':
        return page(authPage('Log in or sign up', `<button>Continue with Google</button><form method="post" action="/auth/email">${field('Email address', 'email', 'email')}<button type="submit">Continue</button></form>`))
      case '/auth/email':
        if (form.get('email') !== this.options.email) return page(authPage('Log in or sign up', '<p>Unknown account</p>'))
        return page(authPage('Enter your password', `<form method="post" action="/auth/password">${field('Password', 'password', 'password')}<button type="submit">Continue</button></form>`))
      case '/auth/password': {
        if (form.get('password') !== this.options.password) return page(authPage('Enter your password', '<p>Wrong password</p>'))
        const mfa = this.options.mfa
        if (mfa === 'none') return signedIn()
        if (mfa === 'challenge') return page(authPage('Verify you are human', '<iframe title="Widget containing a Cloudflare security challenge"></iframe>'))
        if (mfa === 'email-code') return codePage('Check your inbox')
        if (mfa === 'push-first') return page(authPage('Check your phone', '<form method="get" action="/auth/methods"><button type="submit">Try another method</button></form>'))
        return codePage('Check your authenticator app')
      }
      case '/auth/methods':
        return page(authPage('Choose a method', '<form method="get" action="/auth/authenticator"><button type="submit">Authenticator app</button></form>'))
      case '/auth/authenticator':
        return codePage('Check your authenticator app')
      case '/auth/code': {
        const code = form.get('code') ?? ''
        this.codeAttempts.push(code)
        const ok = this.options.mfa === 'email-code'
          ? code === '424242'
          : new TOTP({ secret: Secret.fromBase32(this.options.totpSecret), digits: 6, period: 30 }).validate({ token: code, window: 1 }) !== null
        if (ok) return signedIn()
        return codePage(this.options.mfa === 'email-code' ? 'Check your inbox' : 'Check your authenticator app')
      }
    }
    res.writeHead(404).end()
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin)
    if (url.pathname === '/backend-api/f/conversation' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += String(chunk)
      const sent = JSON.parse(body) as Sent
      this.sent.push(sent)
      const id = sent.conversationId ?? randomUUID()
      const conversation = this.conversations.get(id) ?? { id, turns: [], researches: [] }
      this.conversations.set(id, conversation)
      const user: Conversation['turns'][number] = { role: 'user', text: sent.prompt }
      conversation.turns.push(user)
      const research = sent.deepResearch && !this.options.clarify
      const answer = sent.deepResearch
        ? (this.options.clarify ? 'Which aspect should the research focus on?' : 'Deep Research has started investigating. The final report will appear here.')
        : typeof this.options.answer === 'function' ? this.options.answer(sent.prompt, sent) : this.options.answer
      if (research) {
        const run = { done: false, report: this.options.report }
        user.research = conversation.researches.push(run) - 1
        if (!this.options.researchHeld) setTimeout(() => { run.done = true }, this.options.researchMs).unref()
      }
      // Like a real session, the cookie is refreshed while answering.
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'set-cookie': `session_refresh=${this.sent.length}; Path=/; Max-Age=3600` })
      this.streams.add(res)
      res.write(`data: ${JSON.stringify({ conversationId: id })}\n\n`)
      await new Promise((resolve) => setTimeout(resolve, this.options.thinkMs))
      for (const word of answer.split(/(?<= )/)) {
        res.write(`data: ${JSON.stringify({ delta: word })}\n\n`)
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      conversation.turns.push({ role: 'assistant', text: answer })
      res.write(`data: ${JSON.stringify({ done: true, research: user.research ?? false, copy: this.options.copied(answer) })}\n\n`)
      // Like the live site, the stream is left open after the answer is complete.
      return
    }
    const signedIn = this.options.requireCookie ? /(?:^|; )session=valid(?:;|$)/.test(req.headers.cookie ?? '') : this.options.signedIn
    const hostMatch = /^\/web-sandbox\.oai\/([0-9a-f-]+)\/(\d+)$/.exec(url.pathname)
    if (hostMatch) {
      const run = this.conversations.get(hostMatch[1]!)?.researches[Number(hostMatch[2])]
      res.writeHead(run ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
      res.end(run ? researchDocument(run) : '')
      return
    }
    const patched = /^\/backend-api\/conversation\/([0-9a-f-]+)$/.exec(url.pathname)
    if (patched && req.method === 'PATCH') {
      this.deleteRequests.push(patched[1]!)
      const known = signedIn && this.conversations.delete(patched[1]!)
      if (known) this.deleted.add(patched[1]!)
      res.writeHead(known ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify({ success: known }))
      return
    }
    if (url.pathname === '/backend-api/me' && req.method === 'GET') {
      res.writeHead(signedIn ? 200 : 401, { 'content-type': 'application/json' })
      res.end(JSON.stringify(signedIn ? { id: this.options.userId, object: 'user' } : { detail: 'unauthorized' }))
      return
    }
    if (!signedIn && !url.pathname.startsWith('/auth')) {
      res.writeHead(302, { location: '/auth/login' })
      res.end()
      return
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (this.options.captcha) return void res.end('<!doctype html><html><body><h1>Verify you are human</h1><iframe title="Widget containing a Cloudflare security challenge" src="/cdn-cgi/challenge-platform/h/b" style="width:300px;height:65px"></iframe></body></html>')
    if (this.options.interstitial) return void res.end('<!doctype html><html><body><div role="dialog" aria-label="Before you continue"><h2>Before you continue</h2><button>Continue</button></div></body></html>')
    if (url.pathname.startsWith('/auth')) return this.auth(url, req, res)
    if (this.options.rotateOnLoad) res.setHeader('set-cookie', `session_seen=${Date.now()}; Path=/; Max-Age=3600`)
    const match = /^\/c\/([0-9a-f-]+)$/.exec(url.pathname)
    res.end(html(this.options, match ? this.conversations.get(match[1]!) : undefined, match && this.deleted.has(match[1]!) ? match[1] : undefined, [...this.conversations.keys()]))
  }
}
