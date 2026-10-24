import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { browserStack } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: deleting a finished run and its website conversations', () => {
  it('deletes a deleted run\'s website conversation on its site, but never one a later run of the session still uses (REQ-PRV-8)', async () => {
    const { ctx, fake } = await boot()
    // As the live check does for the real site: the fake's delete flow is the one its map describes.
    const map = (ctx.providers.get('chatgpt-web') as unknown as { map: { elements: Record<string, { unverified?: true }>; actions: Record<string, { unverified?: true }> } }).map
    for (const spec of [...Object.values(map.elements), ...Object.values(map.actions)]) delete spec.unverified
    const first = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'hello', persist: true }).runId, 30_000)
    const second = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'again', sessionId: first.sessionId }).runId, 30_000)
    const alone = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'alone', persist: true }).runId, 30_000)
    const [binding] = ctx.turns.conversations({ sessionId: first.sessionId! }).map((c) => c.binding)
    // The session continues in the second run: deleting the first releases nothing.
    ctx.workflow.delete(first.runId, ctx.workflow.delete(first.runId).updatedAt)
    expect(ctx.turns.conversations({ sessionId: first.sessionId! })).toEqual([expect.objectContaining({ binding, state: 'live' })])
    ctx.workflow.delete(alone.runId, ctx.workflow.delete(alone.runId).updatedAt)
    await expect.poll(() => ctx.turns.conversations({ sessionId: alone.sessionId! })[0]?.state, { timeout: 60_000 }).toBe('deleted')
    ctx.workflow.delete(second.runId, ctx.workflow.delete(second.runId).updatedAt)
    await expect.poll(() => ctx.turns.conversations({ sessionId: first.sessionId! })[0]?.state, { timeout: 60_000 }).toBe('deleted')
    expect(fake.deleted.has(binding!)).toBe(true)
    expect(ctx.eventLog.query({ type: 'conversation.released' })).toHaveLength(2)
  }, 180_000)

  it('deletes a finished run only on the exact version its preview showed (REQ-WF-7)', async () => {
    const { ctx } = await boot()
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'bye' }).runId, 30_000)
    const preview = ctx.workflow.delete(done.runId)
    expect(preview).toMatchObject({ deleted: false, runId: done.runId, status: 'completed', updatedAt: done.updatedAt, nodes: 1 })
    expect(() => ctx.workflow.delete(done.runId, '2000-01-01T00:00:00.000Z')).toThrow(/changed/)
    expect(ctx.workflow.delete(done.runId, preview.updatedAt)).toMatchObject({ deleted: true })
    expect(ctx.workflow.get(done.runId)).toBeUndefined()
    // Artifacts are append-only and stay.
    expect(ctx.artifacts.get(done.result!)).toBeDefined()
  }, 60_000)
})
