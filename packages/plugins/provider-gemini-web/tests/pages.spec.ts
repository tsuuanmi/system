import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { GeminiWebDriver } from '../src/index.ts'
import { fakeSite, PRESETS } from './site.ts'

describe.runIf(canRunBrowser)('GeminiWebDriver against the fake site: sign-in, challenges, and the site\'s own pages', { timeout: 60_000 }, () => {
  const { open } = fakeSite()

  it('outlines a page that shows neither signed in nor signed out, as drift evidence, and reports it unknown', async () => {
    const { page, fake } = await open({ interstitial: true })
    const driver = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { readyMs: 1500 } })
    const drifts: Array<{ element: string; outline?: { nodes: Array<{ role?: string }> } }> = []
    driver.onDrift = (event) => void drifts.push(event as never)
    expect(await driver.checkAuth(page)).toBe('unknown')
    expect(drifts).toEqual([expect.objectContaining({ element: 'auth.account', kind: 'unresolved' })])
    expect(drifts[0]!.outline!.nodes.some((n) => n.role === 'dialog')).toBe(true)
  })

  it('stops at Google\'s unusual-traffic check as a challenge, at once and with nothing sent (live 2026-10-16)', async () => {
    const { page, driver, fake } = await open({ captcha: true })
    const started = Date.now()
    await expect(driver.checkAuth(page)).rejects.toMatchObject({ kind: 'challenge', disposition: 'USER_ACTION', message: expect.stringMatching(/unusual-traffic check/) })
    // Not the 60 s a page that never becomes ready waits.
    expect(Date.now() - started).toBeLessThan(20_000)
    await expect(driver.ask(page, 'hello', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'challenge' })
    expect(fake.sent).toEqual([])
  })

  it('fails an answer that is the site\'s own error before anything judges it, and reads a longer answer about errors as an answer (live 2026-10-17)', async () => {
    const { page, driver, fake } = await open({ answer: 'I seem to be encountering an error. Can I try something else for you?' })
    await expect(driver.ask(page, 'hello', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'overloaded', message: expect.stringMatching(/the site answered with its own error instead of an answer \("I seem to be encountering an error/) })
    expect(fake.sent).toHaveLength(1)
    fake.options.answer = `Something went wrong in the build: ${'the cache was stale, so the step ran twice. '.repeat(10)}`
    expect((await driver.ask(page, 'why?', { conversation: 'temporary' })).text).toMatch(/^Something went wrong in the build/)
  })

  it('stops at a terms notice over the input as a challenge for the operator, at once, never clicking it and with nothing sent (live 2026-10-17)', async () => {
    const { page, driver, fake } = await open({ termsNotice: true })
    const notice = { kind: 'challenge', disposition: 'USER_ACTION', message: 'gemini-web: the site shows a terms notice over the input; acknowledge it in the login profile (system account login) and Save' }
    await expect(driver.checkAuth(page)).rejects.toMatchObject(notice)
    const started = Date.now()
    // Not the wait for a textbox it covers (readyMs here is 5 s), nor a mode switch it hides.
    await expect(driver.ask(page, 'hello', { conversation: 'temporary', mode: 'pro' })).rejects.toMatchObject(notice)
    expect(Date.now() - started).toBeLessThan(4000)
    expect(fake.sent).toEqual([])
    expect(await page.locator('gem-banner').count()).toBe(1)
  })

  it('fails a page that shows neither signed in nor signed out once, as drift, never as a session to retry', async () => {
    const { page, fake } = await open({ interstitial: true })
    const driver = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { readyMs: 1500 } })
    await expect(driver.ask(page, 'hello', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'ui_drift', disposition: 'CONFIG_FIX' })
    expect(fake.sent).toEqual([])
  })

  it('is signed in with a "Sign in" offer beside the account\'s own button, and signed out only without it', async () => {
    const { page, driver, fake } = await open({ signInOffer: true, answer: 'still here' })
    expect(await driver.checkAuth(page)).toBe('signed-in')
    expect((await driver.ask(page, 'hi', { conversation: 'temporary' })).text).toBe('still here')
    expect(fake.sent).toHaveLength(1)
  })
})
