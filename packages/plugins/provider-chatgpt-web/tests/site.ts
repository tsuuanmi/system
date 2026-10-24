/**
 * The driver specs' fake ChatGPT site and the file's one headed Chrome. A spec file calls
 * {@link fakeSite} once, at its top: it launches the browser in `beforeAll` and closes it in
 * `afterAll`, and each `site` starts a fake site and a browser context that are stopped when their
 * test finishes. The specs are split by theme, one file each, so they run side by side.
 */
import type { Browser, BrowserContext, Page } from 'patchright-core'
import { afterAll, beforeAll, onTestFinished } from 'vitest'
import { canRunBrowser, launchTestBrowser } from '../../browser-patchright/tests/support.ts'
import { FakeChatGpt, type FakeOptions } from '../fixtures/fake-chatgpt.ts'
import { ChatGptWebDriver, type DriverTimeouts } from '../src/index.ts'

export interface Site { fake: FakeChatGpt; page: Page; context: BrowserContext; driver: ChatGptWebDriver }

export function fakeSite(): { site(all?: FakeOptions & { timeouts?: DriverTimeouts }): Promise<Site> } {
  let browser: Browser | undefined
  let close: (() => Promise<void>) | undefined
  beforeAll(async () => {
    if (canRunBrowser) ({ browser, close } = await launchTestBrowser())
  })
  afterAll(async () => close?.())

  /** A fake site and a fresh context on it, with a driver in the instant preset; both stop when the test finishes. */
  async function site(all: FakeOptions & { timeouts?: DriverTimeouts } = {}): Promise<Site> {
    const { timeouts, ...options } = all
    const fake = new FakeChatGpt(options)
    await fake.start()
    const context = await browser!.newContext()
    onTestFinished(() => fake.stop())
    onTestFinished(() => context.close())
    const page = await context.newPage()
    const driver = new ChatGptWebDriver({
      origin: fake.origin, timeouts: { turnMs: 20_000, stallMs: 10_000, stableMs: 400, pollMs: 100, researchStartMs: 3000, ...timeouts },
      modes: { instant: { model: 'Latest', effort: 'Instant' }, deep: { model: 'GPT-6', effort: 'High' }, locked: { model: 'GPT-5.6 Sol', effort: 'Medium' }, missing: { model: 'GPT-9' } },
      defaultMode: 'instant',
    })
    return { fake, page, context, driver }
  }

  return { site }
}
