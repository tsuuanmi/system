import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { browserStack, kind, member, until } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: a team member\'s session, checkpointed and handed off', () => {
  it('checkpoints a long-running session, and compacts it into a handoff it continues from in a new conversation (REQ-SES-6)', async () => {
    const answer = (prompt: string): string => {
      if (kind(prompt) !== 'other') return member(prompt)
      if (prompt.includes('Write a handoff summary')) return 'HANDOFF: the plan is agreed; the open question is the deadline.'
      if (prompt.includes('<handoff>')) return 'continuing from the handoff'
      if (prompt.includes('Messages for you')) return `noted ${'x'.repeat(6000)}`
      return 'an answer'
    }
    const { ctx, fake } = await boot({ fake: { answer }, gemini: { answer: member }, sessions: { checkpointEveryTurns: 3, compactAtTokens: 1000 } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'brainstorm', input: 'Plan it' }).runId, 120_000)
    const m1 = ctx.workerSessions.ofRun(done.runId).find((m) => m.role === 'm1')!
    const conversationBefore = ctx.workers.handle(m1.sessionId)
    ctx.workerSessions.send({ from: 'operator', messageId: 'long-1', to: { session: m1.sessionId }, body: 'Long update one.' })
    // Past the threshold: the session writes its handoff in its own conversation, and continues in a new one.
    await until(() => ctx.artifacts.list({ kind: 'handoff' }).length === 1, 120_000)
    const [handoff] = ctx.artifacts.list({ kind: 'handoff' })
    expect(handoff).toMatchObject({ bodySchema: 'session-summary@1.0', body: { sessionId: m1.sessionId, reason: 'compaction', summary: 'HANDOFF: the plan is agreed; the open question is the deadline.' } })
    // The handoff is written in the compaction's own activation; the rebind starts the next generation (REQ-SES-1).
    const written = (handoff!.body as { generation: number }).generation
    expect(written).toBeGreaterThan(0)
    await until(() => ctx.workerSessions.session(m1.sessionId)!.binding.generation === written + 1 && ctx.workerSessions.session(m1.sessionId)!.state === 'IDLE', 30_000)
    ctx.workerSessions.send({ from: 'operator', messageId: 'after', to: { session: m1.sessionId }, body: 'What is open?' })
    await until(() => fake.sent.some((s) => s.prompt.includes('<handoff>')), 120_000)
    const resumed = fake.sent.find((s) => s.prompt.includes('<handoff>'))!
    expect(resumed.prompt).toContain('the open question is the deadline')
    await until(() => ctx.workerSessions.session(m1.sessionId)!.state === 'IDLE' && ctx.workers.handle(m1.sessionId) !== undefined, 60_000)
    expect(ctx.workers.handle(m1.sessionId)).not.toBe(conversationBefore)
    expect(ctx.workerSessions.session(m1.sessionId)).toMatchObject({ sessionId: m1.sessionId, binding: { nativeHandle: ctx.workers.handle(m1.sessionId) } })
    // The turn after the compaction was an activation of its own.
    expect(ctx.workerSessions.session(m1.sessionId)!.binding.generation).toBeGreaterThan(written + 1)
    // Checkpoints at bounded intervals: the third turn (the team's own steps do not count) writes one.
    expect(ctx.artifacts.list({ kind: 'report' }).filter((a) => a.bodySchema === 'session-summary@1.0').length).toBeGreaterThanOrEqual(1)
  }, 300_000)
})
