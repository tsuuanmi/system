// One Worker, several tiers (ADR-0073, T261): a role that declares a model per tier on a runtime
// derives one Worker per account that offers every tier it declares; routing serves it at the lowest
// a step admits, and its run asks for that tier's model. Per-model quota: a model's own pool per
// account, so a frontier model's limit closes only the frontier tier. Model names here are fake ones:
// model names are configuration only, never in the repository's code, docs, or tests.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { RunResult, RunSpec } from '@tsuuanmi/system-agent-runtime-core'
import AgentRuntimeRegistry from '@tsuuanmi/system-agent-runtimes'
import Artifacts from '@tsuuanmi/system-artifacts'
import Vault from '@tsuuanmi/system-credentials-vault'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import type { PoolTemplate } from '@tsuuanmi/system-resources-core'
import Store from '@tsuuanmi/system-store'
import WorkerRouter, { AdmissionFailure, type AdmittedWorker, type WorkRequirement } from '@tsuuanmi/system-workers'
import type { CapabilityDescriptor, Tier, WorkerExecution } from '@tsuuanmi/system-workers-core'
import { describe, expect, it, onTestFinished } from 'vitest'
import { FakeAgentRuntime } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import { FakeResources } from '../../../resources-core/conformance/resources.ts'
import { deriveWorkers } from '../src/roles.ts'
import AgentWorkers, { checkConfig, type Config } from '../src/index.ts'

const schemas = new SchemaRegistry()
const A = 'fake-a'
const ACC1 = `${A}:0123456789abcdef`
/** Fake model names: the operator's configuration names the real ones. */
const ECONOMY = 'model-economy-1'
const STANDARD = 'model-standard-1'
const FRONTIER = 'model-frontier-1'
/** A fixed instant the frontier model's weekly window resets at, far ahead of any clock this runs on. */
const BACK = '2099-01-05T09:00:00.000Z'

/** A fake runtime that records each run's spec. */
class RecordingRuntime extends FakeAgentRuntime {
  readonly specs: RunSpec[] = []
  /** Set: the next run fails on a usage limit its runtime names no window or reset of. */
  limitNext = false
  /** Set: the next run holds its account's one slot until it is stopped, so the runs after it wait queued. */
  holdNext = false
  override async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void): Promise<RunResult> {
    this.specs.push(spec)
    if (this.holdNext) {
      this.holdNext = false
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      throw new ProviderError('aborted', 'fake-a: stopped')
    }
    if (this.limitNext) {
      this.limitNext = false
      throw new ProviderError('quota_exhausted', 'fake-a: usage limit reached')
    }
    return super.run(spec, signal, onHandle)
  }
}

const TEMPLATES: PoolTemplate[] = [
  { template: 'plan', group: A, kind: 'interactive', windows: [{ id: 'five-hour', kind: 'rolling', seconds: 18_000 }] },
  { template: 'model-standard', group: A, kind: 'interactive', windows: [{ id: 'weekly', kind: 'rolling', seconds: 604_800 }] },
  { template: 'model-frontier', group: A, kind: 'interactive', windows: [{ id: 'weekly', kind: 'rolling', seconds: 604_800 }] },
]

/** A role whose Workers on `A` offer three tiers, each its own (fake) model; the frontier one with a turn limit of its own. */
const tieredRole = (workspace: string, extra: Record<string, unknown> = {}) => ({
  id: 'review', workspace, sandbox: 'read-only' as const,
  runtimes: { [A]: { maxTurns: 4, tiers: { economy: { model: ECONOMY }, standard: { model: STANDARD }, frontier: { model: FRONTIER, maxTurns: 8 } } } }, ...extra,
})
/** The provider entry that meters each account on its plan's pool, and each of two models on one more pool of its own. */
const METERED = {
  provider: A, pool: 'plan', windows: { five_hour: 'five-hour' },
  modelPools: [{ model: STANDARD, pool: 'model-standard', windows: { 'model_scoped:standard': 'weekly' } }, { model: FRONTIER, pool: 'model-frontier', windows: { 'model_scoped:frontier': 'weekly' } }],
}

interface Booted { ctx: Context; dir: string; home: string; runtime: RecordingRuntime; stop: () => Promise<void> }

