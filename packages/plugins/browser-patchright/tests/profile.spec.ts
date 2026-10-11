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

describe.runIf(canRunBrowser)('ctx.browser.captureProfile (the Save flow)', () => {
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
    const { state, result } = await ctx.browser.captureProfile(dir, {
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
    await expect(ctx.browser.captureProfile(dir, { url: `${origin}/`, origins: [origin], inspect: async () => 1 }))
      .rejects.toMatchObject({ kind: 'session_broken', message: expect.stringMatching(/in use/) })
    rmSync(join(dir, 'SingletonLock'))
    symlinkSync(`${hostname()}-2147483646`, join(dir, 'SingletonLock'))
    await expect(ctx.browser.captureProfile(dir, { url: `${origin}/`, origins: [origin], inspect: async () => 1 })).resolves.toMatchObject({ result: 1 })
  }, 60_000)
})
