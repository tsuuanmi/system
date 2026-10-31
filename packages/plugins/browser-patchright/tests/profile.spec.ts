import { symlinkSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { profileUsers } from '../src/profiles.ts'
import { canRunBrowser, scaled } from './support.ts'
import { boot, capture, gone, origin, pool, profileStack, reads, running, signedInProfile, squatter } from './profile-stack.ts'

describe.runIf(canRunBrowser)('pool(ctx).captureProfile (the Save flow)', () => {
  profileStack()

  it('reopens the login profile invisibly and captures state for the origins only, in memory', async () => {
    const ctx = await boot()
    const dir = await signedInProfile()
    const { state, result } = await capture(ctx, dir)
    expect(result).toBe('signed in')
    expect(state.cookies).toEqual([expect.objectContaining({ name: 'session', value: 'valid' })])
    expect(state.origins).toEqual([origin])
  }, scaled(60_000))

  it('refuses a profile a live browser holds, and takes a lock whose pid runs no browser on it as stale (a reused pid)', async () => {
    const ctx = await boot()
    const dir = await signedInProfile()
    const browser = squatter(dir)
    await expect(capture(ctx, dir)).rejects.toMatchObject({ kind: 'session_broken', message: expect.stringMatching(/in use by process/) })
    expect(running(browser)).toBe(true)
    browser.kill('SIGKILL')
    await gone(browser)
    // A live pid, but not a browser on this profile: the lock is a leftover.
    symlinkSync(`${hostname()}-${process.pid}`, join(dir, 'SingletonLock'))
    await expect(capture(ctx, dir)).resolves.toMatchObject({ result: 'signed in' })
  }, scaled(90_000))

  it('runs one Save per account at a time, so two never open the profile together', async () => {
    const ctx = await boot()
    const dir = await signedInProfile()
    const both = await Promise.all([capture(ctx, dir), capture(ctx, dir)])
    expect(both.map((b) => b.result)).toEqual(['signed in', 'signed in'])
  }, scaled(90_000))

  describe('profile turns (a session-bound account, ADR-0030)', () => {
    it('opens each turn as a page of one persistent context on the login profile, and closes only the page (REQ-ACC-4)', async () => {
      const ctx = await boot()
      const dir = await signedInProfile()
      const a = await pool(ctx).openTurn('acct', { profile: { dir } })
      const b = await pool(ctx).openTurn('acct', { profile: { dir } })
      expect(b.context).toBe(a.context)
      await a.page.goto(`${origin}/`)
      // The operator's sign-in, from the profile itself: no portable state was given.
      expect(await reads(a.page)).toBe('signed in')
      await a.context.addCookies([{ name: 'seen', value: 'by-a', url: origin }])
      await b.page.goto(`${origin}/`)
      expect(await b.page.evaluate(() => document.cookie)).toContain('seen=by-a')
      await a.close()
      expect(a.page.isClosed()).toBe(true)
      expect(b.page.isClosed()).toBe(false)
      expect(pool(ctx).openAccounts()).toEqual(['acct'])
      expect(pool(ctx).profileStates()).toEqual([{ account: 'acct', open: true, pages: 1, kept: 0, reserved: false }])
      // The real browser is seen on the profile, marked as system's; its children carry no mark.
      expect(profileUsers(dir).filter((u) => u.browser)).toEqual([expect.objectContaining({ owned: true })])
      expect(profileUsers(dir).some((u) => !u.browser && !u.owned)).toBe(true)
      await b.close()
      await pool(ctx).close('acct')
      expect(pool(ctx).openAccounts()).toEqual([])
      // Closing returned only once the browser and its children had exited.
      expect(profileUsers(dir)).toEqual([])
      // Closed, its browser has exited: the Save flow reopens the profile at once.
      await expect(capture(ctx, dir)).resolves.toMatchObject({ result: 'signed in' })
    }, scaled(90_000))

    it('reserves the profile for the operator: refused while a turn runs; once reserved, turns fail as overloaded until every reservation is released', async () => {
      const ctx = await boot()
      const dir = await signedInProfile()
      const turn = await pool(ctx).openTurn('acct', { profile: { dir } })
      await expect(pool(ctx).reserveProfile('acct', dir)).rejects.toMatchObject({ kind: 'overloaded', message: expect.stringMatching(/1 operation/) })
      await turn.close()
      const first = await pool(ctx).reserveProfile('acct', dir)
      // Closed for the operator's browser, and no turn opens it meanwhile.
      expect(pool(ctx).openAccounts()).toEqual([])
      expect(pool(ctx).profileStates()).toEqual([{ account: 'acct', open: false, pages: 0, kept: 0, reserved: true }])
      await expect(pool(ctx).openTurn('acct', { profile: { dir } })).rejects.toMatchObject({ kind: 'overloaded', disposition: 'BACKOFF' })
      // The Save that ends a remote login still reads the profile.
      await expect(capture(ctx, dir)).resolves.toMatchObject({ result: 'signed in' })
      // The operator's login browser, under the first reservation: a second one never stops it.
      const operator = squatter(dir)
      const second = await pool(ctx).reserveProfile('acct', dir)
      expect(running(operator)).toBe(true)
      operator.kill('SIGKILL')
      await gone(operator)
      first()
      first()
      await expect(pool(ctx).openTurn('acct', { profile: { dir } })).rejects.toMatchObject({ kind: 'overloaded' })
      second()
      const again = await pool(ctx).openTurn('acct', { profile: { dir } })
      await again.close()
    }, scaled(90_000))

    it('stops a browser a crashed host left on the profile when the operator reserves it', async () => {
      const ctx = await boot()
      const dir = await signedInProfile()
      const orphan = squatter(dir, { owned: true })
      const release = await pool(ctx).reserveProfile('acct', dir)
      await gone(orphan)
      release()
    }, scaled(90_000))
  })
})
