// An account's quota read from its runtime's own usage report (ADR-0059): after each run of a
// derived Worker on a declared pool, after any run that hit a limit, and every limitReadSeconds per
// ready account, into its pool's windows; a report never opens a window a limit closed. Over fake
// runtimes with scripted homes and scripted reports, and the fake ledger.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { LimitReport, LimitsOptions, RunObserver, RunResult, RunSpec } from '@tsuuanmi/system-agent-runtime-core'
import AgentRuntimeRegistry from '@tsuuanmi/system-agent-runtimes'
import Artifacts from '@tsuuanmi/system-artifacts'
import Vault from '@tsuuanmi/system-credentials-vault'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import type { LimitState, PoolTemplate } from '@tsuuanmi/system-resources-core'
import Store from '@tsuuanmi/system-store'
import WorkerRouter, { type WorkRequirement } from '@tsuuanmi/system-workers'
import type { CapabilityDescriptor, WorkerExecution } from '@tsuuanmi/system-workers-core'
import { describe, expect, it, onTestFinished } from 'vitest'
import { FakeAgentRuntime } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import { FakeResources } from '../../../resources-core/conformance/resources.ts'
import AgentWorkers, { checkConfig, type Config } from '../src/index.ts'

const A = 'fake-a'
const TEMPLATE: PoolTemplate = { template: 'plan', group: A, kind: 'interactive', windows: [{ id: 'five-hour', kind: 'rolling', seconds: 18_000 }, { id: 'seven-day', kind: 'rolling', seconds: 604_800 }] }
const WINDOWS = { five_hour: 'five-hour', seven_day: 'seven-day' }
const IN = (ms: number): string => new Date(Date.now() + ms).toISOString()

/**
 * A fake runtime that records its runs and its usage reads (each read's home, and how many are in
 * flight at once), reports turns (so a run's usage is recorded), and, when `quota` is set, fails each
 * run on a usage limit it gives no reading for; while `holdReads` is set, a read waits until stopped.
 */
class ReportingRuntime extends FakeAgentRuntime {
  readonly runs: RunSpec[] = []
  readonly reads: Array<string | undefined> = []
  inFlight = 0
  most = 0
  quota = false
  holdReads = false
  /** What happened, in order, across the runtime and the ledger. */
  readonly events: string[] = []

  override async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void, observer?: RunObserver): Promise<RunResult> {
    this.runs.push(spec)
    const result = await super.run(spec, signal, onHandle, observer)
    this.events.push('run')
    if (this.quota) throw new ProviderError('quota_exhausted', `${this.kind}: You have exhausted your quota.`)
    return { ...result, turns: 1 }
  }

  override async limits(options: LimitsOptions, signal: AbortSignal): Promise<LimitReport> {
    this.reads.push(options.home)
    this.events.push('report')
    this.inFlight++
    this.most = Math.max(this.most, this.inFlight)
    try {
      if (this.holdReads) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      return await super.limits(options, signal)
    } finally {
      this.inFlight--
    }
  }
}

/** Where the recording ledger notes its records and releases, when a test points it at a list. */
let ledgerEvents: string[] | undefined
class RecordingResources extends FakeResources {
  override async record(...args: Parameters<FakeResources['record']>) {
    ledgerEvents?.push('record')
    return super.record(...args)
  }

  override async release(...args: Parameters<FakeResources['release']>) {
    ledgerEvents?.push('release')
    return super.release(...args)
  }
}

interface Booted {
  ctx: Context
  dir: string
  runtime: ReportingRuntime
  stop: () => Promise<void>
}

/** A daemon with a vault, the fake ledger (the plan template), the `agents` source, and one reporting runtime with its own home; `dir` reused stands for a restart. */
async function boot(config: Partial<Config>, options: { dir?: string; ledger?: boolean } = {}): Promise<Booted> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'system-agent-reports-'))
  if (!options.dir) onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const home = join(dir, 'home-a')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(join(dir, 'ws'), { recursive: true })
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }),
    ...(options.ledger === false ? [] : [ctx.plugin(RecordingResources, { pools: [], templates: [TEMPLATE] })]),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry),
  ]
  await Promise.all(fibers)
  const agents = ctx.plugin(AgentWorkers, { workers: [], accountHomes: join(dir, 'agent-homes'), probeTtlMs: 0, ...config } as Config)
  await agents
  fibers.push(agents)
  const runtime = new ReportingRuntime(A, '1.0.0', home)
  ctx.agentRuntimes.register(runtime)
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  }
  onTestFinished(stop)
  return { ctx, dir, runtime, stop }
}

