import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { type RunMetering, withMetering } from '@tsuuanmi/system-agent-runtime-core'
import { SchemaRegistry, usageUnknownOf } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { type LimitState, type PoolConfig, ResourcesError, type UsageRecord } from '@tsuuanmi/system-resources-core'
import { FakeResources } from '../../../resources-core/conformance/resources.ts'
import { describe, expect, it } from 'vitest'
import AgentWorkers, { type Config } from '../src/index.ts'
import { ScriptedAgent, worker, boot, requirement } from './stack.ts'

/** A pool for agent runs that is available until a reading limits it. */
const POOL: PoolConfig = {
  pool: 'max.agents', account: 'max', kind: 'programmatic', unknown: 'available',
  windows: [{ id: 'five-hour', kind: 'rolling', seconds: 18000 }, { id: 'seven-day', kind: 'rolling', seconds: 604800 }],
}
const LEDGER = { pools: [POOL] }
const metered = (overrides: Partial<Config['workers'][number]> = {}) => worker({ pool: 'max.agents', account: 'max', windows: { five_hour: 'five-hour', seven_day: 'seven-day' }, ...overrides })
/** What a run reports it consumed, normalized by its runtime (input includes cached input). */
const METERING: RunMetering = {
  resultId: 'h-1:r-1', model: 'model-main', turns: 3, costUsd: 0.25,
  usage: { inputTokens: 36_000, outputTokens: 1900, cacheReadInputTokens: 30_500, cacheCreationInputTokens: 4000 },
  models: [
    { model: 'model-main', usage: { inputTokens: 35_200, outputTokens: 900, cacheReadInputTokens: 30_000, cacheCreationInputTokens: 4000 }, costUsd: 0.2 },
    { model: 'model-small', usage: { inputTokens: 800, outputTokens: 1000, cacheReadInputTokens: 500, cacheCreationInputTokens: 0 }, costUsd: 0.05 },
  ],
}
const inAnHour = (): string => new Date(Date.now() + 3_600_000).toISOString()
const limitReading = (window: { id: string; kind: 'rolling'; seconds: number }, extra: Partial<LimitState>): LimitState => ({
  schema: 'limit-state@1.0', pool: 'max.agents', account: 'max', window, state: 'ok', source: 'limit-notice', observedAt: new Date().toISOString(), ...extra,
})

