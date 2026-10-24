/**
 * `ctx.login`: account login profiles and the Save flow
 * (docs/design/browser-runtime.md#save-both-modes). Each account has its own login
 * profile, used for interactive login, and for every operation of a session-bound account
 * (ADR-0030). Save reopens that profile invisibly, captures the portable state in memory,
 * verifies it in a fresh context (in the profile itself when session-bound), and stores it
 * encrypted through `ctx.accounts` with a hashed identity. A failed verification saves
 * nothing.
 * @module @tsuuanmi/system-login
 */
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { RemoteLogin, type RemoteSessionInfo } from './remote.ts'
import { TotpCodes } from './totp.ts'
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { AccountView } from '@tsuuanmi/system-accounts'
import { contentId, dshHome, ensurePrivateDir, registerSecretPath } from '@tsuuanmi/system-libs'
import { outline, reply } from '@tsuuanmi/system-gateway-core'
import { ProviderError } from '@tsuuanmi/system-provider-core'

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
  /** Loopback port of the remote login page (default 0: a free one per login, so several accounts sign in at once; PROP-0007). */
  remotePort?: number
  /** How long a credential sign-in waits for an operator-supplied code (default 5 min). */
  codeWaitMs?: number
}

const ID = /^[a-z][a-z0-9-]*$/

export class Login extends Service {
  static inject = ['accounts', 'browser', 'providers']

  static Config: z<Config> = z.object({
    profilesDir: z.string().description('Directory of per-account login profiles'),
    vncPath: z.string().description('VNC server (x0vncserver or x11vnc)'),
    chromePath: z.string().description('Chrome for the remote login desktop'),
    remoteTtlMs: z.natural().default(30 * 60_000).description('Lifetime of a remote login desktop, in milliseconds'),
    remotePort: z.natural().default(0).description('Loopback port of the remote login page (0, the default: a free port per login, so several accounts sign in at once; the CLI prints the tunnel for it)'),
    codeWaitMs: z.natural().default(5 * 60_000).description('How long a sign-in waits for an operator-supplied code, in milliseconds'),
  })

