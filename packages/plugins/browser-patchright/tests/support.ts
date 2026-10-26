/**
 * Test-only helpers for suites that need a real Chrome: headless (the web UI's), or headed on a
 * private Xvfb. Where no browser can run, a test says so when it skips (docs/engineering/testing.md
 * #real-browser-tests-in-a-workers-confinement).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { type XvfbHandle, startXvfb } from '@tsuuanmi/system-display-virtual'
import { Display, type PreparedDisplay, ProviderError } from '@tsuuanmi/system-provider-core'
import { type Browser, chromium, type LaunchOptions } from 'patchright-core'
import { afterAll, beforeAll, it, type TestContext } from 'vitest'
import { managedChromePath } from '../src/chrome.ts'
import { CHROME_ARGS, IGNORED_DEFAULT_ARGS, discoverChrome } from '../src/index.ts'

/** The account's own home, from the password database: `HOME` is a Worker's private home inside its confinement. */
function accountHome(): string | undefined {
  try {
    return userInfo().homedir || undefined
  } catch {
    return undefined
  }
}

/**
 * The Chrome the product itself would choose (configured path, CHROME_PATH, a system Chrome
 * no older than the engine, the managed build under the DSH home), else the same pinned build in
 * the managed directory or the developer cache `~/.cache/system-chrome` (same layout, e.g. from
 * `npx @puppeteer/browsers install`) of each of `homes`. Inside a Worker's confinement `HOME` is its
 * private home and `DSH_HOME` is scrubbed, so the confinement names where it binds
 * `$DSH_HOME/system/browsers` back read-only in `SYSTEM_BROWSERS_DIR` (`named`, looked in first,
 * whatever the DSH home is), and the account's own home is looked in too (agent-runtimes, T247).
 */
export function findTestChrome(
  homes: readonly string[] = [...new Set([homedir(), accountHome()].filter((h): h is string => !!h))],
  product: () => string | undefined = () => discoverChrome(undefined)?.path,
  places: readonly string[] = [join('.dsh', 'system', 'browsers'), join('.cache', 'system-chrome')],
  named: string | null = process.env.SYSTEM_BROWSERS_DIR || null,
): string | undefined {
  const found = product()
  if (found) return found
  const dirs = [...(named && isAbsolute(named) ? [named] : []), ...homes.flatMap((home) => places.map((place) => join(home, place)))]
  for (const dir of dirs) {
    const chrome = existsSync(dir) ? managedChromePath(dir) : undefined
    if (chrome) return chrome
  }
  return undefined
}

const hasXvfb = process.platform === 'linux' && (() => {
  try {
    execFileSync('sh', ['-c', 'command -v Xvfb'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** The Chrome the browser tests launch: found as {@link findTestChrome} finds it, in a Worker's confinement too. */
export const testChrome = findTestChrome()
/**
 * The Chrome the headed suites look for, as they always have: the product's own discovery, else
 * the developer cache under `HOME`. Their gate is left as it was: a Chrome the headless tests find
 * in the account's home does not start the headed suites, whose display a confinement may not give.
 */
const headedChrome = findTestChrome([homedir()], () => discoverChrome(undefined)?.path, [join('.cache', 'system-chrome')], null)
/** A headed Chrome on a private Xvfb can run here. */
export const canRunBrowser = hasXvfb && headedChrome !== undefined

/** CI requires the browser tests to run: a browser that cannot fails them instead of skipping them. */
const REQUIRE_BROWSER = process.env.SYSTEM_REQUIRE_BROWSER === '1'

/** The words every browser test's skip note starts with: what the run's report counts (scripts/browser-skips.ts). */
export const BROWSER_SKIP = 'browser tests did not run'

/**
 * Chrome's own writable XDG config, cache, and data directories, made under `dir`. Chrome keeps its
 * crash database under `XDG_CONFIG_HOME` (default `~/.config`), never under its profile: where
 * `HOME` is read-only, as in a Worker's confinement (a check's host is read-only, an agent's private
 * home too), its crash handler exits (`chrome_crashpad_handler: --database is required`) and Chrome
 * with it.
 */
function chromeDirs(dir: string): Record<string, string> {
  const xdg = { XDG_CONFIG_HOME: join(dir, 'config'), XDG_CACHE_HOME: join(dir, 'cache'), XDG_DATA_HOME: join(dir, 'data') }
  for (const path of Object.values(xdg)) mkdirSync(path, { recursive: true, mode: 0o700 })
  return xdg
}

/** This process's environment, its unset names left out. */
const processEnv = (): Record<string, string> => Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))

/** What a probe that could not start Chrome said: its fatal line, else its last, else how it ended. */
export function startFailure(result: { status: number | null; signal: string | null; stderr: string; error?: Error }): string {
  if (result.error) return result.error.message.split('\n')[0]!.slice(0, 200)
  const lines = result.stderr.split('\n').map((line) => line.trim()).filter(Boolean)
  const fatal = lines.find((line) => /FATAL|Check failed/.test(line)) ?? lines.at(-1)
  const said = fatal?.replace(/^\[[^\]]*\]\s*/, '').slice(0, 200)
  return said || (result.signal ? `ended on ${result.signal}` : `exited ${result.status}`)
}

/**
 * Why `chrome` cannot start headless here, undefined when it can: decided by starting it once, as
 * the tests do (no sandbox of its own, its own XDG directories), on a blank page; a host whose
 * sandbox forbids what Chrome needs (unix sockets, its shared memory) says so here, before any test.
 */
export function chromeCannotStart(chrome: string, run: typeof spawnSync = spawnSync): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'system-chrome-probe-'))
  try {
    const result = run(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', 'about:blank'], {
      env: { ...processEnv(), ...chromeDirs(dir) }, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'ignore', 'pipe'],
    })
    return result.status === 0 ? undefined : `Chrome cannot start here (${startFailure({ status: result.status, signal: result.signal, stderr: String(result.stderr ?? ''), ...(result.error ? { error: result.error } : {}) })})`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** This host's headless verdict, probed once per process when a headless test first asks. */
