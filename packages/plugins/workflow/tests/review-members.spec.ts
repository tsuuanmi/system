/**
 * `review` team members on Workers whose offers are scoped to a review member's steps (ADR-0049):
 * the engine names that kind of work on every member step, and nothing else, so such a Worker is a
 * member of a review, single-round or with a debate, and never takes an ask or a brainstorm. The
 * Workers are scripted as an `agents` source describes a read-only agent named a review member.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { sha256, startPrompt } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { ArtifactRef, CapabilityDescriptor, WorkerExecution, WorkerStart } from '@tsuuanmi/system-workers-core'
import { afterEach, describe, expect, it } from 'vitest'
import { worker } from '../../../workers-core/conformance/workers.ts'
import Workflow from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const AT = '2026-10-23T00:00:00Z'
const MATERIAL = 'Review this change:\nfunction f() {\n  const lease = acquire()\n  work()\n}'

/** An agent Worker named a review member: review and local-data for any work; reason, and its conversation, for a review member's steps only. */
const member = (id: string, family: string): CapabilityDescriptor => worker(id, {
  schema: 'capability-descriptor@1.4', provider: family, family, quotaClass: 'agent-plan', locality: 'local',
  capabilities: [
    ...['local-data', 'review'].map((capability) => ({ capability, evidence: { kind: 'probe' as const, at: AT } })),
    { capability: 'reason', evidence: { kind: 'probe', at: AT }, scope: 'review-member' },
    { capability: 'persistent-conversation', evidence: { kind: 'conformance', at: AT }, scope: 'review-member' },
  ],
})
/** A website Worker: reason and its conversation for any work. */
const website = worker('web:a', { schema: 'capability-descriptor@1.1', family: 'site-a', proves: ['reason', 'persistent-conversation'] })

const isProposal = (prompt: string): boolean => prompt.includes('Answer on your own')
const findings = '```json\n' + JSON.stringify({ findings: [{ severity: 'warning', claim: 'the lease is never released', evidence: 'line 3', quote: { path: 'material', line: 3, text: 'const lease = acquire()' } }] }) + '\n```'
const ballot = (choice: 'pass' | 'changes', objections: string[] = []): string => '```json\n' + JSON.stringify({
  choice, ranking: [choice, choice === 'pass' ? 'changes' : 'pass'], rationale: `I vote ${choice}`, evidence: [], strongest: { [choice === 'pass' ? 'changes' : 'pass']: 'it is careful' }, objections, confidence: 'high',
}) + '\n```'

/** A scripted source over `workers`: sessions stay on their Worker; each start answers at once. */
function scripted(ctx: Context, workers: CapabilityDescriptor[], answer: (prompt: string, start: WorkerStart) => string) {
  const started: Array<WorkerStart & { prompt: string }> = []
  const sessions = new Map<string, string>()
  const executions = new Map<string, WorkerExecution>()
  ctx.workers.register({
    name: 'scripted', describe: async () => workers,
    start: (request) => {
      const prompt = startPrompt(request, (ref) => ctx.artifacts.get(ref)).prompt
      if (request.sessionId) sessions.set(request.sessionId, sessions.get(request.sessionId) ?? request.worker)
      started.push({ ...request, prompt })
      const id = `x-${started.length}`
      const result = ctx.artifacts.put({
        kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'public', producer: { type: 'worker', ref: request.worker },
        body: { schema: 'provider-answer@1.0', provider: 'scripted', account: 'scripted', turnId: id, conversation: { mode: 'temporary' }, promptHash: sha256(prompt), text: answer(prompt, request) },
      }).id as ArtifactRef
      const execution: WorkerExecution = { id, status: 'completed', submitted: true, result, decisions: [] }
      executions.set(id, execution)
      return execution
    },
    get: (id) => executions.get(id),
    wait: async (id) => executions.get(id)!,
    affinity: (sessionId) => (sessions.has(sessionId) ? [sessions.get(sessionId)!] : undefined),
  })
  return started
}

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'system-review-members-'))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, { retryDelayMs: 100 }),
  ]
  await Promise.all(fibers)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  return { ctx }
}

const routeReasons = (ctx: Context, ref: string): string[] =>
  (ctx.artifacts.get(ref as ArtifactRef)!.body as { candidates: Array<{ selected: boolean; reasons: string[] }> }).candidates.find((c) => c.selected)!.reasons

