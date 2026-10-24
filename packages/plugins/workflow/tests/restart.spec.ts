import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { source } from '../../../workers-core/conformance/workers.ts'
import { browserStack, until } from './stack.ts'

const { boot, cleanups } = browserStack()

describe.runIf(canRunBrowser)('ctx.workflow: failures, restarts, retention, explain, and MCP', () => {
  it('never resends a submitted prompt: a timeout after sending fails the node, without a retry (INV-4)', async () => {
    const { ctx, fake } = await boot({ fake: { thinkMs: 20_000 }, turns: { turnTimeoutMs: 4000, stallTimeoutMs: 3500 }, workflow: { retryDelayMs: 100 } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'slow' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'failed', error: { disposition: 'USER_ACTION' } })
    expect(fake.sent).toHaveLength(1)
    const record = ctx.workflow.records(done.runId)[0]!
    expect(ctx.artifacts.get(record.lastDecision!)?.body).toMatchObject({ decisionType: 'recovery', outcome: { option: 'fail' } })
  }, 90_000)

  it('takes a run back after its lease was lost, instead of stranding it', async () => {
    const { ctx } = await boot({ fake: { thinkMs: 3000 } })
    const run = ctx.workflow.start({ template: 'ask', input: 'keep going' })
    await until(() => ctx.workflow.get(run.runId)?.nodes[0]?.state === 'RUNNING')
    ctx.leases.invalidate(`run:${run.runId}`)
    expect((await ctx.workflow.wait(run.runId, 60_000)).status).toBe('completed')
  }, 90_000)

  it('refuses a template whose acceptance contract is unknown before anything is sent', async () => {
    const typo = [{ nodeId: 'ask:1', objective: 'x', prompt: '{{input}}', capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.anwser' }]
    const { ctx, fake } = await boot({ workflow: { templates: { typo } } })
    expect(() => ctx.workflow.start({ template: 'typo', input: 'x' })).toThrow(/unknown acceptance contract acceptance.anwser/)
    expect(fake.sent).toEqual([])
  }, 60_000)

  it('fails closed with USER_ACTION when no account is ready, and sends nothing', async () => {
    const { ctx, fake } = await boot({ ready: false })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'nobody' }).runId, 30_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'reauth_required', disposition: 'USER_ACTION' } })
    expect(ctx.artifacts.get(ctx.workflow.records(done.runId)[0]!.lastDecision!)?.body).toMatchObject({ decisionType: 'recovery', inputs: [expect.any(String)] })
    expect(fake.sent).toEqual([])
  }, 60_000)

  it('keeps local-private work off website Workers (REQ-WRK-7, MVP exit criterion 3)', async () => {
    const { ctx, fake } = await boot()
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'my notes', classification: 'local-private' }).runId, 30_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'egress_denied' } })
    expect(fake.sent).toEqual([])
  }, 60_000)

  it('starts nothing for a node that is still routing when the engine stops', async () => {
    const { ctx, fake, stop } = await boot()
    let routing!: () => void
    const entered = new Promise<void>((resolve) => (routing = resolve))
    ctx.workers.register(source('slow', async () => (routing(), await new Promise((resolve) => setTimeout(resolve, 2000)), [])))
    ctx.workflow.start({ template: 'ask', input: 'caught mid-route' })
    await entered
    await stop()
    cleanups.splice(cleanups.indexOf(stop), 1)
    expect(fake.sent).toEqual([])
  }, 60_000)

  it('supersedes a run left with a running node after a restart: a turn that answered meanwhile stays history, never taken or resent, and the node runs again once (INV-4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-workflow-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const step = (nodeId: string, prompt: string, extra: Record<string, unknown> = {}) => ({ nodeId, objective: nodeId, prompt, capabilities: ['reason'], tier: 'standard' as const, conversation: 'temporary' as const, acceptance: 'acceptance.answer', ...extra })
    // The slow step answers in its own conversation; its sibling needs a capability no Worker has, so the run fails beside it.
    const templates = { 'fan-out': [
      step('context:1', 'Context for: {{input}}'),
      step('slow:1', 'Slow step on: {{node:context:1}}', { dependsOn: ['context:1'], conversation: 'persistent' }),
      step('blocked:1', 'Blocked on: {{node:context:1}}', { dependsOn: ['context:1'], capabilities: ['reason', 'connector:nowhere'] }),
      step('final:1', 'Both: {{node:slow:1}} {{node:blocked:1}}', { dependsOn: ['slow:1', 'blocked:1'] }),
    ] }
    const first = await boot({ dir, fake: { thinkMs: 3000, answer: (prompt) => (prompt.startsWith('Context for') ? 'the old context' : `answered: ${prompt}`) }, workflow: { templates } })
    const run = first.ctx.workflow.start({ template: 'fan-out', input: 'a question' })
    const slowTurn = (): string | undefined => first.ctx.workflow.get(run.runId)!.nodes.find((n) => n.nodeId === 'slow:1')?.executionId
    // Every wait is on state, with budgets above the turn clocks: a loaded host is slow, never wrong.
    await until(() => slowTurn() !== undefined && first.ctx.turns.get(slowTurn()!)?.binding !== undefined, 150_000, 'the slow step bound')
    const orphan = slowTurn()!
    await first.stop()
    cleanups.splice(cleanups.indexOf(first.stop), 1)
    const slow = (context: string) => first.fake.sent.filter((s) => s.prompt.startsWith(`Slow step on: ${context}`))
    // The site answers while no host runs; the restarted turn runtime recovers that answer.
    const second = await boot({ dir, shared: first.fake, workflow: { templates } })
    await until(() => second.ctx.workflow.get(run.runId)?.status === 'failed', 150_000, 'the restarted run failed')
    await until(() => second.ctx.turns.get(orphan)?.status !== 'running' && second.ctx.turns.get(orphan)?.status !== 'queued', 150_000, 'the orphan settled')
    // Recovered when the restarted runtime observes the answer in time; on a loaded host it may not,
    // and then it fails closed (reconciliation_failed). Either way it is settled before the supersede.
    const answered = second.ctx.turns.get(orphan)!.status === 'completed'
    expect(second.ctx.workflow.get(run.runId)!.nodes.find((n) => n.nodeId === 'slow:1')).toMatchObject({ state: 'RUNNING', executionId: orphan })
    const website = second.ctx.workers.source('website')!
    const cancel = website.cancel!.bind(website)
    const cancels: Array<[string, boolean]> = []
    website.cancel = (id) => {
      const done = cancel(id)
      cancels.push([id, done])
      return done
    }
    // Refused before anything is cancelled: the slow step has no result to replace.
    await expect(second.ctx.workflow.supersede(run.runId, 'slow:1', { text: 'x' })).rejects.toThrow('has no completed result')
    expect(cancels).toEqual([])
    await second.ctx.workflow.supersede(run.runId, 'context:1', { text: 'the new context' })
    // Settled already: it is not cancelled.
    expect(cancels).toEqual([])
    await until(() => second.ctx.workflow.get(run.runId)?.status === 'failed' && second.ctx.workflow.get(run.runId)!.nodes.find((n) => n.nodeId === 'slow:1')?.state === 'COMPLETED', 180_000, 'the slow step ran again')
    expect(slow('the old context')).toHaveLength(1)
    expect(slow('the new context')).toHaveLength(1)
    const node = second.ctx.workflow.explain(run.runId)!.nodes.find((n) => n.nodeId === 'slow:1')!
    expect(node.state).toBe('COMPLETED')
    const rerun = node.decisions.find((d) => d.type === 'recovery' && d.outcome === 'rerun')!
    expect(rerun.reasons).toEqual([expect.stringMatching(/^context:1's result .* was superseded by/), answered
      ? expect.stringMatching(new RegExp(`^its execution ${orphan} had already finished; its result sha256:[0-9a-f]{64} is history, never taken or resent$`))
      : `its execution ${orphan} had already ended (reconciliation_failed); nothing of it is taken or resent`])
    // The orphan's answer is not the node's result.
    expect(second.ctx.artifacts.read(node.decisions.filter((d) => d.type === 'acceptance').at(-1)!.result!)).toMatchObject({ text: expect.stringMatching(/^answered: Slow step on: the new context/) })
  }, 720_000)

  it('recovers a run after a restart without sending the research prompt again (REQ-WF-4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-workflow-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, fake: { researchMs: 6000 } })
    const run = first.ctx.workflow.start({ template: 'deep-research', input: 'survive a crash' })
    await until(() => {
      const id = first.ctx.workflow.get(run.runId)!.nodes[0]!.executionId
      return id !== undefined && first.ctx.turns.get(id)?.binding !== undefined
    })
    await first.stop()
    cleanups.splice(cleanups.indexOf(first.stop), 1)
    const second = await boot({ dir, shared: first.fake })
    const done = await second.ctx.workflow.wait(run.runId, 90_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'Synthesis: plugins matter (https://src.example/catalog).' })
    expect(first.fake.sent.map((s) => s.deepResearch)).toEqual([true, false])
  }, 150_000)

  it('clears a finished run\'s private text after the retention period, but keeps the run while run retention is off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-workflow-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, workflow: { retainRunsDays: 0 } })
    const done = await first.ctx.workflow.wait(first.ctx.workflow.start({ template: 'ask', input: 'private words' }).runId, 30_000)
    first.ctx.store.db.prepare("UPDATE workflow_runs SET updated_at = '2000-01-01T00:00:00.000Z'").run()
    await first.stop()
    cleanups.splice(cleanups.indexOf(first.stop), 1)
    const second = await boot({ dir, shared: first.fake, workflow: { retainRunsDays: 0 } })
    await until(() => (second.ctx.store.db.prepare('SELECT input FROM workflow_runs').get() as { input: string }).input === '')
    expect(second.ctx.store.db.prepare('SELECT prompt FROM workflow_nodes').get()).toEqual({ prompt: null })
    expect(second.ctx.workflow.get(done.runId)).toMatchObject({ status: 'completed', answer: 'Plain answer.' })
  }, 90_000)

  it('expires finished runs past retainRunsDays, keeps a session\'s latest run, then collects what only they needed (INV-9)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-workflow-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir })
    const one = await first.ctx.workflow.wait(first.ctx.workflow.start({ template: 'ask', input: 'standalone' }).runId, 30_000)
    const s1 = await first.ctx.workflow.wait(first.ctx.workflow.start({ template: 'ask', input: 'session one', persist: true }).runId, 30_000)
    const s2 = await first.ctx.workflow.wait(first.ctx.workflow.start({ template: 'ask', input: 'session two', sessionId: s1.sessionId }).runId, 30_000)
    const onlyOf = (ctx: typeof first.ctx, runId: string) => (ctx.store.db.prepare(`SELECT COUNT(*) AS n FROM artifact_runs r WHERE r.run_id = ?
      AND NOT EXISTS (SELECT 1 FROM artifact_runs o WHERE o.id = r.id AND o.run_id != r.run_id)`).get(runId) as { n: number }).n
    expect(onlyOf(first.ctx, one.runId)).toBeGreaterThan(0)
    // Everything is old: runs, turns, artifacts (past the grace period).
    const old = '2000-01-01T00:00:00.000Z'
    for (const sql of ['UPDATE workflow_runs SET updated_at = ?', 'UPDATE turns SET updated_at = ?', 'UPDATE artifacts SET created_at = ?']) first.ctx.store.db.prepare(sql).run(old)
    await first.stop()
    cleanups.splice(cleanups.indexOf(first.stop), 1)
    const second = await boot({ dir, shared: first.fake, workflow: { retainRunsDays: 1 }, turns: { retainDays: 1 } })
    await until(() => !second.ctx.workflow.get(one.runId) && !second.ctx.workflow.get(s1.runId))
    await until(() => (second.ctx.store.db.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number }).n === 0)
    // The session's latest run stays, so the session can continue.
    expect(second.ctx.workflow.get(s2.runId)).toMatchObject({ status: 'completed', sessionId: s1.sessionId })
    await second.ctx.artifacts.collect()
    expect(onlyOf(second.ctx, one.runId)).toBe(0)
    expect(second.ctx.artifacts.get(s2.result!)).toBeDefined()
    const events = second.ctx.eventLog.query({ type: 'workflow.run.expired' }).map((e) => e.runId).sort()
    expect(events).toEqual([one.runId, s1.runId].sort())
    // One summary per sweep; the session continued by the retained run keeps its conversation.
    expect(second.ctx.eventLog.query({ type: 'workflow.retention.swept' })).toEqual([expect.objectContaining({ data: { runs: 2, conversations: 0, retainRunsDays: 1 } })])
    expect(second.ctx.turns.conversations({ sessionId: s1.sessionId! })).toEqual([expect.objectContaining({ state: 'live' })])
  }, 120_000)

  it('explains a run: egress, tier, route, and acceptance for every node (REQ-ART-3)', async () => {
    const { ctx } = await boot()
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'deep-research', input: 'why' }).runId, 60_000)
    const explained = ctx.workflow.explain(done.runId)!
    expect(explained.nodes.map((n) => [n.nodeId, n.decisions.map((d) => [d.type, d.outcome])])).toEqual([
      ['research:1', [['egress', 'allow'], ['tier', 'frontier'], ['route', 'worker:chatgpt-main/frontier'], ['acceptance', 'accept']]],
      ['compact:1', [['egress', 'allow'], ['tier', 'economy'], ['route', 'worker:chatgpt-main/economy'], ['acceptance', 'accept']]],
    ])
    expect(explained.nodes[1]!.decisions[3]!.reasons).toEqual(['the answer has text'])
    // Runs outlive their turns: the chain survives the turn runtime's retention.
    ctx.store.db.prepare('DELETE FROM turns').run()
    expect(ctx.workflow.explain(done.runId)!.nodes.map((n) => n.decisions.length)).toEqual([4, 4])
  }, 90_000)

  it('serves ask, research, run, result, usage, and explain over MCP in place of the placeholders (REQ-GW-3, REQ-SES-8)', async () => {
    const { ctx, dir } = await boot()
    const { url, tokenFiles } = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as { url: string; tokenFiles: { operator: string } }
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${readFileSync(tokenFiles.operator).toString('base64url')}` } } }) as unknown as Transport)
    try {
      const asked = await client.callTool({ name: 'ask', arguments: { prompt: 'hi', waitSeconds: 25 } })
      expect(asked.content).toEqual([{ type: 'text', text: 'Plain answer.' }])
      const runId = (asked.structuredContent as { runId: string }).runId
      expect(asked.structuredContent).toMatchObject({ runId, status: 'completed', answer: 'Plain answer.' })
      // `research` runs the research profile's procedure: without that profile it fails closed, naming the template.
      const noProfile = await client.callTool({ name: 'research', arguments: { question: 'q' } })
      expect(noProfile).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/unknown workflow template research/) }] })
      ctx.workflow.template('research', [{ nodeId: 'study:1', objective: 'answer', prompt: '{{input}}', capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer' }])
      expect((await client.callTool({ name: 'research', arguments: { question: 'q' } })).structuredContent).toMatchObject({ template: 'research', nodes: [{ nodeId: 'study:1' }] })
      const research = await client.callTool({ name: 'run', arguments: { template: 'deep-research', input: 'q', waitSeconds: 0 } })
      const researchRun = research.structuredContent as { runId: string; status: string; sessionId: string }
      expect(researchRun).toMatchObject({ status: 'running', sessionId: expect.stringMatching(/^ses_/) })
      const fetched = await client.callTool({ name: 'result', arguments: { runId: researchRun.runId, waitSeconds: 40 } })
      expect(fetched.structuredContent).toMatchObject({ status: 'completed' })
      const usage = await client.callTool({ name: 'usage', arguments: {} })
      expect((usage.structuredContent as { runs: Array<{ runId: string; nodes: Array<{ tier: string; quotaClass: string }> }> }).runs.find((r) => r.runId === researchRun.runId)?.nodes)
        .toEqual([expect.objectContaining({ tier: 'frontier', quotaClass: 'subscription-chat' }), expect.objectContaining({ tier: 'economy', quotaClass: 'subscription-chat' })])
      const explained = await client.callTool({ name: 'explain', arguments: { id: runId } })
      expect(explained.structuredContent).toMatchObject({ runId, nodes: [{ nodeId: 'ask:1' }] })
      const ran = await client.callTool({ name: 'run', arguments: { template: 'ask', input: 'via run', waitSeconds: 25 } })
      expect(ran.structuredContent).toMatchObject({ template: 'ask', status: 'completed', answer: 'Plain answer.' })
      expect((await client.callTool({ name: 'run', arguments: { template: 'nope', input: 'x' } })).isError).toBe(true)
      const missing = await client.callTool({ name: 'result', arguments: { runId: 'run_nope' } })
      expect(missing.isError).toBe(true)
    } finally {
      await client.close()
    }
  }, 120_000)
})
