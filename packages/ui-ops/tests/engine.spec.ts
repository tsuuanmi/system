import { type Server, createServer } from 'node:http'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import type { Browser, BrowserContext, Page } from 'patchright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { canRunBrowser, launchTestBrowser } from '../../plugins/browser-patchright/tests/support.ts'
import { type DriftEvent, type EngineOptions, type HealEvent, UiEngine, loadUiMap, readbackDiff } from '../src/index.ts'

const MAP = `
schema: ui-map@1.0
provider: test-site
uiRevision: '2026-10-09'
locales: [en, vi]
elements:
  composer.form:
    candidates:
      - { css: 'form[data-type="composer"]' }
  composer.input:
    scope: composer.form
    candidates:
      - { testId: prompt-textarea }
      - { role: textbox }
    fingerprint: { role: textbox }
  composer.send:
    scope: composer.form
    candidates:
      - { testId: send-button }
      - { role: button, name: { en: '^Send prompt$', vi: '^Gửi lời nhắc$' } }
    fingerprint: { role: button, name: { en: 'send', vi: 'gửi' }, nearRole: textbox }
  response.stop:
    candidates: [{ testId: stop-button }]
  turn.user:
    cardinality: many
    candidates: [{ css: '[data-role="user"]' }]
  turn.assistant.last:
    candidates: [{ css: '[data-role="assistant"]:last-of-type' }]
  auth.login:
    candidates: [{ testId: login-button }]
actions:
  composer.insert:
    do: insertText
    target: composer.input
    require: [editable]
    verify: { attr: { of: composer.input, name: data-filled, present: true } }
    sideEffect: none
  composer.send:
    do: click
    target: composer.send
    require: [enabled]
    fallback: { press: Enter, on: composer.input }
    verify: { anyOf: [{ network: conversation.post }, { countIncreased: turn.user }] }
    sideEffect: irreversible
    heal: deterministic
    timeouts: { resolveMs: 1500, verifyMs: 3000 }
network:
  conversation.post: { method: POST, url: '/backend-api/conversation$' }
  stream.open: { url: '/backend-api/conversation$', contentType: text/event-stream, open: true }
states:
  auth.signed-out: { visible: auth.login }
  turn.running: { anyOf: [{ visible: response.stop }, { network: stream.open }] }
  turn.complete: { allOf: [{ not: { state: turn.running } }, { stableTextMs: 300, of: turn.assistant.last }] }
errors:
  - { when: { state: auth.signed-out }, kind: reauth_required }
`

/** A minimal chat page: sending appends a user turn and POSTs to the conversation endpoint. */
const page = (form: string, extra = ''): string => `<!doctype html><html lang="en"><body>
<main>${form}<section id="log"></section></main>${extra}
<script>
  const input = document.querySelector('[contenteditable]')
  input.addEventListener('input', () => input.setAttribute('data-filled', ''))
  async function send() {
    const turn = document.createElement('div'); turn.dataset.role = 'user'; turn.textContent = input.textContent
    document.getElementById('log').append(turn)
    const res = await fetch('/backend-api/conversation', { method: 'POST', body: input.textContent })
    await res.text()
    const answer = document.createElement('div'); answer.dataset.role = 'assistant'; answer.textContent = 'hi'
    document.getElementById('log').append(answer)
  }
  for (const b of document.querySelectorAll('[data-send]')) b.addEventListener('click', send)
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send() } })
</script></body></html>`

const CURRENT = page(`<form data-type="composer"><div contenteditable data-testid="prompt-textarea" role="textbox"></div>
  <button type="button" data-testid="send-button" aria-label="Send prompt" data-send>↑</button></form>`)
const RENAMED_TESTID = page(`<form data-type="composer"><div contenteditable data-testid="prompt-textarea" role="textbox"></div>
  <button type="button" data-testid="composer-submit" aria-label="Send prompt" data-send>↑</button></form>`)
