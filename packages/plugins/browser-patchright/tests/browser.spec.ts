import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { type XvfbHandle, startXvfb } from '@tsuuanmi/system-display-virtual'
import { Display, type PreparedDisplay, ProviderError } from '@tsuuanmi/system-provider-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import BrowserPool, { discoverChrome } from '../src/index.ts'

/** A modern Chrome for the real-browser tests: CHROME_PATH, a recent system Chrome, or Chrome for Testing in ~/.cache/system-chrome. */
function findTestChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  for (const path of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
    try {
      const major = Number(/(\d+)\./.exec(execFileSync(path, ['--version'], { encoding: 'utf8' }))?.[1])
      if (major >= 120) return path
    } catch { /* not installed */ }
  }
  const cache = join(homedir(), '.cache', 'system-chrome', 'chrome')
  if (!existsSync(cache)) return undefined
  const newest = readdirSync(cache).sort().at(-1)
  const path = newest && join(cache, newest, 'chrome-linux64', 'chrome')
  return path && existsSync(path) ? path : undefined
}

const hasXvfb = process.platform === 'linux' && (() => {
  try {
    execFileSync('sh', ['-c', 'command -v Xvfb'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const chrome = findTestChrome()
const canRun = hasXvfb && chrome !== undefined
// CI sets SYSTEM_REQUIRE_BROWSER=1 so a missing browser fails instead of silently skipping.
if (process.env.SYSTEM_REQUIRE_BROWSER === '1' && !canRun) throw new Error('real-browser tests need Xvfb and a modern Chrome (set CHROME_PATH)')

describe('discoverChrome', () => {
  it('uses an explicit path and fails closed when it does not exist', () => {
    expect(() => discoverChrome('/nonexistent/chrome')).toThrow(ProviderError)
    expect(() => discoverChrome('/nonexistent/chrome')).toThrow(/does not exist/)
  })

  it('falls back to CHROME_PATH, then standard locations, and never to a bundled browser', () => {
    vi.stubEnv('CHROME_PATH', process.execPath)
    expect(discoverChrome(undefined)).toBe(process.execPath)
    vi.stubEnv('CHROME_PATH', '')
    expect(discoverChrome(undefined, [])).toBeUndefined()
    vi.unstubAllEnvs()
  })
})

/** A display provider whose Xvfb the test can kill, to simulate a lost display. */
class KillableDisplay extends Display {
  xvfb: XvfbHandle | undefined
  private prepared: PreparedDisplay | undefined
  private generation = 0

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      await this.xvfb?.stop()
    })
  }

  protected async prepareInvisible(): Promise<PreparedDisplay> {
    if (this.prepared && !this.prepared.lost.aborted) return this.prepared
    const xvfb = await startXvfb({ executable: 'Xvfb', startupTimeoutMs: 5000 })
    const lost = new AbortController()
    void xvfb.exited.then(() => lost.abort(new ProviderError('session_broken', 'Xvfb exited')))
    this.xvfb = xvfb
    this.prepared = { kind: 'virtual', env: { DISPLAY: xvfb.display }, windowArgs: ['--window-size=1920,1080'], viewport: null, generation: ++this.generation, lost: lost.signal }
    return this.prepared
  }
}

describe.runIf(canRun)('ctx.browser with a real headed Chrome on Xvfb', () => {
  let server: Server
  let origin: string
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end('<!doctype html><title>t</title><p>ok</p>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const cleanups: Array<() => unknown> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!()
  })

  async function boot(config: Record<string, unknown> = {}): Promise<{ ctx: Context; display: KillableDisplay }> {
    const ctx = new Context()
    const displayFiber = ctx.plugin(KillableDisplay)
    await displayFiber
    const fiber = ctx.plugin(BrowserPool, { chromePath: chrome!, ...config })
    await fiber
    cleanups.push(() => displayFiber.dispose(), () => fiber.dispose())
    return { ctx, display: ctx.display as KillableDisplay }
  }

  it('opens a turn page that is headed, foreground, and free of automation leaks', async () => {
    const { ctx } = await boot()
    const turn = await ctx.browser.openTurn('acct-a')
    await turn.page.goto(`${origin}/`)
    const probe = await turn.page.evaluate(() => ({
      webdriver: navigator.webdriver, visibility: document.visibilityState, focus: document.hasFocus(), ua: navigator.userAgent, width: innerWidth,
    }))
    expect(probe).toMatchObject({ webdriver: false, visibility: 'visible', focus: true })
    expect(probe.ua).not.toMatch(/Headless/)
    expect(probe.width).toBeGreaterThan(1800)
    const second = await turn.context.newPage()
    await second.goto(`${origin}/`)
    expect(await second.evaluate(() => document.hasFocus())).toBe(true)
    // Focus emulation: a page whose window is behind another still behaves as focused.
    await second.bringToFront()
    expect(await turn.page.evaluate(() => document.hasFocus())).toBe(true)
    await turn.close()
  }, 60_000)

  it('builds each turn in a fresh context from portable state and captures it back filtered', async () => {
    const { ctx } = await boot()
    const origins = [origin]
    const host = new URL(origin).hostname
    const state = {
      origins, capturedAt: '2026-10-11T00:00:00Z',
      cookies: [{ name: 'session', value: 'abc', domain: host, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
      localStorage: [{ origin, localStorage: [{ name: 'k', value: 'v' }] }],
    }
    const turn = await ctx.browser.openTurn('acct-a', { state })
    await turn.page.goto(`${origin}/`)
    expect(await turn.page.evaluate(() => [document.cookie, localStorage.getItem('k')])).toEqual(['session=abc', 'v'])
    await turn.page.evaluate(() => new Promise<void>((resolve, reject) => {
      localStorage.setItem('k2', 'v2')
      const open = indexedDB.open('db', 1)
      open.onupgradeneeded = () => open.result.createObjectStore('s').put('value', 'key')
      open.onsuccess = () => { open.result.close(); resolve() }
      open.onerror = () => reject(open.error)
    }))
    await turn.context.addCookies([{ name: 'foreign', value: 'x', domain: 'example.net', path: '/' }])
    const captured = await ctx.browser.capture(turn, { origins })
    expect(captured.cookies.map((c) => c.name)).toEqual(['session'])
    expect(captured.localStorage).toEqual([{ origin, localStorage: expect.arrayContaining([{ name: 'k', value: 'v' }, { name: 'k2', value: 'v2' }]) }])
    expect(captured.indexedDB?.status).toBe('captured')
    await turn.close()

    const fresh = await ctx.browser.openTurn('acct-a')
    await fresh.page.goto(`${origin}/`)
    expect(await fresh.page.evaluate(() => [document.cookie, localStorage.length])).toEqual(['', 0])
    await fresh.close()
  }, 60_000)

  it('keeps one browser per account and closes it after the idle timeout', async () => {
    const { ctx } = await boot({ closeAfterMs: 300 })
    const [a1, a2, b] = await Promise.all([ctx.browser.openTurn('acct-a'), ctx.browser.openTurn('acct-a'), ctx.browser.openTurn('acct-b')])
    expect(ctx.browser.openAccounts().sort()).toEqual(['acct-a', 'acct-b'])
    expect(a1.context.browser()).toBe(a2.context.browser())
    expect(a1.context.browser()).not.toBe(b.context.browser())
    await a1.close()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(ctx.browser.openAccounts().sort()).toEqual(['acct-a', 'acct-b'])
    await Promise.all([a2.close(), b.close()])
    await vi.waitFor(() => expect(ctx.browser.openAccounts()).toEqual([]), { timeout: 5000 })
  }, 60_000)

  it('closes a turn context when its signal aborts', async () => {
    const { ctx } = await boot()
    const controller = new AbortController()
    const turn = await ctx.browser.openTurn('acct-a', { signal: controller.signal })
    const closed = new Promise((resolve) => turn.context.once('close', resolve))
    controller.abort()
    await closed
  }, 60_000)

  it('closes the browsers on a lost display and relaunches on the next display', async () => {
    const { ctx, display } = await boot()
    const turn = await ctx.browser.openTurn('acct-a')
    const disconnected = new Promise((resolve) => turn.context.browser()!.once('disconnected', resolve))
    await display.xvfb!.stop()
    await disconnected
    await vi.waitFor(() => expect(ctx.browser.openAccounts()).toEqual([]))
    const next = await ctx.browser.openTurn('acct-a')
    await next.page.goto(`${origin}/`)
    expect(await next.page.evaluate(() => document.visibilityState)).toBe('visible')
    await next.close()
  }, 60_000)

  it('closes every browser on dispose', async () => {
    const { ctx } = await boot()
    const turn = await ctx.browser.openTurn('acct-a')
    const browser = turn.context.browser()!
    await cleanups.pop()!()
    expect(browser.isConnected()).toBe(false)
  }, 60_000)
})
