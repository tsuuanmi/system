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

  it('proves reasoning only: Temporary-chat turns, never a persistent conversation or a site feature', async () => {
    const driver: ProviderDriver<Page> = new GeminiWebDriver({ modes: PRESETS })
    expect(driver.capabilities).toEqual(['reason'])
    expect(driver.features).toBeUndefined()
    await expect(driver.ask({} as Page, 'hi', { conversation: 'persistent' })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(driver.ask({} as Page, 'hi', { conversation: 'temporary', feature: 'deep-research' })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(driver.snapshot({} as Page, 'abc')).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  it('fails closed on an unknown preset, before opening anything', async () => {
    const driver = new GeminiWebDriver({ modes: PRESETS })
    await expect(driver.ask({} as Page, 'hi', { conversation: 'temporary', mode: 'ultra' })).rejects.toMatchObject({ kind: 'config_error' })
    expect(() => new GeminiWebDriver({ modes: PRESETS, defaultMode: 'ultra' })).toThrow(/default mode ultra/)
  })

  it('registers on ctx.providers with the shipped presets', async () => {
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
    expect(fake.sent).toEqual([{ prompt: 'Say OK', tab: 'chat', temporary: true, model: '3.1 Pro', level: 'High' }])
    expect(boundaries).toEqual([{ previousResponse: null, mode: { model: '3.1 Pro', effort: 'High' } }])
    expect(new URL(page.url()).pathname).toBe('/app')
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
    const lite = new GeminiWebDriver({ origin: fake.origin, modes: { odd: { model: 'Flash', effort: 'High' } }, timeouts: { readyMs: 5000 } })
    await expect(lite.ask(page, 'hi', { conversation: 'temporary', mode: 'odd' })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/High is not offered/) })
    expect(fake.sent).toEqual([])
  })

  it('selects nothing for an empty preset on an account without a mode picker', async () => {
    const { page, driver, fake } = await open({ modePicker: false })
    expect((await driver.ask(page, 'hi', { conversation: 'temporary', mode: 'site' })).mode).toEqual({})
    await expect(driver.ask(page, 'hi', { conversation: 'temporary', mode: 'pro' })).rejects.toMatchObject({ kind: 'ui_drift' })
    expect(fake.sent).toHaveLength(1)
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