/** Enroll a slot signed in as `login`; its account id and home. */
async function enroll(b: Booted, login: string): Promise<{ id: string; home: string }> {
  const begun = await b.ctx.agentWorkers.agentAccounts.begin({ provider: A })
  FakeAgentRuntime.signIn(begun.account.home, login)
  const verified = await b.ctx.agentWorkers.agentAccounts.verify({ provider: A, slot: begun.account.slot })
  return { id: verified.accountId!, home: begun.account.home }
}

/** Two accounts enrolled in one boot, then a second boot on the same state with `config` (roles and assignments of both). */
async function twoAccounts(config: (a: string, b: string, ws: string) => Partial<Config>): Promise<Booted & { a: { id: string; home: string }; b: { id: string; home: string } }> {
  const dir = mkdtempSync(join(tmpdir(), 'system-agent-reports-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const first = await boot({ providers: [{ provider: A, slots: 2 }] }, { dir, ledger: false })
  const a = await enroll(first, 'alice@example.test')
  const b = await enroll(first, 'bob@example.test')
  await first.stop()
  return { ...await boot(config(a.id, b.id, join(dir, 'ws')), { dir }), a, b }
}

const metered = (extra: Record<string, unknown> = {}) => (a: string, b: string, ws: string): Partial<Config> => ({
  providers: [{ provider: A, slots: 2, pool: 'plan', windows: WINDOWS, ...extra }],
  roles: [{ id: 'review', workspace: ws, sandbox: 'read-only', tier: 'standard' }], assignments: [{ account: a, roles: ['review'] }, { account: b, roles: ['review'] }],
})

const requirement = (): WorkRequirement => ({
  schema: 'work-requirement@1.0', objective: 'review', capabilities: ['review', 'local-data'], data: { classification: 'operator-shared', refs: [] },
  egressPolicy: 'egress.classification-and-secrets', tier: { min: 'economy', source: 'caller' }, acceptance: { contract: 'acceptance.answer' },
})
const run = async (b: Booted, worker: string, key: string): Promise<WorkerExecution> => {
  const source = b.ctx.workers.source('agents')!
  const started = source.start({ key, worker, prompt: key, requirement: requirement(), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never })
  return source.wait(started.id, 10_000)
}
const described = async (b: Booted): Promise<Map<string, CapabilityDescriptor>> => new Map((await b.ctx.workers.list()).map((d) => [d.worker, d]))
/** Declare the source's pools (a describe does), then read every window of each account's pool ok, a few seconds ago. */
const open = async (b: Booted, ...accounts: string[]): Promise<void> => {
  await described(b)
  for (const account of accounts) for (const w of TEMPLATE.windows) await b.ctx.resources.observe({ schema: 'limit-state@1.0', pool: `plan/${account}`, account, window: w, state: 'ok', source: 'runtime-result', observedAt: new Date(Date.now() - 5000).toISOString() })
}
const readingOf = async (b: Booted, account: string, window: string): Promise<LimitState | undefined> =>
  (await b.ctx.resources.pools({ account })).find((p) => p.pool === `plan/${account}`)?.readings.find((r) => r.window.id === window)
const limit = (b: Booted, account: string, window: string, until: string): Promise<unknown> => b.ctx.resources.observe({
  schema: 'limit-state@1.0', pool: `plan/${account}`, account, window: TEMPLATE.windows.find((w) => w.id === window)!, state: 'limited', resetsAt: until, source: 'runtime-result', observedAt: new Date(Date.now() - 1000).toISOString(),
})

describe('an account\'s usage report after each run (ADR-0059)', () => {
  it('reads the account\'s report once after each run of a derived Worker on a declared pool, in the home it ran in, before its usage is recorded and its reservation released: the latest reading has the share', async () => {
    const b = await twoAccounts(metered({ limitReadSeconds: 0 }))
    FakeAgentRuntime.report(b.b.home, [{ window: 'five_hour', status: 'allowed', usedPercentage: 42, resetsAt: IN(3_600_000) }, { window: 'seven_day', status: 'allowed', usedPercentage: 17.5 }])
    // Both pools open first, so the run is admitted (no reading yet is unknown, so closed).
    await open(b, b.a.id, b.b.id)
    ledgerEvents = b.runtime.events
    onTestFinished(() => { ledgerEvents = undefined })
    const done = await run(b, `agent:${b.b.id}/review`, 'k1')
    expect(done.status).toBe('completed')
    expect(b.runtime.reads).toEqual([b.b.home])
    expect(b.runtime.events).toEqual(['run', 'report', 'record', 'release'])
    expect(await readingOf(b, b.b.id, 'five-hour')).toMatchObject({ state: 'ok', usedPercentage: 42, resetsAt: expect.any(String), source: 'runtime-result' })
    expect(await readingOf(b, b.b.id, 'seven-day')).toMatchObject({ state: 'ok', usedPercentage: 17.5, source: 'runtime-result' })
    // The other account's windows are its own.
    expect((await readingOf(b, b.a.id, 'five-hour'))!.usedPercentage).toBeUndefined()
    // A run on the account in the runtime's own home (slot 1) reads that home.
    FakeAgentRuntime.report(b.a.home, [{ window: 'five_hour', status: 'allowed', usedPercentage: 5 }])
    await run(b, `agent:${b.a.id}/review`, 'k2')
    expect(b.runtime.reads).toEqual([b.b.home, undefined])
    expect((await readingOf(b, b.a.id, 'five-hour'))!.usedPercentage).toBe(5)
  })

  it('takes a reset read at a limit over the cooldown fallback: a run that hit a limit with no reading of its own closes its pool until the report\'s reset', async () => {
    const b = await twoAccounts(metered({ limitReadSeconds: 0, limitCooldownSeconds: 600 }))
    await open(b, b.b.id)
    const reset = new Date(Date.now() + 2 * 3_600_000).toISOString()
    FakeAgentRuntime.report(b.b.home, [{ window: 'five_hour', status: 'rejected', usedPercentage: 100, resetsAt: reset }, { window: 'seven_day', status: 'allowed', usedPercentage: 60 }])
    b.runtime.quota = true
    expect(await run(b, `agent:${b.b.id}/review`, 'k1')).toMatchObject({ status: 'failed', error: { kind: 'quota_exhausted' } })
    expect(await readingOf(b, b.b.id, 'five-hour')).toMatchObject({ state: 'limited', resetsAt: reset, usedPercentage: 100, source: 'runtime-result' })
    // No cooldown fallback replaced it (that would be a limit-notice for 600 s).
    expect((await b.ctx.resources.pools({ account: b.b.id }))[0]!.readings.every((r) => r.source === 'runtime-result')).toBe(true)
    expect((await described(b)).get(`agent:${b.b.id}/review`)).toMatchObject({ state: 'quota-exhausted', account: { limitUntil: reset } })
  })

  it('after a run that hit a limit on a Worker with no pool (a hand-named one, the runtime\'s own home), cools the account down until the report\'s rejected reset, not the fallback cooldown', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'system-agent-reports-ws-'))
    onTestFinished(() => rmSync(ws, { recursive: true, force: true }))
    const b = await boot({ workers: [{ id: 'reviewer', runtime: A, workspace: ws, sandbox: 'read-only', tier: 'standard', limitCooldownSeconds: 600 }] })
    const home = b.runtime.home!
    FakeAgentRuntime.signIn(home, 'alice@example.test')
    const reset = new Date(Date.now() + 3 * 3_600_000).toISOString()
    FakeAgentRuntime.report(home, [{ window: 'five_hour', status: 'rejected', usedPercentage: 100, resetsAt: reset }])
    b.runtime.quota = true
    const done = await run(b, 'agent:reviewer', 'k1')
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'quota_exhausted' } })
    expect(b.runtime.reads).toEqual([undefined])
    expect((await described(b)).get('agent:reviewer')).toMatchObject({ state: 'quota-exhausted', account: { limitUntil: reset } })
    // A run that did not hit a limit, on a Worker with no pool, reads nothing.
    b.runtime.quota = false
    const other = await boot({ workers: [{ id: 'reviewer', runtime: A, workspace: ws, sandbox: 'read-only', tier: 'standard' }] })
    FakeAgentRuntime.signIn(other.runtime.home!, 'alice@example.test')
    expect((await run(other, 'agent:reviewer', 'k1')).status).toBe('completed')
    expect(other.runtime.reads).toEqual([])
  })

  it('records nothing from a report it cannot read, and the run\'s outcome stands', async () => {
    const b = await twoAccounts(metered({ limitReadSeconds: 0 }))
    await open(b, b.b.id)
    FakeAgentRuntime.report(b.b.home, 'garbled')
    const before = await b.ctx.resources.pools({ account: b.b.id })
    expect((await run(b, `agent:${b.b.id}/review`, 'k1')).status).toBe('completed')
    expect(b.runtime.reads).toHaveLength(1)
    expect((await b.ctx.resources.pools({ account: b.b.id }))[0]!.readings).toEqual(before[0]!.readings)
  })
})

