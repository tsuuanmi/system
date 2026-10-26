import type { DriftEvent } from '@tsuuanmi/system-ui-ops'
import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { GeminiWebDriver } from '../src/index.ts'
import { fakeSite, PRESETS, showTermsNotice, TIMEOUTS } from './site.ts'

/** The operator's step, as the runbook gives it (Account re-auth): never drift, never clicked. */
const NOTICE = { kind: 'challenge', disposition: 'USER_ACTION', message: 'gemini-web: a notice of updated terms ("Keep in mind") covers the input; system never acknowledges it: press the notice\'s own button in the login profile (system account login), then Save' }

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

  it('fails an answer that is the site\'s own error before anything judges it, marked as the site\'s error, and reads a longer answer about errors as an answer (live 2026-10-17, ADR-0062)', async () => {
    const { page, driver, fake } = await open({ answer: 'I seem to be encountering an error. Can I try something else for you?' })
    await expect(driver.ask(page, 'hello', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'overloaded', siteError: true, message: expect.stringMatching(/the site answered with its own error instead of an answer \("I seem to be encountering an error/) })
    expect(fake.sent).toHaveLength(1)
    // Live 2026-10-24, a team member's first turn: the error T125 found.
    fake.options.answer = 'Sorry, something went wrong. Please try your request again.'
    await expect(driver.ask(page, 'again', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'overloaded', siteError: true })
    fake.options.answer = `Something went wrong in the build: ${'the cache was stale, so the step ran twice. '.repeat(10)}`
    expect((await driver.ask(page, 'why?', { conversation: 'temporary' })).text).toMatch(/^Something went wrong in the build/)
  })

  it('stops at a terms notice over the input as a challenge for the operator, at once, never clicking it and with nothing sent (live 2026-10-17)', async () => {
    const { page, driver, fake } = await open({ termsNotice: true })
    await expect(driver.checkAuth(page)).rejects.toMatchObject(NOTICE)
    const started = Date.now()
    // Not the wait for a textbox it covers (readyMs here is 5 s), nor a mode switch it hides.
    await expect(driver.ask(page, 'hello', { conversation: 'temporary', mode: 'pro' })).rejects.toMatchObject(NOTICE)
    expect(Date.now() - started).toBeLessThan(4000)
    expect(fake.sent).toEqual([])
    expect(await page.locator('gem-banner').count()).toBe(1)
  })

  it('stops at a terms notice whose page shows no account at once, as a challenge, never as drift after the readiness bound (live 2026-10-16: "Keep in mind" up, the account unresolved)', async () => {
    const { page, fake } = await open({ termsNotice: true, accountHidden: true })
    // Bounds long enough that waiting either one out would show.
    const driver = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { ...TIMEOUTS, readyMs: 30_000, accountMs: 15_000 } })
    const drifts: DriftEvent[] = []
    driver.onDrift = (event) => void drifts.push(event)
    const started = Date.now()
    await expect(driver.checkAuth(page)).rejects.toMatchObject(NOTICE)
    await expect(driver.ask(page, 'hello', { conversation: 'persistent' })).rejects.toMatchObject(NOTICE)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(drifts).toEqual([])
    expect(fake.sent).toEqual([])
    expect(await page.locator('gem-banner').count()).toBe(1)
  })

  it('stops at a terms notice that shows mid-session on a kept page as a challenge, never as drift, sending nothing more and never clicking it', async () => {
    const { page, driver, fake } = await open({ startOnSpark: false, answer: 'first' })
    const drifts: DriftEvent[] = []
    driver.onDrift = (event) => void drifts.push(event)
    const first = await driver.ask(page, 'one', { conversation: 'persistent' })
    const loads = fake.pageLoads.length
    // Over the input of the page the session keeps, its account hidden with it, as on 2026-10-16.
    await showTermsNotice(page, { hideAccount: true })
    await expect(driver.ask(page, 'two', { conversation: 'persistent', binding: first.binding! })).rejects.toMatchObject(NOTICE)
    // What the turn runtime checks on a page whose turn failed there (a drift, a stall): the notice, so the failure becomes the operator's.
    await expect(driver.checkAuth(page)).rejects.toMatchObject(NOTICE)
    expect(fake.sent).toHaveLength(1)
    expect(fake.pageLoads.length).toBe(loads)
    expect(drifts).toEqual([])
    expect(await page.locator('gem-banner').count()).toBe(1)
  })

  it('gives a rendered app\'s account a short bound, not the whole readiness bound, and outlines it with what each candidate found and where the page was (live 2026-10-24)', async () => {
    const { page, driver: first, fake } = await open({ startOnSpark: false, answer: 'first' })
    const { binding } = await first.ask(page, 'one', { conversation: 'persistent' })
    // The account's button is still in the page, hidden; the site no longer has the conversation and sends its page to /app.
    fake.options.accountHidden = true
    fake.conversations.delete(binding!)
    const driver = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { ...TIMEOUTS, readyMs: 30_000, accountMs: 1500 } })
    const drifts: DriftEvent[] = []
    driver.onDrift = (event) => void drifts.push(event)
    const fresh = await page.context().newPage()
    const started = Date.now()
    await expect(driver.ask(fresh, 'two', { conversation: 'persistent', binding: binding! })).rejects.toMatchObject({
      kind: 'ui_drift', disposition: 'CONFIG_FIX',
      message: `gemini-web: the app rendered, but neither the signed-in account nor a sign-in page showed within 1.5 s; its account button is on the page but hidden; the page is at /app, not conversation ${binding} (outlined as a ui.drift of auth.account)`,
    })
    expect(Date.now() - started).toBeLessThan(15_000)
    // The account's link is found and not shown; nothing has its name as a button.
    expect(drifts).toEqual([expect.objectContaining({ element: 'auth.account', kind: 'unresolved', url: '/app', matches: [{ found: 1, shown: 0 }, { found: 0, shown: 0 }] })])
    expect(fake.sent).toHaveLength(1)
  })

  it('masks the account in that outline though the page hides its button: the name is read from the hidden button', async () => {
    const { page, fake } = await open({ accountHidden: true })
    const driver = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { ...TIMEOUTS, accountMs: 500 } })
    const drifts: DriftEvent[] = []
    driver.onDrift = (event) => void drifts.push(event)
    await page.goto(`${fake.origin}/app`)
    await page.evaluate(() => document.querySelector('nav')!.insertAdjacentHTML('beforeend', '<button class="settings" aria-label="Settings for Test User">s</button>'))
    expect(await driver.checkAuth(page)).toBe('unknown')
    expect(drifts[0]!.outline!.nodes.map((n) => n.label)).toContain('[redacted]')
    expect(JSON.stringify(drifts[0]!.outline)).not.toMatch(/Test User|test@example/)
  })

  it('reads the account for a Save from its hidden button, by the map\'s own candidates, while a turn still needs it shown (live 2026-10-26)', async () => {
    const { page, fake } = await open({ accountHidden: 'button' })
    const driver = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { ...TIMEOUTS, readyMs: 1500, accountMs: 500 } })
    const drifts: DriftEvent[] = []
    driver.onDrift = (event) => void drifts.push(event)
    await page.goto(`${fake.origin}/app`)
    expect(await driver.checkAuth(page, { save: true })).toBe('signed-in')
    expect(await driver.identity(page)).toBe('Test User (test@example.test)')
    expect(drifts).toEqual([])
    // A button the page hides that is not the account's ("Google Account: …") names no one.
    await page.evaluate(() => {
      const button = document.querySelector('[aria-label^="Google Account:"]')!
      button.setAttribute('aria-label', 'Google Accounts help')
    })
    expect(await driver.checkAuth(page, { save: true })).toBe('unknown')
    // A turn's check is unchanged: a hidden button is drift there.
    await page.evaluate(() => document.querySelector('[aria-label="Google Accounts help"]')!.setAttribute('aria-label', 'Google Account: Test User (test@example.test)'))
    expect(await driver.checkAuth(page)).toBe('unknown')
  })

  it('names no one when two shown account buttons name different accounts: the hidden fallback is never read past them, nor past two hidden ones', async () => {
    const { page, fake } = await open()
    const driver = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { ...TIMEOUTS, readyMs: 1500, accountMs: 500 } })
    await page.goto(`${fake.origin}/app`)
    expect(await driver.identity(page)).toBe('Test User (test@example.test)')
    // A second shown link naming another account, and a hidden one naming the first: ambiguous, never the hidden one's or the first shown one's.
    await page.evaluate(() => document.querySelector('header')!.insertAdjacentHTML('beforeend', '<a href="#" aria-label="Google Account: Other User (other@example.test)">O</a><a href="#" aria-label="Google Account: Test User (test@example.test)" hidden>T</a>'))
    const saving = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { ...TIMEOUTS, readyMs: 1500, accountMs: 500 } })
    const drifts: DriftEvent[] = []
    saving.onDrift = (event) => void drifts.push(event)
    await expect(saving.identity(page)).rejects.toMatchObject({ kind: 'ui_drift', message: expect.stringMatching(/exactly one account/) })
    expect(drifts).toEqual([expect.objectContaining({ element: 'auth.account', kind: 'unresolved', matches: [{ found: 3, shown: 2 }, { found: 0, shown: 0 }] })])
    expect(await saving.checkAuth(page, { save: true })).toBe('unknown')
    // All hidden, naming two accounts: no one either.
    await page.evaluate(() => { for (const link of document.querySelectorAll('header a')) link.setAttribute('hidden', '') })
    await expect(saving.identity(page)).rejects.toMatchObject({ kind: 'ui_drift' })
    expect(await saving.checkAuth(page, { save: true })).toBe('unknown')
    // Hidden and naming one account only (the other removed): that account.
    await page.evaluate(() => document.querySelector('[aria-label^="Google Account: Other"]')!.remove())
    expect(await saving.identity(page)).toBe('Test User (test@example.test)')
  })

  it('masks every account the buttons name in a drift outline, though they are ambiguous and name no one', async () => {
    const { page, fake } = await open({ accountHidden: true })
    await page.goto(`${fake.origin}/app`)
    await page.evaluate(() => {
      document.querySelector('header')!.insertAdjacentHTML('beforeend', '<a href="#" aria-label="Google Account: Other User (other@example.test)" hidden>O</a>')
      document.querySelector('header')!.insertAdjacentHTML('afterend', '<div><button class="settings first" aria-label="Settings for Test User">s</button><button class="settings second" aria-label="Settings for Other User">s</button></div>')
    })
    const driver = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { ...TIMEOUTS, readyMs: 1500, accountMs: 500 } })
    const drifts: DriftEvent[] = []
    driver.onDrift = (event) => void drifts.push(event)
    await expect(driver.identity(page)).rejects.toMatchObject({ kind: 'ui_drift' })
    expect(drifts).toEqual([expect.objectContaining({ element: 'auth.account', kind: 'unresolved', matches: [{ found: 2, shown: 0 }, { found: 0, shown: 0 }] })])
    // Both settings buttons are in the outline (unlike classes, so not folded into one), masked.
    expect(drifts[0]!.outline!.nodes.filter((n) => n.classes?.includes('settings')).map((n) => n.label)).toEqual(['[redacted]', '[redacted]'])
    expect(JSON.stringify(drifts[0]!.outline)).not.toMatch(/Test User|Other User|example\.test/)
  })

  it('saves an account whose button is hidden beside a "Sign in" offer, and is signed out with the offer and no account', async () => {
    const { page, fake } = await open({ accountHidden: 'button', signInOffer: true })
    const driver = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { ...TIMEOUTS, readyMs: 1500, accountMs: 500 } })
    const drifts: DriftEvent[] = []
    driver.onDrift = (event) => void drifts.push(event)
    await page.goto(`${fake.origin}/app`)
    expect(await driver.checkAuth(page, { save: true })).toBe('signed-in')
    expect(await driver.identity(page)).toBe('Test User (test@example.test)')
    // No drift of the account (the fake's "Sign in" is a button, the map's second candidate of auth.login: a fallback).
    expect(drifts.filter((event) => event.element === 'auth.account')).toEqual([])
    // A turn's check is unchanged: the offer with no account shown is signed out.
    expect(await driver.checkAuth(page)).toBe('signed-out')
    // With no account named at all, the offer is a signed-out page for a Save too.
    await page.evaluate(() => document.querySelector('[aria-label^="Google Account:"]')!.remove())
    expect(await driver.checkAuth(page, { save: true })).toBe('signed-out')
  })

  it('fails the identity as drift, outlined, when the page names no account, shown or hidden; a Save\'s sign-in check is unknown', async () => {
    const { page, fake } = await open({ accountMissing: true })
    const driver = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { ...TIMEOUTS, readyMs: 1500, accountMs: 500 } })
    const drifts: DriftEvent[] = []
    driver.onDrift = (event) => void drifts.push(event)
    await page.goto(`${fake.origin}/app`)
    expect(await driver.checkAuth(page, { save: true })).toBe('unknown')
    expect(drifts).toEqual([expect.objectContaining({ element: 'auth.account', kind: 'unresolved', matches: [{ found: 0, shown: 0 }, { found: 0, shown: 0 }] })])
    // The identity on its own, with a driver of its own (a driver reports one element's drift once per page).
    const saving = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { ...TIMEOUTS, readyMs: 1500, accountMs: 500 } })
    const identityDrifts: DriftEvent[] = []
    saving.onDrift = (event) => void identityDrifts.push(event)
    await expect(saving.identity(page)).rejects.toMatchObject({ kind: 'ui_drift', message: expect.stringMatching(/shown or hidden/) })
    expect(identityDrifts).toEqual([expect.objectContaining({ element: 'auth.account', kind: 'unresolved', matches: [{ found: 0, shown: 0 }, { found: 0, shown: 0 }] })])
  })

  it('fails a page that shows neither signed in nor signed out once, as drift, never as a session to retry', async () => {
    const { page, fake } = await open({ interstitial: true })
    const driver = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { readyMs: 1500 } })
    await expect(driver.ask(page, 'hello', { conversation: 'temporary' })).rejects.toMatchObject({
      kind: 'ui_drift', disposition: 'CONFIG_FIX',
      message: 'gemini-web: the page showed neither the app, the signed-in account, nor a sign-in page within 1.5 s; a dialog or menu is open (outlined as a ui.drift of auth.account)',
    })
    expect(fake.sent).toEqual([])
  })

  it('is signed in with a "Sign in" offer beside the account\'s own button, and signed out only without it', async () => {
    const { page, driver, fake } = await open({ signInOffer: true, answer: 'still here' })
    expect(await driver.checkAuth(page)).toBe('signed-in')
    expect((await driver.ask(page, 'hi', { conversation: 'temporary' })).text).toBe('still here')
    expect(fake.sent).toHaveLength(1)
  })
})
