import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'
import { McpTools, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import WorkerSessions from '../src/index.ts'

/** A `ctx.mcp` that keeps contributed tools, so a test calls a handler as a given scope would. */
class RecordingMcp extends McpTools {
  readonly tools = new Map<string, { spec: ToolSpec; handler: ToolHandler }>()
  tool(name: string, spec: ToolSpec, handler: ToolHandler): void {
    this.tools.set(name, { spec, handler })
  }
}

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function boot(at?: string) {
  const dir = at ?? mkdtempSync(join(tmpdir(), 'system-sessions-'))
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(WorkerSessions, {})]
  await Promise.all(fibers)
  if (!at) cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const stop = async () => { for (const f of [...fibers].reverse()) await f.dispose() }
  cleanups.push(stop)
  return Object.assign(ctx, { dir, stop })
}

const H = (c: string) => `sha256:${c.repeat(64)}` as const
const team = (ctx: Context, barrier = true) => {
  ctx.workerSessions.group('grp-1', { barrier })
  ctx.workerSessions.join('grp-1', { sessionId: 'ses_a', role: 'm1', runtime: 'website', worker: 'worker:acct-a/standard', formation: H('a'), runId: 'run_1', nodeId: 'panel' })
  ctx.workerSessions.join('grp-1', { sessionId: 'ses_b', role: 'm2', runtime: 'website', worker: 'worker:acct-b/standard', formation: H('b') })
  ctx.workerSessions.join('grp-1', { sessionId: 'ses_c', role: 'm3', runtime: 'claude-agent-sdk', worker: 'agent:c', formation: H('c'), mayMessage: ['ses_a'] })
}

