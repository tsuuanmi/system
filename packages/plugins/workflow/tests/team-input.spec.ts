import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { browserStack, kind, member, until } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: a team member\'s session that needs a peer\'s input', () => {
  it('lets a session ask for input it cannot go on without, then resume when a peer answers (REQ-SES-7)', async () => {
    const answer = (prompt: string): string => {
      if (kind(prompt) !== 'other') return member(prompt)
      if (prompt.includes('Messages for you (m1)')) return prompt.includes('the unit is metres') ? 'resolved: 42 metres' : 'INPUT_REQUIRED: which unit?'
      if (prompt.includes('Messages for you (m2)')) return 'the unit is metres'
      return 'an answer'
    }
    const { ctx, fake, gemini } = await boot({ fake: { answer }, gemini: { answer } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'brainstorm', input: 'How far?' }).runId, 120_000)
    const members = ctx.workerSessions.ofRun(done.runId)
    const m1 = members.find((m) => m.role === 'm1')!
    const m2 = members.find((m) => m.role === 'm2')!
    ctx.workerSessions.send({ from: m2.sessionId, messageId: 'how-far', to: { session: m1.sessionId }, intent: 'request', body: 'How far is it?' })
    // m1 asks; m2 is woken by the question and answers; the answer wakes m1, which resolves.
    await until(() => ctx.workerSessions.inbox(m2.sessionId).some((m) => m.message.body === 'resolved: 42 metres'), 120_000)
    const kinds = ctx.artifacts.list({ kind: 'message' }).map((a) => a.body as { from: string; intent?: string; body: string }).filter((m) => m.from === m1.sessionId || m.from === m2.sessionId)
      .map((m) => `${m.from === m1.sessionId ? 'm1' : 'm2'}:${m.intent}:${m.body}`)
    expect(kinds.slice(-4)).toEqual(['m2:request:How far is it?', 'm1:input-required:INPUT_REQUIRED: which unit?', 'm2:answer:the unit is metres', 'm1:answer:resolved: 42 metres'])
    await until(() => ctx.workerSessions.session(m1.sessionId)!.state === 'IDLE', 30_000)
    // m1 (on the first family) was woken twice, m2 once.
    expect(fake.sent.filter((s) => s.prompt.includes('Messages for you'))).toHaveLength(2)
    expect(gemini!.sent.filter((s) => s.prompt.includes('Messages for you'))).toHaveLength(1)
  }, 240_000)
})
