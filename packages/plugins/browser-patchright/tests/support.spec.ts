// The browser tests' own helper (T247): where no browser can run, a browser test skips with a note
// naming why, in the words the run's report counts; and a Worker's confinement, whose HOME is its
// private home, still finds the managed Chrome and the developer cache in the account's own home.
import type { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Browser, computeExecutablePath } from '@puppeteer/browsers'
import { describe, expect, it, type RunnerTask, vi } from 'vitest'
import { BROWSER_SKIP as REPORTED } from '../../../../scripts/browser-skips.ts'
import { CHROME_LOCK } from '../src/index.ts'
import { BROWSER_LEFT_OUT, BROWSER_SKIP, browserTestsLeftOut, browserUnavailable, chromeCannotStart, findTestChrome, headlessIt, startFailure, testChrome } from './support.ts'

// A browser test as headlessIt registers it (web-ui's), under a factor of 3, and never run (T348).
describe.skip('a headless browser test, registered under SYSTEM_TEST_TIME_FACTOR=3', () => {
  const before = process.env.SYSTEM_TEST_TIME_FACTOR
  process.env.SYSTEM_TEST_TIME_FACTOR = '3'
  try {
    headlessIt('factor probe', async () => undefined, 60_000)
  } finally {
    if (before === undefined) delete process.env.SYSTEM_TEST_TIME_FACTOR
    else process.env.SYSTEM_TEST_TIME_FACTOR = before
  }
})

describe('a browser spec\'s bound scales with the factor (T348)', () => {
  it('registers a headless browser test with its timeout times the factor', ({ task }) => {
    const probe = task.file.tasks.flatMap((t: RunnerTask) => ('tasks' in t ? t.tasks : [t])).find((t) => t.name === 'factor probe')
    expect((probe as RunnerTask & { timeout: number } | undefined)?.timeout).toBe(180_000)
  })
})

