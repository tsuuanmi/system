/**
 * A local stand-in for chatgpt.com, built from the live accessibility tree recorded on
 * 2026-10-11 (docs/research/browser-interaction-and-self-healing.md#live-check-2026-10-11-signed-in-account-read-only).
 * It reproduces what the driver depends on, including the traps seen live:
 * - the composer mode can start on **Work**, and Chat/Work live in `group "Composer mode"`;
 * - Temporary chat (`?temporary-chat=true`) hides the mode group;
 * - the action slot shows Send (disabled when empty), Stop while running, and voice on an empty home page;
 * - turns are marked only by headings "You said:" / "ChatGPT said:"; a finished answer gets "Copy" and "Regenerate response";
 * - the send is `POST /backend-api/f/conversation` answered with an event stream that **stays open**;
 * - a second visible form also carries `data-chatgpt-composer`, without the textbox.
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
  /** Accessible name of the send button (drift tests). */
  sendLabel?: string
  /** Answer text; streamed word by word. */
  answer?: string
  /** Delay before streaming starts, in ms. */
  thinkMs?: number
}

export interface Sent {
  prompt: string
  mode: string
  temporary: boolean
  conversationId: string | undefined
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
      <button type="button" aria-label="Select ChatGPT model" aria-haspopup="menu">Instant</button>
      <button type="button" aria-label="Dictate">d</button>
      <span id="slot"></span>
    </form>
  </main>
</main>
<script>
const { options, conversationId } = ${state}
let mode = options.startOnWork ? 'work' : 'chat'
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
$('mode-chat').onclick = () => { if (!options.chatToggleBroken) mode = 'chat'; render() }
$('mode-work').onclick = () => { mode = 'work'; render() }
$('temp').onclick = () => { temporary = true; history.pushState({}, '', '/?temporary-chat=true'); render() }
$('temp-off').onclick = () => { temporary = false; history.pushState({}, '', '/'); render() }
$('input').addEventListener('input', render)
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!running && $('input').textContent.trim()) send() } })
async function send() {
  const prompt = $('input').textContent
  $('input').textContent = ''
  const user = document.createElement('div')
  user.className = 'turn'
  user.innerHTML = '<h4 class="sr-only">You said:</h4><div></div><button aria-label="Copy message">c</button><button aria-label="Edit message">e</button>'
  user.querySelector('div').textContent = prompt
  $('log').append(user)
  running = true
  render()
  const res = await fetch('/backend-api/f/conversation', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, mode, temporary, conversationId: convId }) })
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
    this.options = { startOnWork: true, chatToggleBroken: false, signedIn: true, sendLabel: 'Send', answer: 'OK', thinkMs: 300, ...options }
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
    if (!this.options.signedIn && !url.pathname.startsWith('/auth')) {
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