/** A daemon with a vault, the `agents` source, and one fake runtime with its own home; `dir` reused stands for a restart. */
async function boot(config: Partial<Config>, options: { dir?: string; ledger?: boolean } = {}): Promise<Booted> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'system-agent-tiers-'))
  if (!options.dir) onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const home = join(dir, 'home-a')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(join(dir, 'ws'), { recursive: true })
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }),
    ...(options.ledger ? [ctx.plugin(FakeResources, { pools: [], templates: TEMPLATES })] : []),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry),
  ]
  await Promise.all(fibers)
  const agents = ctx.plugin(AgentWorkers, { workers: [], accountHomes: join(dir, 'agent-homes'), probeTtlMs: 0, ...config } as Config)
  await agents
  fibers.push(agents)
  const runtime = new RecordingRuntime(A, '1.0.0', home)
  ctx.agentRuntimes.register(runtime)
  const stop = async (): Promise<void> => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  }
  onTestFinished(stop)
  return { ctx, dir, home, runtime, stop }
}

/** Enroll slot 1 (the runtime's own home) signed in as `login`, on a row with no Workers; the account id it was verified as. */
async function enrolled(dir: string, login: string): Promise<string> {
  const first = await boot({}, { dir })
  const begun = await first.ctx.agentWorkers.agentAccounts.begin({ provider: A })
  FakeAgentRuntime.signIn(begun.account.home, login)
  const verified = await first.ctx.agentWorkers.agentAccounts.verify({ provider: A, slot: begun.account.slot })
  await first.stop()
  return verified.accountId!
}

const requirement = (min: Tier): WorkRequirement => ({
  schema: 'work-requirement@1.0', objective: 'review', capabilities: ['review', 'local-data'], data: { classification: 'operator-shared', refs: [] },
  egressPolicy: 'egress.classification-and-secrets', tier: { min, source: 'caller' }, acceptance: { contract: 'acceptance.answer' },
})
/** Start the work on the Worker routing admitted, at the tier it was admitted at, as the workflow engine does. */
const startOn = (b: Booted, admitted: AdmittedWorker, key: string, min: Tier): WorkerExecution =>
  b.ctx.workers.source('agents')!.start({ key, worker: admitted.worker.worker, prompt: key, requirement: requirement(min), decisions: admitted.decisions, ...(admitted.tier ? { tier: admitted.tier } : {}) })
const wait = (b: Booted, run: WorkerExecution): Promise<WorkerExecution> => b.ctx.workers.source('agents')!.wait(run.id, 10_000)
const described = async (b: Booted): Promise<Map<string, CapabilityDescriptor>> => new Map((await b.ctx.workers.list()).map((d) => [d.worker, d]))
const resultOf = (b: Booted, run: WorkerExecution) => b.ctx.artifacts.get(run.result!)!.body as Record<string, unknown>

