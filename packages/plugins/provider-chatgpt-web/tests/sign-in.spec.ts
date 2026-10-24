import { Secret, TOTP } from 'otpauth'
import type { Browser } from 'patchright-core'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { canRunBrowser, launchTestBrowser } from '../../browser-patchright/tests/support.ts'
import { FakeChatGpt, type FakeOptions } from '../fixtures/fake-chatgpt.ts'
import { ChatGptWebDriver } from '../src/index.ts'

const credentials = { email: 'operator@example.test', password: 'correct horse' }
const totp = (secret: string) => new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate()

describe.runIf(canRunBrowser)('credential sign-in (driver.signIn, against the fake auth flow)', () => {
  let browser: Browser
  let close: () => Promise<void>
  beforeAll(async () => {
    ;({ browser, close } = await launchTestBrowser())
  })
  afterAll(async () => close())

  async function signedOut(options: FakeOptions) {
    const fake = new FakeChatGpt({ requireCookie: true, ...options })
    await fake.start()
    const context = await browser.newContext()
    onTestFinished(() => fake.stop())
    onTestFinished(() => context.close())
    const page = await context.newPage()
    const driver = new ChatGptWebDriver({ origin: fake.origin, timeouts: { readyMs: 5000 } })
    expect(await driver.checkAuth(page)).toBe('signed-out')
    return { fake, page, driver }
  }

  it('signs in with email, password, and a locally computed TOTP code', async () => {
    const { page, driver, fake } = await signedOut({ mfa: 'totp' })
    const asked: string[] = []
    await driver.signIn(page, credentials, async (kind) => { asked.push(kind); return totp(fake.options.totpSecret) })
    expect(asked).toEqual(['totp'])
    expect(await driver.checkAuth(page)).toBe('signed-in')
  }, 60_000)

  it('switches from a push prompt to the authenticator app', async () => {
    const { page, driver, fake } = await signedOut({ mfa: 'push-first' })
    await driver.signIn(page, credentials, async () => totp(fake.options.totpSecret))
    expect(await driver.checkAuth(page)).toBe('signed-in')
  }, 60_000)

  it('uses the email code provider for an emailed code', async () => {
    const { page, driver } = await signedOut({ mfa: 'email-code' })
    const asked: string[] = []
    await driver.signIn(page, credentials, async (kind) => { asked.push(kind); return '424242' })
    expect(asked).toEqual(['email'])
    expect(await driver.checkAuth(page)).toBe('signed-in')
  }, 60_000)

  it('stops at a challenge and never tries to solve it', async () => {
    const { page, driver } = await signedOut({ mfa: 'challenge' })
    await expect(driver.signIn(page, credentials, async () => '000000')).rejects.toMatchObject({ kind: 'challenge' })
  }, 60_000)

  it('gives up after two wrong codes, without locking the account', async () => {
    const { page, driver, fake } = await signedOut({ mfa: 'totp' })
    await expect(driver.signIn(page, credentials, async () => '000000')).rejects.toMatchObject({ kind: 'reauth_required' })
    expect(fake.codeAttempts).toHaveLength(2)
  }, 60_000)
})