const DRIFTED = page(`<form data-type="composer"><div contenteditable role="textbox" aria-label="Message"></div>
  <button type="button" aria-label="Voice mode">🎤</button>
  <button type="button" data-testid="submit-v2" aria-label="Send message" data-send>↑</button></form>`)
const AMBIGUOUS = page(`<form data-type="composer"><div contenteditable role="textbox" aria-label="Message"></div>
  <button type="button" aria-label="Send now">↑</button><button type="button" aria-label="Send later">⏱</button></form>`)
const VIETNAMESE = page(`<form data-type="composer"><div contenteditable role="textbox"></div>
  <button type="button" aria-label="Gửi lời nhắc" data-send>↑</button></form>`)
const WITH_CHIP = page(`<form data-type="composer"><div contenteditable data-testid="prompt-textarea" role="textbox"><p><span contenteditable="false" data-chip><img alt="Deep research">Deep research</span>&nbsp;</p></div>
  <button type="button" data-testid="send-button" aria-label="Send prompt" data-send>↑</button></form>`)
const SIGNED_OUT = page(`<form data-type="composer"><div contenteditable role="textbox"></div></form>`, '<a data-testid="login-button" href="#">Log in</a>')

describe('readbackDiff: where a composer changed a paste, never what it said', () => {
  it('names the first difference by line, offset, and character class', () => {
    const inserted = 'Review the code:\n\n```ts\nconst secret = 1\n```\nThanks'
    const read = 'Review the code:\n\nts\nconst secret = 1\nThanks'
    expect(readbackDiff(inserted, read)).toEqual({ insertedChars: inserted.length, readChars: read.length, insertedLines: 5, readLines: 4, line: 1, offset: 0, inserted: 'punctuation `', read: 'letter', truncated: false })
    // Structure only: none of the text itself.
    expect(JSON.stringify(readbackDiff(inserted, read))).not.toMatch(/secret|Review|Thanks/)
  })

  it('says when the text was cut short', () => {
    expect(readbackDiff('one two three\nfour', 'one two')).toMatchObject({ line: 0, offset: 7, inserted: 'space', read: 'end', truncated: true })
  })
})

describe('loadUiMap', () => {
  it('validates the map and appends overlay candidates after the shipped ones', () => {
    const shipped = loadUiMap(MAP)
    const overlaid = loadUiMap(MAP, `elements:\n  composer.send:\n    candidates:\n      - { testId: submit-v2 }\n`)
    expect(overlaid.elements['composer.send']!.candidates.at(-1)).toEqual({ testId: 'submit-v2', source: 'overlay' })
    expect(overlaid.elements['composer.send']!.candidates[0]).toEqual({ testId: 'send-button', source: 'shipped' })
    expect(overlaid.hash).not.toBe(shipped.hash)
  })

  it('rejects an invalid map and an overlay naming an unknown element', () => {
    expect(() => loadUiMap(MAP.replace('candidates:\n      - { css', 'candidates: []\n      - { css'))).toThrow()
    expect(() => loadUiMap(MAP, 'elements:\n  nope:\n    candidates: [{ testId: x }]\n')).toThrow(/unknown element/)
  })
})