describe('a role with tiers: one Worker per account offers them all (ADR-0073)', () => {
  it('derives one Worker from a role with three tiers, offering the three, each with its model and options, its lowest as its tier', () => {
    const [worker, ...more] = deriveWorkers([tieredRole('/srv/ws')], [{ account: ACC1, roles: ['review'] }], [])
    expect(more).toEqual([])
    expect(worker).toMatchObject({ id: `${ACC1}/review`, tier: 'economy', maxTurns: 4 })
    expect(worker!.tiers).toEqual([
      { tier: 'economy', declared: true, model: ECONOMY, maxTurns: 4 },
      { tier: 'standard', declared: true, model: STANDARD, maxTurns: 4 },
      { tier: 'frontier', declared: true, model: FRONTIER, maxTurns: 8 },
    ])
    // Each tier's model draws on its own pool of the account, where the provider names one; the economy model has none.
    const metered = deriveWorkers([tieredRole('/srv/ws')], [{ account: ACC1, roles: ['review'] }], [METERED])[0]!
    expect(metered.tiers!.map((t) => [t.tier, t.modelPool?.pool])).toEqual([['economy', undefined], ['standard', `model-standard/${ACC1}`], ['frontier', `model-frontier/${ACC1}`]])
  })

  it('keeps a one-tier role exactly as before: one tier, the runtime\'s model, no tiers on its Worker', () => {
    const [worker] = deriveWorkers([{ id: 'review', workspace: '/srv/ws', sandbox: 'read-only', tier: 'standard', runtimes: { [A]: { model: STANDARD } } }], [{ account: ACC1, roles: ['review'] }], [])
    expect(worker).toMatchObject({ tier: 'standard', model: STANDARD })
    expect(worker).not.toHaveProperty('tiers')
  })

  it('refuses tiers that are malformed, a role that gives no tier on a runtime, and model pools that are not one per model on a metered provider', () => {
    const assign = [{ account: ACC1, roles: ['review'] }]
    const role = (tiers: unknown) => ({ id: 'review', workspace: '/srv/ws', sandbox: 'read-only' as const, runtimes: { [A]: { tiers } } }) as never
    expect(() => deriveWorkers([role({})], assign, [])).toThrow(/tiers must name at least one tier/)
    expect(() => deriveWorkers([role({ premium: { model: FRONTIER } })], assign, [])).toThrow(/tiers\.premium: not a tier/)
    expect(() => deriveWorkers([role({ frontier: {} })], assign, [])).toThrow(/tiers\.frontier\.model must be a model name/)
    expect(() => deriveWorkers([role({ frontier: { model: 'two words' } })], assign, [])).toThrow(/one word of plain text/)
    expect(() => deriveWorkers([role({ frontier: { model: FRONTIER, sandbox: 'workspace-write' } })], assign, [])).toThrow(/tiers\.frontier\.sandbox: a tier sets its model, tools, and maxTurns only/)
    expect(() => deriveWorkers([role({ frontier: { model: FRONTIER, maxTurns: 0 } })], assign, [])).toThrow(/maxTurns must be a whole number/)
    // Capability stays the role's: a role with no tier and no tiers on the runtime it is assigned on gives that runtime none.
    expect(() => deriveWorkers([{ id: 'review', workspace: '/srv/ws', sandbox: 'read-only' }], assign, [])).toThrow(/the role review gives no tier on fake-a/)
    expect(checkConfig({ roles: [tieredRole('/srv/ws')], assignments: assign, providers: [{ provider: A, modelPools: [{ model: FRONTIER, pool: 'model-frontier' }] }] }))
      .toEqual([expect.stringMatching(/modelPools: a model's pool is drawn on beside its account's, and no pool is set/)])
    expect(checkConfig({ roles: [tieredRole('/srv/ws')], assignments: assign, providers: [{ ...METERED, modelPools: [METERED.modelPools[0]!, { ...METERED.modelPools[1]!, model: STANDARD }] }] }))
      .toEqual([expect.stringMatching(/is named twice; one pool per model/)])
    expect(checkConfig({ roles: [tieredRole('/srv/ws')], assignments: assign, providers: [{ ...METERED, modelPools: [{ ...METERED.modelPools[0]!, pool: 'plan' }] }] }))
      .toEqual([expect.stringMatching(/the template plan is already drawn on by this provider/)])
    expect(checkConfig({ roles: [tieredRole('/srv/ws')], assignments: assign, providers: [METERED] })).toEqual([])
  })
})

