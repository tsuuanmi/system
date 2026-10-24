import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { ballot, browserStack, isProposal, kind, member, proposal } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: a team\'s provider families and accounts', () => {
  it('runs a team on one account in two conversations when the operator allows the same family, and says so on the record (ADR-0029, ADR-0035)', async () => {
    const { ctx, fake } = await boot({ fake: { answer: member }, workflow: { allowSameFamily: true } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'brainstorm', input: 'q' }).runId, 120_000)
    expect(done.status).toBe('completed')
    const worker = (id: string) => done.nodes.find((n) => n.nodeId === id)!.worker
    expect([worker('brainstorm:m1:propose'), worker('brainstorm:m2:propose')]).toEqual(['worker:chatgpt-main/standard', 'worker:chatgpt-main/standard'])
    // Two members, two conversations: each ballot goes back to its own member's conversation.
    const proposals = fake.sent.filter((s) => kind(s.prompt) === 'proposal')
    const ballots = fake.sent.filter((s) => kind(s.prompt) === 'ballot')
    expect(new Set(ballots.map((b) => b.conversationId)).size).toBe(2)
    expect(proposals).toHaveLength(2)
    // Never "independent": the decision and the answer say the members are one provider family.
    expect(done.answer).toContain('Members: same provider family (allowSameFamily), some sharing one account: no other provider judged this.')
    const final = ctx.artifacts.get(ctx.workflow.records(done.runId).at(-1)!.outputReceipt!.acceptance)!.body as { outcome: { detail: Record<string, unknown> } }
    expect(final.outcome.detail).toMatchObject({ members: 'same provider family, sharing an account' })
    // With one account the middle step admits nothing: the last step shares it (ADR-0035).
    const m2 = ctx.workflow.explain(done.runId)!.nodes.find((n) => n.nodeId === 'brainstorm:m2:propose')!
    expect(m2.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'admission', outcome: 'same-family-shared-account' })]))
  }, 180_000)

  it('keeps a one-provider team on accounts of their own while there are enough, before sharing one (ADR-0035)', async () => {
    const { ctx } = await boot({ fake: { answer: member }, workflow: { allowSameFamily: true }, accounts: ['chatgpt-main', 'chatgpt-2'] })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'brainstorm', input: 'q' }).runId, 120_000)
    expect(done.status).toBe('completed')
    const worker = (id: string) => done.nodes.find((n) => n.nodeId === id)!.worker
    expect(new Set([worker('brainstorm:m1:propose'), worker('brainstorm:m2:propose')])).toEqual(new Set(['worker:chatgpt-main/standard', 'worker:chatgpt-2/standard']))
    expect(done.answer).toContain('Members: same provider family (allowSameFamily), each on an account of its own: no other provider judged this.')
    const decisions = ctx.workflow.explain(done.runId)!.nodes.flatMap((n) => n.decisions)
    expect(decisions.some((d) => d.type === 'admission' && d.outcome === 'same-family')).toBe(true)
    expect(decisions.some((d) => d.outcome === 'same-family-shared-account')).toBe(false)
  }, 180_000)

  it('still uses a second family whenever one is admitted, with the same-family opt-in on (ADR-0029)', async () => {
    const { ctx } = await boot({
      fake: { answer: (prompt) => (isProposal(prompt) ? proposal('Use SQLite') : ballot('O1')) },
      gemini: { answer: (prompt) => (isProposal(prompt) ? proposal('Use Postgres') : ballot('O1')) },
      workflow: { allowSameFamily: true },
    })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'brainstorm', input: 'Which store?' }).runId, 120_000)
    expect(done.status).toBe('completed')
    expect(done.nodes.find((n) => n.nodeId === 'brainstorm:m2:propose')!.worker).toBe('worker:gemini-main/standard')
    expect(done.answer).not.toContain('same provider family')
    const decisions = ctx.workflow.explain(done.runId)!.nodes.flatMap((n) => n.decisions)
    expect(decisions.some((d) => d.outcome === 'same-family')).toBe(false)
  }, 180_000)

  it('fails closed when a team finds fewer provider families than members, and says what it needs (ADR-0027, REQ-TEAM-4)', async () => {
    // Two accounts of one provider: one family. The second member is refused, and nothing is sent for it.
    const { ctx, fake } = await boot({ fake: { answer: member }, accounts: ['chatgpt-main', 'chatgpt-2'] })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'brainstorm', input: 'q' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'config_error', message: expect.stringMatching(/^team brainstorm needs 2 provider families, one per member; 1 is ready \(ADR-0027\)\. .*same provider family/) } })
    expect(fake.sent.map((s) => kind(s.prompt))).toEqual(['proposal'])
    // A run of the team procedure an earlier version ran stays readable, and cannot run again.
    ctx.store.db.prepare("UPDATE workflow_nodes SET spec = json_set(spec, '$.team.role', 'member') WHERE run_id = ? AND node_id = 'brainstorm:m1:propose'").run(done.runId)
    expect(() => ctx.workflow.continue(done.runId)).toThrow('is a team procedure that was removed (PROP-0004)')
    expect(ctx.workflow.explain(done.runId)).toMatchObject({ status: 'failed' })
  }, 90_000)
})
