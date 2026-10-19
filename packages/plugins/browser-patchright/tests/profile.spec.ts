import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import VirtualDisplay from '@tsuuanmi/system-display-virtual'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { OWNED_PROFILE_SWITCH } from '@tsuuanmi/system-provider-core'
import BrowserPool from '../src/index.ts'
import { MAX_KEPT_TABS, profileUsers } from '../src/profiles.ts'
import { canRunBrowser, testChrome } from './support.ts'
import { chromium } from 'patchright-core'

/** These tests exercise the patchright provider itself, so they use its concrete page and context types. */
const pool = (ctx: Context): BrowserPool => ctx.browser as unknown as BrowserPool


describe.runIf(canRunBrowser)('pool(ctx).captureProfile (the Save flow)', () => {
  let server: Server
  let origin: string
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(`<!doctype html><p>${/session=valid/.test(req.headers.cookie ?? '') ? 'signed in' : 'signed out'}</p>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const dirs: string[] = []
  const fibers: Array<{ dispose(): Promise<void> }> = []
  afterEach(async () => {
    while (fibers.length) await fibers.pop()!.dispose()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function boot(): Promise<Context> {
    const ctx = new Context()
    const display = ctx.plugin(VirtualDisplay, {})
    await display
    const browser = ctx.plugin(BrowserPool, { chromePath: testChrome! })
    await browser
    fibers.push(display, browser)
    return ctx
  }

  /** A login profile where the operator has "signed in" (a persistent session cookie). */
  async function signedInProfile(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'system-profile-'))
    dirs.push(dir)
    const ctx = await chromium.launchPersistentContext(dir, { executablePath: testChrome!, headless: true })
    await ctx.addCookies([{ name: 'session', value: 'valid', url: origin, expires: Math.floor(Date.now() / 1000) + 3600 }])
    await ctx.close()
    return dir
  }

  /**
   * A process that runs "Chrome" on `dir` as far as the host can tell (its command line names the
   * profile). `owned`: one system started (a crashed host's browser, or one that will not exit);
   * otherwise one the operator opened. `stubborn` ignores SIGTERM.
   */
  function squatter(dir: string, options: { owned?: boolean; stubborn?: boolean } = {}): ChildProcess {
    const args = ['-e', `${options.stubborn ? "process.on('SIGTERM', () => {});" : ''}setInterval(() => {}, 1000)`, '--', `--user-data-dir=${dir}`, ...(options.owned ? [OWNED_PROFILE_SWITCH] : [])]
    const child = spawn(process.execPath, args, { stdio: 'ignore' })
    fibers.push({ dispose: async () => void child.kill('SIGKILL') })
    return child
  }
  /** Still running (a reaped or zombie process has no command line). */
  const running = (child: ChildProcess): boolean => {
    try {
      return readFileSync(`/proc/${child.pid}/cmdline`).length > 0
    } catch {
      return false
    }
  }
  const gone = (child: ChildProcess): Promise<unknown> => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve)))
  const reads = (page: { locator(s: string): { innerText(): Promise<string> } }): Promise<string> => page.locator('p').innerText()
  const capture = (ctx: Context, dir: string) => pool(ctx).captureProfile('acct', dir, { url: `${origin}/`, origins: [origin], inspect: (page) => reads(page) })

  it('reopens the login profile invisibly and captures state for the origins only, in memory', async () => {
    const ctx = await boot()
    const dir = await signedInProfile()
    const { state, result } = await capture(ctx, dir)
    expect(result).toBe('signed in')
    expect(state.cookies).toEqual([expect.objectContaining({ name: 'session', value: 'valid' })])
    expect(state.origins).toEqual([origin])
  }, 60_000)

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
  }, 90_000)

  it('runs one Save per account at a time, so two never open the profile together', async () => {
    const ctx = await boot()
    const dir = await signedInProfile()
    const both = await Promise.all([capture(ctx, dir), capture(ctx, dir)])
    expect(both.map((b) => b.result)).toEqual(['signed in', 'signed in'])
  }, 90_000)

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
    }, 90_000)

    it('stops a browser a crashed host left on the profile, then opens it', async () => {
      const ctx = await boot()
      const dir = await signedInProfile()
      const orphan = squatter(dir, { owned: true, stubborn: true })
      const turn = await pool(ctx).openTurn('acct', { profile: { dir } })
      await gone(orphan)
      await turn.page.goto(`${origin}/`)
      expect(await reads(turn.page)).toBe('signed in')
      await turn.close()
    }, 90_000)

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
    }, 120_000)

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
    }, 90_000)

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
    }, 90_000)

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
    }, 90_000)

    it('stops a browser a crashed host left on the profile when the operator reserves it', async () => {
      const ctx = await boot()
      const dir = await signedInProfile()
      const orphan = squatter(dir, { owned: true })
      const release = await pool(ctx).reserveProfile('acct', dir)
      await gone(orphan)
      release()
    }, 90_000)

    it('spaces the page opens of one account by the gap, and captures a held profile in place', async () => {
      const ctx = await boot()
      const dir = await signedInProfile()
      const first = await pool(ctx).openTurn('acct', { profile: { dir, gapMs: 1500 } })
      const opened = Date.now()
      const second = await pool(ctx).openTurn('acct', { profile: { dir, gapMs: 1500 } })
      expect(Date.now() - opened).toBeGreaterThanOrEqual(1400)
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
      const first = await pool(ctx).openTurn('acct-a', { profile: { dir: a, gapMs: 0, pace } })
      const opened = Date.now()
      // Another account of the same site waits the group's gap, though its own gap is 0.
      const second = await pool(ctx).openTurn('acct-b', { profile: { dir: b, gapMs: 0, pace } })
      expect(Date.now() - opened).toBeGreaterThanOrEqual(1400)
      await Promise.all([first.close(), second.close()])
    }, 120_000)

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
})
