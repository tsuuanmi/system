import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import Providers from '@tsuuanmi/system-providers'
import { loadUiMap } from '@tsuuanmi/system-ui-ops'
import type { Browser } from 'patchright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canRunBrowser, launchTestBrowser } from '../../browser-patchright/tests/support.ts'
import { FakeChatGpt } from '../fixtures/fake-chatgpt.ts'
import ChatGptWebPlugin, { ChatGptWebDriver, shippedMap } from '../src/index.ts'

// The driver against its fake site is tested by theme, one file each so they run side by side:
// pages.spec.ts, answers.spec.ts, composer.spec.ts, conversations.spec.ts, deletion.spec.ts,
// research.spec.ts, and research-runs.spec.ts.

describe('the shipped ChatGPT UI map', () => {
  it('validates, and Send is irreversible with deterministic healing only', () => {
    const map = shippedMap()
    expect(map.provider).toBe('chatgpt-web')
    expect(map.actions['composer.send']).toMatchObject({ sideEffect: 'irreversible', heal: 'deterministic' })
  })

  it('accepts a local overlay', () => {
    const map = shippedMap('elements:\n  composer.send:\n    candidates:\n      - { testId: composer-submit }\n')
    expect(map.elements['composer.send']!.candidates.at(-1)).toMatchObject({ testId: 'composer-submit', source: 'overlay' })
  })
})

it('ships a map that loads with the generic loader too', () => {
  const text = readFileSync(new URL('../ui/chatgpt-web.ui.yaml', import.meta.url), 'utf8')
  expect(loadUiMap(text).hash).toMatch(/^sha256:/)
})

describe.runIf(canRunBrowser)('the driver as a provider plugin', () => {
  let browser: Browser
  let close: () => Promise<void>
  beforeAll(async () => {
    ;({ browser, close } = await launchTestBrowser())
  })
  afterAll(async () => close())

  it('exposes login support: login URL, state origins, and a hashed-only identity hint', async () => {
    const fake = new FakeChatGpt({ userId: 'user-abc' })
    await fake.start()
    const context = await browser.newContext()
    try {
      const driver = new ChatGptWebDriver({ origin: fake.origin })
      expect(driver.loginUrl).toBe(`${fake.origin}/auth/login`)
      expect(driver.stateOrigins).toEqual([fake.origin])
      const page = await context.newPage()
      expect(await driver.checkAuth(page)).toBe('signed-in')
      expect(await driver.identity(page)).toBe('chatgpt-web:user-abc')
    } finally {
      await context.close()
      await fake.stop()
    }
  }, 30_000)

  it('registers itself on ctx.providers, with its site\'s title for people (T116)', async () => {
    const ctx = new Context()
    await ctx.plugin(Providers)
    await ctx.plugin(ChatGptWebPlugin, { origin: 'http://127.0.0.1:9' })
    expect(ctx.providers.get('chatgpt-web')).toBeInstanceOf(ChatGptWebDriver)
    expect(ctx.providers.get('chatgpt-web').title).toBe('ChatGPT')
  })
})