describe('agents source: metering through ctx.resources (docs/design/resources.md)', () => {
  const run = async (ctx: Context, key = 'k', prompt = 'look at it') => {
    const source = ctx.workers.source('agents')!
    return source.wait(source.start({ key, worker: 'agent:reviewer', prompt, requirement: requirement(), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never }).id, 10_000)
  }

  it('reserves before a run, records exactly one usage-record with the runtime\'s normalized numbers, releases, and writes agent-result@1.2 (INV-2, INV-13, INV-14)', async () => {
    const agent = new ScriptedAgent({ metering: METERING })
    const { ctx } = await boot(agent, { workers: [metered()] }, undefined, LEDGER)
    expect((await ctx.workers.list())[0]).toMatchObject({ worker: 'agent:reviewer', state: 'ready' })
    const done = await run(ctx)
    expect(done).toMatchObject({ status: 'completed', submitted: true })
    // The egress decision, then the budget decision: the run's decision chain.
    expect(done.decisions).toHaveLength(2)
    expect(ctx.artifacts.get(done.decisions[1]!)!.body).toMatchObject({ decisionType: 'budget', outcome: { option: 'reserved', detail: { runId: done.id, lines: [{ pool: 'max.agents', unit: 'runs', amount: 1 }] } } })
    const { records, totals } = await ctx.resources.usage({ runId: done.id })
    expect(records).toEqual([{
      schema: 'usage-record@1.0', requestId: 'scripted:h-1:r-1', source: 'runtime-result', observedAt: expect.any(String), account: 'max', pool: 'max.agents',
      worker: 'agent:reviewer', runId: done.id, model: { request: 'model-x', response: 'model-main' }, usage: METERING.usage, models: METERING.models,
      turns: 3, durationMs: expect.any(Number), cost: { amount: 0.25, currency: 'USD', basis: 'runtime-estimate' }, outcome: 'completed',
    }])
    expect(totals).toEqual([{ pool: 'max.agents', records: 1, usage: METERING.usage, turns: 3, costUsd: 0.25 }])
    // Released: the ledger no longer holds it.
    const { reservation_id } = ctx.store.db.prepare('SELECT reservation_id FROM agent_runs WHERE run_id = ?').get(done.id) as { reservation_id: string }
    await expect(ctx.resources.release(reservation_id)).rejects.toMatchObject({ failure: 'unknown-reservation' })
    const result = ctx.artifacts.get(done.result!)!
    expect(result).toMatchObject({ bodySchema: 'agent-result@1.2', body: { schema: 'agent-result@1.2', model: 'model-main', usage: METERING.usage, models: METERING.models, turns: 3, costUsd: 0.25 } })
    new SchemaRegistry().assertRecord(result.body as { schema: string })
  })

  it('names the board task its brief serves on its reservation and its usage record, so the ledger counts the run for that task (PROP-0010)', async () => {
    const { ctx } = await boot(new ScriptedAgent({ metering: METERING }), { workers: [metered()] }, undefined, LEDGER)
    const brief = ctx.artifacts.put({
      kind: 'objective', bodySchema: 'brief@1.1', classification: 'operator-shared', producer: { type: 'system', ref: 'workflow' },
      body: {
        schema: 'brief@1.1', projectId: 'p1', taskId: 'task-1', attempt: 1, goal: 'look at it', acceptance: [{ id: 'a1', statement: 'it is looked at' }], artifacts: [],
        instructions: [{ text: 'look at it' }], budget: { remaining: [] }, sandbox: { mode: 'read-only', network: 'allow-list', commands: false }, classification: 'operator-shared',
      },
    }).id as `sha256:${string}`
    const source = ctx.workers.source('agents')!
    const done = await source.wait(source.start({ key: 'k-task', worker: 'agent:reviewer', brief, requirement: requirement(), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never }).id, 10_000)
    expect(done).toMatchObject({ status: 'completed' })
    expect((await ctx.resources.usage({ taskId: 'task-1' })).records).toMatchObject([{ runId: done.id, taskId: 'task-1', projectId: 'p1', usage: METERING.usage }])
    // A run that serves no task names none.
    const plain = await run(ctx, 'k-plain')
    expect(ctx.store.db.prepare('SELECT task_id, project_id FROM agent_runs WHERE run_id = ?').get(plain.id)).toEqual({ task_id: null, project_id: null })
  })

  it('runs nothing when the reservation is refused: the run fails unsubmitted as quota_exhausted, with its budget decision (INV-2)', async () => {
    const agent = new ScriptedAgent({ metering: METERING })
    const { ctx } = await boot(agent, { workers: [metered()] }, undefined, LEDGER)
    await ctx.resources.observe(limitReading(POOL.windows[0] as never, { state: 'limited', resetsAt: inAnHour() }))
    const done = await run(ctx)
    expect(done).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'quota_exhausted', disposition: 'USER_ACTION' } })
    expect(done.error!.message).toContain('max.agents')
    expect(ctx.artifacts.get(done.decisions[1]!)!.body).toMatchObject({ decisionType: 'budget', outcome: { option: 'refused' } })
    expect(agent.runs).toEqual([])
    expect((await ctx.resources.usage()).records).toEqual([])
  })

  it('describes a metered Worker as quota-exhausted while its pool is unavailable, so routing skips it, and ready once it is back (REQ-WRK-8, INV-2)', async () => {
    const { ctx } = await boot(new ScriptedAgent(), { workers: [metered()] }, undefined, LEDGER)
    await ctx.resources.observe(limitReading(POOL.windows[1] as never, { state: 'limited', resetsAt: inAnHour() }))
    expect((await ctx.workers.list())[0]).toMatchObject({ state: 'quota-exhausted' })
    await expect(ctx.workers.route(requirement())).rejects.toMatchObject({ name: 'AdmissionFailure' })
    await ctx.resources.observe(limitReading(POOL.windows[1] as never, { state: 'ok', observedAt: new Date(Date.now() + 1000).toISOString() }))
    expect((await ctx.workers.list())[0]).toMatchObject({ state: 'ready' })
    expect((await ctx.workers.route(requirement())).worker.worker).toBe('agent:reviewer')
  })

  it('names its runtime\'s one account, assigned by default, and when an exhausted pool is back, so routing can wait for it (ADR-0052)', async () => {
    const { ctx } = await boot(new ScriptedAgent(), { workers: [metered()] }, undefined, LEDGER)
    expect((await ctx.workers.list())[0]).toMatchObject({ schema: 'capability-descriptor@1.5', account: { id: 'scripted', group: 'scripted', mode: 'assigned' } })
    expect((await ctx.workers.list())[0]!.account).not.toHaveProperty('limitUntil')
    const reset = inAnHour()
    await ctx.resources.observe(limitReading(POOL.windows[1] as never, { state: 'limited', resetsAt: reset }))
    expect((await ctx.workers.list())[0]).toMatchObject({ state: 'quota-exhausted', account: { mode: 'assigned', limitUntil: reset } })
    // With one account for the runtime, the refusal says when it is back.
    await expect(ctx.workers.route(requirement())).rejects.toMatchObject({ name: 'AdmissionFailure', limitUntil: reset })
  })

  it('pools a runtime\'s accounts only with the operator\'s recorded terms, recorded at start as a gate decision (ADR-0052)', async () => {
    expect(() => new AgentWorkers(new Context(), { workers: [worker()], providers: [{ provider: 'scripted', accounts: 'pooled' }] })).toThrow(/agent-workers\.providers\[0\]: scripted is pooled, and no pooledTerms/)
    const pooledTerms = { confirmedBy: 'operator', confirmedAt: '2026-10-24T09:00:00Z', terms: 'the plan terms, read 2026-10-24' }
    const { ctx } = await boot(new ScriptedAgent(), { workers: [worker()], providers: [{ provider: 'scripted', accounts: 'pooled', pooledTerms }] })
    expect((await ctx.workers.list())[0]).toMatchObject({ account: { id: 'scripted', group: 'scripted', mode: 'pooled' } })
    const gates = ctx.artifacts.list({ kind: 'decision', decisionType: 'gate', limit: 10 }).map((a) => a.body as { decider: { id: string }; outcome: { option: string; detail: Record<string, unknown> } })
    expect(gates.filter((g) => g.decider.id === 'agent-workers.pooled-terms')).toEqual([expect.objectContaining({ outcome: { option: 'pooled', detail: { provider: 'scripted', ...pooledTerms } } })])
  })

  it('fails closed when a metered Worker\'s ledger or pool is missing: unavailable, and a run never starts (INV-2)', async () => {
    const agent = new ScriptedAgent()
    const unledgered = await boot(agent, { workers: [metered()] })
    expect((await unledgered.ctx.workers.list())[0]).toMatchObject({ state: 'unavailable', capabilities: [] })
    expect(await run(unledgered.ctx)).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error', message: expect.stringContaining('ctx.resources') } })
    const unknown = await boot(agent, { workers: [metered({ pool: 'nope' })] }, undefined, LEDGER)
    expect((await unknown.ctx.workers.list())[0]).toMatchObject({ state: 'unavailable' })
    expect(await run(unknown.ctx)).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error' } })
    expect(agent.runs).toEqual([])
  })

  it('records the runtime\'s rate-limit observations as readings of the mapped windows; an unmapped window that is not a limit hit is skipped (INV-11)', async () => {
    const observedAt = new Date().toISOString()
    const resetsAt = inAnHour()
    const agent = new ScriptedAgent({
      metering: {
        ...METERING, limits: [
          { window: 'seven_day', status: 'warning', usedPercentage: 82, resetsAt, observedAt },
          { window: 'seven_day_other', status: 'warning', resetsAt, observedAt },
          { window: 'five_hour', status: 'rejected', resetsAt, observedAt },
        ],
      },
    })
    const { ctx } = await boot(agent, { workers: [metered()] }, undefined, LEDGER)
    expect((await run(ctx)).status).toBe('completed')
    const pool = (await ctx.resources.pools({ account: 'max' })).find((p) => p.pool === 'max.agents')!
    expect(pool.readings).toEqual([
      { schema: 'limit-state@1.0', pool: 'max.agents', account: 'max', window: POOL.windows[0], state: 'limited', resetsAt, source: 'runtime-result', observedAt },
      { schema: 'limit-state@1.0', pool: 'max.agents', account: 'max', window: POOL.windows[1], state: 'ok', resetsAt, usedPercentage: 82, source: 'runtime-result', observedAt },
    ])
    // The limit hit closes the pool: the Worker takes no new work until the window resets.
    expect(pool).toMatchObject({ available: false, until: resetsAt })
    expect((await ctx.workers.list())[0]).toMatchObject({ state: 'quota-exhausted' })
  })

  it('reads a limit hit without a reset time as limited for the configured cooldown, never unknown or ok, so even a pool that admits unknown windows closes (INV-2)', async () => {
    const observedAt = new Date().toISOString()
    const agent = new ScriptedAgent({ metering: { limits: [{ window: 'five_hour', status: 'rejected', observedAt }] } })
    const { ctx } = await boot(agent, { workers: [metered({ limitCooldownSeconds: 600 })] }, undefined, LEDGER)
    await run(ctx)
    const pool = (await ctx.resources.pools({ account: 'max' }))[0]!
    const cooldownUntil = new Date(Date.parse(observedAt) + 600_000).toISOString()
    expect(pool.readings).toMatchObject([{ window: { id: 'five-hour' }, state: 'limited', cooldownUntil, source: 'runtime-result' }])
    expect(pool).toMatchObject({ available: false, until: cooldownUntil })
  })

  it('closes every window of the pool on a limit hit it cannot place (an unmapped or unnamed window), so it is never retried there unseen (INV-2)', async () => {
    const observedAt = new Date().toISOString()
    const resetsAt = inAnHour()
    const agent = new ScriptedAgent({ metering: { limits: [{ window: '*', status: 'rejected', resetsAt, observedAt }] } })
    const { ctx } = await boot(agent, { workers: [metered()] }, undefined, LEDGER)
    await run(ctx)
    const pool = (await ctx.resources.pools({ account: 'max' }))[0]!
    expect(pool.readings.map((r) => [r.window.id, r.state, r.resetsAt])).toEqual(POOL.windows.map((w) => [w.id, 'limited', resetsAt]))
    expect(pool.available).toBe(false)
  })

  it('meters a failed run from the numbers its error carries, and a run that reported nothing gets no invented record', async () => {
    const failing = new ScriptedAgent({ fail: withMetering(new ProviderError('session_broken', 'the agent broke'), METERING) })
    const { ctx } = await boot(failing, { workers: [metered()] }, undefined, LEDGER)
    const done = await run(ctx)
    expect(done).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'session_broken' } })
    expect((await ctx.resources.usage({ runId: done.id })).records).toMatchObject([{ outcome: 'failed', usage: METERING.usage, turns: 3 }])
    const silent = await boot(new ScriptedAgent({ fail: new ProviderError('session_broken', 'no result') }), { workers: [metered()] }, undefined, LEDGER)
    expect((await run(silent.ctx)).status).toBe('failed')
    expect((await silent.ctx.resources.usage()).records).toEqual([])
  })

  /** The `usage.unknown` facts recorded so far, oldest first. */
  const unknowns = (ctx: Context) => ctx.eventLog.query({ type: 'usage.unknown' })
  /** The warnings logged anywhere in the context from now on. */
  const warnings = (ctx: Context): string[] => {
    const messages: string[] = []
    ctx.logger.exporter({ levels: { default: 3 }, export: (m) => { if (m.type === 'warn') messages.push(String(m.args[0])) } })
    return messages
  }

  it('records a run whose runtime reported no usage as a usage.unknown fact, never a record: the run, Worker, pool, task, how it ended, and why (D25, INV-14)', async () => {
    const { ctx } = await boot(new ScriptedAgent({ metering: { turns: undefined } }), { workers: [metered()] }, undefined, LEDGER)
    const brief = ctx.artifacts.put({
      kind: 'objective', bodySchema: 'brief@1.1', classification: 'operator-shared', producer: { type: 'system', ref: 'workflow' },
      body: {
        schema: 'brief@1.1', projectId: 'p1', taskId: 'task-1', attempt: 1, goal: 'look at it', acceptance: [{ id: 'a1', statement: 'it is looked at' }], artifacts: [],
        instructions: [{ text: 'look at it' }], budget: { remaining: [] }, sandbox: { mode: 'read-only', network: 'allow-list', commands: false }, classification: 'operator-shared',
      },
    }).id as `sha256:${string}`
    const source = ctx.workers.source('agents')!
    const done = await source.wait(source.start({ key: 'k-wf', worker: 'agent:reviewer', brief, runId: 'run_wf', requirement: requirement(), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never }).id, 10_000)
    expect(done).toMatchObject({ status: 'completed' })
    // Counted as nothing, as before: no record is invented.
    expect((await ctx.resources.usage()).records).toEqual([])
    const [fact, ...more] = unknowns(ctx)
    expect(more).toEqual([])
    expect(fact).toMatchObject({ type: 'usage.unknown', runId: 'run_wf' })
    expect(fact!.data).toEqual({
      schema: 'usage-unknown@1.0', runId: done.id, kind: 'not-reported', account: 'max', pool: 'max.agents', worker: 'agent:reviewer', projectId: 'p1', taskId: 'task-1',
      outcome: 'completed', observedAt: expect.any(String), reason: 'its runtime reported neither tokens nor turns',
    })
    expect(usageUnknownOf(fact!.data)).toBeDefined()
    // A failed run that reported nothing is one too.
    const failing = await boot(new ScriptedAgent({ fail: new ProviderError('session_broken', 'no result') }), { workers: [metered()] }, undefined, LEDGER)
    const failed = await run(failing.ctx)
    expect(unknowns(failing.ctx)).toMatchObject([{ data: { runId: failed.id, kind: 'not-reported', outcome: 'failed' } }])
  })

  it('records what the ledger takes of a refused record: its totals without a per-model split it refused; else a refused fact naming the record, kept as evidence (D25)', async () => {
    // A ledger that refuses the per-model split, as the store-backed one does when it does not sum to
    // the totals: the totals are what a cap counts, and they are taken.
    class SplitRefusing extends FakeResources {
      override async record(usage: UsageRecord) {
        if (usage.models) throw new ResourcesError('invalid', 'usage.inputTokens 36000 is not the sum over models (35999)')
        return super.record(usage)
      }
    }
    const split = await boot(new ScriptedAgent({ metering: METERING }), { workers: [metered()] }, undefined, { ...LEDGER, provider: SplitRefusing })
    const warned = warnings(split.ctx)
    const first = await run(split.ctx)
    expect(first.status).toBe('completed')
    const counted = (await split.ctx.resources.usage({ runId: first.id })).records
    expect(counted).toMatchObject([{ usage: METERING.usage, turns: 3, cost: { amount: 0.25 } }])
    expect(counted[0]).not.toHaveProperty('models')
    expect(unknowns(split.ctx)).toEqual([])
    expect(warned).toContainEqual(expect.stringMatching(/refused the per-model split of .*; its totals were recorded$/))
    // Totals it refuses too (cached input above the input): nothing counted, the record kept, a refused fact.
    const broken = { ...METERING, usage: { ...METERING.usage!, cacheReadInputTokens: 99_999 } }
    const refused = await boot(new ScriptedAgent({ metering: broken }), { workers: [metered()] }, undefined, LEDGER)
    const second = await run(refused.ctx)
    expect(second.status).toBe('completed')
    expect((await refused.ctx.resources.usage()).records).toEqual([])
    const [fact] = unknowns(refused.ctx)
    expect(fact!.data).toMatchObject({ runId: second.id, kind: 'refused', failure: 'invalid', outcome: 'completed', reason: 'cached input exceeds the input it is part of', record: expect.stringMatching(/^sha256:/) })
    expect(refused.ctx.artifacts.get(String(fact!.data!['record']))).toMatchObject({ kind: 'evidence', bodySchema: 'usage-record@1.0', body: { runId: second.id, usage: broken.usage, models: METERING.models } })
    // A pool the ledger configures under another account takes nothing of it.
    const elsewhere = await boot(new ScriptedAgent({ metering: METERING }), { workers: [metered({ account: 'other' })] }, undefined, LEDGER)
    const third = await run(elsewhere.ctx)
    expect(third.status).toBe('completed')
    expect(unknowns(elsewhere.ctx)).toMatchObject([{ data: { runId: third.id, kind: 'refused', failure: 'unknown-pool', account: 'other', pool: 'max.agents' } }])
  })

  it('marks a workflow run\'s step whose usage the ledger could not count in the usage report, and only there (system usage, MCP usage; D25)', async () => {
    const { ctx } = await boot(new ScriptedAgent({ metering: { turns: undefined } }), { workers: [metered()] }, undefined, LEDGER)
    const silent = await ctx.workflow.wait(ctx.workflow.start({ template: 'agent-review', input: 'Check the diff', classification: 'operator-shared' }).runId, 10_000)
    expect(silent).toMatchObject({ status: 'completed', nodes: [{ nodeId: 'review:1', worker: 'agent:reviewer' }] })
    expect(silent.nodes[0]).not.toHaveProperty('usageUnknown')
    expect(ctx.workflow.usage(10).find((r) => r.runId === silent.runId)!.nodes).toMatchObject([{ nodeId: 'review:1', worker: 'agent:reviewer', usageUnknown: 'not-reported' }])
    // A step whose usage was counted is not marked.
    const counted = await boot(new ScriptedAgent({ metering: METERING }), { workers: [metered()] }, undefined, LEDGER)
    const done = await counted.ctx.workflow.wait(counted.ctx.workflow.start({ template: 'agent-review', input: 'Check the diff', classification: 'operator-shared' }).runId, 10_000)
    expect(counted.ctx.workflow.usage(10).find((r) => r.runId === done.runId)!.nodes[0]).not.toHaveProperty('usageUnknown')
  })

  it('records a record() that failed otherwise as a failed fact, and logs one it cannot record; the run\'s own outcome never changes (D25, INV-2)', async () => {
    class LockedLedger extends FakeResources {
      override async record(): Promise<never> {
        throw new Error('database is locked')
      }
    }
    const { ctx } = await boot(new ScriptedAgent({ metering: METERING }), { workers: [metered()] }, undefined, { ...LEDGER, provider: LockedLedger })
    const done = await run(ctx)
    expect(done.status).toBe('completed')
    const [fact] = unknowns(ctx)
    expect(fact!.data).toMatchObject({ runId: done.id, kind: 'failed', reason: 'database is locked', outcome: 'completed' })
    expect(fact!.data).not.toHaveProperty('failure')
    // A fact that is not a valid record (an account that is no id) cannot be recorded: it is logged, never lost silently.
    const odd = await boot(new ScriptedAgent({ metering: { turns: undefined } }), { workers: [metered({ account: 'not an id' })] }, undefined, LEDGER)
    const warned = warnings(odd.ctx)
    const silent = await run(odd.ctx)
    expect(silent.status).toBe('completed')
    expect(unknowns(odd.ctx)).toEqual([])
    expect(warned).toContainEqual(expect.stringContaining(`the usage of ${silent.id} on agent:reviewer (pool max.agents) is unknown (not-reported: its runtime reported neither tokens nor turns), and that could not be recorded`))
  })

  it('meters nothing for a Worker with no pool, even with a ledger loaded; a runtime\'s usage still goes into agent-result@1.2', async () => {
    const { ctx } = await boot(new ScriptedAgent({ metering: METERING }), { workers: [worker()] }, undefined, LEDGER)
    const done = await run(ctx)
    expect(done.decisions).toHaveLength(1)
    expect((await ctx.resources.usage()).records).toEqual([])
    expect(ctx.artifacts.get(done.result!)).toMatchObject({ bodySchema: 'agent-result@1.2', body: { model: 'model-main', usage: METERING.usage } })
  })

  it('never invents the usage of a run that started before a restart: it fails, and its usage is left to transcript reconciliation (INV-4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agents-'))
    const first = await boot(new ScriptedAgent({ holdMs: 30_000, process: true }), { workers: [metered()] }, dir, LEDGER)
    const source = first.ctx.workers.source('agents')!
    const started = source.start({ key: 'k', worker: 'agent:reviewer', prompt: 'long', requirement: requirement(), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never })
    await new Promise((resolve) => setTimeout(resolve, 300))
    // Stopped mid-run: the agent reported nothing, and the run stays started.
    await first.stop()
    const again = new ScriptedAgent({ metering: METERING })
    const second = await boot(again, { workers: [metered()], deadAfterSeconds: 1 }, dir, LEDGER)
    expect(await second.ctx.workers.source('agents')!.wait(started.id, 10_000)).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'reconciliation_failed' } })
    expect(again.runs).toEqual([])
    expect((await second.ctx.resources.usage()).records).toEqual([])
    // What the ledger cannot count is recorded, under the pool the run drew on (D25): the stop
    // aborted the agent before it reported anything, and the restart found the run interrupted.
    const facts = second.ctx.eventLog.query({ type: 'usage.unknown' }).map((e) => e.data)
    expect(facts).toMatchObject([{ runId: started.id, kind: 'not-reported', outcome: 'aborted' }, { runId: started.id, kind: 'interrupted', pool: 'max.agents', account: 'max', outcome: 'failed' }])
  })
})

