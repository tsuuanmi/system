import { OWNED_PROFILE_SWITCH } from '@tsuuanmi/system-provider-core'
import { chromium } from 'patchright-core'
import { describe, expect, it } from 'vitest'
import { profileUsers } from '../src/profiles.ts'
import { canRunBrowser, scaled, testChrome } from './support.ts'
import { boot, gone, origin, pool, profileStack, reads, running, signedInProfile, squatter } from './profile-stack.ts'

describe.runIf(canRunBrowser)('pool(ctx) profile turns: a browser left on the login profile, and who stops it (ADR-0030)', () => {
  profileStack()

  it('stops a browser a crashed host left on the profile, then opens it', async () => {
    const ctx = await boot()
    const dir = await signedInProfile()
    const orphan = squatter(dir, { owned: true, stubborn: true })
    const turn = await pool(ctx).openTurn('acct', { profile: { dir } })
    await gone(orphan)
    await turn.page.goto(`${origin}/`)
    expect(await reads(turn.page)).toBe('signed in')
    await turn.close()
  }, scaled(90_000))

  it('stops a real Chrome system left on the profile, and never one it did not start', async () => {
    const ctx = await boot()
    const dir = await signedInProfile()
    const mine = await chromium.launchPersistentContext(dir, { executablePath: testChrome!, headless: true, args: [OWNED_PROFILE_SWITCH] })
    let stopped = false
    mine.once('close', () => void (stopped = true))
    const turn = await pool(ctx).openTurn('acct', { profile: { dir } })
    expect(stopped).toBe(true)
    await turn.close()
    await pool(ctx).close('acct')
    const theirs = await chromium.launchPersistentContext(dir, { executablePath: testChrome!, headless: true })
    try {
      await expect(pool(ctx).openTurn('acct', { profile: { dir } })).rejects.toMatchObject({ kind: 'overloaded', message: expect.stringMatching(/never stopped/) })
      const page = await theirs.newPage()
      await page.goto(`${origin}/`)
      expect(await reads(page)).toBe('signed in')
    } finally {
      await theirs.close()
    }
    const again = await pool(ctx).openTurn('acct', { profile: { dir } })
    await again.close()
  }, scaled(120_000))

  it('never stops a browser system did not start: it blocks the account until it closes, and health shows it', async () => {
    const ctx = await boot()
    const dir = await signedInProfile()
    const operator = squatter(dir)
    await expect(pool(ctx).openTurn('acct', { profile: { dir } })).rejects.toMatchObject({ kind: 'overloaded', message: expect.stringMatching(/not started by system, so it is never stopped: close that browser/) })
    await expect(pool(ctx).reserveProfile('acct', dir)).rejects.toMatchObject({ kind: 'overloaded' })
    expect(running(operator)).toBe(true)
    expect(pool(ctx).profileStates()).toEqual([expect.objectContaining({ account: 'acct', blocked: expect.stringMatching(/close that browser/) })])
    operator.kill('SIGKILL')
    await gone(operator)
    // Its process gone, the profile is free again.
    expect(pool(ctx).profileStates()).toEqual([])
    const turn = await pool(ctx).openTurn('acct', { profile: { dir } })
    await turn.close()
  }, scaled(90_000))

  it('waits for a closed profile\'s browser to exit, and stops one that will not before the profile counts as free', async () => {
    const ctx = await boot()
    const dir = await signedInProfile()
    const turn = await pool(ctx).openTurn('acct', { profile: { dir } })
    await turn.close()
    // A process of the closing browser that will not exit.
    const wedged = squatter(dir, { owned: true, stubborn: true })
    await pool(ctx).close('acct')
    await gone(wedged)
    expect(pool(ctx).profileStates()).toEqual([])
  }, scaled(90_000))

  it('ends a turn whose page close the browser never confirms within the bound, freeing its page; the tab closes with its context (INV-9, CI 2026-10-24)', async () => {
    const ctx = await boot()
    const dir = await signedInProfile()
    const turn = await pool(ctx).openTurn('acct', { profile: { dir } })
    // As Chrome does with a close that lands as the page's navigation commits: acknowledged, then dropped.
    turn.page.close = () => new Promise<void>(() => undefined)
    const started = Date.now()
    await turn.close()
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(pool(ctx).profileStates()).toEqual([{ account: 'acct', open: true, pages: 0, kept: 0, reserved: false }])
    expect(turn.page.isClosed()).toBe(false)
    await pool(ctx).close('acct')
    expect(turn.page.isClosed()).toBe(true)
    expect(profileUsers(dir)).toEqual([])
  }, scaled(90_000))
})