describe('an account\'s usage report every limitReadSeconds (ADR-0059)', () => {
  it('reads each ready account with a pool once per period, in its own home, at most one read in flight per runtime; another pass within the period reads none', async () => {
    const b = await twoAccounts(metered())
    FakeAgentRuntime.report(b.a.home, [{ window: 'five_hour', status: 'allowed', usedPercentage: 12 }, { window: 'seven_day', status: 'allowed', usedPercentage: 3 }])
    FakeAgentRuntime.report(b.b.home, [{ window: 'five_hour', status: 'allowed', usedPercentage: 64 }, { window: 'seven_day', status: 'allowed', usedPercentage: 30 }])
    await b.ctx.agentWorkers.readUsageReports()
    expect([...b.runtime.reads].sort()).toEqual([b.b.home, undefined].sort())
    expect(b.runtime.most).toBe(1)
    expect((await readingOf(b, b.a.id, 'five-hour'))!.usedPercentage).toBe(12)
    expect((await readingOf(b, b.b.id, 'five-hour'))!.usedPercentage).toBe(64)
    // Its first readings make an idle account's pool available: every window read ok.
    expect((await described(b)).get(`agent:${b.b.id}/review`)!.state).toBe('ready')
    await b.ctx.agentWorkers.readUsageReports()
    expect(b.runtime.reads).toHaveLength(2)
  })

  it('reads nothing periodically when limitReadSeconds is 0, nor an account that is not ready, nor without a pool', async () => {
    const off = await twoAccounts(metered({ limitReadSeconds: 0 }))
    await off.ctx.agentWorkers.readUsageReports()
    expect(off.runtime.reads).toEqual([])
    const unpooled = await twoAccounts((a, b, ws) => ({ providers: [{ provider: A, slots: 2 }], roles: [{ id: 'review', workspace: ws, sandbox: 'read-only', tier: 'standard' }], assignments: [{ account: a, roles: ['review'] }, { account: b, roles: ['review'] }] }))
    await unpooled.ctx.agentWorkers.readUsageReports()
    expect(unpooled.runtime.reads).toEqual([])
    // An account signed out is not ready: only the other is read.
    const one = await twoAccounts(metered())
    FakeAgentRuntime.signOut(one.b.home)
    await one.ctx.agentWorkers.agentAccounts.recheck(A, one.b.home)
    await one.ctx.agentWorkers.readUsageReports()
    expect(one.runtime.reads).toEqual([undefined])
  })

  it('never opens a window a limit closed before its reset; records the rest; and opens it once that reset has passed', async () => {
    const b = await twoAccounts(metered())
    const until = IN(3_600_000)
    await described(b)
    await limit(b, b.b.id, 'five-hour', until)
    FakeAgentRuntime.report(b.b.home, [{ window: 'five_hour', status: 'allowed', usedPercentage: 99 }, { window: 'seven_day', status: 'allowed', usedPercentage: 30 }])
    await b.ctx.agentWorkers.readUsageReports()
    expect(await readingOf(b, b.b.id, 'five-hour')).toMatchObject({ state: 'limited', resetsAt: until })
    expect(await readingOf(b, b.b.id, 'seven-day')).toMatchObject({ state: 'ok', usedPercentage: 30 })
    expect((await described(b)).get(`agent:${b.b.id}/review`)).toMatchObject({ state: 'quota-exhausted' })
    // A limit whose reset has passed no longer holds the window: the report's reading is recorded.
    await b.stop()
    const restart = await boot(metered()(b.a.id, b.b.id, join(b.dir, 'ws')), { dir: b.dir })
    await described(restart)
    await limit(restart, b.b.id, 'five-hour', new Date(Date.now() - 500).toISOString())
    await restart.ctx.agentWorkers.readUsageReports()
    expect(await readingOf(restart, b.b.id, 'five-hour')).toMatchObject({ state: 'ok', usedPercentage: 99 })
  })

  it('closes a window its report says is used up, until its reset, and every window for a used-up one it does not map', async () => {
    const b = await twoAccounts(metered())
    const reset = IN(2 * 3_600_000)
    FakeAgentRuntime.report(b.b.home, [{ window: 'five_hour', status: 'rejected', usedPercentage: 100, resetsAt: reset }, { window: 'seven_day', status: 'allowed', usedPercentage: 40 }])
    FakeAgentRuntime.report(b.a.home, [{ window: 'seven_day_oauth_apps', status: 'rejected', usedPercentage: 100, resetsAt: reset }, { window: 'five_hour', status: 'allowed', usedPercentage: 1 }])
    await b.ctx.agentWorkers.readUsageReports()
    expect(await readingOf(b, b.b.id, 'five-hour')).toMatchObject({ state: 'limited', resetsAt: reset })
    expect((await described(b)).get(`agent:${b.b.id}/review`)).toMatchObject({ state: 'quota-exhausted', account: { limitUntil: reset } })
    // An unmapped window used up closes every window of the pool; its own ok of a window it closed is not recorded.
    for (const w of ['five-hour', 'seven-day']) expect(await readingOf(b, b.a.id, w)).toMatchObject({ state: 'limited', resetsAt: reset })
  })

  it('stops a read in flight with the source: the stop does not wait for its bound, and nothing is recorded', async () => {
    const b = await twoAccounts(metered())
    FakeAgentRuntime.report(b.b.home, [{ window: 'five_hour', status: 'allowed', usedPercentage: 64 }])
    b.runtime.holdReads = true
    const pass = b.ctx.agentWorkers.readUsageReports()
    await expect.poll(() => b.runtime.inFlight).toBe(1)
    const started = Date.now()
    await b.stop()
    expect(Date.now() - started).toBeLessThan(5000)
    await pass
    expect(b.runtime.inFlight).toBe(0)
  })
})

