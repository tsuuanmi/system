import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import VirtualDisplay from '@tsuuanmi/system-display-virtual'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
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

  it('reopens the login profile invisibly and captures state for the origins only, in memory', async () => {
    const ctx = await boot()
    const dir = await signedInProfile()
    const { state, result } = await pool(ctx).captureProfile(dir, {
      url: `${origin}/`, origins: [origin], inspect: (page) => page.locator('p').innerText(),
    })
    expect(result).toBe('signed in')
    expect(state.cookies).toEqual([expect.objectContaining({ name: 'session', value: 'valid' })])
    expect(state.origins).toEqual([origin])
  }, 60_000)

  it('refuses a profile that a live browser still holds, and clears a stale lock', async () => {
    const ctx = await boot()
    const dir = await signedInProfile()
    symlinkSync(`${hostname()}-${process.pid}`, join(dir, 'SingletonLock'))
    await expect(pool(ctx).captureProfile(dir, { url: `${origin}/`, origins: [origin], inspect: async () => 1 }))
      .rejects.toMatchObject({ kind: 'session_broken', message: expect.stringMatching(/in use/) })
    rmSync(join(dir, 'SingletonLock'))
    symlinkSync(`${hostname()}-2147483646`, join(dir, 'SingletonLock'))
    await expect(pool(ctx).captureProfile(dir, { url: `${origin}/`, origins: [origin], inspect: async () => 1 })).resolves.toMatchObject({ result: 1 })
  }, 60_000)

  describe('profile turns (a session-bound account, ADR-0030)', () => {
    const reads = (page: { locator(s: string): { innerText(): Promise<string> } }) => page.locator('p').innerText()

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
      await b.close()
      await pool(ctx).close('acct')
      expect(pool(ctx).openAccounts()).toEqual([])
      // Closed, the profile is free again: the Save flow reopens it.
      await expect(pool(ctx).captureProfile(dir, { url: `${origin}/`, origins: [origin], inspect: (page) => reads(page) })).resolves.toMatchObject({ result: 'signed in' })
    }, 90_000)

    it('clears a lock a crashed host left on the profile, and refuses one a live browser holds', async () => {
      const ctx = await boot()
      const dir = await signedInProfile()
      symlinkSync(`${hostname()}-${process.pid}`, join(dir, 'SingletonLock'))
      await expect(pool(ctx).openTurn('acct', { profile: { dir } })).rejects.toMatchObject({ kind: 'session_broken', message: expect.stringMatching(/in use/) })
      rmSync(join(dir, 'SingletonLock'))
      symlinkSync(`${hostname()}-2147483646`, join(dir, 'SingletonLock'))
      const turn = await pool(ctx).openTurn('acct', { profile: { dir } })
      await turn.page.goto(`${origin}/`)
      expect(await reads(turn.page)).toBe('signed in')
      await turn.close()
    }, 90_000)

    it('reserves the profile for the operator: refused while a turn runs, then turns wait until it is released', async () => {
      const ctx = await boot()
      const dir = await signedInProfile()
      const turn = await pool(ctx).openTurn('acct', { profile: { dir } })
      await expect(pool(ctx).reserveProfile('acct')).rejects.toMatchObject({ kind: 'overloaded', message: expect.stringMatching(/1 operation/) })
      await turn.close()
      const release = await pool(ctx).reserveProfile('acct')
      // Closed for the operator's browser, and no turn opens it meanwhile.
      expect(pool(ctx).openAccounts()).toEqual([])
      await expect(pool(ctx).openTurn('acct', { profile: { dir } })).rejects.toMatchObject({ kind: 'overloaded', disposition: 'BACKOFF' })
      // The Save that ends a remote login still reads the profile.
      await expect(pool(ctx).captureProfile(dir, { url: `${origin}/`, origins: [origin], inspect: (page) => reads(page) })).resolves.toMatchObject({ result: 'signed in' })
      release()
      const again = await pool(ctx).openTurn('acct', { profile: { dir } })
      await again.close()
    }, 90_000)

    it('spaces the page opens of one account by the gap, and captures a held profile in place', async () => {
      const ctx = await boot()
      const dir = await signedInProfile()
      const first = await pool(ctx).openTurn('acct', { profile: { dir, gapMs: 1500 } })
      const opened = Date.now()
      const second = await pool(ctx).openTurn('acct', { profile: { dir, gapMs: 1500 } })
      expect(Date.now() - opened).toBeGreaterThanOrEqual(1400)
      await Promise.all([first.close(), second.close()])
      const { result } = await pool(ctx).captureProfile(dir, { url: `${origin}/`, origins: [origin], inspect: (page) => reads(page) })
      expect(result).toBe('signed in')
      // Used in place: the profile stays held for the account's next turn.
      expect(pool(ctx).openAccounts()).toEqual(['acct'])
    }, 90_000)
  })
})
