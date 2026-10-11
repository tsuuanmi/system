/** Test-only helpers for suites that need a real headed Chrome on a private Xvfb. */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type XvfbHandle, startXvfb } from '@tsuuanmi/system-display-virtual'
import { type Browser, chromium } from 'patchright-core'

/** A modern Chrome: CHROME_PATH, a system Chrome ≥ 120, or Chrome for Testing in ~/.cache/system-chrome. */
export function findTestChrome(): string | undefined {
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
    ignoreDefaultArgs: ['--no-sandbox'], args: ['--no-first-run', '--no-default-browser-check'],
  })
  return { browser, close: async () => { await browser.close(); await xvfb.stop() } }
}
