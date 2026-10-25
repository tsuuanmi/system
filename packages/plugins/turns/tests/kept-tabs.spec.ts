import { describe, expect, it, vi } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { kept, keptPage, session, turn, turnsStack } from './stack.ts'

const { bootBound } = turnsStack()

describe.runIf(canRunBrowser)('ctx.turns: kept tabs: a session\'s page between its turns (ADR-0030)', () => {
  it('runs a session\'s three turns on its kept tab: the conversation loads once, and the session\'s end closes the tab', async () => {
    const { ctx, fake } = await bootBound({ fake: { answer: (prompt) => `A: ${prompt}` } })
    const loads = fake.pageLoads.length
    const id = session()
    for (const prompt of ['one', 'two', 'three']) expect(await turn(ctx, prompt, id)).toMatchObject({ status: 'completed', answer: `A: ${prompt}` })
    expect(fake.pageLoads.length - loads).toBe(1)
    expect(fake.conversations.size).toBe(1)
    expect(kept(ctx)).toBe(1)
    ctx.turns.release([id], 'the run ended')
    await vi.waitFor(() => expect(kept(ctx)).toBe(0), { timeout: 10_000, interval: 50 })
  }, 180_000)

  it('discards the tab after a failed turn: the next turn starts from a fresh page', async () => {
    const { ctx, fake } = await bootBound({ fake: { dropOver: 40 } })
    // The dropped send fails its check after a small bound, not the map's 20 s.
    const send = (ctx.providers.get('gemini-web') as unknown as { map: { actions: Record<string, { timeouts?: Record<string, number> }> } }).map.actions['composer.send']!
    send.timeouts = { ...send.timeouts, verifyMs: 5000 }
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
})
