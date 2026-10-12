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
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import Workflow, { DEFAULT_TEMPLATES } from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const REPORT = 'Plugins matter <a href="https://src.example/catalog">[1]</a>.'
/** Compaction answers cite; anything else answers plainly. */
const answer = (prompt: string): string => (prompt.includes('<report>') ? 'Synthesis: plugins matter (https://src.example/catalog).' : 'Plain answer.')

async function boot(options: { fake?: FakeOptions; dir?: string; shared?: FakeChatGpt; turns?: Record<string, unknown>; workflow?: Record<string, unknown>; sessions?: Record<string, unknown>; ready?: boolean; accounts?: string[] } = {}) {
  const ids = options.accounts ?? ['chatgpt-main']
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
    ctx.plugin(Accounts, { accounts: ids.map((id) => ({ id, provider: 'chatgpt-web', quotaClass: 'subscription-chat' as const, tiers: { economy: 'instant', standard: 'medium', frontier: 'high' } })) }),
    ctx.plugin(VirtualDisplay, {}),
    ctx.plugin(BrowserPool, { chromePath: testChrome! }),
    ctx.plugin(Providers),
    ctx.plugin(ChatGptWeb, { origin: fake.origin, overlayPath: join(dir, 'none.yaml'), modes: { instant: { model: 'Latest', effort: 'Instant' }, medium: { model: 'Latest', effort: 'Medium' }, high: { model: 'GPT-6', effort: 'High' } }, defaultMode: 'instant' }),
    ctx.plugin(Login, { profilesDir: join(dir, 'profiles') }),
    ctx.plugin(WorkerRouter, {}),
    ctx.plugin(Turns, { turnTimeoutMs: 90_000, stallTimeoutMs: 80_000, ...options.turns }),
    ctx.plugin(WorkerSessions, options.sessions ?? {}),
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
    for (const [index, id] of ids.entries()) {
      await ctx.accounts.saveState(id, {
        state: { origins: [fake.origin], cookies: [], capturedAt: '2026-10-12T00:00:00Z' },
        identityHash: `sha256:${String(index).repeat(64)}`, verifiedAt: '2026-10-12T00:00:00Z',
      })
      // As a feature probe on the fake site would find (REQ-PRV-7); fresh, so no background probe runs.
      await ctx.accounts.setFeatures(id, ['deep-research', 'web-search', 'image-generation'])
    }
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
    const started = ctx.workflow.start({ template: 'deep-research', input: 'Survey the plugin catalog' })
    expect(started).toMatchObject({ template: 'deep-research', status: 'running' })
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

  it('fails the run when a result is rejected by its acceptance contract, and never runs the next node (REQ-WRK-3, INV-3)', async () => {
    // A deployment that requires cited reports.
    const cited = DEFAULT_TEMPLATES['deep-research']!.map((node) => ({ ...node, acceptance: 'acceptance.cited' }))
    const { ctx, fake } = await boot({ fake: { report: 'A report without any source.' }, workflow: { templates: { 'deep-research': cited } } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'deep-research', input: 'q' }).runId, 60_000)
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

  it('grows the graph from a planner\'s validated plan, and feeds the steps\' findings to its dependent (REQ-WF-8, REQ-WF-10)', async () => {
    const answer = (prompt: string): string => {
      if (prompt.includes('Plan how to answer')) {
        return '```json\n' + JSON.stringify({ confidence: 'high', nodes: [
          { id: 'step-1', objective: 'Look up one', prompt: 'step one: look it up', capabilities: ['reason'], tier: 'economy' },
          { id: 'step-2', objective: 'Analyse two', prompt: 'step two: analyse {{input}}', capabilities: ['reason'], tier: 'standard', dependsOn: ['step-1'] },
        ] }) + '\n```'
      }
      if (prompt.includes('<findings>')) return `Synthesis of ${['finding A', 'finding B'].filter((f) => prompt.includes(f)).join(' and ')}`
      return prompt.includes('step one') ? 'finding A' : 'finding B'
    }
    const { ctx, fake } = await boot({ fake: { answer } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'investigate', input: 'why?' }).runId, 90_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'Synthesis of finding A and finding B' })
    expect(done.nodes.map((n) => [n.nodeId, n.state, n.tier])).toEqual([
      ['plan:1', 'COMPLETED', 'standard'], ['plan:1:step-1', 'COMPLETED', 'economy'], ['plan:1:step-2', 'COMPLETED', 'standard'], ['synthesis:1', 'COMPLETED', 'standard'],
    ])
    // A plan's text is used literally: its prompts are never expanded as templates.
    expect(fake.sent.map((s) => s.prompt)).toContain('step two: analyse {{input}}')
    const schemas = new SchemaRegistry()
    for (const record of ctx.workflow.records(done.runId)) schemas.assertRecord(record)
    const growth = ctx.artifacts.list({ kind: 'decision', decisionType: 'graph-growth', runId: done.runId })
    expect(growth.map((g) => (g.body as { outcome: { option: string } }).outcome.option)).toEqual(['append'])
    expect(ctx.artifacts.get(growth[0]!.inputs[0]!)).toMatchObject({ kind: 'plan', bodySchema: 'plan@1.0' })
  }, 120_000)

  it('refuses an invalid plan without appending anything', async () => {
    const { ctx, fake } = await boot({ fake: { answer: () => '```json\n{"confidence":"high","nodes":[{"id":"a","objective":"o","prompt":"p","capabilities":["develop"],"tier":"economy"}]}\n```' } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'investigate', input: 'q' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'plan_rejected', disposition: 'NONE' } })
    expect(done.nodes.map((n) => n.nodeId)).toEqual(['plan:1', 'synthesis:1'])
    expect(fake.sent).toHaveLength(1)
  }, 60_000)

  it('holds steps that need approval until the operator approves the exact plan (REQ-WF-11)', async () => {
    const gated = DEFAULT_TEMPLATES.investigate!.map((n) => (n.grows ? { ...n, grows: { maxNodes: 2, approvalRequired: ['reason'] } } : n))
    const answer = (prompt: string): string => (prompt.includes('Plan how to answer')
      ? '```json\n{"confidence":"high","nodes":[{"id":"only","objective":"o","prompt":"the step","capabilities":["reason"],"tier":"economy"}]}\n```'
      : prompt.includes('<findings>') ? 'final' : 'step done')
    const { ctx, fake } = await boot({ fake: { answer }, workflow: { templates: { gated, rejectable: gated } } })
    const run = ctx.workflow.start({ template: 'gated', input: 'q' })
    await until(() => ctx.workflow.get(run.runId)?.blocked !== undefined, 60_000)
    const blocked = ctx.workflow.get(run.runId)!
    expect(blocked).toMatchObject({ status: 'running', blocked: { nodeId: 'plan:1:gate' } })
    expect(fake.sent).toHaveLength(1)
    ctx.workflow.approve(run.runId, { verdict: 'approved', note: 'fine' })
    const done = await ctx.workflow.wait(run.runId, 60_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'final' })
    const approval = ctx.artifacts.list({ kind: 'approval', runId: run.runId })[0]!
    expect(approval.body).toMatchObject({ verdict: 'approved', by: 'operator', subject: { type: 'artifact', ref: blocked.blocked!.plan } })
    // A rejection fails the run, and the steps never run.
    const second = ctx.workflow.start({ template: 'rejectable', input: 'q2' })
    await until(() => ctx.workflow.get(second.runId)?.blocked !== undefined, 60_000)
    ctx.workflow.approve(second.runId, { verdict: 'rejected' })
    expect(await ctx.workflow.wait(second.runId, 30_000)).toMatchObject({ status: 'failed', error: { kind: 'plan_rejected' } })
    expect(() => ctx.workflow.approve(second.runId, { verdict: 'approved' })).toThrow(/waiting for approval/)
  }, 150_000)

  it('runs a panel: independent first answers behind a barrier, critiques, and a cited synthesis, on distinct accounts (REQ-TEAM-1..4)', async () => {
    const answer = (prompt: string): string => {
      if (prompt.includes("final answers")) return 'Both hold [m1] [m2].'
      if (prompt.includes('other panel members')) return `revised after reading: ${prompt.includes('first answer') ? 'peers' : 'nothing'}`
      return prompt.includes('member 1 of') ? 'first answer\nTo m2: private note for m2' : 'first answer'
    }
    const { ctx, fake } = await boot({ fake: { answer }, accounts: ['chatgpt-main', 'chatgpt-2'] })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'panel', input: 'Is it safe?' }).runId, 120_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'Both hold [m1] [m2].' })
    const byId = Object.fromEntries(done.nodes.map((n) => [n.nodeId, n]))
    // Distinct accounts, and each member stays on its own for every round (one identity, one Worker).
    const account = (id: string) => byId[id]!.worker!.split('/')[0]
    expect(account('panel:m1:r1')).not.toBe(account('panel:m2:r1'))
    expect(account('panel:m1:r2')).toBe(account('panel:m1:r1'))
    expect(account('panel:m2:r2')).toBe(account('panel:m2:r1'))
    // The barrier: every first-round prompt went out before any critique, and none carried a peer's answer.
    const kinds = fake.sent.map((s) => (s.prompt.includes('other panel members') ? 'r2' : s.prompt.includes('final answers') ? 'synthesis' : 'r1'))
    expect(kinds).toEqual(['r1', 'r1', 'r2', 'r2', 'synthesis'])
    expect(fake.sent.filter((s) => !s.prompt.includes('other panel members') && !s.prompt.includes('final answers')).every((s) => !s.prompt.includes('first answer'))).toBe(true)
    expect(ctx.artifacts.get(ctx.workflow.records(done.runId).at(-1)!.outputReceipt!.acceptance)?.body).toMatchObject({ decisionType: 'acceptance', outcome: { option: 'accept' } })
    // Peers talk through their mailboxes: each answer and critique is that member's message (ADR-0015).
    const messages = ctx.artifacts.list({ kind: 'message' }).map((a) => a.body as { intent: string; to: { group?: string } })
    expect(messages.map((m) => m.intent).sort()).toEqual(['answer', 'answer', 'critique', 'critique', 'inform'])
    expect(messages.filter((m) => m.intent !== 'inform').every((m) => m.to.group === `team:${done.runId}:panel`)).toBe(true)
    // A direct message reaches its one member only, and stays out of the group message.
    const critiques = fake.sent.filter((s) => s.prompt.includes('other panel members')).map((s) => s.prompt)
    expect(critiques.filter((p) => p.includes('private note for m2'))).toHaveLength(1)
    expect(critiques.every((p) => p.includes('first answer'))).toBe(true)
    const members = done.nodes.filter((n) => n.nodeId.endsWith(':r1'))
    const sessions = members.map((n) => ctx.workflow.records(done.runId).find((r) => r.nodeId === n.nodeId)!)
    expect(sessions).toHaveLength(2)
  }, 180_000)

  it('lets a lead close a converged team early: later rounds carry each member\'s last answer, nothing is sent, and the barrier still opens (teams.md#lead, REQ-TEAM-1)', async () => {
    const leadAfter = (closeAt: number) => (prompt: string): string => {
      if (prompt.includes('final answers')) return 'Both hold [m1] [m2].'
      const round = /After round (\d)/.exec(prompt)
      if (round) return JSON.stringify({ converged: Number(round[1]) >= closeAt, reason: `round ${round[1]}` })
      return prompt.includes('other panel members') ? 'revised answer' : 'first answer'
    }
    const panel = (team: object) => [{ nodeId: 'panel', objective: 'Answer as a panel', prompt: '{{input}}', capabilities: ['reason'], tier: 'standard', conversation: 'temporary',
      acceptance: 'acceptance.team-synthesis', team: { members: 2, distinctAccounts: true, ...team } }]
    const templates = { 'led-panel': panel({ rounds: 3, lead: { tier: 'economy' } }), 'one-round': panel({ rounds: 1 }) }
    // Converged after round 1: rounds 2 and 3 run nothing.
    const early = await boot({ fake: { answer: leadAfter(1) }, accounts: ['chatgpt-main', 'chatgpt-2'], workflow: { templates } })
    const one = await early.ctx.workflow.wait(early.ctx.workflow.start({ template: 'led-panel', input: 'Is it safe?' }).runId, 120_000)
    expect(one).toMatchObject({ status: 'completed', answer: 'Both hold [m1] [m2].' })
    expect(early.fake.sent).toHaveLength(4) // two first answers, the lead, the synthesis
    const records = Object.fromEntries(early.ctx.workflow.records(one.runId).map((r) => [r.nodeId, r]))
    expect(records['panel:m1:r3']!.outputReceipt!.result).toBe(records['panel:m1:r1']!.outputReceipt!.result)
    const lead = early.ctx.artifacts.get(records['panel:lead:1']!.lastDecision!)!.body as { decisionType: string; decider: { type: string }; outcome: { option: string } }
    expect(lead).toMatchObject({ decisionType: 'gate', decider: { type: 'model' }, outcome: { option: 'close' } })
    expect(records['panel:m2:r2']!.lastDecision).toBe(records['panel:lead:1']!.lastDecision)
    // The barrier opened once round 1 was done, though no later round ran (nor exists in a
    // one-round team): a message after the run still reaches a member and wakes it.
    const wakes = async (runId: string): Promise<void> => {
      const m1 = early.ctx.workerSessions.ofRun(runId).find((m) => m.role === 'm1')!
      const before = early.ctx.workflow.usage(50).map((r) => r.runId)
      early.ctx.workerSessions.send({ from: 'operator', messageId: `after-${runId}`, to: { session: m1.sessionId }, body: 'one more question', intent: 'request' })
      let woke: string | undefined
      await until(() => !!(woke = early.ctx.workflow.usage(50).map((r) => r.runId).find((r) => !before.includes(r))))
      expect((await early.ctx.workflow.wait(woke!, 60_000)).status).toBe('completed')
    }
    await wakes(one.runId)
    const single = await early.ctx.workflow.wait(early.ctx.workflow.start({ template: 'one-round', input: 'Is it safe?' }).runId, 120_000)
    expect(single.status).toBe('completed')
    await wakes(single.runId)
    // Not converged after round 1, converged after round 2: round 2 runs, round 3 carries.
    const later = await boot({ fake: { answer: leadAfter(2) }, accounts: ['chatgpt-main', 'chatgpt-2'], workflow: { templates } })
    const two = await later.ctx.workflow.wait(later.ctx.workflow.start({ template: 'led-panel', input: 'Is it safe?' }).runId, 120_000)
    expect(two.status).toBe('completed')
    expect(later.fake.sent.map((s) => (/After round/.test(s.prompt) ? 'lead' : s.prompt.includes('final answers') ? 'synthesis' : s.prompt.includes('other panel members') ? 'r2' : 'r1')))
      .toEqual(['r1', 'r1', 'lead', 'r2', 'r2', 'lead', 'synthesis'])
  }, 240_000)

  it('wakes an idle member on a message after its team finished; its reply goes to the peer, and an answer wakes nobody (REQ-SES-2, REQ-SES-5)', async () => {
    const answer = (prompt: string): string => {
      if (prompt.includes('final answers')) return 'Both hold [m1] [m2].'
      if (prompt.includes('Messages for you (m1)')) return prompt.includes('from m2') ? 'm1 answers m2' : 'm1 answers the operator'
      return 'an answer'
    }
    const { ctx, fake } = await boot({ fake: { answer }, accounts: ['chatgpt-main', 'chatgpt-2'] })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'panel', input: 'Is it safe?' }).runId, 120_000)
    expect(done.status).toBe('completed')
    const members = ctx.workerSessions.ofRun(done.runId)
    const m1 = members.find((m) => m.role === 'm1')
    const m2 = members.find((m) => m.role === 'm2')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(fake.sent).toHaveLength(5) // the rounds' leftover mail wakes nobody
    expect(ctx.workerSessions.pending()).toEqual([])
    const wakeRun = async (from: string, body: string, intent?: 'request') => {
      const before = ctx.workflow.usage(50).map((r) => r.runId)
      ctx.workerSessions.send({ from, messageId: `t-${body.replace(/\W/g, "-")}`, to: { session: m1!.sessionId }, body, ...(intent ? { intent } : {}) })
      let id: string | undefined
      await until(() => !!(id = ctx.workflow.usage(50).map((r) => r.runId).find((r) => !before.includes(r))))
      return ctx.workflow.wait(id!, 60_000)
    }
    // The operator writes to m1: one turn, on m1's own account and session; the answer is the run's.
    const one = await wakeRun('operator', 'operator question')
    expect(one).toMatchObject({ status: 'completed', answer: 'm1 answers the operator' })
    expect(one.nodes[0]!.worker).toBe(done.nodes.find((n) => n.nodeId === 'panel:m1:r1')!.worker)
    await until(() => ctx.workerSessions.session(m1!.sessionId)!.state === 'IDLE')
    expect(ctx.workerSessions.inbox(m1!.sessionId)).toEqual([])
    // m2 asks m1: m1's reply reaches m2 as an answer, which does not wake m2.
    const two = await wakeRun(m2!.sessionId, 'question from m2', 'request')
    expect(two).toMatchObject({ status: 'completed', answer: 'm1 answers m2' })
    await until(() => ctx.workerSessions.inbox(m2!.sessionId).length === 1)
    expect(ctx.workerSessions.inbox(m2!.sessionId)[0]!.message).toMatchObject({ from: m1!.sessionId, intent: 'answer', body: 'm1 answers m2' })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(fake.sent).toHaveLength(7)
    expect(ctx.workerSessions.session(m1!.sessionId)!.usage).toMatchObject({ turns: 2 })
  }, 240_000)

  it('lets a session ask for input it cannot go on without, then resume when a peer answers (REQ-SES-7)', async () => {
    const answer = (prompt: string): string => {
      if (prompt.includes('final answers')) return 'Both hold [m1] [m2].'
      if (prompt.includes('Messages for you (m1)')) return prompt.includes('the unit is metres') ? 'resolved: 42 metres' : 'INPUT_REQUIRED: which unit?'
      if (prompt.includes('Messages for you (m2)')) return 'the unit is metres'
      return 'an answer'
    }
    const { ctx, fake } = await boot({ fake: { answer }, accounts: ['chatgpt-main', 'chatgpt-2'] })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'panel', input: 'How far?' }).runId, 120_000)
    const members = ctx.workerSessions.ofRun(done.runId)
    const m1 = members.find((m) => m.role === 'm1')!
    const m2 = members.find((m) => m.role === 'm2')!
    ctx.workerSessions.send({ from: m2.sessionId, messageId: 'how-far', to: { session: m1.sessionId }, intent: 'request', body: 'How far is it?' })
    // m1 asks; m2 is woken by the question and answers; the answer wakes m1, which resolves.
    await until(() => ctx.workerSessions.inbox(m2.sessionId).some((m) => m.message.body === 'resolved: 42 metres'), 120_000)
    const kinds = ctx.artifacts.list({ kind: 'message' }).map((a) => a.body as { from: string; intent?: string; body: string }).filter((m) => m.from === m1.sessionId || m.from === m2.sessionId)
      .map((m) => `${m.from === m1.sessionId ? 'm1' : 'm2'}:${m.intent}:${m.body}`).filter((m) => !m.includes('answer:an answer') && !m.includes('critique'))
    expect(kinds.slice(-4)).toEqual(['m2:request:How far is it?', 'm1:input-required:INPUT_REQUIRED: which unit?', 'm2:answer:the unit is metres', 'm1:answer:resolved: 42 metres'])
    await until(() => ctx.workerSessions.session(m1.sessionId)!.state === 'IDLE', 30_000)
    expect(fake.sent.filter((s) => s.prompt.includes('Messages for you'))).toHaveLength(3)
  }, 240_000)

  it('checkpoints a long-running session, and compacts it into a handoff it continues from in a new conversation (REQ-SES-6)', async () => {
    const answer = (prompt: string): string => {
      if (prompt.includes('final answers')) return 'Both hold [m1] [m2].'
      if (prompt.includes('Write a handoff summary')) return 'HANDOFF: the plan is agreed; the open question is the deadline.'
      if (prompt.includes('<handoff>')) return 'continuing from the handoff'
      if (prompt.includes('Messages for you')) return `noted ${'x'.repeat(6000)}`
      return 'an answer'
    }
    const { ctx, fake } = await boot({ fake: { answer }, accounts: ['chatgpt-main', 'chatgpt-2'], sessions: { checkpointEveryTurns: 3, compactAtTokens: 1000 } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'panel', input: 'Plan it' }).runId, 120_000)
    const m1 = ctx.workerSessions.ofRun(done.runId).find((m) => m.role === 'm1')!
    const conversationBefore = ctx.workers.handle(m1.sessionId)
    ctx.workerSessions.send({ from: 'operator', messageId: 'long-1', to: { session: m1.sessionId }, body: 'Long update one.' })
    // Past the threshold: the session writes its handoff in its own conversation, and continues in a new one.
    await until(() => ctx.artifacts.list({ kind: 'handoff' }).length === 1, 120_000)
    const [handoff] = ctx.artifacts.list({ kind: 'handoff' })
    expect(handoff).toMatchObject({ bodySchema: 'session-summary@1.0', body: { sessionId: m1.sessionId, reason: 'compaction', summary: 'HANDOFF: the plan is agreed; the open question is the deadline.', generation: 0 } })
    await until(() => ctx.workerSessions.session(m1.sessionId)!.binding.generation === 1 && ctx.workerSessions.session(m1.sessionId)!.state === 'IDLE', 30_000)
    ctx.workerSessions.send({ from: 'operator', messageId: 'after', to: { session: m1.sessionId }, body: 'What is open?' })
    await until(() => fake.sent.some((s) => s.prompt.includes('<handoff>')), 120_000)
    const resumed = fake.sent.find((s) => s.prompt.includes('<handoff>'))!
    expect(resumed.prompt).toContain('the open question is the deadline')
    await until(() => ctx.workerSessions.session(m1.sessionId)!.state === 'IDLE' && ctx.workers.handle(m1.sessionId) !== undefined, 60_000)
    expect(ctx.workers.handle(m1.sessionId)).not.toBe(conversationBefore)
    expect(ctx.workerSessions.session(m1.sessionId)).toMatchObject({ sessionId: m1.sessionId, binding: { generation: 1, nativeHandle: ctx.workers.handle(m1.sessionId) } })
    // Checkpoints at bounded intervals: the third turn (the two panel rounds do not count) writes one.
    expect(ctx.artifacts.list({ kind: 'report' }).filter((a) => a.bodySchema === 'session-summary@1.0').length).toBeGreaterThanOrEqual(1)
  }, 300_000)

  it('fails closed when a team needs more distinct accounts than are ready (REQ-TEAM-4)', async () => {
    const { ctx } = await boot({ fake: { answer: 'x' } })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'panel', input: 'q' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'config_error', message: expect.stringContaining('distinct accounts') } })
  }, 90_000)

  it('lets the operator stop a run: running work is cancelled, nothing else starts, nothing is resent (REQ-WF-7)', async () => {
    const { ctx, fake } = await boot({ fake: { thinkMs: 20_000 } })
    const run = ctx.workflow.start({ template: 'deep-research', input: 'long one' })
    await until(() => ctx.workflow.get(run.runId)?.nodes[0]?.state === 'RUNNING' && fake.sent.length === 1)
    const stopped = await ctx.workflow.stop(run.runId, 'not needed any more')
    expect(stopped).toMatchObject({ status: 'failed', error: { kind: 'stopped', disposition: 'NONE' } })
    expect(stopped.nodes.map((n) => n.state)).toEqual(['FAILED', 'FAILED'])
    const turn = await ctx.turns.wait(stopped.nodes[0]!.executionId!, 10_000)
    expect(turn).toMatchObject({ status: 'failed', error: { kind: 'aborted' } })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(fake.sent).toHaveLength(1)
    await expect(ctx.workflow.stop(run.runId)).rejects.toThrow(/not running/)
  }, 90_000)

  it('drains: refuses new runs, reports what is still executing until it ends, and resumes (REQ-HOST-1)', async () => {
    const { ctx, fake } = await boot({ fake: { thinkMs: 3000 } })
    const run = ctx.workflow.start({ template: 'ask', input: 'a slow one' })
    await until(() => ctx.workflow.get(run.runId)?.nodes[0]?.state === 'RUNNING' && fake.sent.length === 1)
    expect(ctx.workflow.drain()).toEqual({ draining: true, active: [run.runId] })
    expect(() => ctx.workflow.start({ template: 'ask', input: 'new work' })).toThrow(/draining/)
    await until(() => ctx.workflow.drain().active.length === 0)
    expect(ctx.workflow.get(run.runId)).toMatchObject({ status: 'completed' })
    expect(ctx.workflow.resume()).toEqual({ draining: false, active: [] })
    expect(ctx.workflow.start({ template: 'ask', input: 'after resume' }).status).toBe('running')
  }, 60_000)

  it('lets the operator continue one failed node as a new attempt, recorded as their decision (REQ-WF-7)', async () => {
    const strict = [{ nodeId: 'ask:1', objective: 'x', prompt: '{{input}}', capabilities: ['reason'], tier: 'economy', conversation: 'temporary', acceptance: 'acceptance.cited', maxEscalations: 0 }]
    let cite = false
    const { ctx, fake } = await boot({ fake: { answer: () => (cite ? 'See https://src.example/a' : 'no source') }, workflow: { templates: { strict } } })
    const failed = await ctx.workflow.wait(ctx.workflow.start({ template: 'strict', input: 'q' }).runId, 60_000)
    expect(failed).toMatchObject({ status: 'failed', error: { kind: 'acceptance_rejected' } })
    cite = true
    const reopened = ctx.workflow.continue(failed.runId)
    expect(reopened).toMatchObject({ status: 'running' })
    const done = await ctx.workflow.wait(failed.runId, 60_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'See https://src.example/a' })
    expect(fake.sent).toHaveLength(2)
    const recovery = ctx.artifacts.list({ kind: 'decision', decisionType: 'recovery', runId: failed.runId }).map((a) => a.body as { decider: { type: string }; outcome: { option: string } })
    expect(recovery).toContainEqual(expect.objectContaining({ decider: expect.objectContaining({ type: 'operator' }), outcome: expect.objectContaining({ option: 'continue' }) }))
    expect(() => ctx.workflow.continue(failed.runId)).toThrow(/not failed/)
  }, 120_000)

  it('keeps a completed step when a later one fails: continuing re-runs only the failed step, on the same input (QA-2, REQ-WF-3)', async () => {
    const chain = [
      { nodeId: 'first:1', objective: 'x', prompt: 'first: {{input}}', capabilities: ['reason'], tier: 'economy', conversation: 'temporary', acceptance: 'acceptance.answer' },
      { nodeId: 'second:1', objective: 'y', dependsOn: ['first:1'], prompt: 'second: {{node:first:1}}', capabilities: ['reason'], tier: 'economy', conversation: 'temporary', acceptance: 'acceptance.cited', maxEscalations: 0 },
    ]
    let cite = false
    const { ctx, fake } = await boot({ fake: { answer: (p: string) => (p.startsWith('first') ? 'the first result' : cite ? 'See https://src.example/a' : 'no source') }, workflow: { templates: { chain } } })
    const failed = await ctx.workflow.wait(ctx.workflow.start({ template: 'chain', input: 'q' }).runId, 60_000)
    expect(failed.nodes.map((n) => n.state)).toEqual(['COMPLETED', 'FAILED'])
    const before = ctx.workflow.records(failed.runId)
    cite = true
    ctx.workflow.continue(failed.runId)
    const done = await ctx.workflow.wait(failed.runId, 60_000)
    expect(done.status).toBe('completed')
    // The first step was sent once; the second twice, both times on the same input hash.
    expect(fake.sent.map((s) => s.prompt.split(':')[0])).toEqual(['first', 'second', 'second'])
    const after = ctx.workflow.records(done.runId)
    expect(after[0]!.outputReceipt).toEqual(before[0]!.outputReceipt)
    expect(after[1]!.inputReceipt!.inputHash).toBe(before[1]!.inputReceipt!.inputHash)
  }, 120_000)

  it('deletes a finished run only on the exact version its preview showed (REQ-WF-7)', async () => {
    const { ctx } = await boot()
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'bye' }).runId, 30_000)
    const preview = ctx.workflow.delete(done.runId)
    expect(preview).toMatchObject({ deleted: false, runId: done.runId, status: 'completed', updatedAt: done.updatedAt, nodes: 1 })
    expect(() => ctx.workflow.delete(done.runId, '2000-01-01T00:00:00.000Z')).toThrow(/changed/)
    expect(ctx.workflow.delete(done.runId, preview.updatedAt)).toMatchObject({ deleted: true })
    expect(ctx.workflow.get(done.runId)).toBeUndefined()
    // Artifacts are append-only and stay.
    expect(ctx.artifacts.get(done.result!)).toBeDefined()
  }, 60_000)

  it('re-runs everything downstream of a superseded result, and records why (lineage invalidation, REQ-ART-2)', async () => {
    const { ctx, fake } = await boot()
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'deep-research', input: 'q' }).runId, 60_000)
    expect(done.status).toBe('completed')
    const old = ctx.workflow.records(done.runId)[0]!.outputReceipt!.result
    const reopened = ctx.workflow.supersede(done.runId, 'research:1', { text: 'Corrected report https://src.example/fixed', note: 'the first report misread the catalog' })
    expect(reopened).toMatchObject({ status: 'running' })
    const again = await ctx.workflow.wait(done.runId, 60_000)
    expect(again.status).toBe('completed')
    expect(fake.sent).toHaveLength(3)
    expect(fake.sent[2]!.prompt).toContain('Corrected report https://src.example/fixed')
    const records = ctx.workflow.records(done.runId)
    const replacement = ctx.artifacts.get(records[0]!.outputReceipt!.result)!
    expect(replacement).toMatchObject({ lineage: { supersedes: [old] }, producer: { type: 'operator' } })
    const recovery = ctx.artifacts.get(records[1]!.inputReceipt!.bundle[0]!)
    expect(recovery?.id).toBe(replacement.id)
    const invalidation = ctx.artifacts.list({ kind: 'decision', decisionType: 'recovery', runId: done.runId })
      .map((a) => a.body as { outcome: { option: string }; inputs: string[] })
      .find((b) => b.outcome.option === 'rerun')!
    expect(invalidation.inputs).toEqual([old, replacement.id].sort())
    expect(() => ctx.workflow.supersede(done.runId, 'compact:1', { text: 'x' })).not.toThrow()
    await ctx.workflow.wait(done.runId, 60_000)
  }, 150_000)

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
    const { url, tokenFile } = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as { url: string; tokenFile: string }
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${readFileSync(tokenFile).toString('base64url')}` } } }) as unknown as Transport)
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
