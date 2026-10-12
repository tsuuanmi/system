import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import type { Browser } from 'patchright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canRunBrowser, launchTestBrowser } from '../../browser-patchright/tests/support.ts'
import { GeminiWebDriver, shippedMap } from '../src/index.ts'

describe('the Gemini Web UI map', () => {
  it('is a valid ui-map with the sign-in states', () => {
    const map = shippedMap()
    expect(map.provider).toBe('gemini-web')
    expect(Object.keys(map.states).sort()).toEqual(['auth.signed-in', 'auth.signed-out'])
    expect(() => new SchemaRegistry().assert('ui-map@1.1', { ...map, elements: map.elements })).toBeDefined()
  })

  it('serves no work until conversations are built: no capabilities, and asking fails closed', async () => {
    const driver = new GeminiWebDriver()
    expect(driver.capabilities).toEqual([])
    await expect(driver.ask()).rejects.toMatchObject({ kind: 'config_error' })
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
      const driver = new GeminiWebDriver({ origin, readyMs: 5000 })
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
