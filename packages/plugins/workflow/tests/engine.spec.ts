import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import type { ModelEntry } from '@tsuuanmi/system-models-core'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { FakeModels, type FakeScript } from '../../../models-core/conformance/models.ts'
import type { CapabilityDescriptor, WorkerExecution } from '@tsuuanmi/system-workers-core'
import { source, worker } from '../../../workers-core/conformance/workers.ts'
import { ModelWorkers } from '../../models/src/index.ts'
import Workflow from '../src/index.ts'
import type { RunView } from '../src/types.ts'
import { TEST_TEMPLATES } from './templates.ts'

const CATALOG: ModelEntry[] = [{ id: 'fast', tier: 'standard', quotaClass: 'metered', locality: 'remote', maxTokens: 64 }]

/** The engine over a fake model Worker: no browser, so faults are injected deterministically. */
async function boot(script: FakeScript = {}, workflow: Record<string, unknown> = {}, catalog: ModelEntry[] = CATALOG) {
  const dir = mkdtempSync(join(tmpdir(), 'system-engine-'))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(FakeModels, { catalog, script }),
    ctx.plugin(ModelWorkers, { callTimeoutMs: 60_000 }), ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, { retryDelayMs: 100, ...workflow }),
  ]
  await Promise.all(fibers)
  // Start-up recovery has run, so nothing scheduled then can take a run back by chance.
  await new Promise((resolve) => setTimeout(resolve, 200))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  onTestFinished(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  return { ctx }
}

