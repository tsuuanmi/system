import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { ask, liveChecked, turnsStack } from './stack.ts'

const { boot } = turnsStack()

describe.runIf(canRunBrowser)('ctx.turns: the conversation ledger (PROP-0004 Phase 5)', () => {
  it('deletes nothing while the delete flow\'s map entries are not checked on the live site: the conversation waits, due', async () => {
    const { ctx, fake } = await boot()
    const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'not yet', persist: true })).turnId, 30_000)
    ctx.turns.release([turn.sessionId!], 'run run_u deleted')
    await ctx.turns.deleteConversations()
    expect(ctx.turns.conversations({ sessionId: turn.sessionId! })[0]).toMatchObject({ state: 'due', attempts: 0, reason: expect.stringMatching(/^unverified-map: conversation\.choose-delete, conversation\.confirm-delete, /) })
    expect(fake.deleteRequests).toEqual([])
    liveChecked(ctx)
    await ctx.turns.deleteConversations()
    expect(ctx.turns.conversations({ sessionId: turn.sessionId! })[0]).toMatchObject({ state: 'deleted', attempts: 1 })
  }, 120_000)

  it('records every conversation it binds, and deletes a released session\'s on its site, once, as one retention decision (REQ-PRV-8)', async () => {
    const { ctx, fake } = await boot({ fake: { answer: 'kept' } })
    liveChecked(ctx)
    const persistent = await ctx.turns.wait((await ask(ctx, { prompt: 'remember this', persist: true })).turnId, 30_000)
    const other = await ctx.turns.wait((await ask(ctx, { prompt: 'and this', persist: true })).turnId, 30_000)
    const temporary = await ctx.turns.wait((await ask(ctx, { prompt: 'just once' })).turnId, 30_000)
    expect(ctx.turns.conversations({ sessionId: persistent.sessionId! })).toEqual([expect.objectContaining({ account: 'chatgpt-main', binding: persistent.binding, state: 'live', mode: 'persistent', turnId: persistent.turnId, attempts: 0 })])
    // A temporary chat leaves the history on its own: kept, never deleted by system.
    for (const row of ctx.turns.conversations().filter((c) => c.turnId === temporary.turnId)) expect(row).toMatchObject({ state: 'kept', reason: 'temporary' })
    const released = ctx.turns.release([persistent.sessionId!, 'ses_unknown'], 'run run_x deleted')
    expect(released.due).toBe(1)
    const decision = ctx.artifacts.get(released.decision!)!
    expect(decision.body).toMatchObject({ decisionType: 'retention', decider: { type: 'rule', id: 'turns.conversation-retention' }, outcome: { option: 'delete', detail: { sessions: [persistent.sessionId, 'ses_unknown'].sort(), conversations: [{ account: 'chatgpt-main', binding: persistent.binding }] } } })
    await expect.poll(() => ctx.turns.conversations({ sessionId: persistent.sessionId! })[0]?.state, { timeout: 60_000 }).toBe('deleted')
    expect([...fake.deleted]).toEqual([persistent.binding])
    expect(fake.conversations.has(other.binding!)).toBe(true)
    expect(ctx.turns.conversations({ sessionId: other.sessionId! })[0]).toMatchObject({ state: 'live' })
    expect(ctx.eventLog.query({ type: 'conversation.deleted' })).toEqual([expect.objectContaining({ data: { account: 'chatgpt-main', binding: persistent.binding, found: 'deleted' } })])
    for (const row of ctx.turns.conversations()) new SchemaRegistry().assertRecord(row)
    // Released again: nothing more is due, and no second decision is recorded.
    expect(ctx.turns.release([persistent.sessionId!], 'again')).toEqual({ due: 0 })
  }, 150_000)

  it('never continues a released session in a new conversation, and a released conversation reused by a session becomes that session\'s, live', async () => {
    const { ctx, fake } = await boot({ fake: { answer: 'again' } })
    const first = await ctx.turns.wait((await ask(ctx, { prompt: 'one', persist: true })).turnId, 30_000)
    // Released while its map entries were still unchecked, so it waits, due.
    ctx.turns.release([first.sessionId!], 'run run_c deleted')
    // Continuing it would silently start over without its context: the turn fails, unsent.
    const next = await ctx.turns.wait((await ask(ctx, { prompt: 'two', sessionId: first.sessionId! })).turnId, 30_000)
    expect(next).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'conversation_lost', disposition: 'USER_ACTION' } })
    // Another session that reopens the due conversation (a stale handle) makes it live, and its own.
    const other = await ctx.turns.wait((await ask(ctx, { prompt: 'three', persist: true })).turnId, 30_000)
    ctx.store.db.prepare('UPDATE turn_sessions SET binding = ? WHERE session_id = ?').run(first.binding!, other.sessionId!)
    const reused = await ctx.turns.wait((await ask(ctx, { prompt: 'four', sessionId: other.sessionId! })).turnId, 30_000)
    expect(reused.binding).toBe(first.binding)
    expect(ctx.turns.conversations().find((c) => c.binding === first.binding)).toMatchObject({ state: 'live', sessionId: other.sessionId, turnId: reused.turnId })
    liveChecked(ctx)
    await ctx.turns.deleteConversations()
    expect(fake.deleteRequests).toEqual([])
    // Released with its new owner, it is deleted.
    ctx.turns.release([other.sessionId!], 'run run_d deleted')
    await expect.poll(() => ctx.turns.conversations().find((c) => c.binding === first.binding)?.state, { timeout: 60_000 }).toBe('deleted')
  }, 180_000)

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

  it('checks the site before deleting again: a deletion a crash interrupted counts as gone, and nothing is clicked', async () => {
    const { ctx, fake } = await boot()
    liveChecked(ctx)
    const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'crash after the click', persist: true })).turnId, 30_000)
    // The click happened, then the host died before the record: the site no longer has it.
    fake.conversations.delete(turn.binding!)
    fake.deleted.add(turn.binding!)
    ctx.turns.release([turn.sessionId!], 'run run_y deleted')
    await expect.poll(() => ctx.turns.conversations({ sessionId: turn.sessionId! })[0], { timeout: 60_000 }).toMatchObject({ state: 'deleted', reason: 'already gone from the site' })
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
