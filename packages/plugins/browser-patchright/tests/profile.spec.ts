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
      expect(pool(ctx).profileStates()).toEqual([{ account: 'acct', open: true, pages: 1, reserved: false }])
      await b.close()
      await pool(ctx).close('acct')
      expect(pool(ctx).openAccounts()).toEqual([])
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
      expect(pool(ctx).profileStates()).toEqual([{ account: 'acct', open: false, pages: 0, reserved: true }])
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
  })
})
