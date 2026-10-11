import { readFileSync } from 'node:fs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { loadUiMap } from '@tsuuanmi/system-ui-ops'
import type { Browser, BrowserContext, Page } from 'patchright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { canRunBrowser, launchTestBrowser } from '../../browser-patchright/tests/support.ts'
import { FakeChatGpt, type FakeOptions } from '../fixtures/fake-chatgpt.ts'
import { ChatGptWebDriver, shippedMap } from '../src/index.ts'

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

describe.runIf(canRunBrowser)('ChatGptWebDriver against the fake site', () => {
  let browser: Browser
  let close: () => Promise<void>
  beforeAll(async () => {
    ;({ browser, close } = await launchTestBrowser())
  })
  afterAll(async () => close())

  const cleanups: Array<() => Promise<unknown>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!()
  })

  async function site(options: FakeOptions = {}): Promise<{ fake: FakeChatGpt; page: Page; context: BrowserContext; driver: ChatGptWebDriver }> {
    const fake = new FakeChatGpt(options)
    await fake.start()
    const context = await browser.newContext()
    cleanups.push(() => fake.stop(), () => context.close())
    const page = await context.newPage()
    const driver = new ChatGptWebDriver({ origin: fake.origin, timeouts: { turnMs: 20_000, stallMs: 10_000, stableMs: 400, pollMs: 100 } })
    return { fake, page, context, driver }
  }

  it('reports signed-in and signed-out with positive evidence', async () => {
    const a = await site()
    expect(await a.driver.checkAuth(a.page)).toBe('signed-in')
    const b = await site({ signedIn: false })
    expect(await b.driver.checkAuth(b.page)).toBe('signed-out')
  }, 30_000)

  it('asks in Temporary chat after switching Work to Chat, and waits for completion though the stream stays open', async () => {
    const { fake, page, driver } = await site({ answer: 'Hello from the fake site' })
    const drift: unknown[] = []
    driver.onDrift = (event) => drift.push(event)
    const turn = await driver.ask(page, 'Reply with a greeting', { conversation: 'temporary' })
    expect(drift).toEqual([]) // the shipped primary candidates match the live structure
    expect(turn.text).toBe('Hello from the fake site')
    expect(fake.sent).toEqual([expect.objectContaining({ prompt: 'Reply with a greeting', mode: 'chat', temporary: true })])
    expect(turn.binding).toBeUndefined()
  }, 40_000)

  it('keeps a persistent conversation id and continues the same conversation', async () => {
    const { fake, page, driver } = await site({ answer: 'first answer' })
    const first = await driver.ask(page, 'one', { conversation: 'persistent' })
    expect(first.text).toBe('first answer')
    expect(first.binding).toMatch(/^[0-9a-f-]{36}$/)
    expect(fake.sent[0]).toMatchObject({ mode: 'chat', temporary: false })

    fake.options.answer = 'second answer'
    const second = await driver.ask(page, 'two', { conversation: 'persistent', binding: first.binding })
    expect(second.text).toBe('second answer')
    expect(second.binding).toBe(first.binding)
    expect(fake.sent[1]).toMatchObject({ conversationId: first.binding })
  }, 60_000)

  it('refuses to send when Chat cannot be selected (Work spends the Codex quota)', async () => {
    const { fake, page, driver } = await site({ chatToggleBroken: true })
    const failure = driver.ask(page, 'never sent', { conversation: 'temporary' })
    await expect(failure).rejects.toBeInstanceOf(ProviderError)
    expect(fake.sent).toEqual([])
  }, 30_000)

  it('survives a renamed Send button by healing it, and reports the drift', async () => {
    const { fake, page, driver } = await site({ sendLabel: 'Submit message', answer: 'healed' })
    const heals: unknown[] = []
    driver.onHeal = (event) => heals.push(event)
    const turn = await driver.ask(page, 'drift', { conversation: 'temporary' })
    expect(turn.text).toBe('healed')
    expect(fake.sent).toHaveLength(1)
    expect(heals).toEqual([expect.objectContaining({ element: 'composer.send', outcome: 'healed' })])
  }, 40_000)

  it('fails closed as reauth_required when signed out', async () => {
    const { fake, page, driver } = await site({ signedIn: false })
    await expect(driver.ask(page, 'x', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'reauth_required' })
    expect(fake.sent).toEqual([])
  }, 30_000)
})

it('ships a map that loads with the generic loader too', () => {
  const text = readFileSync(new URL('../ui/chatgpt-web.ui.yaml', import.meta.url), 'utf8')
  expect(loadUiMap(text).hash).toMatch(/^sha256:/)
})
