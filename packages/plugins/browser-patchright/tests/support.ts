/** Test-only helpers for suites that need a real headed Chrome on a private Xvfb. */
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { type XvfbHandle, startXvfb } from '@tsuuanmi/system-display-virtual'
import { Display, type PreparedDisplay, ProviderError } from '@tsuuanmi/system-provider-core'
import { type Browser, chromium } from 'patchright-core'
import { afterAll, beforeAll } from 'vitest'
import { CHROME_ARGS, IGNORED_DEFAULT_ARGS, discoverChrome } from '../src/index.ts'

/**
 * The Chrome the product itself would choose (configured path, CHROME_PATH, a system Chrome
 * no older than the engine, the managed build), else the same pinned build in the developer
 * cache `~/.cache/system-chrome` (same layout, e.g. from `npx @puppeteer/browsers install`).
 */
function findTestChrome(): string | undefined {
  return (discoverChrome(undefined) ?? discoverChrome(undefined, { managedDir: join(homedir(), '.cache', 'system-chrome') }))?.path
}

const hasXvfb = process.platform === 'linux' && (() => {
  try {
    execFileSync('sh', ['-c', 'command -v Xvfb'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

export const testChrome = findTestChrome()
export const canRunBrowser = hasXvfb && testChrome !== undefined

// CI sets SYSTEM_REQUIRE_BROWSER=1 so a missing browser fails instead of silently skipping.
if (process.env.SYSTEM_REQUIRE_BROWSER === '1' && !canRunBrowser) {
  throw new Error('real-browser tests need Xvfb and a modern Chrome (set CHROME_PATH)')
}

/** One headed Chrome on its own Xvfb for a whole suite. */
export async function launchTestBrowser(): Promise<{ browser: Browser; close(): Promise<void> }> {
  const xvfb: XvfbHandle = await startXvfb({ executable: 'Xvfb', startupTimeoutMs: 5000 })
  const browser = await chromium.launch({
    executablePath: testChrome!, headless: false, env: { ...process.env, DISPLAY: xvfb.display, XAUTHORITY: xvfb.authority },
    ignoreDefaultArgs: IGNORED_DEFAULT_ARGS, args: [...CHROME_ARGS, '--window-size=1920,1080'],
  })
  // The display is stopped even when the browser fails to close (a run killed outright leaves it to test-tmp).
  return { browser, close: async () => { try { await browser.close() } finally { await xvfb.stop() } } }
}

interface Shared { xvfb: XvfbHandle; generation: number; lost: AbortSignal }

/**
 * One Xvfb for a whole test file, shared by every test's context the way display-virtual shares
 * one display between the browsers of a profile. Call it at the top of the file: it starts the X
 * server in `beforeAll` (when a browser can run) and stops it in `afterAll`. Mount the provider it
 * returns where a test would mount display-virtual. Each mount is its own `ctx.display`: its
 * disposal signals loss to the browsers on it, as display-virtual's does, and leaves the X server
 * to the file's next test. An X server that exits is replaced at the next `prepare`, under a new
 * generation. It passes the display conformance suite (browser.spec.ts).
 */
export function fileDisplay(): new (ctx: Context) => Display {
  let shared: Shared | undefined
  let starting: Promise<Shared> | undefined
  let generation = 0
  const start = (): Promise<Shared> => (starting ??= (async () => {
    // As long as the other real-Xvfb tests allow: a loaded host can take more than display-virtual's 5 s.
    const xvfb = await startXvfb({ executable: 'Xvfb', startupTimeoutMs: 15_000 })
    const exited = new AbortController()
    void xvfb.exited.then(() => exited.abort(new ProviderError('session_broken', `Xvfb ${xvfb.display} exited`)))
    shared = { xvfb, generation: ++generation, lost: exited.signal }
    return shared
  })().finally(() => { starting = undefined }))
  beforeAll(async () => {
    if (canRunBrowser) await start()
  })
  afterAll(async () => {
    await shared?.xvfb.stop()
  })
  return class FileDisplay extends Display {
    private readonly disposed = new AbortController()
    private prepared: PreparedDisplay | undefined

    constructor(ctx: Context) {
      super(ctx)
      ctx.effect(() => () => this.disposed.abort(new ProviderError('session_broken', 'the test file\'s display provider is disposed')))
    }

    protected async prepareInvisible(): Promise<PreparedDisplay> {
      if (this.disposed.signal.aborted) throw new ProviderError('session_broken', 'the test file\'s display provider is disposed')
      const current = shared && !shared.lost.aborted ? shared : await start()
      if (this.prepared?.generation !== current.generation) {
        this.prepared = {
          kind: 'virtual', env: { DISPLAY: current.xvfb.display, XAUTHORITY: current.xvfb.authority }, windowArgs: ['--window-size=1920,1080'], viewport: null,
          generation: current.generation, lost: AbortSignal.any([current.lost, this.disposed.signal]),
        }
      }
      return this.prepared
    }
  }
}
