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

// The seam's contract is held by its conformance suite (conformance.spec.ts); these tests pin what
// only this provider does.
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

  it('records an Antigravity CLI member\'s runtime as worker-session@1.1, and a record that names it as @1.0 is refused', async () => {
    const ctx = await boot()
    team(ctx)
    ctx.workerSessions.join('grp-1', { sessionId: 'ses_d', role: 'm4', runtime: 'antigravity-cli', worker: 'agent:agy-review', formation: H('d') })
    const session = ctx.workerSessions.session('ses_d')!
    new SchemaRegistry().assertRecord(session)
    expect(session).toMatchObject({ schema: 'worker-session@1.1', binding: { runtime: 'antigravity-cli', generation: 0 } })
    expect(ctx.workerSessions.session('ses_a')).toMatchObject({ schema: 'worker-session@1.0' })
    expect(() => new SchemaRegistry().assertRecord({ ...session, schema: 'worker-session@1.0' })).toThrow()
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
    expect(ctx.workerSessions.activate('ses_a', 'https://chatgpt.test/c/1')).toEqual({ activated: true, generation: 1 })
    expect(ctx.workerSessions.session('ses_a')).toMatchObject({ state: 'ACTIVE', binding: { nativeHandle: 'https://chatgpt.test/c/1' }, usage: { turns: 1 } })
    new SchemaRegistry().assertRecord(ctx.workerSessions.session('ses_a')!)
    expect(ctx.workerSessions.activate('ses_a', 'https://chatgpt.test/c/1')).toMatchObject({ activated: false, reason: expect.stringMatching(/ACTIVE/) })
    ctx.workerSessions.settle('ses_a', 1)
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
      expect(turns.workerSessions.activate('ses_a', 'h')).toEqual({ activated: true, generation: i + 1 })
      turns.workerSessions.settle('ses_a', i + 1)
    }
    expect(turns.workerSessions.activate('ses_a', 'h')).toMatchObject({ activated: false, budget: 'turns' })
    expect(turns.workerSessions.session('ses_a')!.state).toBe('FAILED')
    expect(decisions(turns)).toEqual(['turns'])
    const old = await boot()
    team(old, false)
    expect(old.workerSessions.activate('ses_a', 'h', Date.now() + 1441 * 60_000)).toMatchObject({ activated: false, budget: 'lifetime' })
    expect(old.workerSessions.activate('ses_b', 'h')).toEqual({ activated: true, generation: 1 })
    old.workerSessions.settle('ses_b', 1)
    expect(old.workerSessions.activate('ses_b', 'h', Date.now() + 721 * 60_000)).toMatchObject({ activated: false, budget: 'idle' })
    expect(decisions(old).sort()).toEqual(['idle', 'lifetime'])
  })

  it('waits in INPUT_REQUIRED until input arrives, then any reply wakes it; every activation and a compaction advance the generation (REQ-SES-7, REQ-SES-6, REQ-SES-1)', async () => {
    const ctx = await boot()
    team(ctx, false)
    const woken: string[][] = []
    ctx.on('worker-sessions/delivered', (ids) => void woken.push(ids))
    ctx.workerSessions.activate('ses_a', 'h-1')
    expect(ctx.workerSessions.settle('ses_a', 1, { inputRequired: true, tokens: 120, nativeHandle: 'h-1' })).toMatchObject({ state: 'INPUT_REQUIRED', usage: { estimatedTokens: 120 } })
    new SchemaRegistry().assertRecord(ctx.workerSessions.session('ses_a')!)
    ctx.workerSessions.send({ from: 'ses_b', messageId: 'a1', to: { session: 'ses_a' }, intent: 'answer', body: 'metres' })
    expect(woken).toEqual([['ses_a']])
    expect(ctx.workerSessions.activate('ses_a', 'h-1')).toEqual({ activated: true, generation: 2 })
    expect(() => ctx.workerSessions.settle('ses_a', 1, { tokens: 9999 })).toThrow(/stale/)
    ctx.workerSessions.settle('ses_a', 2, { tokens: 80 })
    expect(ctx.workerSessions.rebind('ses_a', 30)).toMatchObject({ state: 'IDLE', binding: { generation: 3, nativeHandle: 'h-1' }, usage: { estimatedTokens: 30 } })
  })
})