describe('a tiered Worker in the agents source (ADR-0073)', () => {
  it('describes one Worker offering its three tiers (capability-descriptor@1.11), and runs a frontier step on the frontier model, recording the tier and the model it ran on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agent-tiers-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const account = await enrolled(dir, 'alice@example.test')
    const b = await boot({ roles: [tieredRole(join(dir, 'ws'))], assignments: [{ account, roles: ['review'] }] }, { dir })
    const workers = await described(b)
    expect([...workers.keys()]).toEqual([`agent:${account}/review`])
    const worker = workers.get(`agent:${account}/review`)!
    expect(worker).toMatchObject({ schema: 'capability-descriptor@1.11', state: 'ready', tier: 'economy', tiers: [{ tier: 'economy', label: ECONOMY, maxTurns: 4 }, { tier: 'standard', label: STANDARD, maxTurns: 4 }, { tier: 'frontier', label: FRONTIER, maxTurns: 8 }] })
    schemas.assertRecord(worker)

    // A frontier step: routed at frontier, run on the frontier model with its own turn limit.
    const top = await b.ctx.workers.route(requirement('frontier'))
    expect([top.worker.worker, top.tier]).toEqual([`agent:${account}/review`, 'frontier'])
    const run = await wait(b, startOn(b, top, 'frontier-step', 'frontier'))
    top.release()
    expect(run.status).toBe('completed')
    expect(b.runtime.specs.at(-1)).toMatchObject({ model: FRONTIER, maxTurns: 8 })
    const result = resultOf(b, run)
    expect(result).toMatchObject({ schema: 'agent-result@1.4', tier: 'frontier', configuredModel: FRONTIER })
    schemas.assertRecord(result)
    expect(b.ctx.store.db.prepare('SELECT tier FROM agent_runs WHERE run_id = ?').get(run.id)).toEqual({ tier: 'frontier' })

    // An economy step on the same Worker runs the economy model; a start with no routed tier takes the lowest at or above the minimum.
    const cheap = await b.ctx.workers.route(requirement('economy'))
    expect(cheap.tier).toBe('economy')
    await wait(b, startOn(b, cheap, 'economy-step', 'economy'))
    cheap.release()
    expect(b.runtime.specs.at(-1)).toMatchObject({ model: ECONOMY, maxTurns: 4 })
    await wait(b, b.ctx.workers.source('agents')!.start({ key: 'unrouted', worker: `agent:${account}/review`, prompt: 'unrouted', requirement: requirement('standard'), decisions: cheap.decisions }))
    expect(b.runtime.specs.at(-1)).toMatchObject({ model: STANDARD })
    // A tier it does not offer is refused before anything starts.
    expect(() => b.ctx.workers.source('agents')!.start({ key: 'nowhere', worker: `agent:${account}/review`, prompt: 'x', requirement: requirement('economy'), decisions: cheap.decisions, tier: 'premium' as Tier }))
      .toThrow(/offers the tiers economy, standard, frontier, not premium/)
  })

  it('keeps a one-tier role\'s Worker as before: no tiers described, its one model run, its result without a tier', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agent-tiers-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const account = await enrolled(dir, 'alice@example.test')
    const b = await boot({ roles: [{ id: 'review', workspace: join(dir, 'ws'), sandbox: 'read-only', tier: 'standard', runtimes: { [A]: { model: STANDARD } } }], assignments: [{ account, roles: ['review'] }] }, { dir })
    const worker = (await described(b)).get(`agent:${account}/review`)!
    expect(worker.schema).toBe('capability-descriptor@1.5')
    expect(worker).not.toHaveProperty('tiers')
    const admitted = await b.ctx.workers.route(requirement('economy'))
    expect(admitted.tier).toBe('standard')
    const run = await wait(b, startOn(b, admitted, 'one-tier', 'economy'))
    admitted.release()
    expect(b.runtime.specs.at(-1)).toMatchObject({ model: STANDARD })
    expect(resultOf(b, run).schema).toBe('agent-result@1.1')
    expect(resultOf(b, run)).not.toHaveProperty('tier')
    expect(() => b.ctx.workers.source('agents')!.start({ key: 'higher', worker: admitted.worker.worker, prompt: 'x', requirement: requirement('economy'), decisions: admitted.decisions, tier: 'frontier' }))
      .toThrow(/offers tier standard only, not frontier/)
  })
})

