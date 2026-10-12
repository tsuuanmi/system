import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import Providers from '@tsuuanmi/system-providers'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import type { ProviderDriver } from '@tsuuanmi/system-provider-core'
import type { Browser, BrowserContext, Page } from 'patchright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { canRunBrowser, launchTestBrowser } from '../../browser-patchright/tests/support.ts'
import { FakeGemini, type FakeOptions } from '../fixtures/fake-gemini.ts'
import { GeminiWebDriver, shippedMap } from '../src/index.ts'
import * as GeminiWebPlugin from '../src/index.ts'

const PRESETS = { 'flash-lite': { model: 'Flash-Lite', effort: 'Low' }, flash: { model: 'Flash', effort: 'Medium' }, pro: { model: 'Pro', effort: 'High' }, site: {} }

describe('the Gemini Web UI map and driver contract', () => {
  it('is a valid ui-map', () => {
    const map = shippedMap()
    expect(map.provider).toBe('gemini-web')
    expect(() => new SchemaRegistry().assert('ui-map@1.1', { ...map, elements: map.elements })).toBeDefined()
    expect(Object.keys(map.states)).toEqual(expect.arrayContaining(['auth.signed-in', 'auth.signed-out', 'turn.running']))
  })

  it('proves reasoning and persistent conversations, and offers Deep research as an account feature', async () => {
    const driver: ProviderDriver<Page> = new GeminiWebDriver({ modes: PRESETS })
    expect(driver.capabilities).toEqual(['reason', 'persistent-conversation'])
    expect(driver.features).toEqual(['deep-research'])
  })

  it('refuses what the site does not offer, before opening anything', async () => {
    const driver = new GeminiWebDriver({ modes: PRESETS })
    // Temporary chat offers no Deep research, and a temporary turn has no conversation to continue.
    await expect(driver.ask({} as Page, 'hi', { conversation: 'temporary', feature: 'deep-research' })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(driver.ask({} as Page, 'hi', { conversation: 'temporary', binding: '7b75f8c2d641e476' })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(driver.ask({} as Page, 'hi', { conversation: 'persistent', feature: 'web-search' })).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  it('fails closed on an unknown preset, before opening anything', async () => {
    const driver = new GeminiWebDriver({ modes: PRESETS })
    await expect(driver.ask({} as Page, 'hi', { conversation: 'temporary', mode: 'ultra' })).rejects.toMatchObject({ kind: 'config_error' })
    expect(() => new GeminiWebDriver({ modes: PRESETS, defaultMode: 'ultra' })).toThrow(/default mode ultra/)
  })

  it('registers itself on ctx.providers', async () => {
    const ctx = new Context()
    await ctx.plugin(Providers)
    await ctx.plugin(GeminiWebPlugin, { origin: 'http://127.0.0.1:9' })
    expect(ctx.providers.get('gemini-web')).toBeInstanceOf(GeminiWebDriver)
  })
})

describe.runIf(canRunBrowser)('GeminiWebDriver against the fake site', { timeout: 60_000 }, () => {
  let browser: Browser
  let close: () => Promise<void>
  let context: BrowserContext | undefined
  let fake: FakeGemini | undefined
  beforeAll(async () => {
    ;({ browser, close } = await launchTestBrowser())
  })
  afterAll(async () => close())
  afterEach(async () => {
    await context?.close()
    await fake?.stop()
    context = undefined
    fake = undefined
  })

  async function open(options: FakeOptions = {}): Promise<{ page: Page; driver: GeminiWebDriver; fake: FakeGemini }> {
    fake = new FakeGemini(options)
    const origin = await fake.start()
    context = await browser.newContext()
    const page = await context.newPage()
    const driver = new GeminiWebDriver({ origin, modes: PRESETS, defaultMode: 'flash', timeouts: { readyMs: 5000, stableMs: 300, pollMs: 100, turnMs: 30_000, stallMs: 15_000 } })
    return { page, driver, fake }
  }

  it('asks in a Temporary chat on the Chat tab, never Spark, with the preset read back before sending', async () => {
    const { page, driver, fake } = await open({ answer: 'Gemini test OK.' })
    const boundaries: unknown[] = []
    const result = await driver.ask(page, 'Say OK', { conversation: 'temporary', mode: 'pro', beforeSend: (b) => void boundaries.push(b) })
    expect(result).toEqual({ text: 'Gemini test OK.', binding: undefined, mode: { model: '3.1 Pro', effort: 'High' } })
    expect(fake.sent).toEqual([{ prompt: 'Say OK', tab: 'chat', temporary: true, model: '3.1 Pro', level: 'High', deepResearch: false }])
    expect(boundaries).toEqual([{ previousResponse: null, mode: { model: '3.1 Pro', effort: 'High' } }])
  })

  it('tells Flash from Flash-Lite, and uses the default preset when a turn names none', async () => {
    const { page, driver, fake } = await open()
    expect((await driver.ask(page, 'one', { conversation: 'temporary', mode: 'flash-lite' })).mode).toEqual({ model: '3.5 Flash-Lite', effort: 'Low' })
    expect((await driver.ask(page, 'two', { conversation: 'temporary' })).mode).toEqual({ model: '3.8 Flash', effort: 'Medium' })
    expect(fake.sent.map((s) => [s.model, s.level])).toEqual([['3.5 Flash-Lite', 'Low'], ['3.8 Flash', 'Medium']])
  })

  it('returns the answer as Markdown from its Copy, with code lines kept (REQ-PRV-5)', async () => {
    const markdown = '## Plan\n\n* **First** item\n* **Second** item\n\nSee `x` and [example.com](https://example.com).\n\n```python\ndef add(a, b):\n    return a + b\n```'
    const { page, driver } = await open({ answer: markdown })
    expect((await driver.ask(page, 'Markdown please', { conversation: 'temporary' })).text).toBe(markdown)
  })

  it('refuses to send when Spark cannot be left', async () => {
    const { page, driver, fake } = await open({ chatTabBroken: true })
    await expect(driver.ask(page, 'hi', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'ui_drift', message: expect.stringMatching(/Chat tab/) })
    expect(fake.sent).toEqual([])
  })

  it('refuses to send when Temporary chat does not turn on', async () => {
    const { page, driver, fake } = await open({ temporaryBroken: true })
    await expect(driver.ask(page, 'hi', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'ui_drift' })
    expect(fake.sent).toEqual([])
  })

  it('fails closed on a model or level the account does not offer, before sending', async () => {
    const { page, driver, fake } = await open({ models: ['3.5 Flash-Lite', '3.8 Flash'], levels: ['Low', 'Medium'] })
    await expect(driver.ask(page, 'hi', { conversation: 'temporary', mode: 'pro' })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/Pro is not offered/) })
    const odd = new GeminiWebDriver({ origin: fake.origin, modes: { odd: { model: 'Flash', effort: 'High' } }, timeouts: { readyMs: 5000 } })
    await expect(odd.ask(page, 'hi', { conversation: 'temporary', mode: 'odd' })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/High is not offered/) })
    expect(fake.sent).toEqual([])
  })

  it('selects nothing for an empty preset on an account without a mode picker', async () => {
    const { page, driver, fake } = await open({ modePicker: false })
    expect((await driver.ask(page, 'hi', { conversation: 'temporary', mode: 'site' })).mode).toEqual({})
    await expect(driver.ask(page, 'hi', { conversation: 'temporary', mode: 'pro' })).rejects.toMatchObject({ kind: 'ui_drift' })
    expect(fake.sent).toHaveLength(1)
  })

  it('continues a persistent conversation by its /app/<id> binding, reported as soon as it exists', async () => {
    const { page, driver, fake } = await open({ answer: 'first answer' })
    const bound: string[] = []
    const first = await driver.ask(page, 'one', { conversation: 'persistent', onBinding: (b) => void bound.push(b) })
    expect(first.binding).toMatch(/^[0-9a-f]{16}$/)
    expect(bound).toEqual([first.binding])
    const boundaries: unknown[] = []
    const second = await driver.ask(page, 'two', { conversation: 'persistent', binding: first.binding, beforeSend: (b) => void boundaries.push(b) })
    expect(second.binding).toBe(first.binding)
    expect(boundaries).toEqual([{ previousResponse: 'first answer', mode: { model: '3.8 Flash', effort: 'Medium' } }])
    expect(fake.sent.map((s) => [s.temporary, s.conversationId])).toEqual([[false, undefined], [false, first.binding]])
  })

  it('reopens a bound conversation for reconciliation; a missing one is not observed', async () => {
    const { page, driver } = await open({ answer: 'kept answer' })
    const { binding } = await driver.ask(page, 'a prompt longer than its heading', { conversation: 'persistent' })
    expect(await driver.snapshot(page, binding!)).toEqual({ text: 'kept answer', running: false, observable: true, lastPrompt: 'a prompt longer than its heading' })
    expect(await driver.snapshot(page, 'ffffffffffffffff')).toEqual({ text: '', running: false, observable: false })
  })

  it('does not observe a conversation whose prompt it cannot read, so nothing is resent blind', async () => {
    const { page, driver, fake } = await open()
    const { binding } = await driver.ask(page, 'the prompt', { conversation: 'persistent' })
    fake.options.promptParagraphs = false
    expect(await driver.snapshot(page, binding!)).toEqual({ text: '', running: false, observable: false })
  })

  it('runs Deep research: chosen from More tools, its plan started, and its report returned with the sources it used', async () => {
    const { page, driver, fake } = await open()
    const result = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research' })
    expect(result.text).toBe('HTTP/3 runs over QUIC, not TCP.\n\nSources:\n- RFC 9114: HTTP/3 https://www.rfc-editor.org/rfc/rfc9114')
    expect(fake.sent).toEqual([expect.objectContaining({ deepResearch: true, temporary: false })])
    expect(fake.started).toEqual([result.binding])
  })

  it('returns a clarifying question as the answer when Deep research asks one instead of a plan', async () => {
    const { page, driver, fake } = await open({ clarify: 'Which aspect should the research focus on?' })
    const result = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research' })
    expect(result.text).toBe('Which aspect should the research focus on?')
    expect(fake.started).toEqual([])
  })

  it('clears Deep research, which a reopened conversation keeps chosen, before a plain follow-up', async () => {
    const { page, driver, fake } = await open({ clarify: 'Which aspect?', answer: 'a plain answer' })
    const { binding } = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research' })
    const follow = await driver.ask(page, 'Which RFC defines HTTP/3?', { conversation: 'persistent', binding })
    expect(follow.text).toBe('a plain answer')
    expect(fake.sent.map((s) => s.deepResearch)).toEqual([true, false])
  })

  it('keeps Deep research chosen, never toggled off, for a Deep research follow-up in the same conversation', async () => {
    const { page, driver, fake } = await open({ clarify: 'Which aspect?' })
    const { binding } = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research' })
    await driver.ask(page, 'Latency, please', { conversation: 'persistent', feature: 'deep-research', binding })
    expect(fake.sent.map((s) => s.deepResearch)).toEqual([true, true])
  })

  it('reopens a Deep research turn as running while its card works, then as its report', async () => {
    const { page, driver, fake } = await open({ researchMs: 6000 })
    let binding: string | undefined
    const asked = driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research', onBinding: (b) => { binding = b } })
    for (let i = 0; i < 100 && !fake.started.length; i++) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fake.started).toEqual([binding])
    const other = await context!.newPage()
    expect(await driver.snapshot(other, binding!, { feature: 'deep-research' })).toMatchObject({ text: '', running: true, observable: true })
    const result = await asked
    // Starting the plan is the conversation's last user turn.
    expect(await driver.snapshot(other, binding!, { feature: 'deep-research' })).toEqual({ text: result.text, running: false, observable: true, lastPrompt: 'Start research' })
  })

  it('probes the account\'s features in a new chat, sending nothing (REQ-PRV-7)', async () => {
    const { page, driver, fake } = await open()
    expect(await driver.probeFeatures(page)).toEqual(['deep-research'])
    const none = await open({ deepResearch: false })
    expect(await none.driver.probeFeatures(none.page)).toEqual([])
    expect([...fake.sent, ...none.fake.sent]).toEqual([])
  })

  it('sends nothing when the receipt cannot be written', async () => {
    const { page, driver, fake } = await open()
    await expect(driver.ask(page, 'hi', { conversation: 'temporary', beforeSend: () => { throw new Error('store down') } })).rejects.toThrow('store down')
    expect(fake.sent).toEqual([])
  })
})

describe.runIf(canRunBrowser)('GeminiWebDriver sign-in against static pages', () => {
  let browser: Browser
  let close: () => Promise<void>
  let server: Server
  let origin: string
  beforeAll(async () => {
    ;({ browser, close } = await launchTestBrowser())
    server = createServer((req, res) => {
      const body = req.url?.startsWith('/app') && req.url.includes('in')
        ? '<header><button aria-label="Google Account: Test User (test@example.test)">T</button></header><main>Hello</main>'
        : '<header><a href="/signin">Sign in</a></header>'
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><body>${body}</body></html>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await close()
    server.close()
  })

  it('tells signed-in from signed-out, and reads the account from its button', async () => {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      const driver = new GeminiWebDriver({ origin, timeouts: { readyMs: 5000 } })
      await page.goto(`${origin}/app?signed=out`)
      expect(await driver.checkAuth(page)).toBe('signed-out')
      await page.goto(`${origin}/app?signed=in`)
      expect(await driver.checkAuth(page)).toBe('signed-in')
      expect(await driver.identity(page)).toBe('Test User (test@example.test)')
    } finally {
      await context.close()
    }
  }, 60_000)
})
