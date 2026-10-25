import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { ballot, browserStack, findings, isProposal } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: review teams and their findings', () => {
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
})