describe('review team members on Workers scoped to a review member\'s steps (ADR-0049)', () => {
  it('runs a review with two such members, each step named review-member work; an ask and a brainstorm never reach them', async () => {
    const { ctx } = await boot()
    const started = scripted(ctx, [member('agent:a', 'runtime-a'), member('agent:b', 'runtime-b')], (prompt) => (isProposal(prompt) ? findings : ballot('pass')))
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'review', input: MATERIAL, classification: 'public' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'completed' })
    expect(done.answer).toMatch(/^outcome: pass; method: team-majority; winner: pass;/)
    // Members differ in family (ADR-0027), each in its own session, on its own Worker.
    expect(new Set(started.map((s) => s.worker))).toEqual(new Set(['agent:a', 'agent:b']))
    for (const id of ['agent:a', 'agent:b']) expect(new Set(started.filter((s) => s.worker === id).map((s) => s.sessionId)).size).toBe(1)
    // Every member step is review-member work; the source, tally, and decision are not.
    const records = ctx.workflow.records(done.runId)
    for (const record of records) {
      if (/^review:m\d:/.test(record.nodeId)) expect(record.requirement, record.nodeId).toMatchObject({ schema: 'work-requirement@1.1', scope: 'review-member', capabilities: ['reason', 'persistent-conversation'] })
      else expect(record.requirement, record.nodeId).toMatchObject({ schema: 'work-requirement@1.0' })
    }
    expect(started.every((s) => s.requirement.scope === 'review-member')).toBe(true)
    // The route says the scoped offers proved it, for that work.
    const m1 = done.nodes.find((n) => n.nodeId === 'review:m1:propose')!
    const route = (ctx.workflow.explain(done.runId)!.nodes.find((n) => n.nodeId === m1.nodeId)!.decisions.find((d) => d.type === 'route'))!
    expect(routeReasons(ctx, route.id)[0]).toBe('proves reason, persistent-conversation for review-member work')
    // An ask and a brainstorm fail closed, naming the capability no Worker proves for them, and nothing is sent (P1).
    const asked = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'q', classification: 'public' }).runId, 30_000)
    expect(asked).toMatchObject({ status: 'failed', error: { message: expect.stringMatching(/no Worker proves reason \(.*it proves reason only for review-member work/) } })
    const brainstorm = await ctx.workflow.wait(ctx.workflow.start({ template: 'brainstorm', input: 'q', classification: 'public' }).runId, 30_000)
    expect(brainstorm).toMatchObject({ status: 'failed', error: { message: expect.stringMatching(/no Worker proves reason, persistent-conversation/) } })
    expect(started).toHaveLength(4)
  }, 60_000)

  it('names review-member work on each debate step too, and keeps every member step on its member\'s Worker', async () => {
    const { ctx } = await boot()
    let ballots = 0
    // A split with objections, then both pass in the debate.
    const started = scripted(ctx, [member('agent:a', 'runtime-a'), member('agent:b', 'runtime-b')], (prompt) => (isProposal(prompt) ? findings
      : prompt.includes('is split') ? ballot('pass') : ++ballots === 1 ? ballot('changes', ['the lease leaks']) : ballot('pass', ['it is fine'])))
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'review', input: MATERIAL, classification: 'public' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'completed' })
    const debates = ctx.workflow.records(done.runId).filter((r) => /^review:m\d:debate:1$/.test(r.nodeId))
    expect(debates.map((r) => r.requirement)).toEqual([expect.objectContaining({ scope: 'review-member' }), expect.objectContaining({ scope: 'review-member' })])
    expect(started).toHaveLength(6)
    for (const s of started) expect(started.filter((t) => t.sessionId === s.sessionId).every((t) => t.worker === s.worker)).toBe(true)
  }, 60_000)

  it('still puts a website Worker first among the Workers a member step admits: the quota order is unchanged (REQ-WRK-8)', async () => {
    const { ctx } = await boot()
    const started = scripted(ctx, [website, member('agent:b', 'runtime-b')], (prompt) => (isProposal(prompt) ? findings : ballot('pass')))
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'review', input: MATERIAL, classification: 'public' }).runId, 60_000)
    expect(done).toMatchObject({ status: 'completed' })
    const workers = Object.fromEntries(done.nodes.map((n) => [n.nodeId, n.worker]))
    expect(workers).toMatchObject({ 'review:m1:propose': 'web:a', 'review:m2:propose': 'agent:b' })
    // The ask goes to the website Worker; the agent member never takes it.
    const asked = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'q', classification: 'public' }).runId, 30_000)
    expect(asked).toMatchObject({ status: 'completed', nodes: [{ worker: 'web:a' }] })
    expect(started.filter((s) => s.worker === 'agent:b').every((s) => s.requirement.scope === 'review-member')).toBe(true)
  }, 60_000)
})