describe('ctx.workerSessions: sessions, mailboxes, direct messages (ADR-0015)', () => {
  it('binds each member\'s session to its Worker when it joins (Model A), as worker-session@1.0', async () => {
    const ctx = await boot()
    team(ctx)
    const session = ctx.workerSessions.session('ses_a')!
    new SchemaRegistry().assertRecord(session)
    expect(session).toMatchObject({ sessionId: 'ses_a', group: 'grp-1', role: 'm1', state: 'IDLE', worker: 'worker:acct-a/standard', formation: H('a'), mailboxSeq: 0, binding: { runtime: 'website', generation: 0 } })
    expect(ctx.workerSessions.join('grp-1', { sessionId: 'ses_a', role: 'm1', runtime: 'website', worker: 'worker:acct-a/standard', formation: H('a') }).revision).toBe(0)
    expect(() => ctx.workerSessions.join('grp-1', { sessionId: 'ses_a', role: 'm1', runtime: 'website', worker: 'worker:other/standard', formation: H('d') })).toThrow(/bound/)
    expect(() => ctx.workerSessions.group('grp-1')).toThrow(/already/)
  })

  it('holds messages behind a closed barrier, then delivers them in order (the barrier is a mailbox gate, REQ-SES-3)', async () => {
    const ctx = await boot()
    team(ctx)
    const sent = ctx.workerSessions.send({ from: 'ses_a', messageId: 'a-1', to: { group: 'grp-1' }, intent: 'answer', body: 'A says one' })
    expect(sent).toMatchObject({ accepted: true, delivered: ['ses_b', 'ses_c'] })
    expect(ctx.workerSessions.inbox('ses_b')).toEqual([])
    ctx.workerSessions.openBarrier('grp-1')
    ctx.workerSessions.send({ from: 'ses_c', messageId: 'c-1', to: { session: 'ses_a' }, body: 'C to A' })
    const inbox = ctx.workerSessions.inbox('ses_b')
    expect(inbox.map((m) => [m.seq, m.from, m.message.body])).toEqual([[1, 'ses_a', 'A says one']])
    expect(ctx.artifacts.get(inbox[0]!.artifact)).toMatchObject({ kind: 'message', bodySchema: 'message@1.0' })
    expect(ctx.workerSessions.inbox('ses_a').map((m) => m.message.body)).toEqual(['C to A'])
    ctx.workerSessions.ack('ses_b', 1)
    expect(ctx.workerSessions.inbox('ses_b')).toEqual([])
    expect(ctx.workerSessions.session('ses_b')).toMatchObject({ mailboxSeq: 1 })
  })

  it('refuses what the group policy does not allow, and records why (REQ-SES-4)', async () => {
    const ctx = await boot()
    team(ctx, false)
    const refused = ctx.workerSessions.send({ from: 'ses_c', messageId: 'c-2', to: { session: 'ses_b' }, body: 'not allowed' })
    expect(refused).toMatchObject({ accepted: false, reason: expect.stringMatching(/may not message/) })
    expect(ctx.artifacts.get((refused as { decision: string }).decision)?.body).toMatchObject({ decisionType: 'gate', outcome: { option: 'refuse' } })
    expect(ctx.workerSessions.send({ from: 'ses_x', messageId: 'x', to: { group: 'grp-1' }, body: 'stranger' })).toMatchObject({ accepted: false })
    expect(ctx.workerSessions.inbox('ses_b')).toEqual([])
  })

  it('records who sent through session_send by the caller\'s scope: a client token is never the operator (QA-14, INV-13)', async () => {
    const ctx = await boot()
    team(ctx, false)
    const fiber = ctx.plugin(RecordingMcp)
    await fiber
    cleanups.push(() => fiber.dispose())
    await new Promise((resolve) => setTimeout(resolve, 0))
    const mcp = (ctx as unknown as { mcp: RecordingMcp }).mcp
    const send = mcp.tools.get('session_send')!
    expect(send.spec.scope).toBe('client')
    await send.handler({ to: 'ses_b', body: 'from a client', messageId: 'c-1' }, { scope: 'client' })
    await send.handler({ to: 'ses_b', body: 'from the operator', messageId: 'o-1' }, { scope: 'operator' })
    const inbox = ctx.workerSessions.inbox('ses_b')
    expect(inbox.map((m) => [m.from, m.message.body])).toEqual([['client', 'from a client'], ['operator', 'from the operator']])
    expect(inbox.map((m) => ctx.artifacts.get(m.artifact)?.producer)).toEqual([{ type: 'system', ref: 'mcp-client' }, { type: 'operator', ref: 'operator' }])
  })

  it('delivers at most once per sender message id, and lets the operator write to a session (REQ-SES-3)', async () => {
    const ctx = await boot()
    team(ctx, false)
    ctx.workerSessions.send({ from: 'ses_a', messageId: 'a-1', to: { session: 'ses_b' }, body: 'once' })
    ctx.workerSessions.send({ from: 'ses_a', messageId: 'a-1', to: { session: 'ses_b' }, body: 'once' })
    ctx.workerSessions.send({ from: 'operator', messageId: 'op-1', to: { session: 'ses_b' }, intent: 'request', body: 'please cite' })
    expect(ctx.workerSessions.inbox('ses_b').map((m) => [m.from, m.message.body])).toEqual([['ses_a', 'once'], ['operator', 'please cite']])
  })

  it('announces deliveries that ask for a reply, and activates an idle session once per turn within its budget (REQ-SES-5)', async () => {
    const ctx = await boot()
    team(ctx, false)
    const woken: string[][] = []
    ctx.on('worker-sessions/delivered', (ids) => void woken.push(ids))
    ctx.workerSessions.send({ from: 'operator', messageId: 'q1', to: { session: 'ses_a' }, body: 'question' })
    ctx.workerSessions.send({ from: 'ses_b', messageId: 'a1', to: { session: 'ses_a' }, intent: 'answer', body: 'an answer wakes nobody' })
    expect(woken).toEqual([['ses_a']])
    expect(ctx.workerSessions.pending()).toEqual(['ses_a'])
    // ACTIVE needs the native conversation to resume (worker-session@1.0).
    expect(ctx.workerSessions.activate('ses_a', undefined)).toMatchObject({ activated: false, reason: expect.stringMatching(/no conversation/) })
    expect(ctx.workerSessions.activate('ses_a', 'https://chatgpt.test/c/1')).toEqual({ activated: true })
    expect(ctx.workerSessions.session('ses_a')).toMatchObject({ state: 'ACTIVE', binding: { nativeHandle: 'https://chatgpt.test/c/1' }, usage: { turns: 1 } })
    new SchemaRegistry().assertRecord(ctx.workerSessions.session('ses_a')!)
    expect(ctx.workerSessions.activate('ses_a', 'https://chatgpt.test/c/1')).toMatchObject({ activated: false, reason: expect.stringMatching(/ACTIVE/) })
    ctx.workerSessions.settle('ses_a')
    expect(ctx.workerSessions.session('ses_a')!.state).toBe('IDLE')
    expect(ctx.workerSessions.ofRun('run_1').map((s) => s.sessionId)).toEqual(['ses_a'])
  })

  it('keeps a session\'s identity, Worker, and mailbox across a host restart (REQ-SES-1)', async () => {
    const first = await boot()
    team(first, false)
    first.workerSessions.send({ from: 'operator', messageId: 'q1', to: { session: 'ses_a' }, body: 'question' })
    const before = first.workerSessions.session('ses_a')!
    await first.stop()
    const again = await boot(first.dir)
    expect(again.workerSessions.session('ses_a')).toEqual(before)
    expect(again.workerSessions.inbox('ses_a').map((m) => m.message.body)).toEqual(['question'])
    expect(() => again.workerSessions.join('grp-1', { sessionId: 'ses_a', role: 'm1', runtime: 'website', worker: 'worker:other/standard', formation: H('d') })).toThrow(/bound/)
  })

  it('bounds turns, lifetime, and idle time: exceeding one fails the session, classified by budget (REQ-SES-7)', async () => {
    const decisions = (ctx: Awaited<ReturnType<typeof boot>>) => ctx.artifacts.list({ kind: 'decision', decisionType: 'gate' })
      .map((a) => (a.body as { outcome: { detail?: { budget?: string } } }).outcome.detail?.budget).filter(Boolean)
    const turns = await boot()
    team(turns, false)
    for (let i = 0; i < 100; i++) {
      expect(turns.workerSessions.activate('ses_a', 'h')).toEqual({ activated: true })
      turns.workerSessions.settle('ses_a')
    }
    expect(turns.workerSessions.activate('ses_a', 'h')).toMatchObject({ activated: false, budget: 'turns' })
    expect(turns.workerSessions.session('ses_a')!.state).toBe('FAILED')
    expect(decisions(turns)).toEqual(['turns'])
    const old = await boot()
    team(old, false)
    expect(old.workerSessions.activate('ses_a', 'h', Date.now() + 1441 * 60_000)).toMatchObject({ activated: false, budget: 'lifetime' })
    expect(old.workerSessions.activate('ses_b', 'h')).toEqual({ activated: true })
    old.workerSessions.settle('ses_b')
    expect(old.workerSessions.activate('ses_b', 'h', Date.now() + 721 * 60_000)).toMatchObject({ activated: false, budget: 'idle' })
    expect(decisions(old).sort()).toEqual(['idle', 'lifetime'])
  })

  it('waits in INPUT_REQUIRED until input arrives, then any reply wakes it; a compaction advances the generation (REQ-SES-7, REQ-SES-6)', async () => {
    const ctx = await boot()
    team(ctx, false)
    const woken: string[][] = []
    ctx.on('worker-sessions/delivered', (ids) => void woken.push(ids))
    ctx.workerSessions.activate('ses_a', 'h-1')
    expect(ctx.workerSessions.settle('ses_a', { inputRequired: true, tokens: 120, nativeHandle: 'h-1' })).toMatchObject({ state: 'INPUT_REQUIRED', usage: { estimatedTokens: 120 } })
    new SchemaRegistry().assertRecord(ctx.workerSessions.session('ses_a')!)
    ctx.workerSessions.send({ from: 'ses_b', messageId: 'a1', to: { session: 'ses_a' }, intent: 'answer', body: 'metres' })
    expect(woken).toEqual([['ses_a']])
    expect(ctx.workerSessions.activate('ses_a', 'h-1')).toEqual({ activated: true })
    ctx.workerSessions.settle('ses_a', { tokens: 80 })
    expect(ctx.workerSessions.rebind('ses_a', 30)).toMatchObject({ state: 'IDLE', binding: { generation: 1, nativeHandle: 'h-1' }, usage: { estimatedTokens: 30 } })
  })
})

