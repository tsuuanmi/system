import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import McpEndpoint from '@tsuuanmi/system-mcp-server'
import Accounts from '@tsuuanmi/system-accounts'
import BrowserPool from '@tsuuanmi/system-browser-patchright'
import Vault from '@tsuuanmi/system-credentials-vault'
import VirtualDisplay from '@tsuuanmi/system-display-virtual'
import { contentId } from '@tsuuanmi/system-libs'
import ChatGptWeb from '@tsuuanmi/system-provider-chatgpt-web'
import Providers from '@tsuuanmi/system-providers'
import { chromium } from 'patchright-core'
import { afterEach, describe, expect, it } from 'vitest'
import { canRunBrowser, testChrome } from '../../browser-patchright/tests/support.ts'
import { FakeChatGpt } from '../../provider-chatgpt-web/fixtures/fake-chatgpt.ts'
import Login from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe.runIf(canRunBrowser)('ctx.login.save', () => {
  async function boot(): Promise<{ ctx: Context; fake: FakeChatGpt; dir: string }> {
    const fake = new FakeChatGpt({ requireCookie: true, userId: 'user-42' })
    await fake.start()
    const dir = mkdtempSync(join(tmpdir(), 'system-login-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => fake.stop())
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }),
      ctx.plugin(Accounts, { accounts: [{ id: 'chatgpt-main', provider: 'chatgpt-web', quotaClass: 'subscription-chat', tiers: { standard: 'instant' } }] }),
      ctx.plugin(VirtualDisplay, {}),
      ctx.plugin(BrowserPool, { chromePath: testChrome! }),
      ctx.plugin(Providers),
      ctx.plugin(ChatGptWeb, { origin: fake.origin, overlayPath: join(dir, 'none.yaml') }),
      ctx.plugin(Login, { profilesDir: join(dir, 'profiles') }),
      ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }),
      ctx.plugin(McpEndpoint, { tokenFile: join(dir, 'mcp.token'), discoveryFile: join(dir, 'mcp.json') }),
    ]
    await Promise.all(fibers)
    cleanups.push(async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    })
    return { ctx, fake, dir }
  }

  /** What the operator's interactive login leaves behind: a persistent session in the profile. */
  async function operatorSignsIn(profileDir: string, origin: string): Promise<void> {
    const ctx = await chromium.launchPersistentContext(profileDir, { executablePath: testChrome!, headless: true })
    await ctx.addCookies([{ name: 'session', value: 'valid', url: origin, expires: Math.floor(Date.now() / 1000) + 3600 }])
    await ctx.close()
  }

  it('captures, verifies, and stores the account encrypted with a hashed identity', async () => {
    const { ctx, fake, dir } = await boot()
    await operatorSignsIn(ctx.login.profileDir('chatgpt-main'), fake.origin)
    const view = await ctx.login.save('chatgpt-main')
    expect(view).toMatchObject({ id: 'chatgpt-main', status: 'ready', revision: 1 })
    const state = await ctx.accounts.portableState('chatgpt-main')
    expect(state?.cookies).toEqual([expect.objectContaining({ name: 'session' })])
    const vault = readFileSync(join(dir, 'vault.enc'))
    expect(vault.includes(Buffer.from('user-42'))).toBe(false)
    expect(vault.includes(Buffer.from('valid'))).toBe(false)
    expect(await ctx.accounts.duplicateIdentities()).toEqual([])
    expect(contentId({ provider: 'chatgpt-web', identity: 'chatgpt-web:user-42' })).toMatch(/^sha256:/)
  }, 90_000)

  it('saves nothing when the profile is not signed in', async () => {
    const { ctx } = await boot()
    await expect(ctx.login.save('chatgpt-main')).rejects.toMatchObject({ kind: 'reauth_required' })
    expect(await ctx.accounts.get('chatgpt-main')).toMatchObject({ status: 'new', revision: 0 })
  }, 90_000)

  it('offers account_list and account_save to the operator over the authenticated MCP endpoint', async () => {
    const { ctx, fake, dir } = await boot()
    await operatorSignsIn(ctx.login.profileDir('chatgpt-main'), fake.origin)
    const { url, tokenFile } = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as { url: string; tokenFile: string }
    const client = new Client({ name: 'cli', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${readFileSync(tokenFile).toString('base64url')}` } } }) as unknown as Transport)
    cleanups.push(() => client.close())
    const saved = await client.callTool({ name: 'account_save', arguments: { account: 'chatgpt-main' } })
    expect(saved.isError).toBeFalsy()
    expect(saved.structuredContent).toMatchObject({ id: 'chatgpt-main', status: 'ready' })
    const listed = await client.callTool({ name: 'account_list', arguments: {} })
    expect(listed.structuredContent).toMatchObject({ accounts: [{ id: 'chatgpt-main', status: 'ready' }] })
    expect(JSON.stringify(listed)).not.toContain('valid')
    const failed = await client.callTool({ name: 'account_save', arguments: { account: 'nope' } })
    expect(failed.isError).toBe(true)
  }, 90_000)

  it('rejects an unknown account', async () => {
    const { ctx } = await boot()
    await expect(ctx.login.save('nope')).rejects.toThrow()
  }, 60_000)
})
