import { type Server, createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { type XvfbHandle, startXvfb } from '@tsuuanmi/system-display-virtual'
import { Display, type PreparedDisplay, ProviderError } from '@tsuuanmi/system-provider-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import BrowserPool from '../src/index.ts'
import { canRunBrowser as canRun, testChrome as chrome } from './support.ts'

/** These tests exercise the patchright provider itself, so they use its concrete page and context types. */
const pool = (ctx: Context): BrowserPool => ctx.browser as unknown as BrowserPool


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

  private starting: Promise<PreparedDisplay> | undefined

  protected prepareInvisible(): Promise<PreparedDisplay> {
    if (this.prepared && !this.prepared.lost.aborted) return Promise.resolve(this.prepared)
    // Concurrent callers share one startup (found by the display conformance suite).
    this.starting ??= this.start().finally(() => { this.starting = undefined })
    return this.starting
  }

  private async start(): Promise<PreparedDisplay> {
    const xvfb = await startXvfb({ executable: 'Xvfb', startupTimeoutMs: 5000 })
    const lost = new AbortController()
    void xvfb.exited.then(() => lost.abort(new ProviderError('session_broken', 'Xvfb exited')))
    this.xvfb = xvfb
    this.prepared = { kind: 'virtual', env: { DISPLAY: xvfb.display, XAUTHORITY: xvfb.authority }, windowArgs: ['--window-size=1920,1080'], viewport: null, generation: ++this.generation, lost: lost.signal }
    return this.prepared
  }
}

/** A display that never becomes ready, like a launch stalled under load. */
class StalledDisplay extends Display {
  protected prepareInvisible(): Promise<PreparedDisplay> {
    return new Promise<PreparedDisplay>(() => undefined)
  }
}

describe('ctx.browser: a stalled launch never holds an aborted turn (live 2026-10-12)', () => {
  it('rejects openTurn as soon as its signal aborts, even while the browser is still launching', async () => {
    const ctx = new Context()
    await ctx.plugin(StalledDisplay)
    await ctx.plugin(BrowserPool, {})
    const controller = new AbortController()
    const opening = pool(ctx).openTurn('acct-a', { signal: controller.signal })
    setTimeout(() => controller.abort(new ProviderError('aborted', 'turn runtime stopped')), 100)
    const started = Date.now()
    await expect(opening).rejects.toMatchObject({ kind: 'aborted' })
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

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

  it('opens a turn page that is headed, foreground, and free of automation leaks (REQ-ACC-6)', async () => {
    const { ctx } = await boot()
    const turn = await pool(ctx).openTurn('acct-a')
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

  it('builds each turn in a fresh context from portable state and captures it back filtered (REQ-ACC-4)', async () => {
    const { ctx } = await boot()
    const origins = [origin]
    const host = new URL(origin).hostname
    const state = {
      origins, capturedAt: '2026-10-11T00:00:00Z',
      cookies: [{ name: 'session', value: 'abc', domain: host, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
      localStorage: [{ origin, localStorage: [{ name: 'k', value: 'v' }] }],
    }
    const turn = await pool(ctx).openTurn('acct-a', { state })
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
    const captured = await pool(ctx).capture(turn, { origins })
    expect(captured.cookies.map((c) => c.name)).toEqual(['session'])
    expect(captured.localStorage).toEqual([{ origin, localStorage: expect.arrayContaining([{ name: 'k', value: 'v' }, { name: 'k2', value: 'v2' }]) }])
    expect(captured.indexedDB?.status).toBe('captured')
    await turn.close()

    const fresh = await pool(ctx).openTurn('acct-a')
    await fresh.page.goto(`${origin}/`)
    expect(await fresh.page.evaluate(() => [document.cookie, localStorage.length])).toEqual(['', 0])
    await fresh.close()
  }, 60_000)

  it('keeps one browser per account and closes it after the idle timeout (REQ-ACC-7)', async () => {
    const { ctx } = await boot({ closeAfterMs: 300 })
    const [a1, a2, b] = await Promise.all([pool(ctx).openTurn('acct-a'), pool(ctx).openTurn('acct-a'), pool(ctx).openTurn('acct-b')])
    expect(pool(ctx).openAccounts().sort()).toEqual(['acct-a', 'acct-b'])
    expect(a1.context.browser()).toBe(a2.context.browser())
    expect(a1.context.browser()).not.toBe(b.context.browser())
    await a1.close()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(pool(ctx).openAccounts().sort()).toEqual(['acct-a', 'acct-b'])
    await Promise.all([a2.close(), b.close()])
    await vi.waitFor(() => expect(pool(ctx).openAccounts()).toEqual([]), { timeout: 5000 })
  }, 60_000)

  it('closes a turn context when its signal aborts', async () => {
    const { ctx } = await boot()
    const controller = new AbortController()
    const turn = await pool(ctx).openTurn('acct-a', { signal: controller.signal })
    const closed = new Promise((resolve) => turn.context.once('close', resolve))
    controller.abort()
    await closed
  }, 60_000)

  it('honours an abort that arrives while Chrome is still launching', async () => {
    const { ctx } = await boot()
    const controller = new AbortController()
    const opening = pool(ctx).openTurn('acct-late', { signal: controller.signal })
    setTimeout(() => controller.abort(new Error('lease lost')), 50)
    await expect(opening).rejects.toThrow(/lease lost/)
  }, 60_000)

  it('closes the browsers on a lost display and relaunches on the next display', async () => {
    const { ctx, display } = await boot()
    const turn = await pool(ctx).openTurn('acct-a')
    const disconnected = new Promise((resolve) => turn.context.browser()!.once('disconnected', resolve))
    await display.xvfb!.stop()
    await disconnected
    await vi.waitFor(() => expect(pool(ctx).openAccounts()).toEqual([]))
    const next = await pool(ctx).openTurn('acct-a')
    await next.page.goto(`${origin}/`)
    expect(await next.page.evaluate(() => document.visibilityState)).toBe('visible')
    await next.close()
  }, 60_000)

  it('closes every browser on dispose', async () => {
    const { ctx } = await boot()
    const turn = await pool(ctx).openTurn('acct-a')
    const browser = turn.context.browser()!
    await cleanups.pop()!()
    expect(browser.isConnected()).toBe(false)
  }, 60_000)
})

if (canRun) {
  const { displayConformance } = await import('../../../provider-core/conformance/display.ts')
  const { browserConformance } = await import('../../../provider-core/conformance/browser.ts')
  displayConformance('KillableDisplay (the test fake)', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(KillableDisplay)
    await fiber
    return { ctx, dispose: () => fiber.dispose() }
  })
  browserConformance('browser-patchright', async () => {
    const ctx = new Context()
    const display = ctx.plugin(KillableDisplay)
    await display
    const browser = ctx.plugin(BrowserPool, { chromePath: chrome! })
    await browser
    return { ctx, dispose: async () => { await browser.dispose(); await display.dispose() } }
  }, {
    goto: async (page, url) => { await (page as import('patchright-core').Page).goto(url) },
    read: (page) => (page as import('patchright-core').Page).evaluate(() => ({ cookie: document.cookie, storage: localStorage.length, visibility: document.visibilityState })),
    setStorage: (page, key, value) => (page as import('patchright-core').Page).evaluate(([k, v]) => localStorage.setItem(k!, v!), [key, value]),
  })
}
