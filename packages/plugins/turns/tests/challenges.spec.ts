import { describe, expect, it, vi } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { showTermsNotice } from '../../provider-gemini-web/tests/site.ts'
import { ask, kept, keptPage, notice, session, turn, turnsStack } from './stack.ts'

const { bootBound } = turnsStack()

describe.runIf(canRunBrowser)('ctx.turns: a site\'s notice or check over a session-bound account\'s page waits for the operator (ADR-0030)', () => {
  it('fails a turn once at a terms notice over the input, with nothing sent: the account waits for the operator, and Save is refused while the notice shows (live 2026-10-17)', async () => {
    const { ctx, fake } = await bootBound()
    // Shown after Save, as the site showed it live.
    fake.options.termsNotice = true
    const message = notice
    const loads = fake.pageLoads.length
    const done = await ctx.turns.wait((await ask(ctx, { prompt: 'hello' })).turnId, 60_000)
    expect(done).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'challenge', disposition: 'USER_ACTION', message } })
    expect(fake.sent).toEqual([])
    // One page, no retry on a new session.
    expect(fake.pageLoads.length - loads).toBe(1)
    expect((await ctx.accounts.get('gemini-main')).status).toBe('challenge')
    await expect(ctx.login.save('gemini-main')).rejects.toMatchObject({ kind: 'challenge', message })
  }, 180_000)

  it('fails a session\'s turn at a terms notice that shows mid-session on its kept tab as the operator\'s challenge, never drift, with nothing more sent (T125)', async () => {
    const { ctx, fake } = await bootBound()
    const id = session()
    expect(await turn(ctx, 'one', id)).toMatchObject({ status: 'completed' })
    // The site shows its notice on the page the session keeps, the account's button hidden with it (live 2026-10-16).
    await showTermsNotice(keptPage(ctx, id), { hideAccount: true })
    const loads = fake.pageLoads.length
    expect(await turn(ctx, 'two', id)).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'challenge', disposition: 'USER_ACTION', message: notice } })
    expect(fake.sent).toHaveLength(1)
    expect(fake.pageLoads.length).toBe(loads)
    expect((await ctx.accounts.get('gemini-main')).status).toBe('challenge')
    expect(ctx.eventLog.query({ type: 'account.challenged' })).toEqual([expect.objectContaining({ data: { account: 'gemini-main', reason: notice } })])
    expect(ctx.eventLog.query({ type: 'ui.drift' })).toEqual([])
  }, 180_000)

  it('never loads a site for a background probe or sign-in check that waited while its account was challenged', async () => {
    const { ctx, fake } = await bootBound({ fake: { holdAnswer: true }, turns: { maxConcurrentTurnsPerAccount: 1, stallTimeoutMs: 4000, turnTimeoutMs: 20_000 } })
    // A turn holds the account's one slot (its answer never comes, so it stalls), and a probe and a check queue behind it.
    const { turnId } = await ask(ctx, { prompt: 'held' })
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1), { timeout: 30_000, interval: 100 })
    const loads = fake.pageLoads.length
    const probing = ctx.turns.probe('gemini-main').then(() => 'probed', (error: unknown) => (error as Error).message)
    const checking = ctx.turns.checkSignIn('gemini-main')
    // The site shows its check meanwhile: the account is challenged before they get the slot.
    await ctx.accounts.markChallenge('gemini-main', 'a check shown to another page')
    await ctx.turns.wait(turnId, 60_000)
    expect(await probing).toBe('gemini-main is challenge')
    expect(await checking).toBe('unknown')
    expect(fake.pageLoads.length).toBe(loads)
  }, 180_000)

  it('checks a kept tab again: Google\'s check shown over it while idle fails as an open would, with nothing sent or loaded, and the tab is discarded', async () => {
    const { ctx, fake } = await bootBound()
    const id = session()
    await turn(ctx, 'one', id)
    // Still showing its conversation, so the turn does not reload it: the check runs on the page as it stands.
    await keptPage(ctx, id).evaluate(() => document.body.insertAdjacentHTML('beforeend', '<iframe title="reCAPTCHA" src="/recaptcha/api2/anchor" style="width:304px;height:78px"></iframe>'))
    const sent = fake.sent.length
    const loads = fake.pageLoads.length
    expect(await turn(ctx, 'two', id)).toMatchObject({ status: 'failed', error: expect.objectContaining({ kind: 'challenge' }) })
    expect((await ctx.accounts.get('gemini-main')).status).toBe('challenge')
    expect(fake.sent.length).toBe(sent)
    // Checked as it stood: nothing was loaded first.
    expect(fake.pageLoads.length).toBe(loads)
    expect(kept(ctx)).toBe(0)
  }, 180_000)
})
