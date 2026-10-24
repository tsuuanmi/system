import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { showTermsNotice } from '../../provider-gemini-web/tests/site.ts'
import { phase } from '../src/index.ts'
import { ask, turnsStack } from './stack.ts'

const { bootBound, bootBoundChatGpt } = turnsStack()

describe.runIf(canRunBrowser)('ctx.turns: a ChatGPT account works in its own login profile (ADR-0030)', () => {
  it('answers in the profile and writes no copy back; a copy of its state shows the logged-out home (live 2026-10-17)', async () => {
    const { ctx, fake } = await bootBoundChatGpt()
    const before = await ctx.accounts.get('chatgpt-main')
    const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'Where are you?' })).turnId, 60_000)
    expect(turn).toMatchObject({ status: 'completed', account: 'chatgpt-main', answer: 'From the ChatGPT profile.' })
    expect(fake.sent).toEqual([expect.objectContaining({ prompt: 'Where are you?' })])
    expect((await ctx.accounts.get('chatgpt-main')).revision).toBe(before.revision)
    expect(ctx.eventLog.query({ type: 'account.write-back-skipped' })).toEqual([])
    expect(fake.deviceChecks.length).toBeGreaterThan(0)
    expect(fake.deviceChecks.every(Boolean)).toBe(true)
    // What the fresh-context path would have done: the copied state is signed out.
    const copy = await ctx.browser.openTurn('chatgpt-main', { state: await ctx.accounts.portableState('chatgpt-main') })
    try {
      expect(await ctx.providers.get('chatgpt-web').checkAuth(copy.page)).toBe('signed-out')
    } finally {
      await copy.close()
    }
  }, 180_000)

  it('reports a turn that stalls on a page the site signed out as a sign-out, so the account shows it (live 2026-10-17)', async () => {
    const { ctx, fake } = await bootBoundChatGpt({ fake: { thinkMs: 60_000 }, turns: { stallTimeoutMs: 4000 } })
    const { turnId } = await ask(ctx, { prompt: 'Still there?' })
    const deadline = Date.now() + 30_000
    while (fake.sent.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    // The site signs the session out while the answer is pending: its page becomes the logged-out home.
    fake.options.loggedOutHome = true
    const held = (ctx.browser as unknown as { profiles: { held: Map<string, { context: import('patchright-core').BrowserContext }> } }).profiles.held.get('chatgpt-main')!
    await held.context.pages().find((p) => p.url().startsWith(fake.origin))!.reload()
    const done = await ctx.turns.wait(turnId, 60_000)
    expect(done).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'reauth_required', disposition: 'USER_ACTION', message: expect.stringMatching(/signed out \(the turn had failed as provider_stalled/) } })
    expect((await ctx.accounts.get('chatgpt-main')).status).toBe('reauth-required')
    // Sent once, never again on a sign-in (INV-4).
    expect(fake.sent).toHaveLength(1)
  }, 180_000)

  it('fails a stalled turn naming the bound that ended it, where the page is outlined, and what to change (live 2026-10-23)', async () => {
    const { ctx, fake } = await bootBoundChatGpt({ fake: { thinkMs: 60_000 }, turns: { stallTimeoutMs: 4000 } })
    const done = await ctx.turns.wait((await ask(ctx, { prompt: 'Think long' })).turnId, 60_000)
    expect(done).toMatchObject({
      status: 'failed', submitted: true,
      error: { kind: 'provider_stalled', message: expect.stringMatching(/no meaningful progress for 4000ms \(turns\.stallTimeoutMs\): .*system events --type provider\.stall.*raise turns\.stallTimeoutMs/) },
    })
    expect(ctx.eventLog.query({ type: 'provider.stall' })).toHaveLength(1)
    expect(fake.sent).toHaveLength(1)
  }, 180_000)
})

