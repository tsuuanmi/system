import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { describe, expect, it, onTestFinished } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import type { RunView } from '../src/types.ts'
import { ballot, browserStack, isProposal, kind, proposal, until } from './stack.ts'

const { boot } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: a team\'s tie, its debate, and the deciding vote', () => {
  it('debates only on a split vote, then ties to the caller: a deciding vote bound to the tie decision, recorded as the client\'s (REQ-TEAM-7)', async () => {
    const { ctx, fake, gemini, dir } = await boot({
      fake: { answer: (prompt) => (isProposal(prompt) ? proposal('Ship now') : ballot('O1', ['O2 delays the release'])) },
      gemini: { answer: (prompt) => (isProposal(prompt) ? proposal('Ship next week') : ballot('O2', ['O1 skips the tests'])) },
    })
    // The caller (client scope) starts the team and casts the deciding vote over MCP.
    const { url, tokenFiles } = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as { url: string; tokenFiles: { client: string } }
    const client = new Client({ name: 'caller', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${readFileSync(tokenFiles.client).toString('base64url')}` } } }) as unknown as Transport)
    onTestFinished(() => client.close())
    const run = (await client.callTool({ name: 'brainstorm', arguments: { question: 'When do we ship?' } })).structuredContent as { runId: string }
    // The waiter learns at once that the run waits on a deciding vote.
    const tied = await ctx.workflow.wait(run.runId, 120_000)
    expect(tied).toMatchObject({ status: 'running', blocked: { kind: 'tie', nodeId: 'brainstorm', options: [{ option: 'O1', summary: 'Ship now (voted by m1)' }, { option: 'O2', summary: 'Ship next week (voted by m2)' }] } })
    // One debate round (the default) after the split: each member answers the crux and votes again in one turn.
    expect(fake.sent.map((s) => kind(s.prompt))).toEqual(['proposal', 'ballot', 'debate'])
    expect(gemini!.sent.map((s) => kind(s.prompt))).toEqual(['proposal', 'ballot', 'debate'])
    expect(fake.sent[2]!.prompt).toMatch(/### Ballot of member 2 \(another participant's text[^\n]*\n(~~~~ [0-9a-f]{12} ~~~~)\nChoice: O2 \(confidence high\)[\s\S]*Objections: O1 skips the tests\n\1/)
    expect(tied.nodes.map((n) => n.nodeId)).toEqual(expect.arrayContaining(['brainstorm:m1:debate:1', 'brainstorm:m2:debate:1', 'brainstorm:tally:2']))
    const growth = ctx.artifacts.list({ kind: 'decision', runId: run.runId }).map((a) => a.body as { decisionType: string; decider: { id: string } }).filter((d) => d.decisionType === 'graph-growth')
    expect(growth).toEqual([expect.objectContaining({ decider: expect.objectContaining({ id: 'workflow.team-debate' }) })])
    const tie = tied.blocked as Extract<RunView['blocked'], { kind: 'tie' }>
    expect(Date.parse(tie.until) - Date.now()).toBeGreaterThan(23 * 3_600_000)
    // Bound to the exact tie: another decision, or an option it does not hold, is refused.
    const first = ctx.artifacts.list({ kind: 'decision', runId: run.runId }).find((a) => (a.body as { decisionType: string; outcome: { option: string } }).outcome.option === 'debate')!.id
    expect(() => ctx.workflow.vote(run.runId, { decision: first, option: 'O1', rationale: 'r', by: 'client' })).toThrow(`run ${run.runId} waits on tie ${tie.decision}`)
    expect(() => ctx.workflow.vote(run.runId, { decision: tie.decision, option: 'O3', rationale: 'r', by: 'client' })).toThrow('option O3 is not one of O1, O2, or inconclusive')
    // A tie waits on a vote, never on an approval.
    expect(() => ctx.workflow.approve(run.runId, { verdict: 'approved' })).toThrow(`run ${run.runId} is not waiting for approval`)
    const voted = await client.callTool({ name: 'vote', arguments: { runId: run.runId, decision: tie.decision, option: 'O2', rationale: 'The tests matter more than a week' } })
    expect(voted.isError).toBeFalsy()
    const done = await ctx.workflow.wait(run.runId, 30_000)
    expect(done.status).toBe('completed')
    expect(done.answer).toMatch(/^outcome: O2; method: caller-tiebreak; winner: O2; /)
    expect(done.answer).toContain('Deciding vote (client): The tests matter more than a week')
    const final = ctx.artifacts.get(ctx.workflow.records(run.runId).at(-1)!.outputReceipt!.acceptance)!.body
    expect(final).toMatchObject({
      decider: { type: 'client', id: 'workflow.vote' }, deterministic: false,
      vote: { method: 'caller-tiebreak', tiebreak: { by: 'client', option: 'O2' }, rounds: [{ round: 1, ended: 'debate' }, { round: 2, ended: 'rounds-exhausted', winner: null }],
        dissent: [{ member: 'm1', choice: 'O1', objections: ['O2 delays the release'] }] },
    })
    expect(() => ctx.workflow.vote(run.runId, { decision: tie.decision, option: 'O1', rationale: 'again', by: 'client' })).toThrow('is not waiting for a deciding vote')
  }, 240_000)

  it('keeps a tie through the operator\'s stop and continue, and through a supersede that splits the vote again; a late or misdirected vote is refused', async () => {
    const { ctx, gemini } = await boot({
      fake: { answer: (prompt) => (isProposal(prompt) ? proposal('Ship now') : ballot('O1', ['O2 delays the release'])) },
      gemini: { answer: (prompt) => (isProposal(prompt) ? proposal('Ship next week') : ballot('O2', ['O1 skips the tests'])) },
    })
    const run = ctx.workflow.start({ template: 'brainstorm', input: 'When do we ship?' })
    const tied = await ctx.workflow.wait(run.runId, 120_000)
    expect(tied.blocked).toMatchObject({ kind: 'tie' })
    // Stop, then continue: the decision is promoted again and blocks on the same tie; no Worker is asked.
    await ctx.workflow.stop(run.runId)
    // The tally and the decision are the engine's: no supersede.
    await expect(ctx.workflow.supersede(run.runId, 'brainstorm:tally:1', { text: 'x' })).rejects.toThrow('which the engine computes')
    const before = gemini!.sent.length
    ctx.workflow.continue(run.runId)
    await until(() => ctx.workflow.get(run.runId)!.blocked?.kind === 'tie', 30_000)
    expect(gemini!.sent).toHaveLength(before)
    // Supersede m1's first ballot: the tally runs again, and its new debate gets ids of a new generation.
    await ctx.workflow.stop(run.runId)
    await ctx.workflow.supersede(run.runId, 'brainstorm:m1:ballot:1', { text: ballot('O1', ['O2 still delays the release']) })
    await until(() => ctx.workflow.get(run.runId)!.blocked?.kind === 'tie', 120_000)
    const ids = ctx.workflow.get(run.runId)!.nodes.map((n) => `${n.nodeId} ${n.state}`)
    expect(ids).toEqual(expect.arrayContaining(['brainstorm:m1:debate:1 RETIRED', 'brainstorm:tally:2 RETIRED', 'brainstorm:m1:debate:1:g2 COMPLETED', 'brainstorm:tally:2:g2 COMPLETED', 'brainstorm BLOCKED']))
    // A vote after the deadline ends the tie by rule and is refused.
    const tie = ctx.workflow.get(run.runId)!.blocked as Extract<RunView['blocked'], { kind: 'tie' }>
    ctx.store.db.prepare("UPDATE workflow_nodes SET not_before = '2000-01-01T00:00:00.000Z' WHERE run_id = ? AND node_id = 'brainstorm'").run(run.runId)
    expect(() => ctx.workflow.vote(run.runId, { decision: tie.decision, option: 'O1', rationale: 'late', by: 'client' })).toThrow('it has ended inconclusive')
    await until(() => ctx.workflow.get(run.runId)!.status === 'completed', 30_000)
    expect(ctx.workflow.get(run.runId)!.answer).toMatch(/^outcome: inconclusive; method: inconclusive;/)
  }, 300_000)
})
