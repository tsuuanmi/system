import { describe, expect, it } from 'vitest'
import { MAX_KEPT_TABS } from '../src/profiles.ts'
import { canRunBrowser } from './support.ts'
import { boot, capture, origin, pool, profileStack, signedInProfile } from './profile-stack.ts'

describe.runIf(canRunBrowser)('pool(ctx) profile turns: their pacing, the browsers kept open, and kept tabs (PROP-0007, ADR-0030)', () => {
  profileStack()

  it('spaces the page opens of one account by the gap, and captures a held profile in place', async () => {
    const ctx = await boot()
    const dir = await signedInProfile()
    // The gap counts from the moment the first open was granted, which is after this read and before it returns.
    const asked = Date.now()
    const first = await pool(ctx).openTurn('acct', { profile: { dir, gapMs: 1500 } })
    const second = await pool(ctx).openTurn('acct', { profile: { dir, gapMs: 1500 } })
    expect(Date.now() - asked).toBeGreaterThanOrEqual(1500)
    await Promise.all([first.close(), second.close()])
    expect((await capture(ctx, dir)).result).toBe('signed in')
    // Used in place: the profile stays held for the account's next turn.
    expect(pool(ctx).openAccounts()).toEqual(['acct'])
  }, 90_000)

  it('spaces page opens across the accounts of one pace group (PROP-0007)', async () => {
    const ctx = await boot()
    const [a, b] = [await signedInProfile(), await signedInProfile()]
    // Both profiles launched first, so what is timed below is the spacing, not a browser start.
    for (const [account, dir] of [['acct-a', a], ['acct-b', b]] as const) await (await pool(ctx).openTurn(account, { profile: { dir, gapMs: 0 } })).close()
    const pace = { key: 'site-1', gapMs: 1500 }
    const asked = Date.now()
    const first = await pool(ctx).openTurn('acct-a', { profile: { dir: a, gapMs: 0, pace } })
    // Another account of the same site waits the group's gap, though its own gap is 0.
    const second = await pool(ctx).openTurn('acct-b', { profile: { dir: b, gapMs: 0, pace } })
    expect(Date.now() - asked).toBeGreaterThanOrEqual(1500)
    await Promise.all([first.close(), second.close()])
  }, 120_000)

  it('keeps account browsers under maxBrowsers: the longest-idle one closes for a new one, and with all busy the new one waits (PROP-0007)', async () => {
    const ctx = await boot({ maxBrowsers: 2 })
    const [a, b, c] = [await signedInProfile(), await signedInProfile(), await signedInProfile()]
    const busy = await pool(ctx).openTurn('acct-a', { profile: { dir: a } })
    await (await pool(ctx).openTurn('acct-b', { profile: { dir: b } })).close()
    // acct-b holds no turn, so it closes to make room; acct-a, busy, stays.
    const third = await pool(ctx).openTurn('acct-c', { profile: { dir: c } })
    expect(pool(ctx).openAccounts().sort()).toEqual(['acct-a', 'acct-c'])
    // Both busy: a fourth waits until one frees.
    let opened = false
    const waiting = pool(ctx).openTurn('acct-b', { profile: { dir: b } }).then((turn) => {
      opened = true
      return turn
    })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(opened).toBe(false)
    await third.close()
    const fourth = await waiting
    expect(pool(ctx).openAccounts().sort()).toEqual(['acct-a', 'acct-b'])
    await Promise.all([busy.close(), fourth.close()])
  }, 180_000)

  describe('kept tabs: a session\'s page between its turns (ADR-0030)', () => {
    it('keeps a session\'s page on close and hands it back, in front, with no new page and no pacing; discard closes it for good', async () => {
      const ctx = await boot()
      const dir = await signedInProfile()
      const first = await pool(ctx).openTurn('acct', { profile: { dir, gapMs: 5000, keep: 'ses_a' } })
      expect(first.reused).toBe(false)
      await first.page.goto(`${origin}/`)
      await first.close()
      expect(first.page.isClosed()).toBe(false)
      expect(pool(ctx).profileStates()).toEqual([{ account: 'acct', open: true, pages: 0, kept: 1, reserved: false }])
      const started = Date.now()
      const again = await pool(ctx).openTurn('acct', { profile: { dir, gapMs: 5000, keep: 'ses_a' } })
      expect(Date.now() - started).toBeLessThan(2000)
      expect(again.reused).toBe(true)
      expect(again.page).toBe(first.page)
      expect(again.page.url()).toBe(`${origin}/`)
      expect(await again.page.evaluate(() => document.visibilityState)).toBe('visible')
      await again.discard!()
      expect(again.page.isClosed()).toBe(true)
      expect(pool(ctx).profileStates()).toEqual([{ account: 'acct', open: true, pages: 0, kept: 0, reserved: false }])
    }, 90_000)

    it('keeps at most MAX_KEPT_TABS per account, closing the least recently used; a session\'s end closes its tab', async () => {
      const ctx = await boot()
      const dir = await signedInProfile()
      const pages = []
      for (const key of ['s1', 's2', 's3', 's4', 's5']) {
        const turn = await pool(ctx).openTurn('acct', { profile: { dir, keep: key } })
        pages.push(turn.page)
        await turn.close()
      }
      expect(MAX_KEPT_TABS).toBe(4)
      expect(pool(ctx).profileStates()[0]).toMatchObject({ kept: 4 })
      expect(pages[0]!.isClosed()).toBe(true)
      expect(pages.slice(1).every((p) => !p.isClosed())).toBe(true)
      await pool(ctx).discardTab('acct', 's3')
      expect(pages[2]!.isClosed()).toBe(true)
      expect(pool(ctx).profileStates()[0]).toMatchObject({ kept: 3 })
      // A kept tab the browser closes on its own is forgotten.
      await pages[1]!.close()
      expect(pool(ctx).profileStates()[0]).toMatchObject({ kept: 2 })
    }, 90_000)

    it('never lets kept tabs refuse the operator: a reservation closes them with the context', async () => {
      const ctx = await boot()
      const dir = await signedInProfile()
      const turn = await pool(ctx).openTurn('acct', { profile: { dir, keep: 's1' } })
      await turn.close()
      const release = await pool(ctx).reserveProfile('acct', dir)
      expect(turn.page.isClosed()).toBe(true)
      expect(pool(ctx).profileStates()).toEqual([{ account: 'acct', open: false, pages: 0, kept: 0, reserved: true }])
      release()
      const fresh = await pool(ctx).openTurn('acct', { profile: { dir, keep: 's1' } })
      expect(fresh.reused).toBe(false)
      await fresh.discard!()
    }, 90_000)
  })
})
