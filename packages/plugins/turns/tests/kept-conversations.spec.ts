import { ProviderError } from '@tsuuanmi/system-provider-core'
import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { ask, liveChecked, turnsStack } from './stack.ts'

const { boot } = turnsStack()

describe.runIf(canRunBrowser)('ctx.turns: a released conversation kept, or failing to delete (PROP-0004 Phase 5)', () => {
  it('fails closed on a driver that cannot say its delete flow is checked, and keeps a conversation no driver can delete', async () => {
    const { ctx, fake } = await boot()
    liveChecked(ctx)
    const driver = ctx.providers.get('chatgpt-web') as unknown as Record<string, unknown>
    const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'unchecked', persist: true })).turnId, 30_000)
    const method = driver.deletionUnverified
    // An own property hides the prototype's method, as a driver without it would.
    driver.deletionUnverified = undefined
    ctx.turns.release([turn.sessionId!], 'run run_e deleted')
    await ctx.turns.deleteConversations()
    expect(ctx.turns.conversations({ sessionId: turn.sessionId! })[0]).toMatchObject({ state: 'due', reason: expect.stringMatching(/^unverified-map: \(the driver does not report its delete flow as checked\)/) })
    driver.deletionUnverified = method
    driver.deleteConversation = undefined
    await ctx.turns.deleteConversations()
    expect(ctx.turns.conversations({ sessionId: turn.sessionId! })[0]).toMatchObject({ state: 'kept', reason: 'chatgpt-web cannot delete a conversation' })
    expect(fake.deleteRequests).toEqual([])
  }, 120_000)

  it('keeps a due conversation due while its account cannot be read, and keeps it only once the account is removed (INV-2)', async () => {
    const { ctx, fake } = await boot()
    liveChecked(ctx)
    const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'unreadable account', persist: true })).turnId, 30_000)
    const accounts = ctx.accounts as unknown as { get: (id: string) => Promise<unknown> }
    const get = accounts.get
    try {
      // The vault cannot be read now: the account is unknown, not removed.
      accounts.get = async () => { throw new Error('vault: authentication failed (wrong key or modified file)') }
      ctx.turns.release([turn.sessionId!], 'run run_v deleted')
      await ctx.turns.deleteConversations()
      await expect.poll(() => ctx.turns.conversations({ sessionId: turn.sessionId! })[0], { timeout: 30_000 }).toMatchObject({ state: 'due', reason: expect.stringMatching(/^the account cannot be read: vault: authentication failed/) })
      // The catalog no longer has it: removed, so the conversation is kept, and says why.
      accounts.get = async (id: string) => { throw new ProviderError('invalid_input', `unknown account ${id}`) }
      await ctx.turns.deleteConversations()
      await expect.poll(() => ctx.turns.conversations({ sessionId: turn.sessionId! })[0], { timeout: 30_000 }).toMatchObject({ state: 'kept', reason: 'the account was removed' })
    } finally {
      accounts.get = get
    }
    expect(fake.deleteRequests).toEqual([])
  }, 120_000)

  it('keeps a Deep research conversation until a live check, and reports a deletion that fails three times', async () => {
    const { ctx, fake } = await boot({ fake: { researchMs: 500, report: 'r', deleteMenu: false } })
    liveChecked(ctx)
    const research = await ctx.turns.wait((await ask(ctx, { prompt: 'Survey it', research: true })).turnId, 60_000)
    const chat = await ctx.turns.wait((await ask(ctx, { prompt: 'plain', persist: true })).turnId, 30_000)
    ctx.turns.release([research.sessionId!, chat.sessionId!], 'run run_z deleted')
    await expect.poll(() => ctx.turns.conversations({ sessionId: research.sessionId! })[0], { timeout: 60_000 })
      .toMatchObject({ state: 'kept', reason: expect.stringMatching(/deep-research conversation is not deleted until a live check/) })
    // No Delete in the menu: each attempt fails and deletes nothing; the third is reported.
    for (let pass = 0; pass < 3 && ctx.turns.conversations({ sessionId: chat.sessionId! })[0]?.state === 'due'; pass++) await ctx.turns.deleteConversations()
    expect(ctx.turns.conversations({ sessionId: chat.sessionId! })[0]).toMatchObject({ state: 'failed', attempts: 3, reason: expect.stringMatching(/^ui_drift/) })
    expect(ctx.eventLog.query({ type: 'conversation.delete-failed' })).toHaveLength(1)
    expect(fake.deleted.size).toBe(0)
  }, 240_000)
})
