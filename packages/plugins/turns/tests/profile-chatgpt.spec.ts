import { describe, expect, it, vi } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { ask, turnsStack } from './stack.ts'

const { bootBoundChatGpt } = turnsStack()

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
    // The turn's stall clock stands still until the page has been reloaded as signed out, then
    // moves 1 s per read: the stall can only fire after the reload, however slow it was.
    let ticking = false
    let clock = 0
    ctx.turns.stallClock = () => (ticking ? (clock += 1000) : clock)
    const { turnId } = await ask(ctx, { prompt: 'Still there?' })
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1), { timeout: 30_000, interval: 100 })
    // The site signs the session out while the answer is pending: its page becomes the logged-out home.
    fake.options.loggedOutHome = true
    const held = (ctx.browser as unknown as { profiles: { held: Map<string, { context: import('patchright-core').BrowserContext }> } }).profiles.held.get('chatgpt-main')!
    await held.context.pages().find((p) => p.url().startsWith(fake.origin))!.reload()
    ticking = true
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