describe('agents source: a usage limit its runtime gives no reading for is never retried unseen (PROP-0012 phase C, INV-2)', () => {
  const QUOTA = (): Error => new ProviderError('quota_exhausted', 'codex-sdk: You\'ve hit your usage limit.')
  const run = async (ctx: Context, key: string, id = 'agent:reviewer') => {
    const source = ctx.workers.source('agents')!
    return source.wait(source.start({ key, worker: id, prompt: 'look at it', requirement: requirement(), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never }).id, 10_000)
  }
  const near = (iso: string | undefined, ms: number): void => expect(Math.abs(Date.parse(iso!) - ms)).toBeLessThan(5000)

  it('closes a metered Worker\'s pool on every window for the cooldown, as a limit-notice reading, until a later reading says otherwise (REQ-WRK-8)', async () => {
    const agent = new ScriptedAgent({ fail: QUOTA() })
    const { ctx } = await boot(agent, { workers: [metered({ limitCooldownSeconds: 600 })] }, undefined, LEDGER)
    const before = Date.now()
    expect(await run(ctx, 'k1')).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'quota_exhausted' } })
    const pool = (await ctx.resources.pools({ account: 'max' }))[0]!
    expect(pool.readings.map((r) => [r.window.id, r.state, r.source])).toEqual(POOL.windows.map((w) => [w.id, 'limited', 'limit-notice']))
    for (const reading of pool.readings) near(reading.cooldownUntil, before + 600_000)
    for (const reading of pool.readings) new SchemaRegistry().assertRecord(reading)
    expect(pool.available).toBe(false)
    expect((await ctx.workers.list())[0]).toMatchObject({ state: 'quota-exhausted' })
    // Not retried there unseen: the next run is refused before the agent starts.
    expect(await run(ctx, 'k2')).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'quota_exhausted' } })
    expect(agent.runs).toHaveLength(1)
    // The limit is the ledger's: no runtime cooldown besides it.
    expect(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM agent_cooldowns').get()).toEqual({ n: 0 })
    // A later reading of each window says otherwise, and the Worker takes work again.
    for (const window of POOL.windows) await ctx.resources.observe(limitReading(window as never, { state: 'ok', observedAt: new Date(Date.now() + 1000).toISOString() }))
    expect((await ctx.workers.list())[0]).toMatchObject({ state: 'ready' })
  })

  it('adds nothing when the runtime reported the limit itself: its own reading closes the pool', async () => {
    const resetsAt = inAnHour()
    const agent = new ScriptedAgent({ fail: withMetering(QUOTA(), { limits: [{ window: 'five_hour', status: 'rejected', resetsAt, observedAt: new Date().toISOString() }] }) })
    const { ctx } = await boot(agent, { workers: [metered()] }, undefined, LEDGER)
    await run(ctx, 'k1')
    const pool = (await ctx.resources.pools({ account: 'max' }))[0]!
    expect(pool.readings.map((r) => [r.window.id, r.state, r.source, r.resetsAt])).toEqual([['five-hour', 'limited', 'runtime-result', resetsAt]])
    expect(pool).toMatchObject({ available: false, until: resetsAt })
  })

  it('cools down every Worker of the runtime of an unmetered Worker (one home, one sign-in), across a restart, until the cooldown ends; other runtimes keep working (REQ-WRK-8)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agents-'))
    const config: Config = { workers: [worker({ limitCooldownSeconds: 600 }), worker({ id: 'second' }), worker({ id: 'elsewhere', runtime: 'other' })] }
    const agent = new ScriptedAgent({ fail: QUOTA() })
    const first = await boot(agent, config, dir)
    first.ctx.agentRuntimes.register(Object.assign(new ScriptedAgent(), { kind: 'other' }))
    const before = Date.now()
    expect(await run(first.ctx, 'k1')).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'quota_exhausted' } })
    const states = async (ctx: Context) => Object.fromEntries((await ctx.workers.list()).map((w) => [w.worker, w.state]))
    expect(await states(first.ctx)).toEqual({ 'agent:reviewer': 'quota-exhausted', 'agent:second': 'quota-exhausted', 'agent:elsewhere': 'ready' })
    const [event] = first.ctx.eventLog.query({ type: 'agent-workers.cooldown' })
    expect(event?.data).toMatchObject({ runtime: 'scripted', worker: 'agent:reviewer', source: expect.stringContaining('usage limit') })
    near(event?.data?.until as string, before + 600_000)
    // A run on the other Worker of that runtime is refused before the agent starts.
    const refused = await run(first.ctx, 'k2', 'agent:second')
    expect(refused).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'quota_exhausted', message: expect.stringMatching(/takes? no run until .*nothing was run/) } })
    expect(agent.runs).toHaveLength(1)
    await first.stop()
    // It survives a restart.
    const second = await boot(new ScriptedAgent(), config, dir)
    second.ctx.agentRuntimes.register(Object.assign(new ScriptedAgent(), { kind: 'other' }))
    expect(await states(second.ctx)).toMatchObject({ 'agent:reviewer': 'quota-exhausted', 'agent:second': 'quota-exhausted' })
    // Once it ends, the Workers take work again.
    second.ctx.store.db.prepare('UPDATE agent_cooldowns SET until = ?').run(new Date(Date.now() - 1000).toISOString())
    expect(await states(second.ctx)).toEqual({ 'agent:reviewer': 'ready', 'agent:second': 'ready', 'agent:elsewhere': 'ready' })
    expect(await run(second.ctx, 'k3')).toMatchObject({ status: 'completed' })
  })

  it('cools an unmetered runtime down until the reset its runtime named, at most seven days (INV-9)', async () => {
    const resetsAt = new Date(Date.now() + 2 * 3_600_000).toISOString()
    const soon = { limits: [{ window: 'five_hour', status: 'rejected' as const, resetsAt, observedAt: new Date().toISOString() }] }
    const { ctx } = await boot(new ScriptedAgent({ fail: withMetering(QUOTA(), soon) }), { workers: [worker()] })
    await run(ctx, 'k1')
    expect(ctx.store.db.prepare('SELECT until FROM agent_cooldowns WHERE runtime = ?').get('scripted')).toEqual({ until: resetsAt })
    const far = { limits: [{ window: 'seven_day', status: 'rejected' as const, resetsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), observedAt: new Date().toISOString() }] }
    const capped = await boot(new ScriptedAgent({ fail: withMetering(QUOTA(), far) }), { workers: [worker()] })
    const before = Date.now()
    await run(capped.ctx, 'k1')
    near((capped.ctx.store.db.prepare('SELECT until FROM agent_cooldowns').get() as { until: string }).until, before + 7 * 86_400_000)
  })

  it('cools the runtime down when the ledger does not take the limit reading, so a metered Worker fails closed too', async () => {
    const agent = new ScriptedAgent({ fail: QUOTA() })
    const { ctx } = await boot(agent, { workers: [metered()] }, undefined, LEDGER)
    ctx.resources.observe = async () => {
      throw new Error('the ledger is read-only')
    }
    await run(ctx, 'k1')
    expect((await ctx.resources.pools({ account: 'max' }))[0]!.available).toBe(true)
    expect((await ctx.workers.list())[0]).toMatchObject({ state: 'quota-exhausted' })
    expect(await run(ctx, 'k2')).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'quota_exhausted' } })
    expect(agent.runs).toHaveLength(1)
  })

  it('cools nothing down for a failure that is not a usage limit', async () => {
    const { ctx } = await boot(new ScriptedAgent({ fail: new ProviderError('session_broken', 'the agent broke') }), { workers: [worker()] })
    await run(ctx, 'k1')
    expect((await ctx.workers.list())[0]).toMatchObject({ state: 'ready' })
    expect(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM agent_cooldowns').get()).toEqual({ n: 0 })
  })
})

