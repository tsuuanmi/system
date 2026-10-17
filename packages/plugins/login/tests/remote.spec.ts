import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Accounts from '@tsuuanmi/system-accounts'
import BrowserPool from '@tsuuanmi/system-browser-patchright'
import Vault from '@tsuuanmi/system-credentials-vault'
import VirtualDisplay from '@tsuuanmi/system-display-virtual'
import ChatGptWeb from '@tsuuanmi/system-provider-chatgpt-web'
import Providers from '@tsuuanmi/system-providers'
import { chromium } from 'patchright-core'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { canRunBrowser, launchTestBrowser, testChrome } from '../../browser-patchright/tests/support.ts'
import { FakeChatGpt } from '../../provider-chatgpt-web/fixtures/fake-chatgpt.ts'
import Login from '../src/index.ts'

/** A TigerVNC scraping server: PATH, X0VNCSERVER, or the developer cache (no root needed). */
const vnc = [process.env.X0VNCSERVER, join(homedir(), '.cache', 'system-tigervnc', 'usr', 'bin', 'x0vncserver'), '/usr/bin/x0vncserver']
  .find((p): p is string => !!p && existsSync(p))
if (process.env.SYSTEM_REQUIRE_BROWSER === '1' && !vnc) throw new Error('remote-login tests need x0vncserver (apt install tigervnc-scraping-server)')

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe.runIf(canRunBrowser && vnc)('ctx.login.remote: the noVNC login desktop', () => {
  async function boot() {
    const fake = new FakeChatGpt({ requireCookie: true, userId: 'user-remote' })
    await fake.start()
    const dir = mkdtempSync(join(tmpdir(), 'system-remote-'))
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }),
      ctx.plugin(Accounts, { accounts: [{ id: 'chatgpt-main', provider: 'chatgpt-web', quotaClass: 'subscription-chat', tiers: {} }] }),
      ctx.plugin(VirtualDisplay, {}),
      ctx.plugin(BrowserPool, { chromePath: testChrome! }),
      ctx.plugin(Providers),
      ctx.plugin(ChatGptWeb, { origin: fake.origin, overlayPath: join(dir, 'none.yaml') }),
      ctx.plugin(Login, { profilesDir: join(dir, 'profiles'), vncPath: vnc!, chromePath: testChrome! }),
    ]
    await Promise.all(fibers)
    cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }), () => fake.stop(), async () => { for (const f of fibers.reverse()) await f.dispose() })
    return { ctx, fake }
  }

  /** The first bytes the VNC server sends through the token-gated WebSocket proxy. */
  function rfbHello(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, ['binary'])
      socket.binaryType = 'nodebuffer'
      socket.once('message', (data: Buffer) => { socket.close(); resolve(data.toString('latin1')) })
      socket.once('error', reject)
      socket.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    })
  }

  it('serves a token-gated page whose WebSocket reaches the VNC server over a private socket (REQ-ACC-3)', async () => {
    const { ctx } = await boot()
    const session = await ctx.login.remote('chatgpt-main')
    expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{40,}\/$/)
    expect(session.sshCommand).toMatch(/^ssh -L \d+:127\.0\.0\.1:\d+ /)
    const page = await fetch(session.url)
    expect(page.status).toBe(200)
    expect(await page.text()).toMatch(/Save account/)
    expect((await fetch(session.url.replace(/\/[^/]+\/$/, '/wrong-token/'))).status).toBe(404)
    const ws = session.url.replace(/^http/, 'ws') + 'websockify'
    expect(await rfbHello(ws)).toMatch(/^RFB 003\.00\d\n/)
    await expect(rfbHello(ws.replace(/\/[^/]+\/websockify$/, '/wrong/websockify'))).rejects.toThrow(/404/)
    expect((await fetch(session.url + 'novnc/core/rfb.js')).status).toBe(200)
    expect((await fetch(session.url + 'novnc/../../etc/passwd')).status).toBe(404)
    await ctx.login.endRemote('chatgpt-main')
    expect(existsSync(session.socketDir)).toBe(false)
  }, 90_000)

  it('joins a second login for the account to the first, and reserves the profile until the desktop ends (ADR-0030)', async () => {
    const { ctx } = await boot()
    const [a, b] = await Promise.all([ctx.login.remote('chatgpt-main'), ctx.login.remote('chatgpt-main')])
    expect(b.url).toBe(a.url)
    expect(ctx.browser.profileStates()).toEqual([expect.objectContaining({ account: 'chatgpt-main', reserved: true })])
    await expect(ctx.browser.openTurn('chatgpt-main', { profile: { dir: ctx.login.profileDir('chatgpt-main') } })).rejects.toMatchObject({ kind: 'overloaded' })
    await ctx.login.endRemote('chatgpt-main')
    expect(ctx.browser.profileStates()).toEqual([])
  }, 90_000)

  it('the noVNC page connects from a real browser and shows the remote desktop (REQ-ACC-3)', async () => {
    const { ctx } = await boot()
    const session = await ctx.login.remote('chatgpt-main')
    const viewer = await launchTestBrowser()
    cleanups.push(() => viewer.close())
    const page = await viewer.browser.newPage()
    await page.goto(session.url)
    await expect.poll(() => page.locator('#status').innerText(), { timeout: 15_000 }).toBe('Sign in, then press Save account.')
    expect(await page.locator('#screen canvas').count()).toBe(1)
  }, 90_000)

  it('Save closes the login Chrome and stores the signed-in account; foreign origins cannot press it', async () => {
    const { ctx, fake } = await boot()
    // What the operator does in the remote view: sign in (the fake signs in by cookie).
    const pre = await chromium.launchPersistentContext(ctx.login.profileDir('chatgpt-main'), { executablePath: testChrome!, headless: true })
    await pre.addCookies([{ name: 'session', value: 'valid', url: fake.origin, expires: Math.floor(Date.now() / 1000) + 3600 }])
    await pre.close()
    const session = await ctx.login.remote('chatgpt-main')
    const forged = await fetch(session.url + 'save', { method: 'POST', headers: { origin: 'http://evil.test' } })
    expect(forged.status).toBe(403)
    const saved = await fetch(session.url + 'save', { method: 'POST', headers: { origin: new URL(session.url).origin } })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ state: 'complete' })
    expect(await ctx.accounts.get('chatgpt-main')).toMatchObject({ status: 'ready' })
    expect(readFileSync(join(ctx.login.profileDir('chatgpt-main'), '..', '..', 'vault.enc')).includes(Buffer.from('user-remote'))).toBe(false)
  }, 120_000)
})
