/**
 * A local stand-in for chatgpt.com, built from the live accessibility tree recorded on
 * 2026-10-11 (docs/research/browser-interaction-and-self-healing.md#live-check-2026-10-11-signed-in-account-read-only).
 * It reproduces what the driver depends on, including the traps seen live:
 * - the composer mode can start on **Work**, and Chat/Work live in `group "Composer mode"`;
 * - Temporary chat (`?temporary-chat=true`) hides the mode group;
 * - the action slot shows Send (disabled when empty), Stop while running, and voice on an empty home page;
 * - turns are marked only by headings "You said:" / "ChatGPT said:"; a finished answer gets "Copy" and "Regenerate response";
 * - the send is `POST /backend-api/f/conversation` answered with an event stream that **stays open**;
 * - a second visible form also carries `data-chatgpt-composer`, without the textbox;
 * - the model menu (`menu "Select ChatGPT model"`): model radios, and a Power slider driven by arrow keys
 *   whose `status` reads "Instant, 1 of 3." (levels Instant, Medium, High), as surveyed live on 2026-10-12;
 * - the "+" popover lists tools as buttons ("Deep research Get a detailed report"); Deep research inserts a
 *   non-editable mention chip into the composer and is not offered in Temporary chat.
 * No private data from the live account is included.
 */
import { randomUUID } from 'node:crypto'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'

export interface FakeOptions {
  /** Start on the Work tab (the trap the driver must avoid). Default true. */
  startOnWork?: boolean
  /** Clicking Chat does nothing (the driver must refuse to send). */
  chatToggleBroken?: boolean
  signedIn?: boolean
  /** Signed in only with the `session=valid` cookie (Save-flow tests). */
  requireCookie?: boolean
  /** Account id returned by `GET /backend-api/me`. */
  userId?: string
  /** Accessible name of the send button (drift tests). */
  sendLabel?: string
  /** Answer text; streamed word by word. */
  answer?: string
  /** Delay before streaming starts, in ms. */
  thinkMs?: number
  /** Model radios in the model menu. */
  models?: string[]
  /** Models shown but locked for this account. */
  lockedModels?: string[]
}

export interface Sent {
  prompt: string
  mode: string
  temporary: boolean
  conversationId: string | undefined
  model: string
  power: string
  deepResearch: boolean
}

interface Conversation {
  id: string
  turns: Array<{ role: 'user' | 'assistant'; text: string }>
}

function html(options: Required<FakeOptions>, conversation: Conversation | undefined): string {
  const turns = (conversation?.turns ?? []).map((t) => t.role === 'user'
    ? `<div class="turn"><h4 class="sr-only">You said:</h4><div>${t.text}</div><button aria-label="Copy message">c</button><button aria-label="Edit message">e</button></div>`
    : `<div class="turn"><div><h4 class="sr-only">ChatGPT said:</h4><p>${t.text}</p></div><div><button aria-label="Copy">c</button><button aria-label="Regenerate response">r</button></div></div>`).join('')
  const state = JSON.stringify({ options, conversationId: conversation?.id })
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ChatGPT</title>
<style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}[hidden]{display:none}</style></head>
<body>
<nav aria-label="App navigation"><button aria-label="Open profile menu">me</button></nav>
<main>
  <button id="temp" aria-label="Temporary chat">t</button>
  <button id="temp-off" aria-label="Turn off temporary chat" hidden>x</button>
  <div role="group" aria-label="Composer mode" id="modes">
    <button id="mode-chat" aria-pressed="false">Chat</button><button id="mode-work" aria-pressed="false">Work</button>
  </div>
  <main>
    <h1 id="title">Where should we begin?</h1>
    <section role="region" aria-label="Conversation" id="log">${turns}</section>
    <form data-chatgpt-composer data-thread-find-composer><input aria-label="Find in chat" type="search"></form>
    <form data-chatgpt-composer data-composer-placement="home" id="composer">
      <button type="button" aria-label="Add files and more">+</button>
      <div contenteditable="true" role="textbox" aria-multiline="true" aria-label="Ask ChatGPT" data-composer-markdown id="input"></div>
      <button type="button" aria-label="Select ChatGPT model" aria-haspopup="menu" aria-expanded="false" id="picker">Instant</button>
      <button type="button" aria-label="Dictate">d</button>
      <span id="slot"></span>
    </form>
  </main>
</main>
<div role="menu" aria-label="Select ChatGPT model" id="model-menu" hidden>
  <div role="menuitem" data-model-picker-view-toggle id="power-label">Instant</div>
  <div role="status" id="power-status">Instant, 1 of 3.</div>
  <div role="menuitem" aria-label="Power" tabindex="0" id="power" data-reasoning-slider><span role="slider" aria-hidden="true">●──</span></div>
  <div id="model-radios"></div>
