/** Test-only helpers for suites that need a real headed Chrome on a private Xvfb. */
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type XvfbHandle, startXvfb } from '@tsuuanmi/system-display-virtual'
import { type Browser, chromium } from 'patchright-core'
import { CHROME_ARGS, IGNORED_DEFAULT_ARGS, discoverChrome } from '../src/index.ts'

/**
 * The Chrome the product itself would choose (configured path, CHROME_PATH, a system Chrome
 * no older than the engine, the managed build), else the same pinned build in the developer
 * cache `~/.cache/system-chrome` (same layout, e.g. from `npx @puppeteer/browsers install`).
 */
export function findTestChrome(): string | undefined {
  return (discoverChrome(undefined) ?? discoverChrome(undefined, { managedDir: join(homedir(), '.cache', 'system-chrome') }))?.path
}

export const hasXvfb = process.platform === 'linux' && (() => {
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
