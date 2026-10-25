import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { browserStack, kind, member } from './stack.ts'

const { boot } = browserStack()

/** Gemini's own error in place of an answer, as the live site showed it on 2026-10-24 (T125). */
const SITE_ERROR = 'Sorry, something went wrong. Please try your request again.'

type Decision = { schema: string; outcome: { option: string; detail?: Record<string, unknown> }; candidates: Array<{ option: string; reasons: string[] }> }

// D60, ADR-0062: the site's own error after the send, end to end through the Gemini driver, the
// turn runtime, and the engine, on the fake site.
describe.runIf(canRunBrowser)('ctx.workflow: a team member\'s first step after a site\'s own error', () => {
  it('resends the member\'s first step once, in a new conversation on the same account, and the member goes on there (D60, ADR-0062)', async () => {
    let proposals = 0
    const gemini = (prompt: string): string => (kind(prompt) === 'proposal' && proposals++ === 0 ? SITE_ERROR : member(prompt))
    const { ctx, gemini: site } = await boot({ fake: { answer: member }, gemini: { answer: gemini } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'brainstorm', input: 'Is it safe?' }).runId, 180_000)
    expect(done.status).toBe('completed')
    const member2 = done.nodes.find((n) => n.nodeId.endsWith(':propose') && n.worker?.startsWith('worker:gemini-main/'))!
    const resends = ctx.artifacts.list({ kind: 'decision', decisionType: 'recovery', runId: done.runId, nodeId: member2.nodeId }).map((a) => a.body as Decision)
    expect(resends.map((d) => d.outcome.option)).toEqual(['resend'])
    expect(resends[0]!.schema).toBe('decision@1.9')
    // The same member, on the same account: two conversations of its one session.
    const conversations = ctx.turns.conversations().filter((c) => c.account === 'gemini-main')
    expect(conversations).toHaveLength(2)
    expect(new Set(conversations.map((c) => c.sessionId)).size).toBe(1)
    const [first, second] = site!.sent
    expect([kind(first!.prompt), kind(second!.prompt)]).toEqual(['proposal', 'proposal'])
    // Each proposal opened a conversation of its own; the ballot went to the one that answered.
    expect(first!.conversationId).toBeUndefined()
    expect(second!.conversationId).toBeUndefined()
    const erred = [...site!.conversations].find(([, turns]) => turns.some((t) => t.role === 'answer' && t.text === SITE_ERROR))![0]
    const ballot = site!.sent.find((s) => kind(s.prompt) === 'ballot')!
    expect(conversations.map((c) => c.binding)).toContain(ballot.conversationId)
    expect(ballot.conversationId).not.toBe(erred)
    expect(site!.sent.filter((s) => kind(s.prompt) === 'proposal')).toHaveLength(2)
  }, 300_000)

  it('never resends a member\'s ballot after a site\'s own error: it relies on its conversation, so the run fails for the operator (D60, ADR-0062)', async () => {
    const gemini = (prompt: string): string => (kind(prompt) === 'ballot' ? SITE_ERROR : member(prompt))
    const { ctx, gemini: site } = await boot({ fake: { answer: member }, gemini: { answer: gemini } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'brainstorm', input: 'Is it safe?' }).runId, 180_000)
    expect(done.status).toBe('failed')
    const ballot = done.nodes.find((n) => n.nodeId.includes(':ballot:') && n.state === 'FAILED')!
    expect(ballot.error).toMatchObject({ kind: 'overloaded', disposition: 'USER_ACTION' })
    const [decision] = ctx.artifacts.list({ kind: 'decision', decisionType: 'recovery', runId: done.runId, nodeId: ballot.nodeId }).map((a) => a.body as Decision)
    expect(decision!.outcome.option).toBe('fail')
    expect(decision!.candidates.find((c) => c.option === 'resend')!.reasons.join(' ')).toMatch(/relies on its conversation/)
    expect(site!.sent.filter((s) => kind(s.prompt) === 'ballot')).toHaveLength(1)
  }, 300_000)
})