let probed: { why: string | undefined } | undefined

/**
 * Why a browser test cannot run here: undefined when it can. `chrome` and `xvfb`, when given (an
 * explicit `chrome: undefined` too: no Chrome), stand for what this host has; omitted, it is this
 * host's, and a headless test's Chrome must also start here ({@link chromeCannotStart}).
 */
export function browserUnavailable(options: { chrome?: string | undefined; xvfb?: boolean; headless: boolean }): string | undefined {
  const given = 'chrome' in options
  const chrome = given ? options.chrome : testChrome
  const xvfb = options.xvfb ?? hasXvfb
  const missing = [
    ...(chrome === undefined ? ['no usable Chrome (CHROME_PATH, a system Chrome no older than the engine, the managed build in $DSH_HOME/system/browsers, or ~/.cache/system-chrome)'] : []),
    ...(!options.headless && !xvfb ? ['no Xvfb on PATH'] : []),
  ]
  if (!missing.length && !given && options.headless && chrome !== undefined) {
    probed ??= { why: chromeCannotStart(chrome) }
    if (probed.why) missing.push(probed.why)
  }
  return missing.length ? `${BROWSER_SKIP}: ${missing.join('; ')}` : undefined
}

// CI sets SYSTEM_REQUIRE_BROWSER=1 so a missing browser fails instead of skipping.
if (REQUIRE_BROWSER && !canRunBrowser) {
  throw new Error('real-browser tests need Xvfb and a modern Chrome (set CHROME_PATH)')
}

/**
 * How a headless browser test launches Chrome: {@link testChrome}, headless (Patchright adds
 * `--no-sandbox`: the confinement isolates it), with its own writable XDG directories in the
 * temporary directory ({@link chromeDirs}).
 */
export function headlessLaunchOptions(): LaunchOptions {
  return { executablePath: testChrome!, headless: true, env: { ...processEnv(), ...chromeDirs(mkdtempSync(join(tmpdir(), 'system-chrome-xdg-'))) } }
}

/**
 * A test that needs a headless Chrome. Where none can run it is skipped, never silently: its skip
 * note says `browser tests did not run: <why>`, the run's report counts it, and a check reports it
 * to the review (scripts/browser-skips.ts). Under `SYSTEM_REQUIRE_BROWSER=1` (CI) it runs, and fails.
 */
export function headlessIt(name: string, fn: (context: TestContext) => Promise<void>, timeout?: number): void {
  it(name, async (context) => {
    const why = browserUnavailable({ headless: true })
    if (why && !REQUIRE_BROWSER) context.skip(why)
    await fn(context)
  }, timeout)
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
