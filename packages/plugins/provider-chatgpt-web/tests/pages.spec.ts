import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { ChatGptWebDriver } from '../src/index.ts'
import { fakeSite } from './site.ts'

describe.runIf(canRunBrowser)('ChatGptWebDriver against the fake site, with no real account (QA-10): sign-in, challenges, and the site\'s own pages', () => {
  const { site } = fakeSite()

  it('stops at a challenge page as a challenge, at once and with nothing sent', async () => {
    const { page, driver, fake } = await site({ captcha: true })
    const started = Date.now()
    await expect(driver.checkAuth(page)).rejects.toMatchObject({ kind: 'challenge', disposition: 'USER_ACTION', message: expect.stringMatching(/Verify you are human/) })
    expect(Date.now() - started).toBeLessThan(20_000)
    await expect(driver.ask(page, 'hello', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'challenge' })
    expect(fake.sent).toEqual([])
  }, 60_000)

  it('loads the site\'s own error page once more before anything is typed, and fails a second one as transient, unsent (live 2026-10-17)', async () => {
    const { page, driver, fake } = await site({ errorPages: 1, timeouts: { readyMs: 5000 } })
    const drifts: unknown[] = []
    driver.onDrift = (event) => void drifts.push(event)
    expect((await driver.ask(page, 'ping', { conversation: 'temporary' })).text).toBe('OK')
    expect(fake.errorPagesShown).toBe(1)
    expect(fake.sent).toHaveLength(1)
    // Twice in a row: transient, and nothing sent; never drift.
    fake.options.errorPages = 3
    const started = Date.now()
    await expect(driver.ask(page, 'again', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'overloaded', disposition: 'BACKOFF', message: expect.stringMatching(/its own error page/) })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(fake.errorPagesShown).toBe(3)
    expect(fake.sent).toHaveLength(1)
    // A sign-in check never reloads: it reports the error page as it is.
    fake.options.errorPages = 4
    await page.goto(`${fake.origin}/`)
    await expect(driver.checkAuth(page)).rejects.toMatchObject({ kind: 'overloaded' })
    expect(drifts).toEqual([])
  }, 60_000)

  it('outlines a page that shows neither signed in nor signed out, and fails it once as drift, never as a session to retry', async () => {
    const { page, fake } = await site({ interstitial: true })
    const driver = new ChatGptWebDriver({ origin: fake.origin, timeouts: { readyMs: 1500 }, modes: { instant: { model: 'Latest', effort: 'Instant' } }, defaultMode: 'instant' })
    const drifts: Array<{ element: string; kind: string; outline?: { nodes: Array<{ role?: string }> } }> = []
    driver.onDrift = (event) => void drifts.push(event as never)
    expect(await driver.checkAuth(page)).toBe('unknown')
    expect(drifts).toEqual([expect.objectContaining({ element: 'composer.input', kind: 'unresolved' })])
    expect(drifts[0]!.outline!.nodes.some((n) => n.role === 'dialog')).toBe(true)
    await expect(driver.ask(page, 'hello', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'ui_drift', disposition: 'CONFIG_FIX' })
    expect(fake.sent).toEqual([])
  }, 60_000)

  it('reports signed-in and signed-out with positive evidence', async () => {
    const a = await site()
    expect(await a.driver.checkAuth(a.page)).toBe('signed-in')
    const b = await site({ signedIn: false })
    expect(await b.driver.checkAuth(b.page)).toBe('signed-out')
  }, 30_000)

  it('reads the logged-out home as signed out, so the turn fails as reauth_required, not drift', async () => {
    const { page, driver, fake } = await site({ loggedOutHome: true })
    const drifts: unknown[] = []
    driver.onDrift = (event) => void drifts.push(event)
    expect(await driver.checkAuth(page)).toBe('signed-out')
    await expect(driver.ask(page, 'hello', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'reauth_required' })
    expect(drifts).toEqual([])
    expect(fake.sent).toEqual([])
  }, 60_000)

  it('counts the logged-out marks only while visible, and never beside a working composer', async () => {
    const hidden = await site({ loggedOutHome: true, timeouts: { readyMs: 1500 } })
    await hidden.page.goto(`${hidden.fake.origin}/`)
    await hidden.page.evaluate(() => document.querySelectorAll('[data-login-button], form[data-logged-out]').forEach((e) => e.setAttribute('hidden', '')))
    expect(await hidden.driver.checkAuth(hidden.page)).toBe('unknown')
    // A signed-in app showing a sign-in button (an offer to switch accounts) stays signed in.
    const offer = await site({ loginOffer: true })
    await offer.page.goto(`${offer.fake.origin}/`)
    expect(await offer.page.locator('[data-login-button]').isVisible()).toBe(true)
    expect(await offer.driver.checkAuth(offer.page)).toBe('signed-in')
  }, 60_000)

  it('holds a logged-out home verdict: a signed-in app that paints that shell first stays signed in', async () => {
    const { page, driver, fake } = await site({ logoutFlashMs: 1000 })
    await page.goto(`${fake.origin}/`)
    expect(await page.locator('form[data-logged-out]').isVisible()).toBe(true)
    expect(await driver.checkAuth(page)).toBe('signed-in')
    expect((await driver.ask(page, 'hello', { conversation: 'temporary' })).text).toBe('OK')
  }, 60_000)

  it('refuses to send on an account without a model picker, assuming no mode (PROP-0004: no ChatGPT Free)', async () => {
    const { fake, page, driver } = await site({ answer: 'free answer', modelPicker: false })
    const error = await driver.ask(page, 'hello', { conversation: 'temporary' }).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'ui_drift' })
    expect(fake.sent).toEqual([])
  }, 60_000)

  it('is signed in with a "Log in" offer beside a working composer', async () => {
    const { fake, page, driver } = await site({ loginOffer: true, answer: 'still here' })
    expect(await driver.checkAuth(page)).toBe('signed-in')
    expect((await driver.ask(page, 'hi', { conversation: 'temporary' })).text).toBe('still here')
    expect(fake.sent).toHaveLength(1)
  }, 40_000)

  it('fails closed as reauth_required when signed out', async () => {
    const { fake, page, driver } = await site({ signedIn: false })
    await expect(driver.ask(page, 'x', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'reauth_required' })
    expect(fake.sent).toEqual([])
  }, 30_000)
})
