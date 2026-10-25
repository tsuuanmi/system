import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { kept, session, turn, turnsStack } from './stack.ts'

const { bootBound } = turnsStack()

describe.runIf(canRunBrowser)('ctx.turns: a kept tab after a failed turn (ADR-0030)', () => {
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
})
