/**
 * `ctx.login`: account login profiles and the Save flow
 * (docs/design/browser-runtime.md#save-both-modes). Each account has its own login
 * profile, used only for interactive login. Save reopens that profile invisibly,
 * captures the portable state in memory, verifies it in a fresh context, and stores it
 * encrypted through `ctx.accounts` with a hashed identity. A failed verification saves
 * nothing.
 * @module @tsuuanmi/system-login
 */
import { join } from 'node:path'
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { AccountView } from '@tsuuanmi/system-accounts'
import type {} from '@tsuuanmi/system-browser-patchright'
import { contentId, dshHome } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-mcp-server'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import type {} from '@tsuuanmi/system-providers'

declare module '@deepseek-ai/cordis' {
  interface Context {
    login: Login
  }
}

export interface Config {
  /** Directory of per-account login profiles (default `<DSH_HOME>/system/login-profiles`). */
  profilesDir?: string
}

const ID = /^[a-z][a-z0-9-]*$/

export class Login extends Service {
  static inject = ['accounts', 'browser', 'providers']

  static Config: z<Config> = z.object({
    profilesDir: z.string().description('Directory of per-account login profiles'),
  })

  private readonly profilesDir: string

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'login')
    this.profilesDir = config.profilesDir ?? join(dshHome(), 'system', 'login-profiles')
    // Operator tools, when the MCP endpoint is mounted. Views are secret-free (INV-8).
    ctx.inject(['mcp'], (c) => {
      const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] })
      c.mcp.tool('account_list', { description: 'List provider accounts and their status (no secrets).', inputSchema: {} }, async () => {
        const accounts = await this.ctx.accounts.list()
        return { content: [{ type: 'text', text: JSON.stringify(accounts) }], structuredContent: { accounts } }
      })
      c.mcp.tool('account_save', {
        description: 'Save an account after an interactive login: capture its login profile, verify, and store it encrypted.',
        inputSchema: { account: zod.string().min(1).max(64) },
      }, async ({ account }) => {
        try {
          const view = await this.save(String(account))
          return { content: [{ type: 'text', text: JSON.stringify(view) }], structuredContent: { ...view } }
        } catch (error) {
          return failure(error)
        }
      })
    })
  }

  /** The account's machine-local login profile directory. */
  profileDir(accountId: string): string {
    if (!ID.test(accountId)) throw new ProviderError('invalid_input', `invalid account id ${JSON.stringify(accountId)}`)
    return join(this.profilesDir, accountId)
  }

  /** Capture → verify in a fresh context → store encrypted (revision-guarded). */
  async save(accountId: string): Promise<AccountView> {
    const account = await this.ctx.accounts.get(accountId)
    const driver = this.ctx.providers.get(account.provider)
    const [home] = driver.stateOrigins
    if (!home) throw new ProviderError('config_error', `${driver.provider} declares no state origins`)
    const previous = await this.ctx.accounts.portableState(accountId)
    const { state, result: identity } = await this.ctx.browser.captureProfile(this.profileDir(accountId), {
      url: `${home}/`,
      origins: [...driver.stateOrigins],
      previous,
      inspect: async (page) => {
        const auth = await driver.checkAuth(page)
        if (auth === 'signed-out') throw new ProviderError('reauth_required', `${accountId} is not signed in; log in first`)
        if (auth !== 'signed-in') throw new ProviderError('session_broken', `${accountId}: could not confirm the sign-in`)
        return driver.identity(page)
      },
    })
    const turn = await this.ctx.browser.openTurn(accountId, { state })
    try {
      if ((await driver.checkAuth(turn.page)) !== 'signed-in') {
        throw new ProviderError('reauth_required', `${accountId}: the captured state does not sign in`)
      }
    } finally {
      await turn.close()
    }
    return this.ctx.accounts.saveState(accountId, {
      state,
      identityHash: contentId({ provider: account.provider, identity }),
      verifiedAt: new Date().toISOString(),
    }, account.revision)
  }
}

export default Login
