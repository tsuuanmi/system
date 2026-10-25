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