describe.runIf(canRunBrowser)('UiEngine on a real page', { timeout: 15_000 }, () => {
  let browser: Browser
  let close: () => Promise<void>
  let server: Server
  let origin: string
  let html = CURRENT
  beforeAll(async () => {
    ;({ browser, close } = await launchTestBrowser())
    server = createServer((req, res) => {
      if (req.url === '/backend-api/conversation') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {}\n\n')
        setTimeout(() => res.end('data: [DONE]\n\n'), 600)
        return
      }
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(html)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await close()
  })

  let context: BrowserContext
  afterEach(async () => context?.close())

  async function open(content: string, map = loadUiMap(MAP), extra: Partial<EngineOptions> = {}): Promise<{ engine: UiEngine; tab: Page; drift: DriftEvent[]; heals: HealEvent[] }> {
    html = content
    context = await browser.newContext()
    const tab = await context.newPage()
    const drift: DriftEvent[] = []
    const heals: HealEvent[] = []
    const engine = new UiEngine(tab, map, { onDrift: (e) => drift.push(e), onHeal: (e) => heals.push(e), defaultResolveMs: 800, ...extra })
    await tab.goto(`${origin}/`)
    return { engine, tab, drift, heals }
  }

  it('reads what a copy control put on the clipboard, and never an earlier copy', async () => {
    const { engine, tab } = await open(page('<form data-type="composer"><div contenteditable role="textbox"></div></form>',
      '<button id="copy" onclick="navigator.clipboard.writeText(\'## Plan\\n**bold**\')">Copy</button><button id="noop">Copy</button>'))
    expect(await engine.copied(tab.locator('#copy'))).toBe('## Plan\n**bold**')
    // The clipboard still holds the first copy; a control that copies nothing reads as nothing.
    expect(await engine.copied(tab.locator('#noop'))).toBe('')
  })

  it('resolves the primary candidate inside its scope, with no drift', async () => {
    const { engine, drift } = await open(CURRENT)
    const send = await engine.resolve('composer.send')
    expect(send.candidate).toBe(0)
    expect(await send.locator.getAttribute('data-testid')).toBe('send-button')
    expect(drift).toEqual([])
  })

  it('names what an unresolved element needed: exactly one visible match, or any for a many element', async () => {
    const { engine } = await open(page('<form data-type="composer"><div contenteditable role="textbox"></div></form>'))
    await expect(engine.resolve('turn.user', 0)).rejects.toMatchObject({ kind: 'ui_drift', message: expect.stringMatching(/turn\.user matched any visible element/) })
    await expect(engine.resolve('response.stop', 0)).rejects.toMatchObject({ kind: 'ui_drift', message: expect.stringMatching(/response\.stop matched exactly one visible element/) })
  })

  it('takes the primary candidate that renders a moment after a later one, with no drift', async () => {
    const { engine, tab, drift } = await open(page(`<form data-type="composer"><div contenteditable role="textbox"></div>
  <button type="button" aria-label="Send prompt">↑</button></form>`))
    await tab.evaluate(() => void setTimeout(() => { document.querySelector('button')!.dataset.testid = 'send-button' }, 100))
    expect((await engine.resolve('composer.send')).candidate).toBe(0)
    expect(drift).toEqual([])
  })

  it('falls back to the next candidate and reports drift, with an outline of the found element\'s parent: structure, never text', async () => {
    const { engine, drift } = await open(RENAMED_TESTID.replace('<div contenteditable', '<div contenteditable data-secret-note="x"').replace('role="textbox"></div>', 'role="textbox">my private draft</div>'))
    const send = await engine.resolve('composer.send')
    expect(send.candidate).toBe(1)
    expect(drift).toEqual([expect.objectContaining({ element: 'composer.send', kind: 'fallback', candidate: 1, source: 'shipped' })])
    const outline = drift[0]!.outline!
    expect(outline).toMatchObject({ schema: 'ui-outline@1.0', root: 'parent of composer.send', truncated: false })
    expect(outline.nodes).toEqual([
      { depth: 0, tag: 'form', data: ['data-type'], text: 18 },
      { depth: 1, tag: 'div', role: 'textbox', data: ['data-secret-note'], testid: 'prompt-textarea', editable: true, text: 16 },
      { depth: 1, tag: 'button', label: 'Send prompt', testid: 'composer-submit', data: ['data-send'], text: 1 },
    ])
    // Text, attribute values other than the named ones, and URLs never appear.
    expect(JSON.stringify(outline)).not.toMatch(/private|draft|"x"/)
    // Reported once per element and kind for the page.
    await engine.resolve('composer.send')
    expect(drift).toHaveLength(1)
  })

  it('reports an action that misses its postcondition, and an action target that no candidate finds, with a page outline', async () => {
    const stuck = loadUiMap(MAP.replace("verify: { attr: { of: composer.input, name: data-filled, present: true } }", "verify: { attr: { of: composer.input, name: data-never, present: true } }\n    timeouts: { verifyMs: 300 }"))
    const { engine, drift } = await open(CURRENT, stuck)
    await expect(engine.act('composer.insert', { text: 'hello' })).rejects.toMatchObject({ kind: 'ui_drift' })
    expect(drift).toEqual([expect.objectContaining({ element: 'composer.insert', kind: 'postcondition', candidate: -1 })])
    expect(drift[0]!.outline).toMatchObject({ root: 'body', nodes: expect.arrayContaining([expect.objectContaining({ tag: 'main' }), expect.objectContaining({ tag: 'form' })]) })
    expect(JSON.stringify(drift[0]!.outline)).not.toContain('hello')
    const gone = await open(AMBIGUOUS)
    await gone.engine.act('composer.insert', { text: 'hello' })
    await expect(gone.engine.act('composer.send', {}, { allowFallback: false })).rejects.toMatchObject({ kind: 'ui_drift' })
    expect(gone.drift.filter((d) => d.kind === 'unresolved')).toEqual([expect.objectContaining({ element: 'composer.send', outline: expect.objectContaining({ root: 'composer.form' }) })])
  })

  it('masks any value that holds an email address or the account\'s own name, and keeps labels short', async () => {
    const stuck = loadUiMap(MAP.replace("verify: { attr: { of: composer.input, name: data-filled, present: true } }", "verify: { attr: { of: composer.input, name: data-never, present: true } }\n    timeouts: { verifyMs: 300 }"))
    const extra = '<button data-testid="who" aria-label="Signed in as ann.lee@example.org">A</button><button data-testid="profile" aria-label="Profile of Ann Lee">P</button>'
      + '<button data-testid="long" aria-label="A label that is far longer than forty characters, by design">L</button>'
    const { engine, drift } = await open(page('<form data-type="composer"><div contenteditable role="textbox"></div></form>', extra), stuck, { redact: async () => ['Ann Lee'] })
    await expect(engine.act('composer.insert', { text: 'hello' })).rejects.toMatchObject({ kind: 'ui_drift' })
    const outline = drift.find((d) => d.kind === 'postcondition')!.outline!
    expect(outline.nodes.filter((n) => n.tag === 'button').map((b) => b.label)).toEqual(['[redacted]', '[redacted]', 'A label that is far longer than forty ch'])
    expect(JSON.stringify(outline)).not.toMatch(/ann\.lee@|Ann Lee/)
  })

  it('folds side navigation in page-wide outlines, so the page\'s content keeps the node budget (live 2026-10-18)', async () => {
    const stuck = loadUiMap(MAP.replace("verify: { attr: { of: composer.input, name: data-filled, present: true } }", "verify: { attr: { of: composer.input, name: data-never, present: true } }\n    timeouts: { verifyMs: 300 }"))
    const side = `<aside><div role="navigation" aria-label="Chats">${Array.from({ length: 300 }, (_, i) => `<button data-testid="b${i}">x</button>`).join('')}</div></aside>`
    const form = '<form data-type="composer"><div contenteditable data-testid="prompt-textarea" role="textbox"></div></form>'
    // The navigation comes first in the page, as a sidebar does.
    const sidebarFirst = (content: string): string => content.replace('<body>\n<main>', `<body>\n${side}<main>`)
    const { engine, drift } = await open(sidebarFirst(page(form)), stuck)
    const stalled = (await engine.stall('answer')).outline!
    expect(stalled.truncated).toBe(false)
    expect(stalled.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'navigation', label: 'Chats' }), expect.objectContaining({ tag: 'main' }), expect.objectContaining({ tag: 'form' })]))
    expect(stalled.nodes.some((n) => n.testid?.startsWith('b'))).toBe(false)
    // A drift with no scope: the same.
    await expect(engine.act('composer.insert', { text: 'hello' })).rejects.toMatchObject({ kind: 'ui_drift' })
    expect(drift.find((d) => d.kind === 'postcondition')!.outline).toMatchObject({ root: 'body', truncated: false })
    // An outline rooted elsewhere keeps everything: only page-wide ones fold.
    const { outlineOf } = await import('../src/index.ts')
    const { tab } = await open(sidebarFirst(page(form)))
    expect((await outlineOf(tab.locator('aside'), 'aside')).truncated).toBe(true)
  })

  it('records each link\'s target as a kind, never the URL (ui-outline@1.1)', async () => {
    const links = '<nav><a href="https://src.example/secret-path">a</a><a href="/c/123">b</a><a>c</a><a href="javascript:void 0">d</a></nav>'
    const { tab } = await open(page('<form data-type="composer"><div contenteditable role="textbox"></div></form>', links))
    const { outlineOf } = await import('../src/index.ts')
    const outline = await outlineOf(tab.locator('nav'), 'nav')
    expect(outline.schema).toBe('ui-outline@1.1')
    // The two links with no target fold into one node, as like siblings do.
    expect(outline.nodes.filter((n) => n.tag === 'a').map((n) => [n.link, n.repeat])).toEqual([['external', undefined], ['site', undefined], ['none', 1]])
    expect(JSON.stringify(outline)).not.toMatch(/src\.example|secret-path|\/c\/123/)
    // With no link in it, an outline stays @1.0.
    expect((await outlineOf(tab.locator('form'), 'form')).schema).toBe('ui-outline@1.0')
  })

  it('folds a run of like siblings into one node, and bounds the outline', async () => {
    const chats = Array.from({ length: 300 }, (_, i) => `<li role="option" aria-label="Chat ${i}"><a href="/c/${i}" aria-label="secret title ${i}">t</a></li>`).join('')
    const buttons = Array.from({ length: 300 }, (_, i) => `<button data-testid="b${i}">x</button>`).join('')
    const { tab } = await open(page('<form data-type="composer"><div contenteditable role="textbox"></div></form>', `<nav><ul>${chats}</ul></nav><aside>${buttons}</aside>`))
    const { outlineOf } = await import('../src/index.ts')
    const nav = await outlineOf(tab.locator('nav'), 'nav')
    // A list of chats is one node with a count; a link's label (often content, such as a chat's title) is never kept.
    expect(nav.nodes.filter((n) => n.role === 'option')).toEqual([expect.objectContaining({ label: 'Chat 0', repeat: 299 })])
    expect(JSON.stringify(nav)).not.toContain('secret title')
    // Distinct nodes stop at the bound.
    const aside = await outlineOf(tab.locator('aside'), 'aside')
    expect(aside).toMatchObject({ truncated: true })
    expect(aside.nodes).toHaveLength(200)
  })

  it('matches localized accessible names', async () => {
    const { engine } = await open(VIETNAMESE)
    expect((await engine.resolve('composer.send')).candidate).toBe(1)
  })

  it('inserts text, sends, and verifies through the network signal', async () => {
    const { engine } = await open(CURRENT)
    await engine.act('composer.insert', { text: 'hello' })
    await engine.act('composer.send')
    expect(await engine.count('turn.user')).toBe(1)
    expect(await engine.state('turn.running')).toBe(true)
    await engine.waitFor({ state: 'turn.complete' }, 5000)
    expect(engine.network.seen('conversation.post')).toBe(1)
    expect(await engine.state('turn.running')).toBe(false)
    expect(await engine.text('turn.assistant.last')).toBe('hi')
  }, 15_000)

  it('heals a drifted control deterministically, ignoring decoys, and proposes an overlay', async () => {
    const { engine, heals } = await open(DRIFTED)
    await engine.act('composer.insert', { text: 'hello' })
    await engine.act('composer.send')
    expect(await engine.count('turn.user')).toBe(1)
    expect(heals).toEqual([expect.objectContaining({ element: 'composer.send', outcome: 'healed', model: false, candidate: { testId: 'submit-v2' } })])
    expect(heals[0]!.scores[0]!.score).toBeGreaterThanOrEqual(0.8)
  })

  it('records a healed choice before acting, and does not act when recording fails (INV-13)', async () => {
    const order: string[] = []
    const ok = await open(DRIFTED, loadUiMap(MAP), { beforeHealedAction: (e) => { order.push(`record ${e.element}`) } })
    await ok.engine.act('composer.insert', { text: 'hello' })
    ok.tab.on('request', (r) => { if (r.url().endsWith('/backend-api/conversation')) order.push('send') })
    await ok.engine.act('composer.send')
    expect(order).toEqual(['record composer.send', 'send'])
    await context.close()

    const refused = await open(DRIFTED, loadUiMap(MAP), { beforeHealedAction: () => { throw new Error('audit store down') } })
    await refused.engine.act('composer.insert', { text: 'hello' })
    await expect(refused.engine.act('composer.send', {}, { allowFallback: false })).rejects.toThrow(/audit store down/)
    expect(await refused.engine.count('turn.user')).toBe(0)
  })

  it('fails closed with CONFIG_FIX when healing is ambiguous, and never clicks a guess', async () => {
    const { engine, heals } = await open(AMBIGUOUS)
    await engine.act('composer.insert', { text: 'hello' })
    const failure = engine.act('composer.send', {}, { allowFallback: false })
    await expect(failure).rejects.toBeInstanceOf(ProviderError)
    await expect(failure).rejects.toMatchObject({ kind: 'ui_drift', disposition: 'CONFIG_FIX' })
    expect(heals).toEqual([expect.objectContaining({ outcome: 'rejected' })])
    expect(await engine.count('turn.user')).toBe(0)
  })

  it('uses the fallback key when the control cannot be resolved', async () => {
    const { engine } = await open(AMBIGUOUS.replace('aria-label="Send later"', 'aria-label="Send now"'))
    await engine.act('composer.insert', { text: 'hello' })
    await engine.act('composer.send')
    expect(await engine.count('turn.user')).toBe(1)
  })

  it('reads inserted text back without the composer\'s non-editable chips (e.g. a Deep research mention)', async () => {
    const { engine, tab } = await open(WITH_CHIP)
    await tab.getByRole('textbox').click()
    await tab.keyboard.press('End')
    await engine.act('composer.insert', { text: 'compare plugin catalogs' })
    expect(await tab.getByRole('textbox').innerText()).toContain('Deep research')
  })

  it('accepts a multi-line prompt, which the composer splits into paragraphs', async () => {
    const { engine, tab } = await open(CURRENT)
    await engine.act('composer.insert', { text: 'line one\nline two\n\n- item' })
    expect(await tab.getByRole('textbox').innerText()).toMatch(/line one[\s\S]*line two[\s\S]*- item/)
  })

  it('finds elements inside nested iframes when the map says frames: any', async () => {
    const framed = page(`<form data-type="composer"><div contenteditable data-testid="prompt-textarea" role="textbox"></div></form>`,
      `<iframe srcdoc="<iframe srcdoc='<main><p>Research completed in 2m</p><h2>Deep Research Report</h2><p>The answer.</p></main>'></iframe>"></iframe>`)
    const map = loadUiMap(MAP.replace('schema: ui-map@1.0', 'schema: ui-map@1.1').replace('elements:\n', `elements:
  research.completed:
    frames: any
    candidates: [{ text: { en: '^Research completed' } }]
`))
    const { engine } = await open(framed, map)
    await expect.poll(() => engine.count('research.completed'), { timeout: 5000 }).toBe(1)
    expect(await engine.state('turn.running')).toBe(false)
    expect(await (await engine.resolve('research.completed')).locator.innerText()).toBe('Research completed in 2m')
  })

  it('does not heal while a guard state is showing', async () => {
    const { engine, heals } = await open(SIGNED_OUT)
    const failure = engine.act('composer.send')
    await expect(failure).rejects.toMatchObject({ kind: 'reauth_required' })
    expect(heals).toEqual([])
  })
})
