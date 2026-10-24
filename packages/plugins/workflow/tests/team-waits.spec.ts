import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import type { RunView } from '../src/types.ts'
import { ballot, browserStack, findings, isProposal, kind, proposal, until } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: runs that wait on a vote, and their bounds (INV-9)', () => {
  it('waits a tie of the longest allowed timeout without spinning: timers are capped (INV-9)', async () => {
    const { ctx } = await boot({
      fake: { answer: (prompt) => (isProposal(prompt) ? proposal('A') : ballot('O1')) },
      gemini: { answer: (prompt) => (isProposal(prompt) ? proposal('B') : ballot('O2')) },
      workflow: { tieTimeoutHours: 720 },
    })
    const run = ctx.workflow.start({ template: 'brainstorm', input: 'q' })
    expect((await ctx.workflow.wait(run.runId, 120_000)).blocked).toMatchObject({ kind: 'tie' })
    const holds: unknown[] = []
    const hold = ctx.leases.hold.bind(ctx.leases)
    ctx.leases.hold = ((...args: Parameters<typeof hold>) => (holds.push(args[0]), hold(...args))) as typeof hold
    await new Promise((resolve) => setTimeout(resolve, 1500))
    // An uncapped 720 h timer fires at once in Node, and the run would advance again and again.
    expect(holds).toEqual([])
  }, 180_000)

  it('admits new work beside a run that only waits on a vote, and bounds such runs on their own (INV-9)', async () => {
    const { ctx } = await boot({
      fake: { answer: (prompt) => (isProposal(prompt) ? proposal('A') : kind(prompt) === 'other' ? 'Plain answer.' : ballot('O1')) },
      gemini: { answer: (prompt) => (isProposal(prompt) ? proposal('B') : ballot('O2')) },
      workflow: { maxActiveRuns: 1, maxWaitingRuns: 1 },
    })
    const tied = ctx.workflow.start({ template: 'brainstorm', input: 'q' })
    expect((await ctx.workflow.wait(tied.runId, 120_000)).blocked).toMatchObject({ kind: 'tie' })
    // The tie runs nothing, so it holds no slot of the one run that may execute.
    const asked = ctx.workflow.start({ template: 'ask', input: 'an unrelated question' })
    expect(() => ctx.workflow.start({ template: 'ask', input: 'one more' })).toThrow('1 runs are already executing (limit 1)')
    expect(await ctx.workflow.wait(asked.runId, 60_000)).toMatchObject({ status: 'completed', answer: 'Plain answer.' })
    // Waiting runs have their own bound: a second tie fills it, and new work is refused, saying why.
    const second = ctx.workflow.start({ template: 'brainstorm', input: 'q2' })
    expect((await ctx.workflow.wait(second.runId, 120_000)).blocked).toMatchObject({ kind: 'tie' })
    expect(() => ctx.workflow.start({ template: 'ask', input: 'blocked' })).toThrow('2 runs wait on an approval or a vote (limit 1)')
    // A deciding vote frees one.
    ctx.workflow.vote(tied.runId, { decision: (ctx.workflow.get(tied.runId)!.blocked as Extract<RunView['blocked'], { kind: 'tie' }>).decision, option: 'O1', rationale: 'r', by: 'client' })
    expect(await ctx.workflow.wait(tied.runId, 60_000)).toMatchObject({ status: 'completed' })
    expect(ctx.workflow.start({ template: 'ask', input: 'after the vote' }).status).toBe('running')
  }, 300_000)

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
})