describe('limitReadSeconds (ADR-0059): checked at load', () => {
  const roles = (extra: Record<string, unknown>): Partial<Config> => ({
    providers: [{ provider: A, pool: 'plan', windows: WINDOWS, ...extra }], roles: [{ id: 'review', workspace: '/srv/ws', sandbox: 'read-only', tier: 'standard' }], assignments: [{ account: `${A}:0123456789abcdef`, roles: ['review'] }],
  })
  it('takes 0 (off) or 60 s to a day, with a pool only, and only with roles and assignments', () => {
    for (const ok of [0, 60, 600, 86_400]) expect(checkConfig(roles({ limitReadSeconds: ok })), String(ok)).toEqual([])
    for (const bad of [30, 59, 86_401, 1.5]) expect(checkConfig(roles({ limitReadSeconds: bad }))[0], String(bad)).toMatch(/limitReadSeconds: 0 \(off\) or 60 to 86400/)
    expect(checkConfig({ providers: [{ provider: A, limitReadSeconds: 600 }], roles: roles({}).roles, assignments: roles({}).assignments })[0]).toMatch(/limitReadSeconds: the usage report is read into an account's pool, and no pool is set/)
    expect(checkConfig({ workers: [{ id: 'reviewer', runtime: A, workspace: '/srv/ws', sandbox: 'read-only', tier: 'standard' }], providers: [{ provider: A, pool: 'plan', limitReadSeconds: 600 }] })[0]).toMatch(/limitReadSeconds apply to Workers derived from roles and assignments/)
  })
})
