import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import Accounts from '@tsuuanmi/system-accounts'
import Artifacts from '@tsuuanmi/system-artifacts'
import BrowserPool from '@tsuuanmi/system-browser-patchright'
import Vault from '@tsuuanmi/system-credentials-vault'
import VirtualDisplay from '@tsuuanmi/system-display-virtual'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import Login from '@tsuuanmi/system-login'
import McpEndpoint from '@tsuuanmi/system-mcp-server'
import ChatGptWeb from '@tsuuanmi/system-provider-chatgpt-web'
import Providers from '@tsuuanmi/system-providers'
import Store from '@tsuuanmi/system-store'
import TurnReceipts from '@tsuuanmi/system-turn-receipts'
import Turns from '@tsuuanmi/system-turns'
import WorkerRouter from '@tsuuanmi/system-workers'
import { afterEach, describe, expect, it } from 'vitest'
import { canRunBrowser, testChrome } from '../../browser-patchright/tests/support.ts'
import { FakeChatGpt, type FakeOptions } from '../../provider-chatgpt-web/fixtures/fake-chatgpt.ts'
import { source } from '../../../workers-core/conformance/workers.ts'
import Workflow, { DEFAULT_TEMPLATES } from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const REPORT = 'Plugins matter <a href="https://src.example/catalog">[1]</a>.'
/** Compaction answers cite; anything else answers plainly. */
const answer = (prompt: string): string => (prompt.includes('<report>') ? 'Synthesis: plugins matter (https://src.example/catalog).' : 'Plain answer.')

async function boot(options: { fake?: FakeOptions; dir?: string; shared?: FakeChatGpt; turns?: Record<string, unknown>; workflow?: Record<string, unknown>; ready?: boolean } = {}) {
  const fake = options.shared ?? new FakeChatGpt({ answer, report: REPORT, ...options.fake })
  if (!options.shared) await fake.start()
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'system-workflow-'))
  if (!options.dir) cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  if (!options.shared) cleanups.push(() => fake.stop())
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }),
    ctx.plugin(Artifacts, {}),
    ctx.plugin(EventLog, {}),
    ctx.plugin(Leases, {}),
    ctx.plugin(Egress, {}),
    ctx.plugin(TurnReceipts, {}),
    ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }),
    ctx.plugin(Accounts, { accounts: [{ id: 'chatgpt-main', provider: 'chatgpt-web', quotaClass: 'subscription-chat', tiers: { economy: 'instant', standard: 'medium', frontier: 'high' } }] }),
    ctx.plugin(VirtualDisplay, {}),
    ctx.plugin(BrowserPool, { chromePath: testChrome! }),
    ctx.plugin(Providers),
    ctx.plugin(ChatGptWeb, { origin: fake.origin, overlayPath: join(dir, 'none.yaml'), modes: { instant: { model: 'Latest', effort: 'Instant' }, medium: { model: 'Latest', effort: 'Medium' }, high: { model: 'GPT-6', effort: 'High' } }, defaultMode: 'instant' }),
    ctx.plugin(Login, { profilesDir: join(dir, 'profiles') }),
    ctx.plugin(WorkerRouter, {}),
    ctx.plugin(Turns, { turnTimeoutMs: 90_000, stallTimeoutMs: 80_000, ...options.turns }),
    ctx.plugin(Workflow, { retryDelayMs: 300, ...options.workflow }),
    ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }),
    ctx.plugin(McpEndpoint, { tokenFile: join(dir, 'mcp.token'), discoveryFile: join(dir, 'mcp.json') }),
  ]
  await Promise.all(fibers)
  const stop = async (): Promise<void> => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  }
  cleanups.push(stop)
  if (!options.shared && options.ready !== false) {
    await ctx.accounts.saveState('chatgpt-main', {
      state: { origins: [fake.origin], cookies: [], capturedAt: '2026-10-12T00:00:00Z' },
      identityHash: `sha256:${'a'.repeat(64)}`, verifiedAt: '2026-10-12T00:00:00Z',
    })
  }
  return { ctx, fake, dir, stop }
}

