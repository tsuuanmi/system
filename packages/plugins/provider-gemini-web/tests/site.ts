/**
 * The driver specs' fake Gemini site: the presets they ask with, and the file's one headed Chrome.
 * A spec file calls {@link fakeSite} once, at its top: it launches the browser in `beforeAll` and
 * closes it in `afterAll`, and each `open` starts a fake site and a browser context that are stopped
 * when their test finishes. The specs are split by theme, one file each, so they run side by side.
 */
import type { Browser, BrowserContext, Page } from 'patchright-core'
import { afterAll, beforeAll, onTestFinished } from 'vitest'
import { canRunBrowser, launchTestBrowser } from '../../browser-patchright/tests/support.ts'
import { FakeGemini, type FakeOptions, TERMS_NOTICE } from '../fixtures/fake-gemini.ts'
import { GeminiWebDriver } from '../src/index.ts'
import type { DriverOptions } from '../src/driver.ts'

export const PRESETS = { 'flash-lite': { model: 'Flash-Lite', effort: 'Low' }, flash: { model: 'Flash', effort: 'Medium' }, pro: { model: 'Pro', effort: 'High' }, site: {} }

/** The timeouts a test's driver uses unless it says otherwise. */
export const TIMEOUTS = { readyMs: 5000, stableMs: 300, pollMs: 100, turnMs: 30_000, stallMs: 15_000 }

export interface Opened { page: Page; driver: GeminiWebDriver; fake: FakeGemini; context: BrowserContext }

/**
 * The fake's terms notice shown on a page already open, over its input, as the site can show one
 * mid-session; with `hideAccount`, the account's button is hidden too (live 2026-10-16).
 */
export async function showTermsNotice(page: Page, options: { hideAccount?: boolean } = {}): Promise<void> {
  await page.evaluate(({ html, hideAccount }) => {
    document.querySelector('.input-area')!.insertAdjacentHTML('beforebegin', html)
    ;(document.querySelector('rich-textarea') as HTMLElement).hidden = true
    if (hideAccount) (document.querySelector('[aria-label^="Google Account:"]') as HTMLElement).hidden = true
  }, { html: TERMS_NOTICE, hideAccount: options.hideAccount ?? false })
}

export function fakeSite(): { open(options?: FakeOptions, driverOptions?: DriverOptions): Promise<Opened> } {
  let browser: Browser | undefined
  let close: (() => Promise<void>) | undefined
  beforeAll(async () => {
    if (canRunBrowser) ({ browser, close } = await launchTestBrowser())
  })
  afterAll(async () => close?.())

  /** A fake site and a fresh context on it, with a driver in the default preset; both stop when the test finishes. */
  async function open(options: FakeOptions = {}, driverOptions: DriverOptions = {}): Promise<Opened> {
    const fake = new FakeGemini(options)
    const origin = await fake.start()
    onTestFinished(() => fake.stop())
    const context = await browser!.newContext()
    onTestFinished(() => context.close())
    const page = await context.newPage()
    const driver = new GeminiWebDriver({ origin, modes: PRESETS, defaultMode: 'flash', timeouts: TIMEOUTS, ...driverOptions })
    return { page, driver, fake, context }
  }

  return { open }
}