describe('ctx.workflow: the engine under injected faults', () => {
  it('takes a run back after its lease is lost while a node waits on its execution, instead of stranding it', async () => {
    const { ctx } = await boot({ holdMs: 23_000 })
    const run = ctx.workflow.start({ template: 'ask', input: 'q', classification: 'public' })
    const node = (): string => ctx.workflow.get(run.runId)!.nodes[0]!.state
    while (node() !== 'RUNNING') await new Promise((resolve) => setTimeout(resolve, 50))
    // The host slept past the lease: the next heartbeat (a third of the TTL) finds it expired and gives it up.
    ctx.store.db.prepare('UPDATE leases SET expires_at = 1 WHERE resource = ?').run(`run:${run.runId}`)
    // The model call ends after that heartbeat; the run must still finish, not stay running for ever.
    expect(await ctx.workflow.wait(run.runId, 40_000)).toMatchObject({ status: 'completed', answer: 'echo: q' })
  }, 60_000)

  it('ends an admission\'s pending count when its execution fails to start right after routing (ADR-0033)', async () => {
    const { ctx } = await boot()
    let reserved = 0
    let pending = 0
    // Ranked first (its quota class is preferred over the model Worker's), and it never starts.
    ctx.workers.register(source('flaky', [worker('w:flaky')], {
      reserve: () => {
        reserved++
        pending++
        return () => void pending--
      },
      start: () => {
        throw new Error('the runtime refused the work')
      },
    }))
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'q', classification: 'public' }).runId, 30_000)
    expect(done.status).toBe('failed')
    expect(reserved).toBeGreaterThan(0)
    expect(pending).toBe(0)
  }, 60_000)

  it('fails a node whose only Worker is under a usage limit for what it needs as quota_exhausted, unsent (ADR-0034)', async () => {
    const survey = { nodeId: 'survey:1', objective: 'survey', prompt: 'Survey {{input}}', capabilities: ['reason', 'deep-research'], tier: 'standard', conversation: 'persistent', acceptance: 'acceptance.answer' }
    const { ctx } = await boot({}, { templates: { survey: [survey] } })
    const until = new Date(Date.now() + 3_600_000).toISOString()
    ctx.workers.register(source('limited', [worker('w:limited', { schema: 'capability-descriptor@1.3', proves: ['reason', 'persistent-conversation', 'deep-research'], cooldowns: [{ capability: 'deep-research', until }] })]))
    const run = ctx.workflow.start({ template: 'survey', input: 'q', classification: 'public' })
    const done = await ctx.workflow.wait(run.runId, 30_000)
    expect(done.status).toBe('failed')
    expect(done.nodes.find((n) => n.error?.kind === 'quota_exhausted')?.error?.message).toMatch(/deep-research limit until/)
  }, 60_000)

  /** Two scripted Workers: each attempt's outcome per Worker comes from `plan`, then they answer. */
  function pair(ctx: Context, plan: Record<string, Array<{ kind: string; disposition: string; sent: boolean }>>, workers: Array<string | CapabilityDescriptor> = ['w:a', 'w:b'], siblings?: (worker: string) => string[] | undefined) {
    const started: string[] = []
    const executions = new Map<string, WorkerExecution>()
    ctx.workers.register(source('pair', workers.map((w) => (typeof w === 'string' ? worker(w) : w)), {
      ...(siblings ? { siblings } : {}),
      start: (request) => {
        started.push(request.worker)
        const fault = plan[request.worker]?.shift()
        const id = `x-${started.length}`
        const execution: WorkerExecution = fault
          ? { id, status: 'failed', submitted: fault.sent, error: { kind: fault.kind, disposition: fault.disposition, message: `${fault.kind} on ${request.worker}` } as never, decisions: [] }
          : { id, status: 'completed', submitted: true, decisions: [], result: ctx.artifacts.put({ kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'public', producer: { type: 'worker', ref: request.worker },
            body: { schema: 'provider-answer@1.0', provider: 'p', account: request.worker.replace(/^w:/, 'acct-').replace(/[^a-z0-9-]/g, '-'), turnId: id, conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text: `answer from ${request.worker}` } }).id as `sha256:${string}` }
        executions.set(id, execution)
        return execution
      },
      get: (id) => executions.get(id),
      wait: async (id) => executions.get(id)!,
    }))
    return started
  }

  it('fails an unsent limit over to a sibling Worker, with a failover decision, and never moves a sent one (ADR-0034)', async () => {
    const { ctx } = await boot()
    const started = pair(ctx, { 'w:a': [{ kind: 'quota_exhausted', disposition: 'USER_ACTION', sent: false }] })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'q', classification: 'public' }).runId, 30_000)
    expect(done.status).toBe('completed')
    expect(started).toEqual(['w:a', 'w:b'])
    const retry = ctx.eventLog.query({ type: 'workflow.node.retry' })[0]!
    expect(retry.data).toMatchObject({ kind: 'quota_exhausted', failoverFrom: 'w:a' })
    const recovery = ctx.artifacts.get(retry.decision as `sha256:${string}`)?.body as { decisionType: string; outcome: { option: string; detail?: Record<string, unknown> } }
    expect(recovery.outcome).toMatchObject({ option: 'failover', detail: { kind: 'quota_exhausted', from: 'w:a', sent: false } })

    const sent = await boot()
    const tried = pair(sent.ctx, { 'w:a': [{ kind: 'quota_exhausted', disposition: 'USER_ACTION', sent: true }] })
    const failed = await sent.ctx.workflow.wait(sent.ctx.workflow.start({ template: 'ask', input: 'q', classification: 'public' }).runId, 30_000)
    expect(failed).toMatchObject({ status: 'failed', error: { kind: 'quota_exhausted' } })
    expect(tried).toEqual(['w:a'])
  }, 60_000)

  it('fails over from every tier of the failed account, never to another tier of it (ADR-0034)', async () => {
    const { ctx } = await boot({}, {}, [])
    const at = (id: string, tier: 'standard' | 'frontier') => worker(id, { tier })
    const account = (id: string) => /^w:(.)/.exec(id)?.[1]
    const started = pair(ctx, { 'w:a-standard': [{ kind: 'overloaded', disposition: 'BACKOFF', sent: false }] },
      [at('w:a-standard', 'standard'), at('w:a-frontier', 'frontier'), at('w:b-frontier', 'frontier')],
      (w) => ['w:a-standard', 'w:a-frontier', 'w:b-frontier'].filter((x) => account(x) === account(w)))
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'q', classification: 'public' }).runId, 30_000)
    expect(done.status).toBe('completed')
    expect(started).toEqual(['w:a-standard', 'w:b-frontier'])
  }, 60_000)

  it('retries an unsent overload on the same Worker when no other one is left (ADR-0034)', async () => {
    const { ctx } = await boot({}, {}, [])
    const started = pair(ctx, { 'w:a': [{ kind: 'overloaded', disposition: 'BACKOFF', sent: false }] }, ['w:a'])
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'ask', input: 'q', classification: 'public' }).runId, 30_000)
    expect(done.status).toBe('completed')
    expect(started).toEqual(['w:a', 'w:a'])
  }, 60_000)

  it('fails the node a scheduler exception happened on, so the operator can continue it once fixed', async () => {
    const { ctx } = await boot()
    const accept = ctx.workers.accept.bind(ctx.workers)
    ctx.workers.accept = (() => {
      throw new Error('a defect in acceptance')
    }) as typeof accept
    const run = ctx.workflow.start({ template: 'ask', input: 'q', classification: 'public' })
    expect(await ctx.workflow.wait(run.runId, 20_000)).toMatchObject({
      status: 'failed', nodes: [{ state: 'FAILED', error: { kind: 'internal', disposition: 'CODE_FIX', message: 'a defect in acceptance' } }],
    })
    // The fix lands; continuing reopens the failed node instead of refusing a run with none.
    ctx.workers.accept = accept
    ctx.workflow.continue(run.runId)
    expect(await ctx.workflow.wait(run.runId, 20_000)).toMatchObject({ status: 'completed', answer: 'echo: q' })
  }, 60_000)

  it('retries a node whose start its Worker refused with a back-off, within the bound: the retry is a decision its event names, and explain keeps the refusal in its own words (REQ-WF-6, INV-13)', async () => {
    const { ctx } = await boot({}, { maxAttempts: 6 }, [])
    const executions = new Map<string, WorkerExecution>()
    let starts = 0
    ctx.workers.register(source('busy', [worker('w:busy')], {
      start: (request) => {
        // As the turn runtime refuses a turn beyond its bound (maxPendingTurns): before anything is sent.
        if (starts++ === 0) throw new ProviderError('overloaded', 'turns: 1 turn is pending, the most this runtime accepts; try again later')
        const id = `x-${starts}`
        executions.set(id, {
          id, status: 'completed', submitted: true, decisions: [], result: ctx.artifacts.put({ kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'public', producer: { type: 'worker', ref: request.worker },
            body: { schema: 'provider-answer@1.0', provider: 'p', account: 'acct-busy', turnId: id, conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text: 'answered after the back-off' } }).id as `sha256:${string}`,
        })
        return executions.get(id)!
      },
      get: (id) => executions.get(id),
      wait: async (id) => executions.get(id)!,
    }))
    const run = ctx.workflow.start({ template: 'ask', input: 'q', classification: 'public' })
    const done = await ctx.workflow.wait(run.runId, 30_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'answered after the back-off' })
    expect(done.nodes[0]!.attempt).toBeGreaterThan(1)
    expect(starts).toBe(2)
    const retry = ctx.eventLog.query({ type: 'workflow.node.retry', runId: run.runId })[0]!
    expect(retry.data).toMatchObject({ kind: 'overloaded', disposition: 'BACKOFF' })
    // The retry is a decision (INV-13), named by the event.
    expect(ctx.artifacts.get(retry.decision!)?.body).toMatchObject({ decisionType: 'recovery', outcome: { option: 'retry' } })
    // explain shows why the failed attempt failed, in its own words, after the run completed.
    const recovery = ctx.workflow.explain(run.runId)!.nodes[0]!.decisions.find((d) => d.type === 'recovery')!
    expect(recovery).toMatchObject({ outcome: 'retry', reasons: expect.arrayContaining([expect.stringMatching(/^error: turns: 1 turn is pending/)]) })
  }, 60_000)

  it('says why it refuses a start: an unknown template, a request key reused for another request, a host that drains until it resumes (INV-2, REQ-HOST-1)', async () => {
    const { ctx } = await boot({ holdMs: 2000 })
    expect(() => ctx.workflow.start({ template: 'nope', input: 'x', classification: 'public' })).toThrow(/unknown workflow template nope/)
    const once = ctx.workflow.start({ template: 'ask', input: 'once', classification: 'public', clientRequestId: 'req-1' })
    expect(() => ctx.workflow.start({ template: 'ask', input: 'other', classification: 'public', clientRequestId: 'req-1' })).toThrow(/clientRequestId was reused with a different request/)
    await vi.waitFor(() => expect(ctx.workflow.get(once.runId)?.nodes[0]?.state).toBe('RUNNING'))
    expect(ctx.workflow.drain()).toEqual({ draining: true, active: [once.runId] })
    expect(() => ctx.workflow.start({ template: 'ask', input: 'new work', classification: 'public' })).toThrow(/the host is draining/)
    await vi.waitFor(() => expect(ctx.workflow.drain().active).toEqual([]), { timeout: 30_000 })
    expect(ctx.workflow.get(once.runId)).toMatchObject({ status: 'completed' })
    expect(ctx.workflow.resume()).toEqual({ draining: false, active: [] })
    expect(ctx.workflow.start({ template: 'ask', input: 'after resume', classification: 'public' }).status).toBe('running')
  }, 60_000)

  it('closes a gate nobody decided within gateTimeoutHours, failing the run by rule and saying why; continue waits again, and an approval in time runs the plan (INV-9)', async () => {
    const gated = TEST_TEMPLATES.investigate!.map((n) => (n.grows ? { ...n, grows: { maxNodes: 2, approvalRequired: ['reason'] } } : n))
    const answer = (prompt: string): string => (prompt.includes('Plan how to answer')
      ? '```json\n{"confidence":"high","nodes":[{"id":"only","objective":"o","prompt":"the step","capabilities":["reason"],"tier":"economy"}]}\n```'
      : prompt.includes('<findings>') ? 'final' : 'step done')
    const { ctx } = await boot({ answer }, { templates: { gated }, gateTimeoutHours: 0.0008 })
    const models = ctx.models as FakeModels
    const run = ctx.workflow.start({ template: 'gated', input: 'q', classification: 'public' })
    await vi.waitFor(() => expect(ctx.workflow.get(run.runId)?.blocked).toBeDefined(), { timeout: 30_000 })
    const blocked = ctx.workflow.get(run.runId)!.blocked as Extract<RunView['blocked'], { kind: 'gate' }>
    expect(Date.parse(blocked.until!) - Date.now()).toBeLessThanOrEqual(3000)
    // Nobody approves: the gate closes by rule, the run fails saying why, and the plan's step never ran.
    await vi.waitFor(() => expect(ctx.workflow.get(run.runId)!.status).toBe('failed'), { timeout: 30_000 })
    expect(ctx.workflow.get(run.runId)).toMatchObject({ status: 'failed', error: { kind: 'gate_timeout', message: expect.stringMatching(/^no verdict on plan sha256:[0-9a-f]{64} arrived by .* \(gateTimeoutHours 0.0008\); continue the run to wait again$/) } })
    expect(models.calls).toHaveLength(1)
    const gate = ctx.workflow.explain(run.runId)!.nodes.find((n) => n.nodeId === 'plan:1:gate')!
    expect(gate.decisions.at(-1)).toMatchObject({ type: 'gate', outcome: 'closed' })
    expect(ctx.artifacts.get(gate.decisions.at(-1)!.id)!.body).toMatchObject({ decider: { type: 'rule', id: 'workflow.gate-timeout' }, deterministic: true })
    // Continued, it waits again with a new deadline, and an approval in time runs the plan.
    ctx.workflow.continue(run.runId)
    await vi.waitFor(() => expect(ctx.workflow.get(run.runId)?.blocked).toBeDefined(), { timeout: 30_000 })
    expect((ctx.workflow.get(run.runId)!.blocked as { until: string }).until > blocked.until!).toBe(true)
    ctx.workflow.approve(run.runId, { verdict: 'approved' })
    await vi.waitFor(() => expect(ctx.workflow.get(run.runId)!.status).not.toBe('running'), { timeout: 30_000 })
    expect(ctx.workflow.get(run.runId)).toMatchObject({ status: 'completed', answer: 'final' })
  }, 60_000)
})