</div>
<div id="tools" hidden>
  <button type="button">Add photos &amp; files Upload from computer</button>
  <button type="button" id="tool-web">Web search Find real-time news and info</button>
  <button type="button" id="tool-dr">Deep research Get a detailed report</button>
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
      : '<button type="button" aria-label="' + options.sendLabel + '" id="send"' + (empty ? ' disabled' : '') + '>↑</button>')
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
    if (el.getAttribute('aria-disabled') !== 'true') { model = el.dataset.model; renderMenu() }
  }
}
$('picker').onclick = () => { const open = $('model-menu').hidden; $('model-menu').hidden = !open; $('picker').setAttribute('aria-expanded', String(open)); renderMenu() }
$('power').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') power = Math.min(2, power + 1)
  if (e.key === 'ArrowLeft') power = Math.max(0, power - 1)
  renderMenu()
})
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('model-menu').hidden = true; $('tools').hidden = true; $('picker').setAttribute('aria-expanded', 'false') } })
document.querySelector('[aria-label="Add files and more"]').onclick = () => { $('tool-dr').hidden = temporary; $('tools').hidden = !$('tools').hidden }
$('tool-dr').onclick = () => {
  const chip = '<span contenteditable="false" data-prompt-link-href="app://connector_openai_deep_research" app-mention-name="deep-research"><img alt="Deep research">Deep research</span>&nbsp;'
  $('input').innerHTML = '<p>' + chip + '</p>'
  $('tools').hidden = true
  render()
}
$('mode-chat').onclick = () => { if (!options.chatToggleBroken) mode = 'chat'; render() }
$('mode-work').onclick = () => { mode = 'work'; render() }
$('temp').onclick = () => { temporary = true; history.pushState({}, '', '/?temporary-chat=true'); render() }
$('temp-off').onclick = () => { temporary = false; history.pushState({}, '', '/'); render() }
$('input').addEventListener('input', render)
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!running && $('input').textContent.trim()) send() } })
async function send() {
  const deepResearch = !!$('input').querySelector('[data-prompt-link-href="app://connector_openai_deep_research"]')
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
    body: JSON.stringify({ prompt, mode, temporary, conversationId: convId, model, power: POWERS[power], deepResearch }) })
  const reader = res.body.getReader()
  const answer = document.createElement('div')
  answer.className = 'turn'
  answer.innerHTML = '<div><h4 class="sr-only">ChatGPT said:</h4><p></p></div>'
  let started = false
  const decoder = new TextDecoder()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    for (const line of decoder.decode(value).split('\\n')) {
      if (!line.startsWith('data: ')) continue
      const event = JSON.parse(line.slice(6))
      if (event.conversationId && !convId) convId = event.conversationId
      if (event.delta !== undefined) {
        if (!started) { $('log').append(answer); started = true }
        answer.querySelector('p').textContent += event.delta
      }
      if (event.done) {
        const actions = document.createElement('div')
        actions.innerHTML = '<button aria-label="Copy">c</button><button aria-label="Regenerate response">r</button>'
        answer.append(actions)
        running = false
        history.pushState({}, '', '/c/' + convId + (temporary ? '?temporary-chat=true' : ''))
        render()
      }
    }
  }
}
render()
fetch('/backend-api/me')
</script></body></html>`
}

/** Serves the fake site; `sent` records every conversation POST the page made. */
export class FakeChatGpt {
  readonly sent: Sent[] = []
  readonly conversations = new Map<string, Conversation>()
  private server: Server | undefined
  private readonly streams = new Set<ServerResponse>()
  options: Required<FakeOptions>
  origin = ''

  constructor(options: FakeOptions = {}) {
    this.options = {
      startOnWork: true, chatToggleBroken: false, signedIn: true, requireCookie: false, userId: 'user-fake123', sendLabel: 'Send',
      answer: 'OK', thinkMs: 300, models: ['Latest', 'GPT-6', 'GPT-5.6 Sol', 'GPT-5.5'], lockedModels: [], ...options,
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin)
    if (url.pathname === '/backend-api/f/conversation' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += String(chunk)
      const sent = JSON.parse(body) as Sent
      this.sent.push(sent)
      const id = sent.conversationId ?? randomUUID()
      const conversation = this.conversations.get(id) ?? { id, turns: [] }
      this.conversations.set(id, conversation)
      conversation.turns.push({ role: 'user', text: sent.prompt })
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      this.streams.add(res)
      res.write(`data: ${JSON.stringify({ conversationId: id })}\n\n`)
      await new Promise((resolve) => setTimeout(resolve, this.options.thinkMs))
      for (const word of this.options.answer.split(/(?<= )/)) {
        res.write(`data: ${JSON.stringify({ delta: word })}\n\n`)
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      conversation.turns.push({ role: 'assistant', text: this.options.answer })
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`)
      // Like the live site, the stream is left open after the answer is complete.
      return
    }
    const signedIn = this.options.requireCookie ? /(?:^|; )session=valid(?:;|$)/.test(req.headers.cookie ?? '') : this.options.signedIn
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
    if (url.pathname.startsWith('/auth')) {
      res.end('<!doctype html><title>Log in</title><h1>Log in or sign up</h1><button>Continue with Google</button><input aria-label="Email address"><button>Continue</button>')
      return
    }
    const match = /^\/c\/([0-9a-f-]+)$/.exec(url.pathname)
    res.end(html(this.options, match ? this.conversations.get(match[1]!) : undefined))
  }
}