  private readonly profilesDir: string
  /** Remote logins by account, claimed before they start. */
  private readonly remotes = new Map<string, Promise<RemoteLogin>>()
  /** The Save running for each account (one at a time). */
  private readonly saves = new Map<string, Promise<AccountView>>()
  private readonly totp = new TotpCodes()
  private readonly pendingCodes = new Map<string, { kind: 'totp' | 'email'; resolve: (code: string) => void; reject: (error: Error) => void }>()

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, 'login')
    this.profilesDir = config.profilesDir ?? join(dshHome(), 'system', 'login-profiles')
    // Login profiles hold every session signed in through them: agent Workers never read them (ADR-0024).
    ctx.effect(() => registerSecretPath(this.profilesDir))
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.remotes.values()].map(async (r) => (await r).end()))
    })
    // Operator tools, when the MCP endpoint is mounted. Views are secret-free (INV-8).
    ctx.inject(['mcp'], (c) => {
      const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] })
      c.mcp.tool('account_list', { description: 'List provider accounts and their status (no secrets).', inputSchema: {} }, async () => {
        const accounts = await this.ctx.accounts.list()
        return reply({ accounts }, accounts.length ? accounts.map((a) => `${a.id} ${a.status}`).join(', ') : 'no account')
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
      c.mcp.tool('account_set_credentials', {
        description: 'Operator tool: store an account\'s login credentials encrypted (email, password, optional Base32 TOTP secret) and switch it to credential login. Nothing is returned or logged.',
        inputSchema: { account: zod.string().min(1).max(64), email: zod.string().min(3).max(320), password: zod.string().min(1).max(1024), totpSecret: zod.string().max(256).optional() },
      }, async ({ account, email, password, totpSecret }) => {
        try {
          const view = await this.ctx.accounts.setCredentials(String(account), { email: String(email), password: String(password), ...(totpSecret ? { totpSecret: String(totpSecret) } : {}) })
          return { content: [{ type: 'text', text: `credentials stored for ${view.id}` }], structuredContent: { ...view } }
        } catch (error) {
          return failure(error)
        }
      })
      c.mcp.tool('account_relogin', {
        description: 'Operator tool: sign an account in again with its stored credentials (local TOTP; an emailed code is supplied with account_code).',
        inputSchema: { account: zod.string().min(1).max(64) },
      }, async ({ account }) => {
        try {
          const view = await this.relogin(String(account))
          return reply(view, outline(view))
        } catch (error) {
          return failure(error)
        }
      })
      c.mcp.tool('account_code', {
        description: 'Operator tool: supply the one-time code a running sign-in is waiting for.',
        inputSchema: { account: zod.string().min(1).max(64), code: zod.string().min(4).max(10) },
      }, async ({ account, code }) => {
        try {
          this.submitCode(String(account), String(code))
          return { content: [{ type: 'text', text: 'code accepted' }] }
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
          return reply(view, outline(view))
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
    // Claimed before the first wait: a second login for the account joins this one.
    const existing = this.remotes.get(accountId)
    if (existing) return (await existing).info()
    const starting = this.startRemote(accountId, () => {
      if (this.remotes.get(accountId) === starting) this.remotes.delete(accountId)
    })
    this.remotes.set(accountId, starting)
    try {
      return (await starting).info()
    } catch (error) {
      if (this.remotes.get(accountId) === starting) this.remotes.delete(accountId)
      throw error
    }
  }

  private async startRemote(accountId: string, ended: () => void): Promise<RemoteLogin> {
    const account = await this.ctx.accounts.get(accountId)
    const driver = this.ctx.providers.get(account.provider)
    const chromePath = this.config.chromePath ?? this.ctx.browser.executablePath()
    if (!chromePath) throw new ProviderError('config_error', 'no usable Chrome: run `system init`')
    const vncPath = this.config.vncPath ?? findOnPath(['x0vncserver', 'x11vnc'])
    if (!vncPath) throw new ProviderError('config_error', 'remote login needs a VNC server: apt install tigervnc-scraping-server (x0vncserver) or x11vnc')
    const profileDir = this.profileDir(accountId)
    ensurePrivateDir(profileDir)
    // The operator's browser and the automation never share the profile (ADR-0030). The login is
    // refused while operations run in it; while it is open, new ones fail as overloaded and are
    // retried later.
    const release = await this.ctx.browser.reserveProfile(accountId, profileDir)
    try {
      return await RemoteLogin.start({
        account: accountId, profileDir, loginUrl: driver.loginUrl, chromePath, vncPath,
        ttlMs: this.config.remoteTtlMs ?? 30 * 60_000, port: this.config.remotePort ?? 0,
        onSave: () => this.save(accountId),
        onEnded: () => {
          ended()
          release()
        },
      })
    } catch (error) {
      release()
      throw error
    }
  }

  /** Close the account's remote login desktop, if open. */
  async endRemote(accountId: string): Promise<void> {
    await (await this.remotes.get(accountId)?.catch(() => undefined))?.end()
  }

  /**
   * Credential login (ADR-0017): only for an account in `credentials` mode, on its persistent
   * login profile so the device stays recognized. One-time codes come from the local TOTP
   * secret, or from the operator (`submitCode`) when the site emails one. A challenge or a
   * failed sign-in marks the account `reauth-required` and nothing is saved.
   */
  async relogin(accountId: string): Promise<AccountView> {
    // The operator is signing in at the remote login: an automated sign-in would race it.
    if (this.remotes.has(accountId)) throw new ProviderError('overloaded', `${accountId} has a remote login open; the automated sign-in fails now and is retried later`)
    const account = await this.ctx.accounts.get(accountId)
    if (account.loginMode !== 'credentials') throw new ProviderError('invalid_input', `${accountId} uses manual login; run system account login ${accountId}`)
    const driver = this.ctx.providers.get(account.provider)
    if (!driver.signIn) throw new ProviderError('config_error', `${driver.provider} has no credential sign-in`)
    const credentials = await this.ctx.accounts.credentials(accountId)
    if (!credentials) throw new ProviderError('invalid_input', `${accountId} has no stored credentials`)
    const code = async (kind: 'totp' | 'email'): Promise<string> => {
      if (kind === 'totp' && credentials.totpSecret) return this.totp.next(accountId, credentials.totpSecret)
      return this.awaitCode(accountId, kind)
    }
    try {
      return await this.save(accountId, { signIn: (page) => driver.signIn!(page as never, { email: credentials.email, password: credentials.password }, code) })
    } catch (error) {
      if (error instanceof ProviderError && (error.kind === 'challenge' || error.kind === 'reauth_required')) {
        const current = await this.ctx.accounts.get(accountId)
        if (current.status !== 'reauth-required') await this.ctx.accounts.markSignedOut(accountId, 'login-surface', current.revision).catch(() => undefined)
      }
      throw error
    } finally {
      this.pendingCodes.get(accountId)?.reject(new ProviderError('aborted', 'sign-in ended'))
      this.pendingCodes.delete(accountId)
    }
  }

  /** The kind of code a sign-in is waiting for (`email`, or `totp` without a stored secret), if any. */
  pendingCode(accountId: string): 'totp' | 'email' | undefined {
    return this.pendingCodes.get(accountId)?.kind
  }

  /** The operator types the code the site sent them (`system account code <id> <code>`). */
  submitCode(accountId: string, code: string): void {
    const pending = this.pendingCodes.get(accountId)
    if (!pending) throw new ProviderError('invalid_input', `no sign-in is waiting for a code for ${accountId}`)
    if (!/^\d{4,10}$/.test(code)) throw new ProviderError('invalid_input', 'a one-time code is 4 to 10 digits')
    this.pendingCodes.delete(accountId)
    pending.resolve(code)
  }

  private awaitCode(accountId: string, kind: 'totp' | 'email'): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCodes.delete(accountId)
        reject(new ProviderError('reauth_required', `no ${kind} code was supplied for ${accountId} in time; use system account code or the remote login`))
      }, this.config.codeWaitMs ?? 5 * 60_000)
      timer.unref()
      this.pendingCodes.set(accountId, {
        kind,
        resolve: (code) => { clearTimeout(timer); resolve(code) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
    })
  }

  /**
   * Capture → verify in a fresh context → store encrypted (revision-guarded). A session-bound
   * account (ADR-0030) is verified in its profile only: a copy is not how it works, and loading
   * one could end its session. One Save (and so one automated sign-in) per account at a time.
   */
  async save(accountId: string, options: { signIn?: (page: unknown) => Promise<void> } = {}): Promise<AccountView> {
    const previous = this.saves.get(accountId)
    const run = (async () => {
      await previous?.catch(() => undefined)
      return this.saveNow(accountId, options)
    })()
    this.saves.set(accountId, run)
    try {
      return await run
    } finally {
      if (this.saves.get(accountId) === run) this.saves.delete(accountId)
    }
  }

  private async saveNow(accountId: string, options: { signIn?: (page: unknown) => Promise<void> }): Promise<AccountView> {
    const account = await this.ctx.accounts.get(accountId)
    const driver = this.ctx.providers.get(account.provider)
    const [home] = driver.stateOrigins
    if (!home) throw new ProviderError('config_error', `${driver.provider} declares no state origins`)
    const previous = await this.ctx.accounts.portableState(accountId)
    const { state, result: identity } = await this.ctx.browser.captureProfile(accountId, this.profileDir(accountId), {
      url: `${home}/`,
      origins: [...driver.stateOrigins],
      previous,
      inspect: async (page) => {
        let auth = await driver.checkAuth(page)
        if (auth === 'signed-out' && options.signIn) {
          await options.signIn(page)
          auth = await driver.checkAuth(page)
        }
        if (auth === 'signed-out') throw new ProviderError('reauth_required', `${accountId} is not signed in; log in first`)
        if (auth !== 'signed-in') throw new ProviderError('session_broken', `${accountId}: could not confirm the sign-in`)
        return driver.identity(page)
      },
    })
    if (!driver.sessionBound) {
      const turn = await this.ctx.browser.openTurn(accountId, { state })
      try {
        if ((await driver.checkAuth(turn.page)) !== 'signed-in') {
          throw new ProviderError('reauth_required', `${accountId}: the captured state does not sign in`)
        }
      } finally {
        await turn.close()
      }
    }
    return this.ctx.accounts.saveState(accountId, {
      state,
      identityHash: contentId({ provider: account.provider, identity }),
      verifiedAt: new Date().toISOString(),
    }, account.revision, { sameIdentity: !!options.signIn })
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