describe('a browser test that cannot run says why (T247)', () => {
  it('names a missing Chrome, and a missing Xvfb only for a headed test, in the words the run\'s report counts', () => {
    expect(BROWSER_SKIP).toBe(REPORTED)
    // An explicit `chrome: undefined` is no Chrome, whatever this host has; an omitted one is this host's, which must also start here.
    const here = browserUnavailable({ headless: true })
    // A run that leaves its browser tests out (T305, SYSTEM_SKIP_BROWSER_TESTS=1) gives the host's verdict as that decision, never as a browser that could not run.
    if (browserTestsLeftOut) expect(here).toBe(BROWSER_LEFT_OUT)
    else if (testChrome === undefined) expect(here).toMatch(/^browser tests did not run: no usable Chrome \(/)
    else expect(here === undefined || /^browser tests did not run: Chrome cannot start here \(.+\)$/.test(here), here).toBe(true)
    expect(browserUnavailable({ chrome: '/opt/chrome', xvfb: false, headless: true })).toBeUndefined()
    expect(browserUnavailable({ chrome: '/opt/chrome', xvfb: true, headless: false })).toBeUndefined()
    expect(browserUnavailable({ chrome: undefined, xvfb: true, headless: true })).toBe(
      'browser tests did not run: no usable Chrome (CHROME_PATH, a system Chrome no older than the engine, the managed build in $DSH_HOME/system/browsers, or ~/.cache/system-chrome)',
    )
    expect(browserUnavailable({ chrome: '/opt/chrome', xvfb: false, headless: false })).toBe('browser tests did not run: no Xvfb on PATH')
    expect(browserUnavailable({ chrome: undefined, xvfb: false, headless: false })).toMatch(/^browser tests did not run: no usable Chrome \(.*\); no Xvfb on PATH$/)
  })

  it('decides whether Chrome starts here by starting it once, headless, without its own sandbox and with its own XDG directories, and names what stopped it', () => {
    const calls: Array<{ args: readonly string[]; env: Record<string, string | undefined> }> = []
    const fake = (outcome: { status: number | null; signal?: string | null; stderr?: string; error?: Error }) => ((_: string, args: readonly string[], options: { env: Record<string, string | undefined> }) => {
      calls.push({ args, env: options.env })
      return { status: outcome.status, signal: outcome.signal ?? null, stderr: outcome.stderr ?? '', stdout: '', pid: 1, output: [], ...(outcome.error ? { error: outcome.error } : {}) }
    }) as unknown as typeof spawnSync
    expect(chromeCannotStart('/opt/chrome', fake({ status: 0 }))).toBeUndefined()
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['--headless', '--no-sandbox', '--dump-dom', 'about:blank']))
    for (const name of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) expect(calls[0]!.env[name], name).toMatch(/system-chrome-probe-/)
    // This sandbox's own refusal (seen in an agent's Bash sandbox): the fatal line, its log prefix dropped.
    const refused = '[2649:2649:1026/123715.962598:FATAL:chrome/browser/process_singleton_posix.cc:297] Check failed: . socket() failed: Operation not permitted (1)\nReceived signal 6\n'
    expect(chromeCannotStart('/opt/chrome', fake({ status: null, signal: 'SIGABRT', stderr: refused }))).toBe('Chrome cannot start here (Check failed: . socket() failed: Operation not permitted (1))')
    expect(startFailure({ status: 1, signal: null, stderr: 'one\nlast words\n' })).toBe('last words')
    expect(startFailure({ status: null, signal: 'SIGKILL', stderr: '' })).toBe('ended on SIGKILL')
    expect(startFailure({ status: 1, signal: null, stderr: '', error: new Error('spawnSync /opt/chrome ETIMEDOUT') })).toBe('spawnSync /opt/chrome ETIMEDOUT')
  })

  it('looks for the pinned build in the managed directory, then the developer cache, of each home it is given (a Worker\'s HOME is its private home), after the product\'s own discovery', () => {
    const empty = mkdtempSync(join(tmpdir(), 'system-test-home-'))
    const account = mkdtempSync(join(tmpdir(), 'system-test-home-'))
    try {
      const none = (): undefined => undefined
      const places = [join('.dsh', 'system', 'browsers'), join('.cache', 'system-chrome')]
      // A home that holds neither (the Worker's private one) finds nothing.
      expect(findTestChrome([empty], none, places, null)).toBeUndefined()
      // The developer cache of the account's own home, in the managed build's layout.
      const cached = computeExecutablePath({ browser: Browser.CHROME, buildId: CHROME_LOCK.buildId, cacheDir: join(account, '.cache', 'system-chrome') })
      mkdirSync(dirname(cached), { recursive: true })
      writeFileSync(cached, '')
      expect(findTestChrome([empty, account], none, places, null)).toBe(cached)
      // The managed build under that home's DSH home comes first.
      const managed = computeExecutablePath({ browser: Browser.CHROME, buildId: CHROME_LOCK.buildId, cacheDir: join(account, '.dsh', 'system', 'browsers') })
      mkdirSync(dirname(managed), { recursive: true })
      writeFileSync(managed, '')
      expect(findTestChrome([empty, account], none, places, null)).toBe(managed)
      // What the product itself finds comes before either.
      expect(findTestChrome([account], () => '/opt/chrome/chrome', places, null)).toBe('/opt/chrome/chrome')
    } finally {
      rmSync(empty, { recursive: true, force: true })
      rmSync(account, { recursive: true, force: true })
    }
  })

  it('finds the managed build under a custom DSH home, which no home holds, by the directory the confinement names in SYSTEM_BROWSERS_DIR, before every home (T247)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'system-test-home-'))
    const custom = mkdtempSync(join(tmpdir(), 'system-custom-dsh-'))
    try {
      const none = (): undefined => undefined
      const browsers = join(custom, 'system', 'browsers')
      const managed = computeExecutablePath({ browser: Browser.CHROME, buildId: CHROME_LOCK.buildId, cacheDir: browsers })
      mkdirSync(dirname(managed), { recursive: true })
      writeFileSync(managed, '')
      // DSH_HOME is scrubbed in a Worker's confinement: without the named directory nothing is found.
      expect(findTestChrome([empty], none, undefined, null)).toBeUndefined()
      expect(findTestChrome([empty], none, undefined, browsers)).toBe(managed)
      // Read from the environment by default, as the confinement sets it.
      vi.stubEnv('SYSTEM_BROWSERS_DIR', browsers)
      expect(findTestChrome([empty], none)).toBe(managed)
      // A relative value is no place.
      expect(findTestChrome([empty], none, undefined, 'system/browsers')).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
      rmSync(empty, { recursive: true, force: true })
      rmSync(custom, { recursive: true, force: true })
    }
  })
})