describe('agents source: every Worker of one runtime is one account, its siblings (PROP-0012 phase C)', () => {
  const run = async (ctx: Context, key: string, id: string) => {
    const source = ctx.workers.source('agents')!
    return source.wait(source.start({ key, worker: id, prompt: 'look at it', requirement: requirement(), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never }).id, 10_000)
  }
  const states = async (ctx: Context) => Object.fromEntries((await ctx.workers.list()).map((w) => [w.worker, w.state]))

  it('names every Worker of the runtime as its siblings, itself included; another runtime\'s Workers are not (one home, one sign-in)', async () => {
    const { ctx } = await boot(new ScriptedAgent({ sandboxes: ['read-only', 'workspace-write'] }), {
      workers: [worker(), worker({ id: 'writer', sandbox: 'workspace-write' }), worker({ id: 'elsewhere', runtime: 'other' })],
    })
    // Before, each agent Worker was an account of its own: siblings gave just itself.
    expect(ctx.workers.siblings('agent:writer')).toEqual(['agent:reviewer', 'agent:writer'])
    expect(ctx.workers.siblings('agent:reviewer')).toEqual(['agent:reviewer', 'agent:writer'])
    expect(ctx.workers.siblings('agent:elsewhere')).toEqual(['agent:elsewhere'])
    // The descriptor's account agrees: one id for the runtime's Workers.
    const accounts = Object.fromEntries((await ctx.workers.list()).map((w) => [w.worker, w.account?.id]))
    expect(accounts).toEqual({ 'agent:reviewer': 'scripted', 'agent:writer': 'scripted', 'agent:elsewhere': 'other' })
    // A Worker this source does not configure is not its to answer for.
    expect(ctx.workers.source('agents')!.siblings!('agent:gone')).toBeUndefined()
  })

  it('holds every role of the account off work while the pool of one of them is closed, and says until when; a run queued on a sibling never starts (REQ-WRK-8, INV-2)', async () => {
    const agent = new ScriptedAgent()
    const { ctx } = await boot(agent, { workers: [metered(), worker({ id: 'second' }), worker({ id: 'elsewhere', runtime: 'other' })] }, undefined, LEDGER)
    ctx.agentRuntimes.register(Object.assign(new ScriptedAgent(), { kind: 'other' }))
    const reset = inAnHour()
    await ctx.resources.observe(limitReading(POOL.windows[1] as never, { state: 'limited', resetsAt: reset }))
    // Before, the unmetered role on the same sign-in stayed ready and took the work into the same limit.
    expect(await states(ctx)).toEqual({ 'agent:reviewer': 'quota-exhausted', 'agent:second': 'quota-exhausted', 'agent:elsewhere': 'ready' })
    expect((await ctx.workers.list()).find((w) => w.worker === 'agent:second')).toMatchObject({ account: { id: 'scripted', limitUntil: reset } })
    const admitted = await ctx.workers.route(requirement(), { excludeWorkers: { workers: ['agent:elsewhere'], reason: 'only the limited account is left' } }).catch((error: unknown) => error)
    expect(admitted).toMatchObject({ name: 'AdmissionFailure', limitUntil: reset })
    // Another runtime is another account: it takes the work.
    expect((await ctx.workers.route(requirement())).worker.worker).toBe('agent:elsewhere')
    const refused = await run(ctx, 'k1', 'agent:second')
    expect(refused).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'quota_exhausted', message: `agent:second: the pool max.agents of agent:reviewer, on the same sign-in, is at its limit until ${reset}; nothing was run` } })
    expect(agent.runs).toEqual([])
    // Once the pool is back, both roles take work again.
    await ctx.resources.observe(limitReading(POOL.windows[1] as never, { state: 'ok', observedAt: new Date(Date.now() + 1000).toISOString() }))
    expect(await states(ctx)).toEqual({ 'agent:reviewer': 'ready', 'agent:second': 'ready', 'agent:elsewhere': 'ready' })
    expect(await run(ctx, 'k2', 'agent:second')).toMatchObject({ status: 'completed' })
  })

  it('says no time when one closed pool of the account names none, and the latest when all do: the account is back only once every pool is', async () => {
    const other: PoolConfig = { ...POOL, pool: 'max.second' }
    const { ctx } = await boot(new ScriptedAgent(), { workers: [metered(), metered({ id: 'second', pool: 'max.second' })] }, undefined, { pools: [POOL, other] })
    const soon = inAnHour()
    const later = new Date(Date.now() + 2 * 3_600_000).toISOString()
    await ctx.resources.observe(limitReading(POOL.windows[0] as never, { state: 'limited', resetsAt: soon }))
    await ctx.resources.observe({ ...limitReading(POOL.windows[0] as never, { state: 'limited', resetsAt: later }), pool: 'max.second' })
    for (const w of await ctx.workers.list()) expect(w).toMatchObject({ state: 'quota-exhausted', account: { limitUntil: later } })
    // A pool closed with no time known (no reading of a pool that admits no unknown window): no
    // Worker of the account says when it is back.
    const unread = await boot(new ScriptedAgent(), { workers: [metered(), metered({ id: 'second', pool: 'max.second' })] }, undefined, { pools: [POOL, { ...other, unknown: 'unavailable' }] })
    await unread.ctx.resources.observe(limitReading(POOL.windows[0] as never, { state: 'limited', resetsAt: soon }))
    for (const w of await unread.ctx.workers.list()) {
      expect(w.state).toBe('quota-exhausted')
      expect(w.account).not.toHaveProperty('limitUntil')
    }
  })

  it('fails closed when the pool of another role on the same sign-in cannot be read: unavailable, and a run never starts (INV-2)', async () => {
    const agent = new ScriptedAgent()
    const { ctx } = await boot(agent, { workers: [metered({ pool: 'nope' }), worker({ id: 'second' })] }, undefined, LEDGER)
    // Before, the unmetered role took work whatever the account's metering said.
    expect(await states(ctx)).toEqual({ 'agent:reviewer': 'unavailable', 'agent:second': 'unavailable' })
    expect(await run(ctx, 'k1', 'agent:second')).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error', message: 'agent:second: the pool nope of agent:reviewer, on the same sign-in, cannot be read; nothing was run' } })
    expect(agent.runs).toEqual([])
  })
})
