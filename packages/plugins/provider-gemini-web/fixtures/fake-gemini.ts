/**
 * A local stand-in for gemini.google.com/app, built from the signed-in page read live on
 * 2026-10-12 (read-only, plus Temporary-chat prompts). It reproduces what the driver depends on,
 * including the traps seen live:
 * - two tabs, Chat (`data-test-id="app-tab-chat"`) and Spark (`app-tab-agent`, the agent); the
 *   active one has the class `app-tab--active`, and nothing else marks it;
 * - "Temporary chat" is an icon button with no pressed state: only its notice ("Temporary chats
 *   don't appear in recent chats ...") shows it is on, and the URL stays `/app`;
 * - the mode picker (`data-test-id="bard-mode-menu-button"`, "Open mode picker, currently Flash")
 *   opens one menu holding the models (`data-test-id="bard-mode-option-…"`, "3.8 Flash\nAll-around
 *   help") and the thinking levels ("Low\nQuick and efficient"); the chosen model and level have
 *   the class `selected`. Here, choosing an item closes the menu;
 * - turns are `user-query` (heading "You said") and `model-response` (heading "Gemini said", then
 *   `message-content`); a finished answer gets "Copy" and "Redo"; Stop is "Stop response";
 * - the answer's Copy gives its Markdown, with a blank line before a code block's closing fence.
 * No private data from the live account is included.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'

export interface FakeOptions {
  /** Start on the Spark tab (the trap the driver must avoid). Default true. */
  startOnSpark?: boolean
  /** Clicking Chat does nothing (the driver must refuse to send). */
  chatTabBroken?: boolean
  /** Clicking Temporary chat does nothing (the driver must refuse to send). */
  temporaryBroken?: boolean
  /** Whether the account has a mode picker (default true). */
  modePicker?: boolean
  /** Models in the mode menu, as the site names them. */
  models?: string[]
  /** Thinking levels in the mode menu. */
  levels?: string[]
  /** Answer Markdown, streamed word by word. */
  answer?: string
}

export interface Sent {
  prompt: string
  tab: 'chat' | 'spark'
  temporary: boolean
  model: string
  level: string
}

const NOTES: Record<string, string> = { 'Flash-Lite': 'Fastest answers', Flash: 'All-around help', Pro: 'Advanced reasoning', Low: 'Quick and efficient', Medium: 'Balanced depth', High: 'Extra thorough' }

/** The page script: no backticks or template holes, so it can sit in a raw string. */
const CLIENT = String.raw`
const options = JSON.parse(document.getElementById('options').textContent)
let tab = options.startOnSpark ? 'spark' : 'chat'
let temporary = false
let running = false
let model = options.models[1] ?? options.models[0]
let level = options.levels[0]
const $ = (id) => document.getElementById(id)
const short = (name) => name.replace(/^\d[\d.]*\s+/, '')
function render() {
  $('tab-chat').classList.toggle('app-tab--active', tab === 'chat')
  $('tab-spark').classList.toggle('app-tab--active', tab === 'spark')
  $('notice').hidden = !temporary
  const empty = !$('input').textContent.trim()
  $('send').hidden = running || empty
  $('stop').hidden = !running
  $('picker').hidden = !options.modePicker
  $('picker').setAttribute('aria-label', 'Open mode picker, currently ' + short(model))
  $('picker').textContent = short(model)
}
function renderMenu() {
  const item = (name, kind, i) => '<div role="menuitem" tabindex="0" data-kind="' + kind + '" data-name="' + name + '"'
    + (kind === 'model' ? ' data-test-id="bard-mode-option-' + i + '"' : '')
    + ' class="' + ((kind === 'model' ? name === model : name === level) ? 'selected' : '') + '">' + name + '<br><span>' + (options.notes[short(name)] ?? '') + '</span></div>'
  $('menu').innerHTML = options.models.map((m, i) => item(m, 'model', i)).join('') + options.levels.map((l, i) => item(l, 'level', i)).join('')
  for (const el of $('menu').querySelectorAll('[data-kind]')) el.onclick = () => {
    if (el.dataset.kind === 'model') model = el.dataset.name
    else level = el.dataset.name
    $('menu').hidden = true
    render()
  }
}
$('picker').onclick = () => { renderMenu(); $('menu').hidden = !$('menu').hidden }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('menu').hidden = true })
$('tab-chat').onclick = () => { if (!options.chatTabBroken) tab = 'chat'; render() }
$('tab-spark').onclick = () => { tab = 'spark'; render() }
$('temp').onclick = () => { if (!options.temporaryBroken) temporary = true; render() }
$('input').addEventListener('input', render)
$('send').onclick = send
$('stop').onclick = () => { running = false; render() }
function renderMarkdown(text) {
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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
async function send() {
  const prompt = $('input').innerText.trim()
  $('input').textContent = ''
  const user = document.createElement('user-query')
  user.innerHTML = '<h5 class="sr-only">You said</h5><div class="query-text"></div>'
  user.querySelector('div').textContent = prompt
  $('log').append(user)
  running = true
  render()
  const res = await fetch('/_/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, tab, temporary, model, level }) })
  const reader = res.body.getReader()
  const answer = document.createElement('model-response')
  answer.innerHTML = '<div class="model-response-label-announcer" aria-live="polite"><h6 class="sr-only">Gemini said</h6></div><message-content><div class="markdown"></div></message-content>'
  $('log').append(answer)
  let raw = ''
  const decoder = new TextDecoder()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    for (const line of decoder.decode(value).split('\n')) {
      if (!line.startsWith('data: ')) continue
      const event = JSON.parse(line.slice(6))
      if (event.delta !== undefined) {
        raw += event.delta
        answer.querySelector('.markdown').textContent = raw
      }
      if (event.done) {
        answer.querySelector('.markdown').innerHTML = renderMarkdown(raw)
        const actions = document.createElement('div')
        actions.innerHTML = '<button aria-label="Copy">c</button><button aria-label="Redo">r</button><button aria-label="Show more options">m</button>'
        // Like the live site: Copy gives the Markdown, with a blank line before a closing fence.
        actions.firstChild.addEventListener('click', () => navigator.clipboard.writeText(raw.replace(/\n(\x60\x60\x60)(\s*)$/gm, '\n\n$1$2')))
        answer.append(actions)
        running = false
        render()
      }
    }
  }
}
render()
`