describe.runIf(canRunBrowser)('ctx.turns: a session-bound account works in its own login profile (ADR-0030)', () => {
  it('answers in the profile, writes no copy back, and a copy of its state is signed out (REQ-ACC-4)', async () => {
    const { ctx, fake } = await bootBound()
    const before = await ctx.accounts.get('gemini-main')
    const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'Where are you?' })).turnId, 60_000)
    expect(turn).toMatchObject({ status: 'completed', account: 'gemini-main', answer: 'From the profile.' })
    expect(fake.sent).toEqual([expect.objectContaining({ prompt: 'Where are you?' })])
    expect(await ctx.turns.checkSignIn('gemini-main')).toBe('signed-in')
    // No write-back: the account record is as Save left it.
    expect((await ctx.accounts.get('gemini-main')).revision).toBe(before.revision)
    expect(ctx.eventLog.query({ type: 'account.write-back-skipped' })).toEqual([])
    expect(fake.deviceChecks.length).toBeGreaterThan(0)
    expect(fake.deviceChecks.every(Boolean)).toBe(true)
    // What the fresh-context path would have done: the copied state is signed out.
    const copy = await ctx.browser.openTurn('gemini-main', { state: await ctx.accounts.portableState('gemini-main') })
    try {
      expect(await ctx.providers.get('gemini-web').checkAuth(copy.page)).toBe('signed-out')
    } finally {
      await copy.close()
    }
  }, 180_000)

  it('runs two sessions side by side, each in its own conversation, in tabs of the one profile', async () => {
    const { ctx, fake } = await bootBound({ fake: { answer: (prompt) => `Answer to ${prompt}` } })
    const [a, b] = await Promise.all([ask(ctx, { prompt: 'first', persist: true }), ask(ctx, { prompt: 'second', persist: true })])
    const [ta, tb] = await Promise.all([ctx.turns.wait(a.turnId, 90_000), ctx.turns.wait(b.turnId, 90_000)])
    expect([ta.answer, tb.answer]).toEqual(['Answer to first', 'Answer to second'])
    expect(ta.binding).toBeTruthy()
    expect(tb.binding).toBeTruthy()
    expect(ta.binding).not.toBe(tb.binding)
    expect(fake.conversations.size).toBe(2)
    expect(fake.deviceChecks.every(Boolean)).toBe(true)
  }, 180_000)

  it('waits for the operator: while a login holds the profile, a turn fails as overloaded with nothing sent', async () => {
    const { ctx, fake } = await bootBound()
    const release = await ctx.browser.reserveProfile('gemini-main', ctx.login.profileDir('gemini-main'))
    const held = await ctx.turns.wait((await ask(ctx, { prompt: 'not now' })).turnId, 60_000)
    expect(held).toMatchObject({ status: 'failed', error: expect.objectContaining({ kind: 'overloaded' }) })
    expect(fake.sent).toEqual([])
    release()
    expect((await ctx.turns.wait((await ask(ctx, { prompt: 'now' })).turnId, 60_000)).answer).toBe('From the profile.')
  }, 180_000)

  describe('background checks spread over their interval (PROP-0007)', () => {
    it('gives each account a stable offset of its own within the interval', () => {
      const hour = 60 * 60_000
      const offsets = ['gemini-main', 'gemini-2', 'gemini-3', 'chatgpt-main', 'chatgpt-2'].map((id) => phase(id, 6 * hour))
      expect(offsets.every((o) => o >= 0 && o < 6 * hour)).toBe(true)
      expect(new Set(offsets).size).toBe(5)
      expect(phase('gemini-main', 6 * hour)).toBe(offsets[0])
    })
  })

  describe('kept tabs: a session\'s page between its turns (ADR-0030)', () => {
    /** The page a session's account keeps for it (test-only: read from the pool's state). */
    const keptPage = (ctx: Context, sessionId: string): import('patchright-core').Page => (ctx.browser as unknown as { profiles: { held: Map<string, { kept: Map<string, { page: import('patchright-core').Page }> }> } }).profiles.held.get('gemini-main')!.kept.get(sessionId)!.page
    const kept = (ctx: Context): number => ctx.browser.profileStates().find((p) => p.account === 'gemini-main')?.kept ?? 0
    const session = (): string => `ses_${randomBytes(8).toString('hex')}`
    const turn = async (ctx: Context, prompt: string, sessionId: string) => ctx.turns.wait((await ask(ctx, { prompt, sessionId })).turnId, 60_000)

    it('runs a session\'s three turns on its kept tab: the conversation loads once, and the session\'s end closes the tab', async () => {
      const { ctx, fake } = await bootBound({ fake: { answer: (prompt) => `A: ${prompt}` } })
      const loads = fake.pageLoads.length
      const id = session()
      for (const prompt of ['one', 'two', 'three']) expect(await turn(ctx, prompt, id)).toMatchObject({ status: 'completed', answer: `A: ${prompt}` })
      expect(fake.pageLoads.length - loads).toBe(1)
      expect(fake.conversations.size).toBe(1)
      expect(kept(ctx)).toBe(1)
      ctx.turns.release([id], 'the run ended')
      const deadline = Date.now() + 10_000
      while (kept(ctx) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
      expect(kept(ctx)).toBe(0)
    }, 180_000)

    it('discards the tab after a failed turn: the next turn starts from a fresh page', async () => {
      const { ctx, fake } = await bootBound({ fake: { dropOver: 40 } })
      const loads = fake.pageLoads.length
      const id = session()
      expect(await turn(ctx, 'short', id)).toMatchObject({ status: 'completed' })
      expect(await turn(ctx, 'a prompt long enough for the site to drop it', id)).toMatchObject({ status: 'failed', error: expect.objectContaining({ kind: 'input_dropped' }) })
      expect(kept(ctx)).toBe(0)
      expect(await turn(ctx, 'again', id)).toMatchObject({ status: 'completed' })
      // The first turn's load, and the fresh page's; the failed turn reused the kept tab.
      expect(fake.pageLoads.length - loads).toBe(2)
    }, 180_000)

    it('navigates a kept tab once when it no longer shows its conversation', async () => {
      const { ctx, fake } = await bootBound()
      const id = session()
      await turn(ctx, 'one', id)
      await keptPage(ctx, id).goto(`${fake.origin}/app`)
      const loads = fake.pageLoads.length
      expect(await turn(ctx, 'two', id)).toMatchObject({ status: 'completed' })
      expect(fake.pageLoads.slice(loads)).toEqual([expect.stringMatching(/^\/app\/[0-9a-f]{16}$/)])
    }, 180_000)

    /** The operator's step for a terms notice, as the runbook gives it (Account re-auth). */
    const notice = 'gemini-web: a notice of updated terms ("Keep in mind") covers the input; system never acknowledges it: press the notice\'s own button in the login profile (system account login), then Save'

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
      const deadline = Date.now() + 30_000
      while (fake.sent.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
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
})