const until = async (check: () => boolean, ms = 30_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

describe.runIf(canRunBrowser)('ctx.workflow: static DAGs on the single engine', () => {
  it('runs research as two nodes: Deep research on frontier, then a cited compaction of the verbatim report on economy', async () => {
    const { ctx, fake } = await boot()
    const started = ctx.workflow.start({ template: 'research', input: 'Survey the plugin catalog' })
    expect(started).toMatchObject({ template: 'research', status: 'running' })
    expect(started.sessionId).toMatch(/^ses_/)
    const done = await ctx.workflow.wait(started.runId, 60_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'Synthesis: plugins matter (https://src.example/catalog).' })
    expect(fake.sent).toHaveLength(2)
    expect(fake.sent[0]).toMatchObject({ prompt: 'Survey the plugin catalog', deepResearch: true, temporary: false, model: 'GPT-6', power: 'High' })
    expect(fake.sent[1]).toMatchObject({ deepResearch: false, temporary: true, model: 'Latest', power: 'Instant' })
    // Editors may change blank-line spacing; every line of the report arrives verbatim.
    expect(fake.sent[1]!.prompt.replace(/\n{2,}/g, '\n\n')).toContain('<report>\nResearch findings\nPlugins matter [1].\n\nSources:\n- [1] https://src.example/catalog\n</report>')
    expect(done.nodes.map((n) => [n.nodeId, n.state, n.worker, n.quotaClass])).toEqual([
      ['research:1', 'COMPLETED', 'worker:chatgpt-main/frontier', 'subscription-chat'],
      ['compact:1', 'COMPLETED', 'worker:chatgpt-main/economy', 'subscription-chat'],
    ])
    // Durable node records validate against workflow-node@1.0 and bind the result to its acceptance.
    const schemas = new SchemaRegistry()
    for (const record of ctx.workflow.records(started.runId)) {
      schemas.assertRecord(record)
      expect(record.outputReceipt).toBeDefined()
      expect(ctx.artifacts.get(record.outputReceipt!.acceptance)?.body).toMatchObject({ decisionType: 'acceptance', outcome: { option: 'accept' } })
    }
    // Template tiers are the profile's, and each requirement carries its node's objective.
    expect(ctx.workflow.records(started.runId).map((r) => [r.requirement.tier, r.requirement.objective])).toEqual([
      [{ min: 'frontier', source: 'profile' }, 'Write a cited Deep research report on the caller\'s question'],
      [{ min: 'economy', source: 'profile' }, 'Compact the report into a cited synthesis'],
    ])
    // Both tiers are visible in the event log (MVP exit criterion 4).
    const completed = ctx.eventLog.query({ type: 'workflow.node.completed', runId: started.runId })
    expect(completed.map((e) => [e.nodeId, e.data?.tier])).toEqual([['research:1', 'frontier'], ['compact:1', 'economy']])
  }, 120_000)

  it('answers ask as a one-node DAG with the caller\'s tier, and continues a session', async () => {
    const { ctx, fake } = await boot()
    const first = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'hello', tier: 'economy', persist: true }).runId, 30_000)
    expect(first).toMatchObject({ status: 'completed', answer: 'Plain answer.', nodes: [{ nodeId: 'ask:1', worker: 'worker:chatgpt-main/economy' }] })
    const second = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'again', sessionId: first.sessionId }).runId, 30_000)
    expect(second).toMatchObject({ status: 'completed', sessionId: first.sessionId, nodes: [{ worker: 'worker:chatgpt-main/standard' }] })
    expect(fake.sent[1]!.conversationId).toBe(fake.sent[0]!.conversationId ?? [...fake.conversations.keys()][0])
  }, 90_000)

  it('is idempotent on clientRequestId and refuses an unknown template', async () => {
    const { ctx, fake } = await boot()
    const a = ctx.workflow.start({ template: 'ask', input: 'once', clientRequestId: 'req-1' })
    const b = ctx.workflow.start({ template: 'ask', input: 'once', clientRequestId: 'req-1' })
    expect(b.runId).toBe(a.runId)
    await ctx.workflow.wait(a.runId, 30_000)
    expect(fake.sent).toHaveLength(1)
    expect(() => ctx.workflow.start({ template: 'ask', input: 'other', clientRequestId: 'req-1' })).toThrow(/different/)
    expect(() => ctx.workflow.start({ template: 'nope', input: 'x' })).toThrow(/unknown workflow template/)
  }, 60_000)

  it('fails the run when a result is rejected by its acceptance contract, and never runs the next node (REQ-WRK-3)', async () => {
    // A deployment that requires cited reports.
    const cited = DEFAULT_TEMPLATES.research!.map((node) => ({ ...node, acceptance: 'acceptance.cited' }))
    const { ctx, fake } = await boot({ fake: { report: 'A report without any source.' }, workflow: { templates: { research: cited } } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'research', input: 'q' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'acceptance_rejected', disposition: 'NONE' } })
    expect(done.nodes.map((n) => n.state)).toEqual(['FAILED', 'WAITING'])
    expect(fake.sent).toHaveLength(1)
  }, 90_000)

  it('escalates a rejected result to the next tier once, keeping the rejected result as evidence (REQ-WRK-9)', async () => {
    const cited = [{ nodeId: 'ask:1', objective: 'x', prompt: '{{input}}', capabilities: ['reason'], tier: 'economy', conversation: 'temporary', acceptance: 'acceptance.cited' }]
    const { ctx, fake } = await boot({
      fake: { answer: (_prompt, sent) => (sent.power === 'Instant' ? 'No sources here.' : 'See https://src.example/a') },
      workflow: { templates: { cited } },
    })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'cited', input: 'q' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'See https://src.example/a', nodes: [{ tier: 'standard' }] })
    expect(fake.sent.map((s) => s.power)).toEqual(['Instant', 'Medium'])
    const record = ctx.workflow.records(done.runId)[0]!
    expect(record.requirement.tier).toMatchObject({ min: 'standard', source: 'decision' })
    const escalation = ctx.artifacts.get(record.requirement.tier.decision!)?.body as { decisionType: string; outcome: { option: string }; inputs: string[] }
    expect(escalation).toMatchObject({ decisionType: 'escalation', outcome: { option: 'escalate' } })
    expect(escalation.inputs).toHaveLength(2)
    expect(ctx.eventLog.query({ type: 'workflow.node.escalated', runId: done.runId })).toHaveLength(1)
  }, 90_000)

  it('retries a node that failed with a back-off disposition, within the bound (REQ-WF-6)', async () => {
    const { ctx, fake } = await boot({ fake: { thinkMs: 1500 }, turns: { maxPendingTurns: 1 }, workflow: { retryDelayMs: 1000, maxAttempts: 6 } })
    const blocker = ctx.workflow.start({ template: 'ask', input: 'hold the only slot' })
    await until(() => ctx.workflow.get(blocker.runId)?.nodes[0]?.executionId !== undefined)
    const run = ctx.workflow.start({ template: 'ask', input: 'after the blocker' })
    const done = await ctx.workflow.wait(run.runId, 60_000)
    expect(done.status).toBe('completed')
    expect(done.nodes[0]!.attempt).toBeGreaterThan(1)
    const retry = ctx.eventLog.query({ type: 'workflow.node.retry', runId: run.runId })[0]!
    expect(retry.data).toMatchObject({ kind: 'overloaded', disposition: 'BACKOFF' })
    // The retry is a decision (INV-13), named by the event.
    expect(ctx.artifacts.get(retry.decision!)?.body).toMatchObject({ decisionType: 'recovery', outcome: { option: 'retry' } })
    expect((await ctx.workflow.wait(blocker.runId, 10_000)).status).toBe('completed')
    expect(fake.sent.map((s) => s.prompt)).toEqual(['hold the only slot', 'after the blocker'])
  }, 90_000)

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

  it('recovers a run after a restart without sending the research prompt again (REQ-WF-4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-workflow-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, fake: { researchMs: 6000 } })
    const run = first.ctx.workflow.start({ template: 'research', input: 'survive a crash' })
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

  it('clears a finished run\'s private text after the retention period, but keeps the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-workflow-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir })
    const done = await first.ctx.workflow.wait(first.ctx.workflow.start({ template: 'ask', input: 'private words' }).runId, 30_000)
    first.ctx.store.db.prepare("UPDATE workflow_runs SET updated_at = '2000-01-01T00:00:00.000Z'").run()
    await first.stop()
    cleanups.splice(cleanups.indexOf(first.stop), 1)
    const second = await boot({ dir, shared: first.fake })
    await until(() => (second.ctx.store.db.prepare('SELECT input FROM workflow_runs').get() as { input: string }).input === '')
    expect(second.ctx.store.db.prepare('SELECT prompt FROM workflow_nodes').get()).toEqual({ prompt: null })
    expect(second.ctx.workflow.get(done.runId)).toMatchObject({ status: 'completed', answer: 'Plain answer.' })
  }, 90_000)

  it('explains a run: egress, tier, route, and acceptance for every node (REQ-ART-3)', async () => {
    const { ctx } = await boot()
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'research', input: 'why' }).runId, 60_000)
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

  it('serves ask, research, run, result, usage, and explain over MCP in place of the placeholders', async () => {
    const { dir } = await boot()
    const { url, tokenFile } = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as { url: string; tokenFile: string }
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${readFileSync(tokenFile).toString('base64url')}` } } }) as unknown as Transport)
    try {
      const asked = await client.callTool({ name: 'ask', arguments: { prompt: 'hi', waitSeconds: 25 } })
      expect(asked.content).toEqual([{ type: 'text', text: 'Plain answer.' }])
      const runId = (asked.structuredContent as { runId: string }).runId
      expect(asked.structuredContent).toMatchObject({ runId, status: 'completed', answer: 'Plain answer.' })
      const research = await client.callTool({ name: 'research', arguments: { question: 'q' } })
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
