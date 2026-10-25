import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { ballot, browserStack, findings, isProposal, kind, member, proposal, until } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: review teams, a member\'s bounds, and provider families', () => {
  it('decides a review changes by a confirmed blocking finding, whatever the ballots; the deciding finding and each member\'s stance come first (PROP-0004 Phase 4)', async () => {
    const material = 'Review this change:\nfunction f() {\n  const lease = acquire()\n  work()\n}'
    const { ctx, fake } = await boot({
      fake: { answer: (prompt) => (isProposal(prompt)
        ? findings([
          // Cited one line off, indentation dropped: confirmed on the line it is found on.
          { severity: 'blocking', claim: 'The lease is never released', quote: { path: 'material', line: 2, text: 'const lease = acquire()' } },
          { severity: 'warning', claim: 'work() can throw', quote: { path: 'material', line: 4, text: 'work(); // never here' } },
        ])
        : JSON.stringify({ ...JSON.parse(ballot('changes', [], 'review')), findings: { F1: 'agree', F2: 'agree' } })) },
      gemini: { answer: (prompt) => (isProposal(prompt)
        ? findings([{ severity: 'info', claim: 'Same line', quote: { path: 'material', line: 3, text: '  const lease = acquire()  ' } }])
        : JSON.stringify({ ...JSON.parse(ballot('pass', [], 'review')), findings: { F1: 'disagree', F2: 'unsure' } })) },
    })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'review', input: material }).runId, 120_000)
    expect(done.status).toBe('completed')
    // The members read the material line-numbered between fence lines, as the one file `material`.
    // (The fake site reads the sent prompt back with runs of spaces collapsed.)
    expect(fake.sent[0]!.prompt).toMatch(/### File 1 of 1\n(~~~~ [0-9a-f]{12} ~~~~)\npath: material\n\s*1\s+Review this change:\n\s*2\s+function f\(\) \{\n\s*3\s+const lease = acquire\(\)\n[\s\S]*\n\1/)
    expect(done.answer!.split('\n').slice(0, 5)).toEqual([
      expect.stringMatching(/^outcome: changes; method: blocking-finding; winner: changes; decision: sha256:/),
      '',
      '## Decision: changes (a confirmed blocking finding decides it)',
      '',
      '- F1 blocking (confirmed) at material:3: m1: The lease is never released; m1 agrees, m2 disagrees',
    ])
    // Merged by quoted line: m2's finding on line 3 is F1's too, each report in its own words. The mismatched quote is not confirmed.
    expect(done.answer).toContain('- F1 at material:3 (cited 2) (evidence: read it) [m1 blocking confirmed: The lease is never released; m2 info confirmed: Same line]')
    expect(done.answer).toContain('- F2 at material:4 (evidence: read it) [m1 warning needs-verification: work() can throw (quote not found within ±2 lines of material:4)]')
    const final = ctx.artifacts.get(ctx.workflow.records(done.runId).at(-1)!.outputReceipt!.acceptance)!
    expect(final.body).toMatchObject({ schema: 'decision@1.2', decider: { type: 'rule', id: 'workflow.blocking-finding' },
      vote: { method: 'blocking-finding', blocking: ['F1'], findings: [{ id: 'F1', members: ['m1', 'm2'], class: 'confirmed', quote: { line: 2, matched: 3 } }, { id: 'F2', class: 'needs-verification' }] } })
    expect(ctx.artifacts.get(done.result!)).toMatchObject({ bodySchema: 'team-result@1.1' })
    // The source step's decision records what the reviewers read.
    const source = ctx.workflow.explain(done.runId)!.nodes.find((n) => n.nodeId === 'source')!
    expect(source).toMatchObject({ state: 'COMPLETED', decisions: [{ type: 'acceptance', outcome: 'accept' }] })
  }, 240_000)

  it('never lends one member\'s confirmed quote to another\'s blocking claim, and does not confirm a trivial quote (record integrity)', async () => {
    const material = 'Review this change:\nfunction f() {\n  const lease = acquire()\n  work()\n}'
    const { ctx, fake } = await boot({
      // m1: a correct quote, but only info. m2: blocking, on the same line, with a quote that is not there.
      fake: { answer: (prompt) => (isProposal(prompt) ? findings([{ severity: 'info', claim: 'A lease is taken', quote: { path: 'material', line: 3, text: 'const lease = acquire()' } }]) : ballot('pass', [], 'review')) },
      gemini: { answer: (prompt) => (isProposal(prompt)
        ? findings([
          { severity: 'blocking', claim: 'The lease leaks', quote: { path: 'material', line: 3, text: 'const lease = leak()' } },
          // `}` is on line 5, but it identifies no line: never confirmed.
          { severity: 'blocking', claim: 'The function never ends', quote: { path: 'material', line: 5, text: '}' } },
          // More findings on one line from one member fold into its one report there.
          ...[1, 2, 3, 4, 5].map((i) => ({ severity: 'warning' as const, claim: `Extra ${i}`, quote: { path: 'material', line: 3, text: `const lease = other${i}()` } })),
        ])
        : ballot('pass', [], 'review')) },
    })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'review', input: material }).runId, 120_000)
    // No report is both confirmed and blocking: the vote decides (both pass).
    expect(done.answer).toMatch(/^outcome: pass; method: team-majority;/)
    const final = ctx.artifacts.get(ctx.workflow.records(done.runId).at(-1)!.outputReceipt!.acceptance)!.body as { vote: { findings: Array<{ id: string; reports: unknown[] }> } }
    // The finding's own class and severity are one report's (the most severe): never m1's class beside m2's severity.
    expect(final.vote.findings[0]).toMatchObject({ id: 'F1', member: 'm2', class: 'needs-verification', severity: 'blocking', claim: expect.stringMatching(/^The lease leaks; also/), reports: [
      { member: 'm1', severity: 'info', claim: 'A lease is taken', class: 'confirmed' },
      { member: 'm2', severity: 'blocking', claim: expect.stringMatching(/^The lease leaks; also warning needs-verification: Extra 1; .*Extra 5$/), class: 'needs-verification', why: 'quote not found within ±2 lines of material:3' },
    ] })
    expect(final.vote.findings[0]!.reports).toHaveLength(2)
    // Voters see each report's class and severity, never a confirmed blocking finding.
    const ballotPrompt = fake.sent.map((s) => s.prompt).find((p) => !isProposal(p))!
    expect(ballotPrompt).toMatch(/F1 at material:3 \(evidence: read it\) \[m1 info confirmed: A lease is taken; m2 blocking needs-verification: The lease leaks; also/)
    expect(final.vote.findings[1]).toMatchObject({ class: 'needs-verification', why: expect.stringMatching(/too short to identify one line/) })
  }, 240_000)

  it('reads a review answer that quotes code in its own blocks before the findings, from either site', async () => {
    const material = 'Review this change:\nfunction f() {\n  const lease = acquire()\n  work()\n}'
    // As members answer a long review: code quoted in a block of its own, prose with braces, then the findings last.
    const reviewed = (lang: string) => (prompt: string): string => (isProposal(prompt)
      ? [
        'In `function f() { ... }` the lease is taken:',
        '', '```' + lang, 'const lease = acquire()', 'work()', '```', '',
        'and nothing releases it, so `{ lease }` outlives the call.',
        '', '```json', JSON.stringify({ findings: [{ severity: 'blocking', claim: 'The lease is never released', evidence: 'read it', quote: { path: 'material', line: 3, text: 'const lease = acquire()' } }] }, null, 2), '```',
      ].join('\n')
      : ballot('changes', [], 'review'))
    const { ctx } = await boot({ fake: { answer: reviewed('ts') }, gemini: { answer: reviewed('typescript') } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'review', input: material }).runId, 120_000)
    expect(done).toMatchObject({ status: 'completed' })
    expect(done.answer).toMatch(/^outcome: changes; method: blocking-finding;/)
    expect(done.answer).toContain('[m1 blocking confirmed: The lease is never released; m2 blocking confirmed: The lease is never released]')
  }, 240_000)

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

  it('ends a tie nobody decides as inconclusive, by rule, after tieTimeoutHours (INV-9); a tied review never passes silently', async () => {
    // No objections: no debate; split: a tie at once.
    const { ctx } = await boot({
      fake: { answer: (prompt) => (isProposal(prompt) ? findings([{ severity: 'blocking', claim: 'The lock is never released', location: 'a.ts:10' }]) : ballot('changes', [], 'review')) },
      gemini: { answer: (prompt) => (isProposal(prompt) ? findings([]) : ballot('pass', [], 'review')) },
      workflow: { tieTimeoutHours: 0.0005 },
    })
    const run = ctx.workflow.start({ template: 'review', input: 'Review this change: ...' })
    const tied = await ctx.workflow.wait(run.runId, 120_000)
    expect(tied.blocked).toMatchObject({ kind: 'tie', options: [{ option: 'pass' }, { option: 'changes' }] })
    // A blocked run is returned at once; the rule ends the tie once its time is up.
    await until(() => ctx.workflow.get(run.runId)!.status === 'completed', 30_000)
    const done = ctx.workflow.get(run.runId)!
    expect(done.answer).toMatch(/^outcome: inconclusive; method: inconclusive; winner: none; /)
    // Whatever ends the tie, the blocking finding stays in the answer.
    // An unquoted finding cannot be confirmed: the vote decides, and it tied.
    expect(done.answer).toContain('## Findings (1 blocking, 0 of them confirmed)\n\n- F1 at a.ts:10 (evidence: read it) [m1 blocking needs-verification: The lock is never released (it quotes no line)]')
    const final = ctx.artifacts.get(ctx.workflow.records(run.runId).at(-1)!.outputReceipt!.acceptance)!.body
    expect(final).toMatchObject({ decider: { type: 'rule', id: 'workflow.tie-timeout' }, deterministic: true, outcome: { option: 'inconclusive' },
      vote: { kind: 'review', method: 'inconclusive', tiebreak: { by: 'rule', option: 'inconclusive' }, rounds: [{ ended: 'no-objections' }], findings: [{ id: 'F1', member: 'm1', severity: 'blocking' }] } })
  }, 240_000)

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
