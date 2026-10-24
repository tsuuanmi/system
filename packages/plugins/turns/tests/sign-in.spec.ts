import { contentId } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { AdmissionFailure, type WorkRequirement } from '@tsuuanmi/system-workers'
import { describe, expect, it, vi } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { account, ask, fromCopies, turnsStack } from './stack.ts'

const { boot } = turnsStack()

describe.runIf(canRunBrowser)('ctx.turns: an account\'s sign-in and its saved state', () => {
  it('re-verifies a falsely signed-out account from its stored state, without a login, and keeps a really signed-out one marked (REQ-ACC-5)', async () => {
    // A "Log in" offer beside the composer: the maps before 431508f took it for a sign-out.
    const { ctx, fake } = await boot({ fake: { loginOffer: true, answer: 'back' } })
    const ready = await ctx.accounts.get('chatgpt-main')
    expect(await ctx.turns.verify('chatgpt-main')).toMatchObject({ status: 'ready', verified: false, reason: expect.stringMatching(/only a reauth-required account/) })
    await ctx.accounts.markSignedOut('chatgpt-main', 'login-surface', ready.revision)
    const restored = await ctx.turns.verify('chatgpt-main')
    expect(restored).toMatchObject({ account: 'chatgpt-main', status: 'ready', verified: true })
    const view = await ctx.accounts.get('chatgpt-main')
    expect(view.status).toBe('ready')
    expect(Date.parse(view.verifiedAt!)).toBeGreaterThan(Date.parse(ready.verifiedAt!))
    expect(ctx.eventLog.query({ type: 'account.re-verified' })).toEqual([expect.objectContaining({ data: expect.objectContaining({ account: 'chatgpt-main' }) })])
    // Nothing was sent to verify; the account works again.
    expect(fake.sent).toEqual([])
    expect((await ctx.turns.wait((await ask(ctx, { prompt: 'are you back?' })).turnId, 30_000)).answer).toBe('back')
    // Really signed out: it stays marked, and says what to do.
    fake.options.signedIn = false
    await ctx.accounts.markSignedOut('chatgpt-main', 'login-surface', (await ctx.accounts.get('chatgpt-main')).revision)
    expect(await ctx.turns.verify('chatgpt-main')).toMatchObject({ status: 'reauth-required', verified: false, reason: expect.stringMatching(/does not sign in: sign in again/) })
    expect((await ctx.accounts.get('chatgpt-main')).status).toBe('reauth-required')
  }, 90_000)

  it('marks an account challenged when its site shows a check only the operator can pass: its Workers stop, nothing is sent (live 2026-10-16)', async () => {
    const { ctx, fake } = await boot()
    const driver = ctx.providers.get('chatgpt-web') as unknown as { checkAuth: () => Promise<string> }
    driver.checkAuth = async () => {
      throw new ProviderError('challenge', 'chatgpt-web: the site shows a CAPTCHA')
    }
    const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'blocked' })).turnId, 30_000)
    expect(turn).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'challenge', disposition: 'USER_ACTION' } })
    expect((await ctx.accounts.get('chatgpt-main')).status).toBe('challenge')
    expect((await ctx.workers.list()).filter((w) => w.worker.startsWith('worker:chatgpt-main/')).every((w) => w.state === 'unavailable')).toBe(true)
    expect(ctx.eventLog.query({ type: 'account.challenged' })).toEqual([expect.objectContaining({ data: expect.objectContaining({ account: 'chatgpt-main' }) })])
    expect(fake.sent).toEqual([])
  }, 90_000)

  it('takes every Worker of two accounts signed in as one person out of work, and sends nothing on a turn routed before (REQ-ACC-7)', async () => {
    const { ctx, fake } = await boot({ accounts: [account('chatgpt-main'), account('chatgpt-2')], ready: ['chatgpt-main', 'chatgpt-2'] })
    const statesOf = async (): Promise<string[]> => [...new Set((await ctx.workers.list()).map((w) => w.state))]
    expect(await statesOf()).toEqual(['ready'])
    const requirement: WorkRequirement = {
      schema: 'work-requirement@1.0', objective: 'x', capabilities: ['reason'], data: { classification: 'public', refs: [] }, egressPolicy: 'egress.classification-and-secrets',
      tier: { min: 'standard', source: 'default' }, acceptance: { contract: 'acceptance.answer' },
    }
    // Routed to chatgpt-main while the two were distinct; then chatgpt-2 is signed in as the same person.
    const admitted = await ctx.workers.route(requirement, { restrict: { workers: ['worker:chatgpt-main/standard'], reason: 'test' } })
    const saved = await ctx.accounts.get('chatgpt-2')
    await ctx.accounts.saveState('chatgpt-2', {
      state: { origins: [fake.origin], cookies: [], capturedAt: '2026-10-23T00:00:00Z' },
      identityHash: contentId({ provider: 'chatgpt-web', identity: `chatgpt-web:${fake.options.userId}` }), verifiedAt: '2026-10-23T00:00:00Z',
    }, saved.revision)
    expect(await ctx.accounts.duplicateIdentities()).toEqual([['chatgpt-main', 'chatgpt-2']])
    // Both entries, every tier: neither is a distinct account, and their status is untouched.
    expect(await statesOf()).toEqual(['unavailable'])
    expect((await ctx.accounts.list()).map((a) => a.status)).toEqual(['ready', 'ready'])
    await expect(ctx.workers.route(requirement)).rejects.toBeInstanceOf(AdmissionFailure)
    const started = ctx.turns.ask({ key: 'routed-before', worker: admitted.worker.worker, prompt: 'never sent', requirement, decisions: admitted.decisions })
    admitted.release()
    const turn = await ctx.turns.wait(started.turnId, 30_000)
    expect(turn).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'reauth_required', disposition: 'USER_ACTION', message: expect.stringMatching(/chatgpt-main is signed in as the same person as chatgpt-2.*nothing was sent/) } })
    expect(fake.sent).toEqual([])
    // Signed in as another person, chatgpt-2 is a distinct account again, and both take work.
    await ctx.accounts.saveState('chatgpt-2', {
      state: { origins: [fake.origin], cookies: [], capturedAt: '2026-10-23T00:00:00Z' },
      identityHash: contentId({ provider: 'chatgpt-web', identity: 'chatgpt-web:someone-else' }), verifiedAt: '2026-10-23T00:00:00Z',
    })
    expect(await ctx.accounts.duplicateIdentities()).toEqual([])
    expect(await statesOf()).toEqual(['ready'])
  }, 90_000)

  it('checks a ready account\'s sign-in, sending nothing, and marks it signed out only on positive evidence (health sees it before a turn)', async () => {
    const { ctx, fake } = await boot({ fake: { loginOffer: true } })
    expect(await ctx.turns.checkSignIn('chatgpt-main')).toBe('signed-in')
    expect((await ctx.accounts.get('chatgpt-main')).status).toBe('ready')
    fake.options.signedIn = false
    expect(await ctx.turns.checkSignIn('chatgpt-main')).toBe('signed-out')
    expect((await ctx.accounts.get('chatgpt-main')).status).toBe('reauth-required')
    expect(ctx.eventLog.query({ type: 'account.signed-out' })).toEqual([expect.objectContaining({ data: { account: 'chatgpt-main', by: 'sign-in check' } })])
    // An account that is not ready is not checked again.
    expect(await ctx.turns.checkSignIn('chatgpt-main')).toBe('unknown')
    expect(fake.sent).toEqual([])
  }, 90_000)

  it('writes back the state a signed-in check refreshed, and never one from a check that found it signed out', async () => {
    const { ctx, fake } = await boot({ fake: { rotateOnLoad: true } })
    fromCopies(ctx)
    const before = await ctx.accounts.get('chatgpt-main')
    expect(await ctx.turns.checkSignIn('chatgpt-main')).toBe('signed-in')
    const after = await ctx.accounts.get('chatgpt-main')
    expect(after.revision).toBe(before.revision + 1)
    expect((await ctx.accounts.portableState('chatgpt-main'))?.cookies.map((c) => c.name)).toContain('session_seen')
    // Signed out: marked, and the page's state is never kept.
    fake.options.signedIn = false
    const kept = await ctx.accounts.portableState('chatgpt-main')
    expect(await ctx.turns.checkSignIn('chatgpt-main')).toBe('signed-out')
    expect(await ctx.accounts.portableState('chatgpt-main')).toEqual(kept)
    expect(ctx.eventLog.query({ type: 'account.write-back-skipped' })).toEqual([])
    expect(fake.sent).toEqual([])
  }, 90_000)

  it('signs a credentials-mode account back in when it was signed out, then runs the turn', async () => {
    const { ctx, fake } = await boot({ fake: { requireCookie: true, mfa: 'totp', answer: 'after relogin' } })
    await ctx.accounts.setCredentials('chatgpt-main', { email: fake.options.email, password: fake.options.password, totpSecret: fake.options.totpSecret })
    const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'x' })).turnId, 90_000)
    expect(turn).toMatchObject({ status: 'completed', answer: 'after relogin' })
    expect(fake.sent).toHaveLength(1)
    expect(await ctx.accounts.get('chatgpt-main')).toMatchObject({ status: 'ready' })
  }, 150_000)

  it('signs in again only before anything was sent: a sign-out seen after the send fails the turn, never resent (INV-4)', async () => {
    const { ctx, fake } = await boot()
    await ctx.accounts.setCredentials('chatgpt-main', { email: fake.options.email, password: fake.options.password })
    // A driver that sends (its receipt is written), then finds itself signed out.
    const chatgpt = ctx.providers.get('chatgpt-web')
    let asks = 0
    const ask0 = chatgpt.ask.bind(chatgpt)
    chatgpt.ask = async (page, prompt, options) => {
      asks++
      await options.beforeSend?.({ previousResponse: null, mode: {} })
      throw new ProviderError('reauth_required', 'signed out after the send')
    }
    try {
      const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'sent once' })).turnId, 60_000)
      expect(turn).toMatchObject({ status: 'failed', error: { kind: 'reauth_required' } })
      expect(asks).toBe(1)
    } finally {
      chatgpt.ask = ask0
    }
  }, 120_000)

  it('marks the account reauth-required on positive sign-out evidence, so the next turn routes elsewhere (REQ-ACC-5)', async () => {
    const { ctx } = await boot({ fake: { signedIn: false } })
    const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'x' })).turnId, 30_000)
    expect(turn).toMatchObject({ status: 'failed', error: { kind: 'reauth_required' } })
    expect(await ctx.accounts.get('chatgpt-main')).toMatchObject({ status: 'reauth-required' })
  }, 60_000)

  it('writes the refreshed browser state back to the account after a turn', async () => {
    const { ctx } = await boot()
    fromCopies(ctx)
    const before = await ctx.accounts.get('chatgpt-main')
    await ctx.turns.wait((await ask(ctx, { prompt: 'refresh me' })).turnId, 30_000)
    const after = await ctx.accounts.get('chatgpt-main')
    expect(after.revision).toBe(before.revision + 1)
    expect((await ctx.accounts.portableState('chatgpt-main'))?.cookies.map((c) => c.name)).toContain('session_refresh')
  }, 90_000)

  it('never overwrites a sign-in saved while a turn ran: its write-back is at a stale revision and is skipped', async () => {
    const { ctx, fake } = await boot({ fake: { thinkMs: 1500 } })
    const started = await ask(ctx, { prompt: 'slow one' })
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1), { timeout: 30_000, interval: 100 })
    // The operator saves the account (Save or relogin) while the turn is still answering.
    const saved = { origins: [fake.origin], cookies: [{ name: 'saved_by_operator', value: 'v', domain: '127.0.0.1', path: '/' }], capturedAt: '2026-10-12T00:00:00Z' }
    await ctx.accounts.saveState('chatgpt-main', { state: saved, identityHash: `sha256:${'a'.repeat(64)}`, verifiedAt: '2026-10-12T00:00:00Z' })
    expect((await ctx.turns.wait(started.turnId, 30_000)).status).toBe('completed')
    expect((await ctx.accounts.portableState('chatgpt-main'))?.cookies.map((c) => c.name)).toEqual(['saved_by_operator'])
  }, 90_000)
})
