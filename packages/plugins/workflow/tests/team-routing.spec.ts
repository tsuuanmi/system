import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { browserStack, findings, isProposal, member, until } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: where a member runs, what it may be sent, and what is refused before anything is sent', () => {
  it('routes a node that must differ beside the node it names, even when it is listed first (ADR-0027)', async () => {
    const step = { objective: 'o', prompt: '{{input}}', capabilities: ['reason'], tier: 'standard' as const, conversation: 'temporary' as const, acceptance: 'acceptance.answer' }
    const pair = [{ ...step, nodeId: 'b', differentFrom: ['a'] }, { ...step, nodeId: 'a' }, { ...step, nodeId: 'join', dependsOn: ['a', 'b'] }]
    const { ctx } = await boot({ fake: { thinkMs: 4000 }, gemini: {}, workflow: { templates: { pair } } })
    const run = ctx.workflow.start({ template: 'pair', input: 'q' })
    const state = (id: string): string => ctx.workflow.get(run.runId)!.nodes.find((n) => n.nodeId === id)!.state
    await until(() => state('b') !== 'READY' && state('b') !== 'WAITING', 60_000)
    // b waited one routing turn for a's Worker, not for a's whole execution.
    expect(state('a')).toBe('RUNNING')
    expect(await ctx.workflow.wait(run.runId, 60_000)).toMatchObject({ status: 'completed' })
    const workers = Object.fromEntries(ctx.workflow.get(run.runId)!.nodes.map((n) => [n.nodeId, n.worker]))
    expect(workers.a?.split('/')[0]).not.toBe(workers.b?.split('/')[0])
  }, 120_000)

  it('fails a member whose site answered with its own error, before any acceptance judges it and without escalating, once its one resend erred too (live 2026-10-17, D60, ADR-0062)', async () => {
    const { ctx, gemini } = await boot({ fake: { answer: member }, gemini: { answer: 'I seem to be encountering an error. Can I try something else for you?' } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'brainstorm', input: 'Which store?' }).runId, 120_000)
    expect(done.status).toBe('failed')
    const m2 = ctx.workflow.explain(done.runId)!.nodes.find((n) => n.nodeId === 'brainstorm:m2:propose')!
    expect(m2.state).toBe('FAILED')
    // No acceptance and no escalation: the error is the site's.
    expect(m2.decisions.map((d) => d.type)).not.toContain('acceptance')
    expect(m2.decisions.map((d) => d.type)).not.toContain('escalation')
    // Resent once, in a new conversation (D60); the second error fails it, as sent, never resent twice.
    const recoveries = m2.decisions.filter((d) => d.type === 'recovery')
    expect(recoveries.map((d) => (d as { outcome?: string }).outcome)).toEqual(['resend', 'fail'])
    expect(recoveries[1]).toMatchObject({ outcome: 'fail', reasons: expect.arrayContaining([expect.stringMatching(/^overloaded came after the prompt was sent/)]) })
    expect(gemini!.sent).toHaveLength(2)
    expect(gemini!.conversations.size).toBe(2)
  }, 240_000)

  it('never sends a Worker more than it takes: an ask goes to one without the bound, and a review member fails unsent, naming the bound that sized it (ADR-0032)', async () => {
    const { ctx, fake, gemini } = await boot({ fake: { answer: (prompt) => (isProposal(prompt) ? findings([]) : 'plain') }, gemini: { answer: 'x' }, workflow: { repositories: { maxSourceChars: 60_000 } } })
    // The Gemini site takes 30,000 characters (its maxPromptChars), the ChatGPT site declares no bound.
    const asked = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'q'.repeat(31_000) }).runId, 60_000)
    expect(asked).toMatchObject({ status: 'completed', nodes: [{ worker: expect.stringMatching(/^worker:chatgpt-main\//) }] })
    const route = ctx.artifacts.get(ctx.workflow.explain(asked.runId)!.nodes[0]!.decisions.find((d) => d.type === 'route')!.id)!.body as { candidates: Array<{ option: string; reasons: string[] }> }
    expect(route.candidates.filter((c) => c.option.startsWith('worker:gemini-main/')).every((c) => c.reasons.includes('the input has 31000 characters; it takes at most 30000'))).toBe(true)
    // A review member must be another family than the first, so only Gemini can take it, and the source shown makes it too long.
    const material = 'Review this change:\n' + 'a line of the change to review\n'.repeat(1100)
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'review', input: material }).runId, 120_000)
    expect(done.status).toBe('failed')
    // Text, not a repository: the text itself is what to shorten, shown once (no focus to narrow).
    expect(done.error).toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/no Worker can take this work: .*it takes at most 30000.*The input is \d+ characters, most of it the caller's text, shown once as the file material \(at most repositories\.maxSourceChars, 60000\): review a smaller part of it, or lower that bound so a text this long is refused before any member is asked$/s) })
    // Two provider families are ready: a shortage of them is not why it failed.
    expect(done.error!.message).not.toMatch(/provider families/)
    expect(gemini!.sent).toEqual([])
    expect(fake.sent.filter((s) => isProposal(s.prompt))).toHaveLength(1)
  }, 240_000)

  it('refuses material too long for a member to read whole, before anything is sent', async () => {
    const { ctx, fake } = await boot({ fake: { answer: 'x' }, gemini: { answer: 'x' }, workflow: { repositories: { maxSourceChars: 2000 } } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'review', input: 'Review this:\n' + 'line of the change\n'.repeat(200) }).runId, 60_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'invalid_input', message: expect.stringMatching(/over the 2000 a member takes/) } })
    expect(fake.sent).toEqual([])
  }, 90_000)

  it('refuses a repository on a host it may not read, before anything is sent', async () => {
    const { ctx, fake } = await boot({ fake: { answer: 'x' }, gemini: { answer: 'x' } })
    const run = ctx.workflow.start({ template: 'review', input: 'Is it safe?', repository: { url: 'https://gitlab.com/a/b' } })
    const done = await ctx.workflow.wait(run.runId, 60_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'invalid_input', message: expect.stringMatching(/not an allowed repository host/) } })
    expect(fake.sent).toEqual([])
    expect(() => ctx.workflow.start({ template: 'brainstorm', input: 'q', repository: { url: 'https://github.com/a/b' } })).toThrow('template brainstorm reads no repository')
  }, 90_000)
})
