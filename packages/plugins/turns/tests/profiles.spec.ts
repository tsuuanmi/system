import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { phase } from '../src/index.ts'
import { ask, turnsStack } from './stack.ts'

const { bootBound } = turnsStack()

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
})
