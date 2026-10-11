/**
 * Which Chrome the provider runtime launches (docs/design/browser-runtime.md
 * #browser-launch-ctxbrowser): the configured path, then `CHROME_PATH`, then a system
 * Chrome no older than the engine's Chromium, then the **managed** build pinned in
 * `chrome.lock.json` (Chrome for Testing, installed by `system init` with
 * `@puppeteer/browsers` under `<DSH_HOME>/system/browsers`). Ported from tsuuanmi/internet
 * `src/browser/chrome.ts`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Browser, computeExecutablePath, install as puppeteerInstall } from '@puppeteer/browsers'
import { dshHome, ensurePrivateDir } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'

export interface ChromeLock {
  browser: 'chrome'
  buildId: string
}

export const CHROME_LOCK: ChromeLock = JSON.parse(readFileSync(new URL('../chrome.lock.json', import.meta.url), 'utf8')) as ChromeLock

const STANDARD_CHROME_PATHS = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']

/** The Chromium major that patchright-core is built against. */
export function engineChromiumMajor(): number {
  const pkg = createRequire(import.meta.url).resolve('patchright-core/package.json')
  const { browsers } = JSON.parse(readFileSync(join(dirname(pkg), 'browsers.json'), 'utf8')) as { browsers: Array<{ name: string; browserVersion: string }> }
  return Number(browsers.find((b) => b.name === 'chromium')?.browserVersion.split('.')[0])
}

function chromeMajor(path: string): number | undefined {
  try {
    const major = /(\d+)\.\d+\.\d+/.exec(execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 10_000 }))?.[1]
    return major === undefined ? undefined : Number(major)
  } catch {
    return undefined
  }
}

export function managedBrowsersDir(home: string = dshHome()): string {
  return join(home, 'system', 'browsers')
}

/** The pinned managed Chrome, if it is installed. */
export function managedChromePath(dir: string = managedBrowsersDir(), lock: ChromeLock = CHROME_LOCK): string | undefined {
  const path = computeExecutablePath({ browser: Browser.CHROME, buildId: lock.buildId, cacheDir: dir })
  return existsSync(path) ? path : undefined
}

type Installer = (options: { browser: Browser; buildId: string; cacheDir: string }) => Promise<{ executablePath: string }>

/** Installs the pinned managed Chrome unless it is already present. */
export async function installManagedChrome(options: { dir?: string; lock?: ChromeLock; install?: Installer } = {}): Promise<{ path: string; installed: boolean }> {
  const dir = options.dir ?? managedBrowsersDir()
  const lock = options.lock ?? CHROME_LOCK
  const existing = managedChromePath(dir, lock)
  if (existing) return { path: existing, installed: false }
  // The installer creates directories with the process umask; create ours owner-only
  // first so `<DSH_HOME>/system` still passes the kernel plugins' private-dir check.
  ensurePrivateDir(dir)
  const install = options.install ?? ((o) => puppeteerInstall({ ...o, unpack: true }))
  const { executablePath } = await install({ browser: Browser.CHROME, buildId: lock.buildId, cacheDir: dir })
  return { path: executablePath, installed: true }
}

export interface ChromeChoice {
  path: string
  source: 'configured' | 'env' | 'system' | 'managed'
}

export interface DiscoverOptions {
  standard?: readonly string[]
  managedDir?: string
}

export function discoverChrome(configured: string | undefined, options: DiscoverOptions = {}): ChromeChoice | undefined {
  if (configured !== undefined) {
    if (!existsSync(configured)) throw new ProviderError('config_error', `configured Chrome path does not exist: ${configured}`)
    return { path: configured, source: 'configured' }
  }
  const env = process.env.CHROME_PATH
  if (env && existsSync(env)) return { path: env, source: 'env' }
  const minimum = engineChromiumMajor()
  for (const path of options.standard ?? STANDARD_CHROME_PATHS) {
    if (existsSync(path) && (chromeMajor(path) ?? 0) >= minimum) return { path, source: 'system' }
  }
  const managed = managedChromePath(options.managedDir)
  return managed ? { path: managed, source: 'managed' } : undefined
}
