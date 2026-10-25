/**
 * What the login profile specs share (profile.spec.ts, profile-owners.spec.ts, profile-pacing.spec.ts):
 * a site that says whether its session cookie is there, the pool on display-virtual, login profiles the
 * operator "signed in" to, and processes that hold a profile as a browser would. A test file calls
 * {@link profileStack} once, inside its describe: that starts the site before its tests and, after
 * each test, stops what the test booted or started and removes its profiles. The specs are split by
 * theme so they run side by side.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import VirtualDisplay from '@tsuuanmi/system-display-virtual'
import { OWNED_PROFILE_SWITCH } from '@tsuuanmi/system-provider-core'
import { chromium } from 'patchright-core'
import { afterAll, afterEach, beforeAll } from 'vitest'
import BrowserPool from '../src/index.ts'
import { testChrome } from './support.ts'

/** These tests exercise the patchright provider itself, so they use its concrete page and context types. */
export const pool = (ctx: Context): BrowserPool => ctx.browser as unknown as BrowserPool

let server: Server
/** The site's origin, set once {@link profileStack} has started it. */
export let origin: string
const dirs: string[] = []
const fibers: Array<{ dispose(): Promise<void> }> = []

/** Starts the site for the file's tests, and releases what each test booted, started, or made. */
export function profileStack(): void {
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end(`<!doctype html><p>${/session=valid/.test(req.headers.cookie ?? '') ? 'signed in' : 'signed out'}</p>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  afterEach(async () => {
    while (fibers.length) await fibers.pop()!.dispose()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
}

export async function boot(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  const display = ctx.plugin(VirtualDisplay, {})
  await display
  const browser = ctx.plugin(BrowserPool, { chromePath: testChrome!, ...config })
  await browser
  fibers.push(display, browser)
  return ctx
}

/** A login profile where the operator has "signed in" (a persistent session cookie). */
export async function signedInProfile(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'system-profile-'))
  dirs.push(dir)
  const ctx = await chromium.launchPersistentContext(dir, { executablePath: testChrome!, headless: true })
  await ctx.addCookies([{ name: 'session', value: 'valid', url: origin, expires: Math.floor(Date.now() / 1000) + 3600 }])
  await ctx.close()
  return dir
}

/**
 * A process that runs "Chrome" on `dir` as far as the host can tell (its command line names the
 * profile). `owned`: one system started (a crashed host's browser, or one that will not exit);
 * otherwise one the operator opened. `stubborn` ignores SIGTERM.
 */
export function squatter(dir: string, options: { owned?: boolean; stubborn?: boolean } = {}): ChildProcess {
  const args = ['-e', `${options.stubborn ? "process.on('SIGTERM', () => {});" : ''}setInterval(() => {}, 1000)`, '--', `--user-data-dir=${dir}`, ...(options.owned ? [OWNED_PROFILE_SWITCH] : [])]
  const child = spawn(process.execPath, args, { stdio: 'ignore' })
  fibers.push({ dispose: async () => void child.kill('SIGKILL') })
  return child
}
/** Still running (a reaped or zombie process has no command line). */
export const running = (child: ChildProcess): boolean => {
  try {
    return readFileSync(`/proc/${child.pid}/cmdline`).length > 0
  } catch {
    return false
  }
}
export const gone = (child: ChildProcess): Promise<unknown> => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve)))
export const reads = (page: { locator(s: string): { innerText(): Promise<string> } }): Promise<string> => page.locator('p').innerText()
export const capture = (ctx: Context, dir: string) => pool(ctx).captureProfile('acct', dir, { url: `${origin}/`, origins: [origin], inspect: (page) => reads(page) })
