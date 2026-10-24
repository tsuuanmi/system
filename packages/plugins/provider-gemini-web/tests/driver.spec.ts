import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import EventLog from '@tsuuanmi/system-event-log'
import Providers from '@tsuuanmi/system-providers'
import Store from '@tsuuanmi/system-store'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import type { ProviderDriver } from '@tsuuanmi/system-provider-core'
import type { Browser, Page } from 'patchright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canRunBrowser, launchTestBrowser } from '../../browser-patchright/tests/support.ts'
import { TERMS_NOTICE_MESSAGE } from '../src/driver.ts'
import { GeminiWebDriver, shippedMap } from '../src/index.ts'
import * as GeminiWebPlugin from '../src/index.ts'
import { PRESETS } from './site.ts'

// The driver against its fake site is tested by theme, one file each so they run side by side:
// modes.spec.ts, composer.spec.ts, pages.spec.ts, stalls.spec.ts, conversations.spec.ts,
// deletion.spec.ts, research.spec.ts, and research-progress.spec.ts.

describe('the Gemini Web UI map and driver contract', () => {
  it('is a valid ui-map', () => {
    const map = shippedMap()
    expect(map.provider).toBe('gemini-web')
    expect(() => new SchemaRegistry().assert('ui-map@1.1', { ...map, elements: map.elements })).toBeDefined()
    expect(Object.keys(map.states)).toEqual(expect.arrayContaining(['auth.signed-in', 'auth.signed-out', 'turn.running']))
  })

  it('tells the operator the same step for a terms notice whether an action\'s guard or the sign-in check finds it', () => {
    const rule = shippedMap().errors.find((e) => 'state' in e.when && e.when.state === 'site.terms-notice')
    expect(rule).toMatchObject({ kind: 'challenge', message: TERMS_NOTICE_MESSAGE })
    expect(TERMS_NOTICE_MESSAGE).toMatch(/system account login/)
    // Within what an account's challenge reason keeps (account.challenged holds 200 characters).
    expect(TERMS_NOTICE_MESSAGE.length).toBeLessThanOrEqual(200)
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
    expect(() => new GeminiWebDriver({ modes: PRESETS, researchMode: 'ultra' })).toThrow(/research mode ultra/)
  })

  it('registers itself on ctx.providers, with its site\'s title for people (T116)', async () => {
    const ctx = new Context()
    await ctx.plugin(Providers)
    await ctx.plugin(GeminiWebPlugin, { origin: 'http://127.0.0.1:9' })
    expect(ctx.providers.get('gemini-web')).toBeInstanceOf(GeminiWebDriver)
    expect(ctx.providers.get('gemini-web').title).toBe('Gemini')
  })

  it('logs drift as ui.drift, its outline kept as local-private evidence (drift evidence, INV-12)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-gemini-'))
    const ctx = new Context()
    const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Providers), ctx.plugin(GeminiWebPlugin, { origin: 'http://127.0.0.1:9' })]
    try {
      await Promise.all(fibers)
      const driver = ctx.providers.get('gemini-web') as GeminiWebDriver
      driver.onDrift!({ provider: 'gemini-web', element: 'temporary.enable', kind: 'postcondition', candidate: -1, mapHash: 'sha256:00', outline: { schema: 'ui-outline@1.0', root: 'body', truncated: false, nodes: [{ depth: 0, tag: 'body', text: 3 }] } })
      const [event] = ctx.eventLog.query({ type: 'ui.drift', limit: 10 })
      expect(event!.data).toEqual({ provider: 'gemini-web', element: 'temporary.enable', kind: 'postcondition', candidate: -1, mapHash: 'sha256:00', outline: expect.stringMatching(/^sha256:/) })
      expect(ctx.artifacts.get(String(event!.data!.outline))).toMatchObject({ kind: 'evidence', bodySchema: 'ui-outline@1.0', classification: 'local-private' })
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
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
