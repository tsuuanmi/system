/**
 * `ctx.login`: account login profiles and the Save flow
 * (docs/design/browser-runtime.md#save-both-modes). Each account has its own login
 * profile, used only for interactive login. Save reopens that profile invisibly,
 * captures the portable state in memory, verifies it in a fresh context, and stores it
 * encrypted through `ctx.accounts` with a hashed identity. A failed verification saves
 * nothing.
 * @module @tsuuanmi/system-login
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { RemoteLogin, type RemoteSessionInfo } from './remote.ts'
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { AccountView } from '@tsuuanmi/system-accounts'
import { discoverChrome } from '@tsuuanmi/system-browser-patchright'
import { contentId, dshHome, ensurePrivateDir } from '@tsuuanmi/system-libs'
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
  /** VNC server for the remote login desktop: x0vncserver (TigerVNC) or x11vnc (default: first found on PATH). */
  vncPath?: string
  /** Chrome for the remote login desktop (default: the same discovery as ctx.browser). */
  chromePath?: string
  /** How long a remote login desktop stays open (default 30 min). */
  remoteTtlMs?: number
  /** Loopback port of the remote login page (default 47318; 0 picks a free one). */
  remotePort?: number
}

const ID = /^[a-z][a-z0-9-]*$/

export class Login extends Service {
  static inject = ['accounts', 'browser', 'providers']

  static Config: z<Config> = z.object({
    profilesDir: z.string().description('Directory of per-account login profiles'),
    vncPath: z.string().description('VNC server (x0vncserver or x11vnc)'),
    chromePath: z.string().description('Chrome for the remote login desktop'),
    remoteTtlMs: z.natural().default(30 * 60_000).description('Lifetime of a remote login desktop, in milliseconds'),
    remotePort: z.natural().default(47318).description('Loopback port of the remote login page (0 = any free port)'),
  })

  private readonly profilesDir: string
  private readonly remotes = new Map<string, RemoteLogin>()

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'login')
    this.profilesDir = config.profilesDir ?? join(dshHome(), 'system', 'login-profiles')
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.remotes.values()].map((r) => r.end()))
    })
    // Operator tools, when the MCP endpoint is mounted. Views are secret-free (INV-8).
    ctx.inject(['mcp'], (c) => {
      const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] })
      c.mcp.tool('account_list', { description: 'List provider accounts and their status (no secrets).', inputSchema: {} }, async () => {
        const accounts = await this.ctx.accounts.list()
        return { content: [{ type: 'text', text: JSON.stringify(accounts) }], structuredContent: { accounts } }
      })
      c.mcp.tool('account_login', {
        description: 'Open a remote login desktop for an account (noVNC over an SSH tunnel). Returns the URL and the ssh -L command; the operator signs in and presses Save account.',
        inputSchema: { account: zod.string().min(1).max(64) },
      }, async ({ account }) => {
        try {
          const info = await this.remote(String(account))
          return { content: [{ type: 'text', text: `${info.sshCommand}\nthen open ${info.url}` }], structuredContent: { ...info } }
        } catch (error) {
          return failure(error)
        }
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

  /**
   * Open (or return) the account's remote login desktop. Save stores the account through
   * {@link save} after the login Chrome has exited; the desktop closes itself afterwards.
   */
  async remote(accountId: string): Promise<RemoteSessionInfo> {
    const existing = this.remotes.get(accountId)
    if (existing) return existing.info()
    const account = await this.ctx.accounts.get(accountId)
    const driver = this.ctx.providers.get(account.provider)
    const chrome = discoverChrome(this.config.chromePath)
    if (!chrome) throw new ProviderError('config_error', 'no usable Chrome: run `system init`')
    const vncPath = this.config.vncPath ?? findOnPath(['x0vncserver', 'x11vnc'])
    if (!vncPath) throw new ProviderError('config_error', 'remote login needs a VNC server: apt install tigervnc-scraping-server (x0vncserver) or x11vnc')
    const profileDir = this.profileDir(accountId)
    ensurePrivateDir(profileDir)
    const session = await RemoteLogin.start({
      account: accountId, profileDir, loginUrl: driver.loginUrl, chromePath: chrome.path, vncPath,
      ttlMs: this.config.remoteTtlMs ?? 30 * 60_000, port: this.config.remotePort ?? 47318,
      onSave: () => this.save(accountId),
      onEnded: () => this.remotes.delete(accountId),
    })
    this.remotes.set(accountId, session)
    return session.info()
  }

  /** Close the account's remote login desktop, if open. */
  async endRemote(accountId: string): Promise<void> {
    await this.remotes.get(accountId)?.end()
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

/** The first of `names` found as an executable on PATH. */
function findOnPath(names: readonly string[]): string | undefined {
  for (const name of names) {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      const candidate = join(dir, name)
      if (dir && existsSync(candidate)) return candidate
    }
  }
  return undefined
}

export type { RemoteSessionInfo } from './remote.ts'
export default Login