describe('a run queued before its role\'s tiers changed (ADR-0073)', () => {
  /**
   * Queue a frontier run behind one that holds the account's one slot, then stop: the restart below
   * comes up with `after`, a changed configuration of the same role, and takes the queued run up.
   */
  async function queuedAtFrontier(): Promise<{ dir: string; account: string; queued: WorkerExecution }> {
    const dir = mkdtempSync(join(tmpdir(), 'system-agent-tiers-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const account = await enrolled(dir, 'alice@example.test')
    const first = await boot({ roles: [tieredRole(join(dir, 'ws'))], assignments: [{ account, roles: ['review'] }] }, { dir })
    first.runtime.holdNext = true
    const holding = await first.ctx.workers.route(requirement('economy'))
    startOn(first, holding, 'holding', 'economy')
    holding.release()
    const top = await first.ctx.workers.route(requirement('frontier'))
    expect(top.tier).toBe('frontier')
    const queued = startOn(first, top, 'queued-frontier', 'frontier')
    top.release()
    await expect.poll(() => first.runtime.specs.length, { timeout: 5_000 }).toBe(1)
    expect(first.ctx.store.db.prepare('SELECT status, tier, configured_model FROM agent_runs WHERE run_id = ?').get(queued.id)).toEqual({ status: 'queued', tier: 'frontier', configured_model: FRONTIER })
    await first.stop()
    return { dir, account, queued }
  }

  it('fails a frontier run queued before its role became one standard tier unsent, naming both tiers, so routing serves it again; it never runs the standard model', async () => {
    const { dir, account, queued } = await queuedAtFrontier()
    const role = { id: 'review', workspace: join(dir, 'ws'), sandbox: 'read-only' as const, tier: 'standard' as const, runtimes: { [A]: { model: STANDARD } } }
    const second = await boot({ roles: [role], assignments: [{ account, roles: ['review'] }] }, { dir })
    const done = await wait(second, queued)
    expect(done).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'worker_changed', disposition: 'IMMEDIATE' } })
    expect(done.error!.message).toMatch(/started at tier frontier, and it no longer offers tier frontier: it offers tier standard only; nothing was run, and routing serves the work again/)
    expect(second.runtime.specs).toEqual([])
  })

  it('fails a frontier run unsent when its tier is still offered but runs another model now, or none of its own', async () => {
    for (const frontier of [{ model: STANDARD }, undefined]) {
      const { dir, account, queued } = await queuedAtFrontier()
      // The same tier, frontier, on a one-tier role: with the standard model, or with the runtime's own default.
      const role = { id: 'review', workspace: join(dir, 'ws'), sandbox: 'read-only' as const, tier: 'frontier' as const, runtimes: { [A]: { ...frontier } } }
      const second = await boot({ roles: [role], assignments: [{ account, roles: ['review'] }] }, { dir })
      const done = await wait(second, queued)
      expect(done).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'worker_changed', disposition: 'IMMEDIATE' } })
      expect(done.error!.message).toMatch(frontier ? /tier frontier now runs another model/ : /tier frontier now names no model of its own/)
      expect(second.runtime.specs).toEqual([])
      await second.stop()
    }
  })

  it('runs a queued run whose tier and model its Worker still offers, after a restart that changed another tier', async () => {
    const { dir, account, queued } = await queuedAtFrontier()
    const role = { ...tieredRole(join(dir, 'ws')), runtimes: { [A]: { maxTurns: 4, tiers: { standard: { model: STANDARD }, frontier: { model: FRONTIER, maxTurns: 8 } } } } }
    const second = await boot({ roles: [role], assignments: [{ account, roles: ['review'] }] }, { dir })
    expect(await wait(second, queued)).toMatchObject({ status: 'completed', submitted: true })
    expect(second.runtime.specs).toEqual([expect.objectContaining({ model: FRONTIER, maxTurns: 8 })])
  })
})