function html(options: Required<FakeOptions>): string {
  const data = JSON.stringify({ ...options, notes: NOTES }).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Gemini</title>
<style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}[hidden]{display:none}</style></head>
<body>
<header><a href="#" aria-label="Google Account: Test User (test@example.test)">T</a></header>
<nav><button aria-label="Temporary chat" id="temp">t</button></nav>
<div><button data-test-id="app-tab-chat" class="app-tab" id="tab-chat">Chat</button><button data-test-id="app-tab-agent" class="app-tab" id="tab-spark">Spark<br>BETA</button></div>
<main>
  <div class="description" id="notice" hidden> <a href="#">Temporary chats</a> don't appear in recent chats <a href="#">and</a> aren't used to improve Google AI.</div>
  <section id="log"></section>
  <div class="input-area">
    <rich-textarea><div contenteditable="true" role="textbox" aria-label="Enter a prompt for Gemini" id="input"></div></rich-textarea>
    <button type="button" aria-label="Upload &amp; tools">+</button>
    <button type="button" data-test-id="bard-mode-menu-button" aria-haspopup="true" id="picker">Flash</button>
    <button type="button" aria-label="Send message" id="send">↑</button>
    <button type="button" aria-label="Stop response" id="stop">■</button>
  </div>
</main>
<div role="menu" id="menu" hidden></div>
<script type="application/json" id="options">${data}</script>
<script>${CLIENT}</script></body></html>`
}

/** Serves the fake site; `sent` records every prompt the page sent. */
export class FakeGemini {
  readonly sent: Sent[] = []
  private server: Server | undefined
  options: Required<FakeOptions>
  origin = ''

  constructor(options: FakeOptions = {}) {
    this.options = {
      startOnSpark: true, chatTabBroken: false, temporaryBroken: false, modePicker: true,
      models: ['3.5 Flash-Lite', '3.8 Flash', '3.1 Pro'], levels: ['Low', 'Medium', 'High'], answer: 'OK', ...options,
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin)
    if (url.pathname === '/_/chat' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += String(chunk)
      const sent = JSON.parse(body) as Sent
      this.sent.push(sent)
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      await new Promise((resolve) => setTimeout(resolve, 300))
      for (const word of this.options.answer.split(/(?<= )/)) {
        res.write(`data: ${JSON.stringify({ delta: word })}\n\n`)
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      res.end(`data: ${JSON.stringify({ done: true })}\n\n`)
      return
    }
    if (url.pathname === '/app') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html(this.options))
      return
    }
    res.writeHead(404).end()
  }
}
