import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import Providers from '@tsuuanmi/system-providers'
import { loadUiMap } from '@tsuuanmi/system-ui-ops'
import type { Browser } from 'patchright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canRunBrowser, launchTestBrowser } from '../../browser-patchright/tests/support.ts'
import { FakeChatGpt } from '../fixtures/fake-chatgpt.ts'
import ChatGptWebPlugin, { ChatGptWebDriver, shippedMap } from '../src/index.ts'
import { Config } from '../src/plugin.ts'

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

describe('the answer-stable window as configuration (T161)', () => {
  const stableOf = async (config: Record<string, unknown>): Promise<number> => {
    const ctx = new Context()
    await ctx.plugin(Providers)
    await ctx.plugin(ChatGptWebPlugin, { origin: 'http://127.0.0.1:9', overlayPath: '/nonexistent/none.yaml', ...config })
    return (ctx.providers.get('chatgpt-web') as unknown as { timeouts: { stableMs: number } }).timeouts.stableMs
  }

  it('defaults to 1.5 s and refuses a window under 100 ms or over 1 min', () => {
    expect(Config({})).toMatchObject({ stableMs: 1500 })
    expect(Config({ stableMs: 300 })).toMatchObject({ stableMs: 300 })
    expect(() => Config({ stableMs: 50 })).toThrow()
    expect(() => Config({ stableMs: 60_001 })).toThrow()
  })

  it('hands the configured window to the driver, and keeps 1.5 s when none is configured', async () => {
    expect(await stableOf({ stableMs: 300 })).toBe(300)
    expect(await stableOf({})).toBe(1500)
  })
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