describe('quota per model (ADR-0073)', () => {
  it('reads each model\'s weekly window into its own pool, so the frontier window at its limit closes only the frontier tier, and leaves standard admissible', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agent-tiers-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const account = await enrolled(dir, 'alice@example.test')
    // Beside it, a one-tier role whose model has no pool of its own: its one tier draws on the account's pool alone.
    const quickRole = { id: 'quick', workspace: join(dir, 'ws'), sandbox: 'read-only' as const, tier: 'standard' as const, runtimes: { [A]: { model: ECONOMY } } }
    const b = await boot({ providers: [METERED], roles: [tieredRole(join(dir, 'ws')), quickRole], assignments: [{ account, roles: ['review', 'quick'] }] }, { dir, ledger: true })
    const id = `agent:${account}/review`
    const quick = `agent:${account}/quick`
    // No reading yet: every pool is unknown, so closed (INV-2), the account's own among them.
    expect((await described(b)).get(id)!.state).toBe('quota-exhausted')
    expect((await b.ctx.resources.pools()).map((p) => p.pool).sort()).toEqual([`model-frontier/${account}`, `model-standard/${account}`, `plan/${account}`])
    // The account's usage report: its five-hour window, and a weekly window per model, the frontier one used up.
    FakeAgentRuntime.report(b.home, [
      { window: 'five_hour', status: 'allowed', usedPercentage: 10 },
      { window: 'model_scoped:standard', status: 'allowed', usedPercentage: 20 },
      { window: 'model_scoped:frontier', status: 'rejected', usedPercentage: 100, resetsAt: BACK },
    ])
    await b.ctx.agentWorkers.readUsageReports()
    const pools = new Map((await b.ctx.resources.pools()).map((p) => [p.pool, p]))
    // Each model's window is a reading of its own pool; the account's pool is open.
    expect([...pools.values()].map((p) => [p.pool, p.available, p.readings.map((r) => [r.window.id, r.state])]).sort()).toEqual([
      [`model-frontier/${account}`, false, [['weekly', 'limited']]],
      [`model-standard/${account}`, true, [['weekly', 'ok']]],
      [`plan/${account}`, true, [['five-hour', 'ok']]],
    ])
    const worker = (await described(b)).get(id)!
    expect(worker).toMatchObject({
      state: 'ready',
      tiers: [
        { tier: 'economy', pools: [`plan/${account}`] },
        { tier: 'standard', pools: [`plan/${account}`, `model-standard/${account}`] },
        { tier: 'frontier', pools: [`plan/${account}`, `model-frontier/${account}`], closed: true, until: BACK },
      ],
    })
    expect(worker.tiers![1]).not.toHaveProperty('closed')
    schemas.assertRecord(worker)
    // The one-tier Worker names the one pool it draws on, so no model's pool (the frontier one, closed) is read as its quota.
    const one = (await described(b)).get(quick)!
    expect(one).toMatchObject({ schema: 'capability-descriptor@1.11', state: 'ready', tier: 'standard', tiers: [{ tier: 'standard', pools: [`plan/${account}`] }] })
    expect(one.tiers![0]).not.toHaveProperty('closed')
    schemas.assertRecord(one)
    const onQuick = await b.ctx.workers.route(requirement('standard'), { restrict: { workers: [quick], reason: 'test' } })
    expect([onQuick.worker.worker, onQuick.tier]).toEqual([quick, 'standard'])
    onQuick.release()

    // A standard step is admitted, and runs the standard model, reserving on the account's pool and the standard model's.
    const standard = await b.ctx.workers.route(requirement('standard'), { restrict: { workers: [id], reason: 'test' } })
    expect([standard.worker.worker, standard.tier]).toEqual([id, 'standard'])
    const run = await wait(b, startOn(b, standard, 'standard-step', 'standard'))
    standard.release()
    expect(run.status).toBe('completed')
    expect(b.runtime.specs.at(-1)).toMatchObject({ model: STANDARD })
    const budget = run.decisions.map((d) => b.ctx.artifacts.get(d)!.body as { decisionType: string; outcome: { option: string; detail?: { lines?: Array<{ pool: string }> } } }).find((d) => d.decisionType === 'budget')!
    expect(budget.outcome.option).toBe('reserved')
    expect(budget.outcome.detail!.lines!.map((l) => l.pool)).toEqual([`plan/${account}`, `model-standard/${account}`])

    // Frontier work is refused for the frontier model's limit alone, and its account says when it is back.
    const refused = await b.ctx.workers.route(requirement('frontier'), { restrict: { workers: [id], reason: 'test' } }).catch((error: unknown) => error as AdmissionFailure)
    expect(refused).toBeInstanceOf(AdmissionFailure)
    // The one-tier Worker beside it is left out by the restriction (and its tier is below frontier).
    expect((refused as AdmissionFailure).rejections.filter((r) => r.worker === id)).toEqual([{ worker: id, state: 'ready', failed: [{ check: 'cooldown', reason: `tier frontier limit until ${BACK} (its model's limit)` }] }])
    expect((refused as AdmissionFailure).limitUntil).toBe(BACK)
    // A run started at frontier anyway is refused by its reservation, before anything reaches the agent.
    const forced = await wait(b, b.ctx.workers.source('agents')!.start({ key: 'forced', worker: id, prompt: 'x', requirement: requirement('frontier'), decisions: standard.decisions, tier: 'frontier' }))
    expect(forced).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'quota_exhausted' } })
    expect(b.runtime.specs.filter((s) => s.model === FRONTIER)).toEqual([])

    // A standard run that hits a limit its runtime names nothing of: the report read after it still shows
    // the frontier model exhausted, which says nothing of this run's limit, so its own pools close (INV-2).
    b.runtime.limitNext = true
    const again = await b.ctx.workers.route(requirement('standard'), { restrict: { workers: [id], reason: 'test' } })
    const hit = await wait(b, startOn(b, again, 'standard-limit', 'standard'))
    again.release()
    expect(hit).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'quota_exhausted' } })
    const plan = (await b.ctx.resources.pools()).find((p) => p.pool === `plan/${account}`)!
    expect(plan.available).toBe(false)
    expect(plan.readings).toEqual([expect.objectContaining({ window: expect.objectContaining({ id: 'five-hour' }), state: 'limited', source: 'limit-notice' })])
    expect((await described(b)).get(id)!.state).toBe('quota-exhausted')
  })
})
