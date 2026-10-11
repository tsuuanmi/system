import { type Server, createServer } from 'node:http'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import type { Browser, BrowserContext, Page } from 'patchright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { canRunBrowser, launchTestBrowser } from '../../plugins/browser-patchright/tests/support.ts'
import { type DriftEvent, type EngineOptions, type HealEvent, UiEngine, loadUiMap } from '../src/index.ts'

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

describe.runIf(canRunBrowser)('UiEngine on a real page', () => {
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

  it('resolves the primary candidate inside its scope, with no drift', async () => {
    const { engine, drift } = await open(CURRENT)
    const send = await engine.resolve('composer.send')
    expect(send.candidate).toBe(0)
    expect(await send.locator.getAttribute('data-testid')).toBe('send-button')
    expect(drift).toEqual([])
  })

  it('falls back to the next candidate and reports drift', async () => {
    const { engine, drift } = await open(RENAMED_TESTID)
    const send = await engine.resolve('composer.send')
    expect(send.candidate).toBe(1)
    expect(drift).toEqual([expect.objectContaining({ element: 'composer.send', candidate: 1 })])
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

  it('records a healed choice before acting, and does not act when recording fails', async () => {
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

  it('does not heal while a guard state is showing', async () => {
    const { engine, heals } = await open(SIGNED_OUT)
    const failure = engine.act('composer.send')
    await expect(failure).rejects.toMatchObject({ kind: 'reauth_required' })
    expect(heals).toEqual([])
  })
})
