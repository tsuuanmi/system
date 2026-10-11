import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Vault from '@tsuuanmi/system-credentials-vault'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { afterEach, describe, expect, it } from 'vitest'
import Accounts, { type PortableState } from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const catalog = [
  { id: 'chatgpt-main', provider: 'chatgpt-web', quotaClass: 'subscription-chat' as const, tiers: { economy: 'instant', frontier: 'pro' } },
  { id: 'chatgpt-2', provider: 'chatgpt-web', quotaClass: 'subscription-chat' as const, tiers: { standard: 'thinking' } },
]

async function boot(accounts = catalog): Promise<{ ctx: Context; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'system-accounts-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fibers = [ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }), ctx.plugin(Accounts, { accounts })]
  await Promise.all(fibers)
  cleanups.push(() => fibers[0]!.dispose())
  return { ctx, dir }
}

const state: PortableState = {
  origins: ['https://chatgpt.com'],
  cookies: [{ name: 'session-token', value: 'cookie-secret-marker', domain: '.chatgpt.com', path: '/' }],
  localStorage: [], indexedDB: { status: 'captured', data: [] }, capturedAt: '2026-10-11T08:00:00Z',
}

describe('ctx.accounts', () => {
  it('lists the configured catalog as secret-free views, all new until signed in', async () => {
    const { ctx } = await boot()
    expect(await ctx.accounts.list()).toEqual([
      { id: 'chatgpt-main', provider: 'chatgpt-web', quotaClass: 'subscription-chat', tiers: { economy: 'instant', frontier: 'pro' }, status: 'new', loginMode: 'manual', revision: 0 },
      { id: 'chatgpt-2', provider: 'chatgpt-web', quotaClass: 'subscription-chat', tiers: { standard: 'thinking' }, status: 'new', loginMode: 'manual', revision: 0 },
    ])
  })

  it('saves portable state encrypted and marks the account ready', async () => {
    const { ctx, dir } = await boot()
    const view = await ctx.accounts.saveState('chatgpt-main', { state, identityHash: `sha256:${'a'.repeat(64)}`, verifiedAt: '2026-10-11T08:00:00Z' })
    expect(view).toMatchObject({ status: 'ready', revision: 1 })
    expect(JSON.stringify(view)).not.toContain('cookie-secret-marker')
    expect(await ctx.accounts.portableState('chatgpt-main')).toEqual(state)
    expect(readFileSync(join(dir, 'vault.enc'), 'utf8')).not.toContain('cookie-secret-marker')
  })

  it('marks reauth-required only on positive sign-out evidence, guarded by revision', async () => {
    const { ctx } = await boot()
    await ctx.accounts.saveState('chatgpt-main', { state, identityHash: `sha256:${'a'.repeat(64)}`, verifiedAt: '2026-10-11T08:00:00Z' })
    await expect(ctx.accounts.markSignedOut('chatgpt-main', 'unknown' as never, 1)).rejects.toThrow(/evidence/)
    expect(await ctx.accounts.markSignedOut('chatgpt-main', 'login-url', 1)).toMatchObject({ status: 'reauth-required', revision: 2 })
    await expect(ctx.accounts.markSignedOut('chatgpt-main', 'login-url', 1)).rejects.toThrow(/revision/)
  })

  it('records a challenge without treating it as a sign-out', async () => {
    const { ctx } = await boot()
    await ctx.accounts.saveState('chatgpt-main', { state, identityHash: `sha256:${'a'.repeat(64)}`, verifiedAt: '2026-10-11T08:00:00Z' })
    expect(await ctx.accounts.markChallenge('chatgpt-main', 'cf-challenge')).toMatchObject({ status: 'challenge' })
    expect(await ctx.accounts.portableState('chatgpt-main')).toEqual(state)
  })

  it('stores login credentials in a separate encrypted record and switches to credential login', async () => {
    const { ctx, dir } = await boot()
    const view = await ctx.accounts.setCredentials('chatgpt-main', { email: 'me@example.com', password: 'pw-marker', totpSecret: 'JBSWY3DPEHPK3PXP' })
    expect(view.loginMode).toBe('credentials')
    expect(await ctx.accounts.credentials('chatgpt-main')).toEqual({ email: 'me@example.com', password: 'pw-marker', totpSecret: 'JBSWY3DPEHPK3PXP' })
    expect(readFileSync(join(dir, 'vault.enc'), 'utf8')).not.toMatch(/pw-marker|JBSWY3DP/)
  })

  it('flags accounts that resolve to the same identity', async () => {
    const { ctx } = await boot()
    const same = `sha256:${'b'.repeat(64)}` as const
    await ctx.accounts.saveState('chatgpt-main', { state, identityHash: same, verifiedAt: '2026-10-11T08:00:00Z' })
    await ctx.accounts.saveState('chatgpt-2', { state, identityHash: same, verifiedAt: '2026-10-11T08:00:00Z' })
    expect(await ctx.accounts.duplicateIdentities()).toEqual([['chatgpt-main', 'chatgpt-2']])
  })

  it('rejects unknown accounts and invalid catalogs', async () => {
    const { ctx } = await boot()
    await expect(ctx.accounts.portableState('nope')).rejects.toThrow(ProviderError)
    const ctx2 = new Context()
    await expect(async () => {
      const fiber = ctx2.plugin(Accounts, { accounts: [catalog[0]!, catalog[0]!] })
      await fiber
      if (ctx2.get('accounts') === undefined) throw new Error('duplicate account id rejected')
    }).rejects.toThrow()
  })
})
