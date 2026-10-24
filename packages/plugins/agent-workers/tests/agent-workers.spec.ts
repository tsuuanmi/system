import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { type RunMetering, type RunObserver, withMetering } from '@tsuuanmi/system-agent-runtime-core'
import AgentRuntimeRegistry, { type AgentRuntimeProvider, type RunSpec, type SandboxMode } from '@tsuuanmi/system-agent-runtimes'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import type { ToolHandler, ToolSpec } from '@tsuuanmi/system-gateway-core'
import { captureGitSubject, processIdentity, SchemaError, SchemaRegistry, startPrompt, subjectId, usageUnknownOf } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { type LimitState, type PoolConfig, ResourcesError, type UsageRecord } from '@tsuuanmi/system-resources-core'
import Store from '@tsuuanmi/system-store'
import WorkerRouter, { AdmissionFailure, type WorkerExecution, type WorkRequirement } from '@tsuuanmi/system-workers'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import Workflow from '@tsuuanmi/system-workflow'
import * as SoftwareDevelopment from '@tsuuanmi/system-profile-software-development'
import { FakeResources } from '../../../resources-core/conformance/resources.ts'
import { DEVELOP } from './develop.ts'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import AgentWorkers, { type Config } from '../src/index.ts'
import { registerRunTools } from '../src/tools.ts'
import { openDirectory } from '../src/worktrees.ts'

/**
 * A scripted agent: it answers with the prompt, and records every run's policy. With `process`, each
 * run starts a real child process that stands for the agent, reports it (PROP-0013), and ends it when
 * the run ends; with `activity`, it reports activity every so many milliseconds while it holds.
 */
class ScriptedAgent implements AgentRuntimeProvider {
  readonly kind = 'scripted'
  readonly runs: RunSpec[] = []
  /** The agent processes its runs started, by pid. */
  readonly processes: number[] = []
  constructor(private readonly options: {
    sandboxes?: SandboxMode[]; resume?: boolean; available?: boolean; holdMs?: number; fail?: Error; executes?: boolean; readsConfined?: boolean; gatesToolCalls?: boolean; act?: (spec: RunSpec) => string | undefined
    /** What each run reports it consumed. */
    metering?: RunMetering
    process?: boolean
    activityEveryMs?: number
  } = {}) {}
  async probe() {
    return {
      available: this.options.available ?? true, detail: 'scripted 1.0', version: '1.0', sandboxes: this.options.sandboxes ?? ['read-only'],
      resume: this.options.resume ?? true, executes: this.options.executes ?? false, readsConfined: this.options.readsConfined ?? true,
      gatesToolCalls: this.options.gatesToolCalls ?? true,
    }
  }
  async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void, observer?: RunObserver) {
    this.runs.push(spec)
    const child = this.options.process ? spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' }) : undefined
    if (child) {
      await once(child, 'spawn')
      this.processes.push(child.pid!)
      observer?.onProcess?.({ pid: child.pid! })
    }
    const active = this.options.activityEveryMs ? setInterval(() => observer?.onActivity?.(Date.now()), this.options.activityEveryMs) : undefined
    try {
      onHandle?.(spec.resume ?? `h-${this.runs.length}`)
      if (this.options.holdMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, this.options.holdMs)
          signal.addEventListener('abort', () => (clearTimeout(timer), reject(new ProviderError('aborted', 'stopped'))), { once: true })
        })
      }
      if (this.options.fail) throw this.options.fail
      return { text: this.options.act?.(spec) ?? `echo: ${spec.prompt}`, nativeHandle: spec.resume ?? `h-${this.runs.length}`, turns: 1, ...this.options.metering }
    } finally {
      clearInterval(active)
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await once(child, 'exit')
      }
    }
  }
}

/** A scripted agent whose probes wait until the test releases them while `hold` is set: a slow probe. */
class SlowProbeAgent extends ScriptedAgent {
  hold = false
  probes = 0
  private readonly held: Array<() => void> = []

  override async probe() {
    this.probes++
    if (this.hold) await new Promise<void>((resolve) => this.held.push(resolve))
    return super.probe()
  }

  release(): void {
    for (const resolve of this.held.splice(0)) resolve()
  }
}

const WORKSPACE = mkdtempSync(join(tmpdir(), 'system-agent-ws-'))
const worker = (overrides: Partial<Config['workers'][number]> = {}): Config['workers'][number] => ({
  id: 'reviewer', runtime: 'scripted', workspace: WORKSPACE, sandbox: 'read-only', tier: 'standard', tools: ['Read', 'Grep'], model: 'model-x', ...overrides,
})

async function boot(agent: AgentRuntimeProvider, config: Config = { workers: [worker()] }, dir = mkdtempSync(join(tmpdir(), 'system-agents-')), ledger?: { pools: readonly PoolConfig[]; provider?: typeof FakeResources }) {
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ...(ledger ? [ctx.plugin(ledger.provider ?? FakeResources, { pools: ledger.pools })] : []),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry), ctx.plugin(AgentWorkers, config), ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, { retryDelayMs: 100, templates: { develop: DEVELOP } }),
  ]
  await Promise.all(fibers)
  // The profile contributes its template once the engine is up.
  fibers.push(ctx.plugin(SoftwareDevelopment))
  await fibers.at(-1)
  ctx.agentRuntimes.register(agent)
  // Once: a test that stops a boot itself (a restart on its state) leaves nothing for its cleanup.
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  }
  onTestFinished(stop)
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return { ctx, dir, stop }
}

const requirement = (overrides: Partial<WorkRequirement> = {}): WorkRequirement => ({
  schema: 'work-requirement@1.0', objective: 'review the change', capabilities: ['review', 'local-data'],
  // An agent's model is remote: local-private never reaches it by default (INV-12).
  data: { classification: 'operator-shared', refs: [] }, egressPolicy: 'egress.classification-and-secrets',
  tier: { min: 'economy', source: 'caller' }, acceptance: { contract: 'acceptance.answer' }, ...overrides,
})

/** A scripted chat Worker (reason) that stands in for the website planner and reporter of `develop`. */
function chatWorker(ctx: Context): string[] {
  const plans: string[] = []
    const executions = new Map<string, WorkerExecution>()
    ctx.workers.register({
      name: 'chat',
      describe: async () => [{ schema: 'capability-descriptor@1.0', worker: 'chat:a', provider: 'test', tier: 'standard', quotaClass: 'subscription-chat', locality: 'remote',
        capabilities: [{ capability: 'reason', evidence: { kind: 'conformance', at: '2026-10-12T00:00:00Z' } }], state: 'ready', observedAt: '2026-10-12T00:00:00Z' }],
      start: (request) => {
        const prompt = startPrompt(request, (ref) => ctx.artifacts.get(ref)).prompt
        plans.push(prompt)
        const text = prompt.includes('Plan the software change')
          ? '```json\n' + JSON.stringify({ confidence: 'high', nodes: [
            { id: 'implement', objective: 'Implement', prompt: 'add the flag', capabilities: ['develop', 'local-data'], tier: 'standard' },
            { id: 'review', objective: 'Review', prompt: 'review the flag change', capabilities: ['review', 'local-data'], tier: 'standard', dependsOn: ['implement'] },
          ] }) + '\n```'
          : 'Report: the flag was added; the review found nothing blocking.'
        const result = ctx.artifacts.put({ kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'operator-shared', producer: { type: 'worker', ref: 'chat:a' },
          body: { schema: 'provider-answer@1.0', provider: 'test', account: 'a', turnId: `t-${plans.length}`, conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text } }).id
        const execution: WorkerExecution = { id: `chat-${plans.length}`, status: 'completed', submitted: true, result: result as `sha256:${string}`, decisions: [] }
        executions.set(execution.id, execution)
        return execution
      },
      get: (id) => executions.get(id),
      wait: async (id) => executions.get(id)!,
    })
  return plans
}

describe('ctx.workers source `agents`: agent runtimes as Workers', () => {
  it('describes each configured Worker with the capabilities its probe proves, never plain reason (REQ-WRK-1)', async () => {
    const { ctx } = await boot(new ScriptedAgent({ resume: true }), {
      workers: [worker(), worker({ id: 'writer', sandbox: 'workspace-write' }), worker({ id: 'ghost', runtime: 'missing' })],
    })
    const workers = Object.fromEntries((await ctx.workers.list()).map((w) => [w.worker, w]))
    expect(workers['agent:reviewer']).toMatchObject({ locality: 'local', quotaClass: 'agent-plan', tier: 'standard', state: 'ready', provider: 'scripted' })
    expect(workers['agent:reviewer']!.capabilities.map((c) => [c.capability, c.evidence.kind])).toEqual([
      ['local-data', 'probe'], ['review', 'probe'], ['persistent-conversation', 'probe'],
    ])
    // The runtime cannot enforce workspace-write: that Worker is unavailable, never loosened.
    expect(workers['agent:writer']).toMatchObject({ state: 'unavailable', capabilities: [] })
    expect(workers['agent:ghost']).toMatchObject({ state: 'unavailable', capabilities: [] })
  })

  it('never admits a Worker whose runtime cannot keep the host state unreadable (ADR-0024, REQ-WRK-6)', async () => {
    const { ctx } = await boot(new ScriptedAgent({ readsConfined: false }), { workers: [worker()] })
    expect((await ctx.workers.list())[0]).toMatchObject({ state: 'unavailable', capabilities: [] })
  })

  it('never admits a Worker whose runtime cannot ask the run\'s gate before each tool call (docs/design/approvals.md)', async () => {
    const { ctx } = await boot(new ScriptedAgent({ gatesToolCalls: false }), { workers: [worker()] })
    expect((await ctx.workers.list())[0]).toMatchObject({ state: 'unavailable', capabilities: [] })
  })

  it('checks the proof again before the agent starts: a run admitted while confined never starts once it is not (ADR-0024)', async () => {
    const options = { readsConfined: true }
    const agent = new ScriptedAgent(options)
    const { ctx } = await boot(agent, { workers: [worker()], probeTtlMs: 0 })
    const admitted = await ctx.workers.route(requirement())
    options.readsConfined = false
    const source = ctx.workers.source('agents')!
    const started = source.start({ key: 'k', worker: 'agent:reviewer', prompt: 'review', requirement: requirement(), decisions: admitted.decisions })
    const done = await source.wait(started.id, 10_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'config_error' } })
    expect(agent.runs).toEqual([])
  })

  it('never makes a describe wait for a re-probe: a slow one keeps the Worker routable within probeTtlMs, past it the Worker is unavailable while the source still answers, and a failed one admits nothing (T50)', async () => {
    const options = { readsConfined: true }
    const agent = new SlowProbeAgent(options)
    const { ctx } = await boot(agent, { workers: [worker()], probeTtlMs: 3000 })
    try {
      const started = Date.now()
      const first = await ctx.workers.route(requirement())
      first.release()
      expect(first.worker.worker).toBe('agent:reviewer')
      // Probes are slow from now on. At half its bound the next starts in the background.
      agent.hold = true
      await expect.poll(() => agent.probes, { timeout: 5000, interval: 20 }).toBe(2)
      const during = await ctx.workers.route(requirement())
      during.release()
      expect(Date.now() - started).toBeLessThan(3000)
      expect(during.worker.worker).toBe('agent:reviewer')
      // The source answered within the router's bound: no decision names it, and its last read says so.
      expect((ctx.artifacts.get(during.decisions.route)!.body as { candidates: Array<{ option: string }> }).candidates.map((c) => c.option)).toEqual(['agent:reviewer'])
      expect(ctx.workers.sources!()).toEqual([expect.objectContaining({ source: 'agents', state: 'described', workers: 1 })])
      // Past the bound, the re-probe still running: the Worker is unavailable, at once, never on the old result.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + 3100 - Date.now())))
      const refused = await ctx.workers.route(requirement()).catch((error: unknown) => error) as AdmissionFailure
      expect(refused).toBeInstanceOf(AdmissionFailure)
      expect(refused.rejections).toEqual([expect.objectContaining({ worker: 'agent:reviewer', state: 'unavailable' })])
      expect((ctx.artifacts.get(refused.decision)!.body as { candidates: Array<{ option: string }> }).candidates.map((c) => c.option)).not.toContain('source agents')
      expect(agent.probes).toBe(2)
      // The probe finishes: the Worker is back.
      agent.hold = false
      agent.release()
      await expect.poll(async () => (await ctx.workers.list())[0]?.state, { timeout: 5000, interval: 20 }).toBe('ready')
      // A refresh that proves less (reads no longer confined) admits nothing from then on.
      options.readsConfined = false
      await expect.poll(async () => (await ctx.workers.list())[0], { timeout: 5000, interval: 20 }).toMatchObject({ state: 'unavailable', capabilities: [] })
      expect(ctx.workers.sources!()).toEqual([expect.objectContaining({ source: 'agents', state: 'described' })])
    } finally {
      agent.hold = false
      agent.release()
    }
  }, 30_000)

  it('never waits for a probe that does not settle past probeTtlMs: the next probe starts, and a stop finishes', async () => {
    const agent = new SlowProbeAgent()
    const { ctx, stop } = await boot(agent, { workers: [worker()], probeTtlMs: 1000 })
    try {
      ;(await ctx.workers.route(requirement())).release()
      // The background re-probe at half the bound never settles.
      agent.hold = true
      await expect.poll(() => agent.probes, { timeout: 5000, interval: 20 }).toBe(2)
      // Its bound passed, it is refused as timed out, which the Worker reads.
      await expect.poll(async () => (await ctx.workers.list())[0], { timeout: 5000, interval: 20 }).toMatchObject({ state: 'unavailable' })
      await expect.poll(() => agent.probes, { timeout: 5000, interval: 20 }).toBe(3)
      // A stop waits for the probe in flight no longer than its bound.
      const stopping = Date.now()
      expect(await Promise.race([stop().then(() => 'stopped'), new Promise((resolve) => setTimeout(resolve, 3000, 'hung'))])).toBe('stopped')
      expect(Date.now() - stopping).toBeLessThan(1500)
    } finally {
      agent.hold = false
      agent.release()
    }
  }, 20_000)

  it('proves develop (never review) for a confined writable Worker, and validate only when the runtime can run commands', async () => {
    const config = { workers: [worker({ id: 'writer', sandbox: 'workspace-write' as const })] }
    const without = await boot(new ScriptedAgent({ sandboxes: ['read-only', 'workspace-write'] }), config)
    expect((await without.ctx.workers.list())[0]!.capabilities.map((c) => c.capability)).toEqual(['local-data', 'develop', 'persistent-conversation'])
    const runs = await boot(new ScriptedAgent({ sandboxes: ['read-only', 'workspace-write'], executes: true }), config)
    expect((await runs.ctx.workers.list())[0]!.capabilities.map((c) => c.capability)).toEqual(['local-data', 'develop', 'validate', 'persistent-conversation'])
  })

  it('admits validate work only on a writable Worker whose runtime proved it runs commands confined; a reviewer never takes it (ADR-0038)', async () => {
    const validate = requirement({ objective: 'run the tests and the type check', capabilities: ['validate', 'local-data'] })
    const config = { workers: [worker(), worker({ id: 'writer', sandbox: 'workspace-write' as const })] }
    // The runtime did not prove its commands confined: no Worker proves validate, with the reason.
    const unproven = await boot(new ScriptedAgent({ sandboxes: ['read-only', 'workspace-write'] }), config)
    await expect(unproven.ctx.workers.route(validate)).rejects.toThrow(/no Worker can take this work: no Worker proves validate/)
    // It did: the writable Worker takes it, and the read-only one, though on the same runtime, does not.
    const proven = await boot(new ScriptedAgent({ sandboxes: ['read-only', 'workspace-write'], executes: true }), config)
    const admitted = await proven.ctx.workers.route(validate)
    admitted.release()
    expect(admitted.worker.worker).toBe('agent:writer')
    await expect(proven.ctx.workers.route(validate, { restrict: { workers: ['agent:reviewer'], reason: 'the reviewer only' } })).rejects.toThrow(/no Worker can take this work/)
  })

  it('describes the kinds of work the operator gives a Worker, so each writer takes only its own kind and a reviewer given none takes any (REQ-WRK-11, ADR-0057)', async () => {
    const write = { sandbox: 'workspace-write' as const }
    const config = { workers: [worker(), worker({ id: 'coder', ...write, kinds: ['code'] }), worker({ id: 'documenter', ...write, kinds: ['docs', 'tests'] })] }
    const { ctx } = await boot(new ScriptedAgent({ sandboxes: ['read-only', 'workspace-write'], executes: true }), config)
    const listed = new Map((await ctx.workers.list()).map((d) => [d.worker, d]))
    expect(listed.get('agent:coder')).toMatchObject({ schema: 'capability-descriptor@1.6', kinds: ['code'] })
    expect(listed.get('agent:documenter')).toMatchObject({ schema: 'capability-descriptor@1.6', kinds: ['docs', 'tests'] })
    expect(listed.get('agent:reviewer')!.schema).toBe('capability-descriptor@1.5')
    expect(listed.get('agent:reviewer')).not.toHaveProperty('kinds')
    const kinded = (kind: string | undefined, capabilities: string[]): WorkRequirement => requirement({ ...(kind ? { schema: 'work-requirement@1.2' as const, kind } : {}), capabilities })
    const routed = async (r: WorkRequirement): Promise<string> => {
      const admitted = await ctx.workers.route(r)
      admitted.release()
      return admitted.worker.worker
    }
    expect(await routed(kinded('code', ['develop', 'local-data']))).toBe('agent:coder')
    expect(await routed(kinded('docs', ['develop', 'local-data']))).toBe('agent:documenter')
    expect(await routed(kinded('tests', ['validate', 'local-data']))).toBe('agent:documenter')
    // A review names no kind: the reviewer, given none, takes it; so it would a kinded review.
    expect(await routed(kinded(undefined, ['review', 'local-data']))).toBe('agent:reviewer')
    expect(await routed(kinded('docs', ['review', 'local-data']))).toBe('agent:reviewer')
    // A writing step that names no kind: every writer is given kinds, so none takes it, fail closed.
    await expect(ctx.workers.route(kinded(undefined, ['develop', 'local-data']))).rejects.toThrow(/no Worker that proves develop, local-data takes work that names no kind/)
  })

  it('refuses kinds of work that are malformed or on a review member, at load (ADR-0057)', async () => {
    for (const kinds of [[], ['Docs'], ['docs', 'docs']]) {
      const { ctx } = await boot(new ScriptedAgent(), { workers: [worker({ kinds })] })
      expect(ctx.get('agentWorkers')).toBeUndefined()
    }
    const member = await boot(new ScriptedAgent(), { workers: [worker({ reviewMember: true, family: 'fam-a', kinds: ['code'] })] })
    expect(member.ctx.get('agentWorkers')).toBeUndefined()
  })

  it('runs work once with the policy from configuration, and stores the result as agent-result@1.1 (REQ-WRK-6, INV-6)', async () => {
    const agent = new ScriptedAgent()
    const { ctx } = await boot(agent)
    const admitted = await ctx.workers.route(requirement())
    expect(admitted).toMatchObject({ source: 'agents', worker: { worker: 'agent:reviewer' } })
    const source = ctx.workers.source('agents')!
    const start = { key: 'k-1', worker: 'agent:reviewer', prompt: 'look at it', requirement: requirement(), decisions: admitted.decisions }
    const started = source.start(start)
    expect(source.start(start).id).toBe(started.id)
    const done = await source.wait(started.id, 10_000)
    expect(done).toMatchObject({ status: 'completed', submitted: true })
    // Every run carries its gate, asked before each tool call (./gate.spec.ts).
    expect(agent.runs).toEqual([{ prompt: 'look at it', workspace: WORKSPACE, sandbox: 'read-only', tools: ['Read', 'Grep'], model: 'model-x', toolGate: expect.any(Function) }])
    const result = ctx.artifacts.get(done.result!)!
    expect(result).toMatchObject({ kind: 'report', bodySchema: 'agent-result@1.1', classification: 'operator-shared' })
    expect(result.body).toMatchObject({ worker: 'agent:reviewer', runtime: 'scripted', sandbox: 'read-only', workspace: WORKSPACE, text: 'echo: look at it', nativeHandle: 'h-1' })
    expect(result.body).not.toHaveProperty('subject') // not a git repository
  })

  it('checks the prompt at egress before the agent starts: its model is remote, so a credential or local-private data never leaves (INV-12)', async () => {
    const agent = new ScriptedAgent()
    const { ctx } = await boot(agent)
    const source = ctx.workers.source('agents')!
    const shared = requirement()
    const admitted = await ctx.workers.route(shared)
    // Generated at run time: never a real secret in the repository.
    const secret = String(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }))
    const leaked = await source.wait(source.start({ key: 'k-secret', worker: 'agent:reviewer', prompt: `debug this: ${secret}`, requirement: shared, decisions: admitted.decisions }).id, 10_000)
    expect(leaked).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'egress_denied' } })
    // The egress decision is part of the run's decision chain (INV-13), as for website turns.
    expect(leaked.decisions).toHaveLength(1)
    expect(ctx.artifacts.get(leaked.decisions[0]!)!.body).toMatchObject({ outcome: { option: 'deny' } })
    const local = requirement({ data: { classification: 'local-private', refs: [] } })
    const privateRun = await source.wait(source.start({ key: 'k-private', worker: 'agent:reviewer', prompt: 'read the notes', requirement: local, decisions: (await ctx.workers.route(local)).decisions }).id, 10_000)
    expect(privateRun).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'egress_denied' } })
    expect(agent.runs).toEqual([])
    const fine = await source.wait(source.start({ key: 'k-fine', worker: 'agent:reviewer', prompt: 'look at it', requirement: shared, decisions: admitted.decisions }).id, 10_000)
    expect(fine.status).toBe('completed')
    expect(ctx.artifacts.get(fine.decisions[0]!)!.body).toMatchObject({ outcome: { option: 'allow' } })
  })

  it('treats an omitted or empty tool list as the runtime\'s minimal set, never as no tools (live 2026-10-12)', async () => {
    const agent = new ScriptedAgent()
    const { ctx } = await boot(agent, { workers: [worker({ tools: [] })] })
    const admitted = await ctx.workers.route(requirement())
    const source = ctx.workers.source('agents')!
    await source.wait(source.start({ key: 'k', worker: 'agent:reviewer', prompt: 'x', requirement: requirement(), decisions: admitted.decisions }).id, 10_000)
    expect(agent.runs[0]).not.toHaveProperty('tools')
  })

  it('stops a run that outlives its deadline, and reports a timeout', async () => {
    const { ctx } = await boot(new ScriptedAgent({ holdMs: 30_000 }), { workers: [worker()], runTimeoutMs: 300 })
    const admitted = await ctx.workers.route(requirement())
    const source = ctx.workers.source('agents')!
    const done = await source.wait(source.start({ key: 'k', worker: 'agent:reviewer', prompt: 'x', requirement: requirement(), decisions: admitted.decisions }).id, 10_000)
    expect(done).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'timeout' } })
  })

  it('runs one thing at a time per Worker: a second run waits for the first (one writer per workspace, INV-15)', async () => {
    const agent = new ScriptedAgent({ sandboxes: ['read-only', 'workspace-write'], holdMs: 600 })
    const { ctx } = await boot(agent, { workers: [worker({ id: 'dev', sandbox: 'workspace-write', tools: [] })] })
    const admitted = await ctx.workers.route(requirement({ capabilities: ['develop'] }))
    const source = ctx.workers.source('agents')!
    const start = (key: string) => source.start({ key, worker: 'agent:dev', prompt: key, requirement: requirement({ capabilities: ['develop'] }), decisions: admitted.decisions })
    const one = start('one')
    const two = start('two')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(agent.runs.map((r) => r.prompt)).toEqual(['one'])
    expect(source.get(two.id)).toMatchObject({ status: 'queued', submitted: false })
    await source.wait(one.id, 10_000)
    expect((await source.wait(two.id, 10_000)).status).toBe('completed')
    expect(agent.runs.map((r) => r.prompt)).toEqual(['one', 'two'])
  })

  it('cancels a running run, and a queued one never starts (REQ-WRK-4)', async () => {
    const agent = new ScriptedAgent({ holdMs: 30_000 })
    const { ctx } = await boot(agent)
    const admitted = await ctx.workers.route(requirement())
    const source = ctx.workers.source('agents')!
    const start = (key: string) => source.start({ key, worker: 'agent:reviewer', prompt: key, requirement: requirement(), decisions: admitted.decisions })
    const running = start('running')
    const queued = start('queued')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(source.cancel!(queued.id)).toBe(true)
    expect(source.cancel!(running.id)).toBe(true)
    expect(await source.wait(running.id, 10_000)).toMatchObject({ status: 'failed', error: { kind: 'aborted' } })
    expect(await source.wait(queued.id, 10_000)).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'aborted' } })
    expect(agent.runs.map((r) => r.prompt)).toEqual(['running'])
    expect(source.cancel!(running.id)).toBe(false)
  })

  it('reports a failed run with its kind, after it was submitted', async () => {
    const { ctx } = await boot(new ScriptedAgent({ fail: new ProviderError('timeout', 'max turns') }))
    const admitted = await ctx.workers.route(requirement())
    const source = ctx.workers.source('agents')!
    const done = await source.wait(source.start({ key: 'k', worker: 'agent:reviewer', prompt: 'x', requirement: requirement(), decisions: admitted.decisions }).id, 10_000)
    expect(done).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'timeout', disposition: 'BACKOFF' } })
  })

  it('continues a session by its native handle, and keeps the session on its Worker', async () => {
    const agent = new ScriptedAgent({ resume: true })
    const { ctx } = await boot(agent)
    const admitted = await ctx.workers.route(requirement({ capabilities: ['review', 'persistent-conversation'] }))
    const source = ctx.workers.source('agents')!
    const start = (key: string) => source.start({ key, worker: 'agent:reviewer', prompt: key, sessionId: 'ses_agent', requirement: requirement(), decisions: admitted.decisions })
    await source.wait(start('one').id, 10_000)
    await source.wait(start('two').id, 10_000)
    expect(agent.runs.map((r) => r.resume)).toEqual([undefined, 'h-1'])
    expect(ctx.workers.affinity('ses_agent')).toEqual(['agent:reviewer'])
  })

  it('writes nothing for a run whose lease was taken during its egress check, and starts nothing (INV-4)', async () => {
    const agent = new ScriptedAgent()
    const { ctx } = await boot(agent)
    const admitted = await ctx.workers.route(requirement())
    const source = ctx.workers.source('agents')!
    let id: string | undefined
    const egress = ctx.egress as unknown as { check: (input: unknown) => Promise<unknown> }
    const check = egress.check.bind(egress)
    egress.check = async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      // Another process took the run meanwhile.
      if (id) ctx.leases.invalidate(`agent-run:${id}`)
      return check(input)
    }
    id = source.start({ key: 'k-taken', worker: 'agent:reviewer', prompt: 'x', requirement: requirement(), decisions: admitted.decisions }).id
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(ctx.store.db.prepare('SELECT egress_decision, status FROM agent_runs WHERE run_id = ?').get(id)).toEqual({ egress_decision: null, status: 'queued' })
    expect(agent.runs).toEqual([])
  })

  it('runs a queued run once a crashed process\'s lease on it expires, instead of stranding it until the next start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agents-'))
    const first = await boot(new ScriptedAgent({ holdMs: 30_000 }), undefined, dir)
    const admitted = await first.ctx.workers.route(requirement())
    const source = first.ctx.workers.source('agents')!
    source.start({ key: 'k-1', worker: 'agent:reviewer', prompt: 'long', requirement: requirement(), decisions: admitted.decisions })
    const queued = source.start({ key: 'k-2', worker: 'agent:reviewer', prompt: 'next', requirement: requirement(), decisions: admitted.decisions })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await first.stop()
    // A crash: the dead process still holds the queued run's lease for a few seconds.
    const db = new DatabaseSync(join(dir, 'system.db'))
    db.prepare("INSERT OR REPLACE INTO leases (resource, owner, token, generation, expires_at) VALUES (?, 'dead:1:x', 'dead', 7, ?)").run(`agent-run:${queued.id}`, Date.now() + 3000)
    db.close()
    const again = new ScriptedAgent()
    const second = await boot(again, undefined, dir)
    expect(await second.ctx.workers.source('agents')!.wait(queued.id, 15_000)).toMatchObject({ status: 'completed', submitted: true })
    expect(again.runs.map((r) => r.prompt)).toEqual(['next'])
  }, 60_000)

  it('never runs a started run again after a restart: it fails for the operator to inspect (INV-4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agents-'))
    // The agent's process is reported, and ends with the stop: the verdict can find it gone (PROP-0013).
    const first = await boot(new ScriptedAgent({ holdMs: 30_000, process: true }), undefined, dir)
    const admitted = await first.ctx.workers.route(requirement())
    const source = first.ctx.workers.source('agents')!
    const started = source.start({ key: 'k', worker: 'agent:reviewer', prompt: 'long', requirement: requirement(), decisions: admitted.decisions })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await first.stop()
    const again = new ScriptedAgent()
    const second = await boot(again, { workers: [worker()], deadAfterSeconds: 1 }, dir)
    const done = await second.ctx.workers.source('agents')!.wait(started.id, 10_000)
    expect(done).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'reconciliation_failed', disposition: 'USER_ACTION' } })
    expect(done.error!.message).toContain('h-1')
    expect(again.runs).toEqual([])
  })

  it('runs the software-development profile: plan, approval, a writable agent implements, a fresh session reviews, a report', async () => {
    const agent = new ScriptedAgent({ sandboxes: ['read-only', 'workspace-write'] })
    const { ctx } = await boot(agent, { workers: [worker({ id: 'dev', sandbox: 'workspace-write', tools: [] }), worker({ id: 'reviewer' })] })
    const plans = chatWorker(ctx)
    const run = ctx.workflow.start({ template: 'develop', input: 'Add a --dry-run flag' })
    const deadline = Date.now() + 10_000
    while (!ctx.workflow.get(run.runId)?.blocked) {
      if (Date.now() > deadline) throw new Error(`never blocked: ${JSON.stringify(ctx.workflow.get(run.runId))}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(agent.runs).toEqual([])
    ctx.workflow.approve(run.runId, { verdict: 'approved' })
    const done = await ctx.workflow.wait(run.runId, 10_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'Report: the flag was added; the review found nothing blocking.' })
    const byId = Object.fromEntries(done.nodes.map((n) => [n.nodeId, n]))
    expect(byId['plan:1:implement']).toMatchObject({ state: 'COMPLETED', worker: 'agent:dev' })
    expect(byId['plan:1:review']!.state).toBe('COMPLETED')
    // The implementation ran with a writable sandbox; the review ran in a fresh session (no resume).
    expect(agent.runs.map((r) => [r.prompt, r.sandbox, r.resume])).toEqual([['add the flag', 'workspace-write', undefined], ['review the flag change', expect.any(String), undefined]])
    expect(plans.at(-1)).toContain('echo: add the flag')
  }, 60_000)

  // Real git repositories and several review cycles: slower than the 5 s default on CI runners.
  describe('exact-head review (REQ-TEAM-5, REQ-WF-5)', { timeout: 60_000 }, () => {
    const gitRepo = (): string => {
      const dir = mkdtempSync(join(tmpdir(), 'system-review-ws-'))
      onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
      const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { stdio: 'ignore' })
      git('init', '-q')
      writeFileSync(join(dir, 'calc.py'), 'def add(a, b):\n    return a - b\n')
      git('add', '.')
      git('commit', '-q', '-m', 'init')
      return dir
    }
    /** The developer fixes calc.py; the reviewer answers with an assessment naming `subjectOf(prompt)`. */
    const develop = async (review: (prompt: string, workspace: string) => string) => {
      const ws = gitRepo()
      const agent = new ScriptedAgent({
        sandboxes: ['read-only', 'workspace-write'],
        act: (spec) => {
          if (spec.sandbox === 'workspace-write') {
            // A remediation step adds a test for what the review asked; the first step fixes add().
            if (spec.prompt.includes('Fix the blocking findings')) writeFileSync(join(ws, `test_${agent.runs.length}.py`), 'assert True\n')
            else writeFileSync(join(ws, 'calc.py'), 'def add(a, b):\n    return a + b\n')
            return 'done'
          }
          return review(spec.prompt, ws)
        },
      })
      const { ctx } = await boot(agent, { workers: [worker({ id: 'dev', sandbox: 'workspace-write', workspace: ws, tools: [] }), worker({ id: 'reviewer', workspace: ws })] })
      chatWorker(ctx)
      const run = ctx.workflow.start({ template: 'develop', input: 'Fix add()' })
      // The operator approves the plan, then each remediation fix: every writing step waits for one (ADR-0028).
      const approvals: string[] = []
      const deadline = Date.now() + 60_000
      for (;;) {
        const view = ctx.workflow.get(run.runId)
        if (view && view.status !== 'running') break
        if (Date.now() > deadline) throw new Error('never finished')
        if (view?.blocked?.kind === 'gate') {
          approvals.push(view.blocked.nodeId)
          ctx.workflow.approve(run.runId, { verdict: 'approved', plan: view.blocked.plan })
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return { ctx, agent, approvals, done: await ctx.workflow.wait(run.runId, 60_000) }
    }
    const subjectOf = (prompt: string): string => /^Subject: (\S+)$/m.exec(prompt)![1]!
    const assessment = (subject: string) => '```json\n' + JSON.stringify({ subject, verdict: 'approve', findings: [{ severity: 'info', title: 'add() now adds' }] }) + '\n```'
    const changes = (subject: string) => '```json\n' + JSON.stringify({ subject, verdict: 'changes-requested', findings: [{ severity: 'blocking', title: 'no test for add()', file: 'calc.py' }] }) + '\n```'

    it('remediates blocking findings: a fix, then a review of the new subject; the report waits for both', async () => {
      let reviews = 0
      const { ctx, agent, approvals, done } = await develop((prompt) => (++reviews === 1 ? changes(subjectOf(prompt)) : assessment(subjectOf(prompt))))
      expect(done.status).toBe('completed')
      // The fix wrote only after the operator approved its exact plan (ADR-0028, INV-15).
      expect(approvals).toEqual(['plan:1:gate', 'plan:1:review:approve:1'])
      const byId = Object.fromEntries(done.nodes.map((n) => [n.nodeId, n]))
      expect(byId['plan:1:review:approve:1']).toMatchObject({ state: 'COMPLETED' })
      expect(byId['plan:1:review:fix:1']).toMatchObject({ state: 'COMPLETED', worker: 'agent:dev' })
      expect(byId['plan:1:review:review:2']).toMatchObject({ state: 'COMPLETED', worker: 'agent:reviewer' })
      expect(agent.runs.find((r) => r.prompt.includes('Fix the blocking findings'))!.prompt).toContain('- no test for add() (calc.py)')
      // Each review bound to its own subject: the fix changed the tree.
      const subjects = agent.runs.filter((r) => r.sandbox === 'read-only').map((r) => subjectOf(r.prompt))
      expect(subjects).toHaveLength(2)
      expect(subjects[0]).not.toBe(subjects[1])
      expect(ctx.artifacts.list({ kind: 'assessment' }).map((a) => (a.body as { verdict: string }).verdict).sort()).toEqual(['approve', 'changes-requested'])
      expect(done.nodes.at(-1)!.nodeId).toBe('report:1')
    })

    it('retires a later remediation cycle with the review that grew it when an earlier fix is superseded, and grows it again under new ids (INV-15)', async () => {
      let reviews = 0
      // Reviews 1 and 2 ask for changes, 3 approves; after the supersede, review 2 runs again (4) and asks once more, and 5 approves.
      const { ctx, done } = await develop((prompt) => ([1, 2, 4].includes(++reviews) ? changes(subjectOf(prompt)) : assessment(subjectOf(prompt))))
      expect(done.status).toBe('completed')
      await ctx.workflow.supersede(done.runId, 'plan:1:review:fix:1', { text: 'fixed by hand', note: 'operator fix' })
      const deadline = Date.now() + 60_000
      for (;;) {
        const view = ctx.workflow.get(done.runId)
        if (view && view.status !== 'running') break
        if (Date.now() > deadline) throw new Error('never finished')
        if (view?.blocked?.kind === 'gate') ctx.workflow.approve(done.runId, { verdict: 'approved', plan: view.blocked.plan })
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const again = await ctx.workflow.wait(done.runId, 60_000)
      expect(again.status).toBe('completed')
      const states = Object.fromEntries(ctx.workflow.records(done.runId).map((r) => [r.nodeId, r.state]))
      // What review 2 grew before is history; its new growth carries its new generation.
      expect(states).toMatchObject({ 'plan:1:review:fix:2': 'RETIRED', 'plan:1:review:review:3': 'RETIRED', 'plan:1:review:approve:2': 'RETIRED' })
      expect(states).toMatchObject({ 'plan:1:review:r2:approve:2': 'COMPLETED', 'plan:1:review:r2:fix:2': 'COMPLETED', 'plan:1:review:r2:review:3': 'COMPLETED' })
    })

    it('stops remediating at the review cycle bound, and says so (QA-8)', async () => {
      const { ctx, done } = await develop((prompt) => changes(subjectOf(prompt)))
      expect(done.status).toBe('completed')
      expect(done.nodes.map((n) => n.nodeId).filter((id) => id.includes(':review'))).toEqual([
        'plan:1:review', 'plan:1:review:approve:1', 'plan:1:review:fix:1', 'plan:1:review:review:2', 'plan:1:review:approve:2', 'plan:1:review:fix:2', 'plan:1:review:review:3',
      ])
      const growth = ctx.artifacts.list({ kind: 'decision' }).map((a) => a.body as { decisionType: string; decider: { id: string }; outcome: { option: string } })
        .filter((d) => d.decider.id === 'workflow.remediation').map((d) => d.outcome.option)
      expect(growth).toEqual(['append', 'append', 'refuse'])
    })

    it('gives the reviewer the exact change and binds its assessment to that subject', async () => {
      const { ctx, agent, done } = await develop((prompt) => assessment(subjectOf(prompt)))
      expect(done.status).toBe('completed')
      const prompt = agent.runs[1]!.prompt
      expect(prompt).toMatch(/^Subject: git:[0-9a-f]{40}:[0-9a-f]{64}$/m)
      expect(prompt).toContain('+    return a + b')
      expect(prompt).toContain('Requested change: Fix add()')
      const [stored] = ctx.artifacts.list({ kind: 'assessment' })
      expect(stored).toMatchObject({ bodySchema: 'assessment@1.0', subject: { type: 'git-head' } })
      expect(stored!.body).toMatchObject({ verdict: 'approve', reviewer: 'agent:reviewer', findings: [{ severity: 'info' }] })
      expect(`git:${(stored!.body as { subject: { ref: string; version: string } }).subject.ref}:${(stored!.body as { subject: { version: string } }).subject.version}`).toBe(subjectOf(prompt))
    })

    it('fails the gate when the review names another subject (INV-5)', async () => {
      const { done } = await develop(() => assessment('git:0000000000000000000000000000000000000000:old'))
      expect(done).toMatchObject({ status: 'failed', error: { kind: 'stale_subject' } })
      expect(done.error!.message).toMatch(/not the subject it was given/)
    })

    it('fails the gate when the working tree changes during the review (INV-5)', async () => {
      const { done } = await develop((prompt, ws) => {
        writeFileSync(join(ws, 'calc.py'), 'def add(a, b):\n    return b + a\n')
        return assessment(subjectOf(prompt))
      })
      expect(done).toMatchObject({ status: 'failed', error: { kind: 'stale_subject' } })
      expect(done.error!.message).toMatch(/changed during the review/)
    })
  })

  it('routes an agent-review run to the local agent by capability, end to end through the engine', async () => {
    const agent = new ScriptedAgent()
    const { ctx } = await boot(agent)
    const run = await ctx.workflow.wait(ctx.workflow.start({ template: 'agent-review', input: 'Check the diff', classification: 'operator-shared' }).runId, 10_000)
    expect(run).toMatchObject({ status: 'completed', answer: 'echo: Check the diff', nodes: [{ nodeId: 'review:1', source: 'agents', worker: 'agent:reviewer', quotaClass: 'agent-plan' }] })
  })
})

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

describe('agents source: a run is gone only on a liveness verdict (PROP-0013, ADR-0056)', () => {
  /** Start a run in `session` on a first boot, stop that boot while the agent runs, and return what a restart needs. */
  const started = async (agent: ScriptedAgent, session = 'ses_live') => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agents-'))
    const first = await boot(agent, undefined, dir)
    const admitted = await first.ctx.workers.route(requirement())
    const execution = first.ctx.workers.source('agents')!.start({ key: 'k', worker: 'agent:reviewer', prompt: 'long', sessionId: session, requirement: requirement(), decisions: admitted.decisions })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await first.stop()
    return { dir, id: execution.id, session }
  }
  const restart = async (dir: string, config: Partial<Config> = {}) => {
    const again = new ScriptedAgent()
    const booted = await boot(again, { workers: [worker()], deadAfterSeconds: 1, ...config }, dir)
    return { ...booted, again }
  }
  const decisionOf = (ctx: Context, done: WorkerExecution) => done.decisions.map((d) => ctx.artifacts.get(d)!.body as { decisionType: string; decider: { id: string; version: string }; outcome: { option: string; detail: Record<string, unknown> }; candidates: Array<{ option: string; reasons: string[] }> })
    .find((d) => d.decisionType === 'reconciliation')

  it('records the holder and the agent process of a run, and reconciles it as dead only when both are gone and it has been quiet long enough (REQ-WRK-16, INV-4)', async () => {
    const agent = new ScriptedAgent({ holdMs: 30_000, process: true })
    const { dir, id, session } = await started(agent)
    const db = new DatabaseSync(join(dir, 'system.db'))
    const row = db.prepare('SELECT holder, agent_process, activity_at, submitted_at FROM agent_runs WHERE run_id = ?').get(id) as Record<string, string>
    db.close()
    expect(JSON.parse(row.holder!)).toMatchObject({ pid: process.pid })
    expect(JSON.parse(row.agent_process!)).toMatchObject({ pid: agent.processes[0] })
    expect(row.activity_at).toBe(row.submitted_at)
    const { ctx, again, stop } = await restart(dir)
    const done = await ctx.workers.source('agents')!.wait(id, 10_000)
    expect(done).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'reconciliation_failed', disposition: 'USER_ACTION', message: expect.stringContaining('it is gone (liveness dead') } })
    expect(again.runs).toEqual([])
    const decision = decisionOf(ctx, done)!
    expect(decision).toMatchObject({ decider: { id: 'agent-workers.reconcile', version: '2' }, outcome: { option: 'dead', detail: { verdict: 'dead', rule: 'liveness@1', looks: 1, deadAfterSeconds: 1 } } })
    expect(decision.candidates[0]!.reasons).toEqual([
      expect.stringContaining('the holder\'s lease: lapsed'), 'the holder\'s process: gone (it is this process, which runs no agent of this run now)',
      `the agent process: gone (no process ${agent.processes[0]} exists)`, expect.stringMatching(/^activity: the latest \d+ s ago$/),
    ])
    // Dead, so its session is free for the next run.
    expect(await ctx.workers.held!(session)).toBeUndefined()
    await stop()
  }, 30_000)

  // The failure mode PROP-0013 found: a run whose liveness could not be shown was failed at restart as if it were gone.
  it('never takes a failed probe for death: a run whose agent process was never reported is looked at again, not failed, then goes to the operator with its session held (REQ-WRK-16, INV-15)', async () => {
    const { dir, id, session } = await started(new ScriptedAgent({ holdMs: 30_000 }))
    const second = await restart(dir)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const look = second.ctx.store.db.prepare('SELECT status, liveness_looks, liveness_verdict, liveness_decision FROM agent_runs WHERE run_id = ?').get(id)
    expect(look).toEqual({ status: 'running', liveness_looks: 1, liveness_verdict: 'unknown', liveness_decision: null })
    expect(await second.ctx.workers.held!(session)).toContain('has not finished (running)')
    await second.stop()
    // The bound reached: to the operator, never declared dead.
    const third = await restart(dir, { maxUnknownVerdicts: 2 })
    const done = await third.ctx.workers.source('agents')!.wait(id, 10_000)
    expect(done).toMatchObject({ status: 'failed', error: { kind: 'reconciliation_failed', disposition: 'USER_ACTION', message: expect.stringContaining('it is not declared dead, so its session stays held') } })
    const decision = decisionOf(third.ctx, done)!
    expect(decision).toMatchObject({ outcome: { option: 'operator', detail: { verdict: 'unknown', looks: 2 } } })
    expect(decision.candidates[0]!.reasons).toContain('the agent process: unknown (never reported)')
    const heldWhy = new RegExp(`^its run ${id} ended without being known to be gone \\(liveness unknown, decision sha256:`)
    expect(await third.ctx.workers.held!(session)).toMatch(heldWhy)
    // The source itself never drives that session again, whoever asks (INV-15), and a refused later run frees nothing.
    const admitted = await third.ctx.workers.route(requirement())
    const later = third.ctx.workers.source('agents')!.start({ key: 'k-later', worker: 'agent:reviewer', prompt: 'next', sessionId: session, requirement: requirement(), decisions: admitted.decisions })
    expect(await third.ctx.workers.source('agents')!.wait(later.id, 10_000)).toMatchObject({
      status: 'failed', submitted: false, error: { kind: 'config_error', message: expect.stringContaining(`run ${id} of session ${session} ended without being known to be gone`) },
    })
    expect(await third.ctx.workers.held!(session)).toMatch(heldWhy)
    expect([second.again.runs, third.again.runs]).toEqual([[], []])
    await third.stop()
  }, 30_000)

  it('takes a holder recorded on another host as unknown, never gone, though its agent process is gone (REQ-WRK-16)', async () => {
    const { dir, id } = await started(new ScriptedAgent({ holdMs: 30_000, process: true }))
    const db = new DatabaseSync(join(dir, 'system.db'))
    const holder = JSON.parse((db.prepare('SELECT holder FROM agent_runs WHERE run_id = ?').get(id) as { holder: string }).holder) as Record<string, unknown>
    db.prepare('UPDATE agent_runs SET holder = ? WHERE run_id = ?').run(JSON.stringify({ ...holder, host: 'another-host' }), id)
    db.close()
    const { ctx, stop } = await restart(dir, { maxUnknownVerdicts: 1 })
    const done = await ctx.workers.source('agents')!.wait(id, 10_000)
    expect(decisionOf(ctx, done)).toMatchObject({ outcome: { option: 'operator', detail: { verdict: 'unknown' } } })
    expect(decisionOf(ctx, done)!.candidates[0]!.reasons).toContain('the holder\'s process: unknown (it ran on another host (another-host))')
    await stop()
  }, 30_000)

  it('reports a running agent stalled once per stall, while its process is present and it is quiet, and never stops it', async () => {
    const quiet = new ScriptedAgent({ holdMs: 3500, process: true })
    const { ctx } = await boot(quiet, { workers: [worker()], stallSeconds: 1 })
    const admitted = await ctx.workers.route(requirement())
    const source = ctx.workers.source('agents')!
    const run = source.start({ key: 'quiet', worker: 'agent:reviewer', prompt: 'quiet', sessionId: 'ses_q', requirement: requirement(), decisions: admitted.decisions })
    expect(await source.wait(run.id, 10_000)).toMatchObject({ status: 'completed' })
    const stalls = ctx.eventLog.query({ type: 'agent-workers.run.stalled' })
    expect(stalls).toHaveLength(1)
    expect(stalls[0]).toMatchObject({ sessionId: 'ses_q', data: { agentRun: run.id, worker: 'agent:reviewer', stallSeconds: 1, rule: 'liveness@1' } })
    // An agent that keeps showing activity, or one whose process is not known, is never reported stalled.
    for (const agent of [new ScriptedAgent({ holdMs: 2500, process: true, activityEveryMs: 200 }), new ScriptedAgent({ holdMs: 2500 })]) {
      const other = await boot(agent, { workers: [worker()], stallSeconds: 1 })
      const id = other.ctx.workers.source('agents')!.start({ key: 'busy', worker: 'agent:reviewer', prompt: 'busy', requirement: requirement(), decisions: admitted.decisions }).id
      expect(await other.ctx.workers.source('agents')!.wait(id, 10_000)).toMatchObject({ status: 'completed' })
      expect(other.ctx.eventLog.query({ type: 'agent-workers.run.stalled' })).toEqual([])
    }
  }, 30_000)

  /** Wait until a restarted source has taken `looks` verdicts on a run. */
  const looked = async (ctx: Context, id: string, looks: number): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      if ((ctx.store.db.prepare('SELECT liveness_looks FROM agent_runs WHERE run_id = ?').get(id) as { liveness_looks: number }).liveness_looks >= looks) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`run ${id} got fewer than ${looks} verdicts`)
  }

  it('tells the runs whose liveness needs a look: being looked at, then unknown with its verdict, reasons, what it holds, and what to do (PROP-0013, REQ-WRK-16)', async () => {
    const { dir, id, session } = await started(new ScriptedAgent({ holdMs: 30_000 }))
    const second = await restart(dir)
    await looked(second.ctx, id, 1)
    const looking = await second.ctx.workers.liveness!()
    expect(looking).toMatchObject({ counts: { unknown: 0, looking: 1, stalled: 0 }, unread: [] })
    expect(looking.runs).toEqual([expect.objectContaining({
      source: 'agents', execution: id, worker: 'agent:reviewer', state: 'looking', verdict: 'unknown (liveness@1)', looks: { taken: 1, max: 3 }, holds: [`session ${session}`],
      reasons: expect.arrayContaining(['the agent process: unknown (never reported)']), action: expect.stringContaining('looked at again (1 of 3 verdicts)'),
    })])
    await second.stop()
    const third = await restart(dir, { maxUnknownVerdicts: 2 })
    const done = await third.ctx.workers.source('agents')!.wait(id, 10_000)
    const told = await third.ctx.workers.liveness!()
    expect(told.counts).toEqual({ unknown: 1, looking: 0, stalled: 0 })
    expect(told.runs).toEqual([expect.objectContaining({
      execution: id, state: 'unknown', verdict: 'unknown (liveness@1)', looks: { taken: 2, max: 2 }, decision: done.decisions.find((d) => (third.ctx.artifacts.get(d)!.body as { decisionType: string }).decisionType === 'reconciliation'),
      holds: [`session ${session}`], action: expect.stringContaining(`system free ${id} --agent-gone`),
    })])
    // The reasons are the decision's signals, never its "not dead" preamble.
    expect(told.runs[0]!.reasons).toContain('the agent process: unknown (never reported)')
    expect(told.runs[0]!.reasons.some((r) => r.startsWith('not dead'))).toBe(false)
    expect(third.ctx.eventLog.query({ type: 'agent-workers.run.unknown' })).toEqual([expect.objectContaining({
      sessionId: session, decision: told.runs[0]!.decision, data: { agentRun: id, worker: 'agent:reviewer', verdict: 'unknown', looks: 2, cause: 'holder', rule: 'liveness@1' },
    })])
    // Asked for one execution, or a workflow run it does not serve.
    expect((await third.ctx.workers.liveness!({ execution: id })).runs).toHaveLength(1)
    expect(await third.ctx.workers.liveness!({ runId: 'run_other' })).toMatchObject({ runs: [], counts: { unknown: 0, looking: 0, stalled: 0 } })
    await third.stop()
  }, 30_000)

  it('tells a running agent that is stalled, with what stops it', async () => {
    const quiet = new ScriptedAgent({ holdMs: 4000, process: true })
    const { ctx } = await boot(quiet, { workers: [worker()], stallSeconds: 1 })
    const admitted = await ctx.workers.route(requirement())
    const run = ctx.workers.source('agents')!.start({ key: 'quiet', worker: 'agent:reviewer', prompt: 'quiet', sessionId: 'ses_q', requirement: requirement(), decisions: admitted.decisions })
    for (let i = 0; i < 100 && !ctx.eventLog.query({ type: 'agent-workers.run.stalled' }).length; i++) await new Promise((resolve) => setTimeout(resolve, 50))
    const told = await ctx.workers.liveness!()
    expect(told.counts).toEqual({ unknown: 0, looking: 0, stalled: 1 })
    expect(told.runs[0]).toMatchObject({ execution: run.id, state: 'stalled', holds: ['session ses_q'], action: expect.stringContaining('its own deadline'), reasons: expect.arrayContaining(['the agent process: present']) })
    expect(await ctx.workers.source('agents')!.wait(run.id, 10_000)).toMatchObject({ status: 'completed' })
    expect((await ctx.workers.liveness!()).runs).toEqual([])
  }, 30_000)

  it('frees a session held by a run that ended unknown only on the operator\'s word that its agent is gone, recorded first as their decision, and refuses while its agent process is present (INV-13, INV-15, INV-2)', async () => {
    const { dir, id, session } = await started(new ScriptedAgent({ holdMs: 30_000 }))
    const { ctx, again } = await restart(dir, { maxUnknownVerdicts: 1 })
    const done = await ctx.workers.source('agents')!.wait(id, 10_000)
    expect(done.status).toBe('failed')
    expect(await ctx.workers.held!(session)).toContain(`system free ${id} --agent-gone`)
    // Never without the operator's word.
    await expect(ctx.agentWorkers.free({ agentRun: id, agentGone: false })).rejects.toThrow(/your word that its agent is gone/)
    // An agent process present on this host is not gone, whatever the operator saw.
    ctx.store.db.prepare('UPDATE agent_runs SET agent_process = ? WHERE run_id = ?').run(JSON.stringify(processIdentity(process.pid)), id)
    await expect(ctx.agentWorkers.free({ agentRun: id, agentGone: true })).rejects.toThrow(/agent process is present on this host/)
    ctx.store.db.prepare('UPDATE agent_runs SET agent_process = NULL WHERE run_id = ?').run(id)
    const reconciliations = () => ctx.artifacts.list({ kind: 'decision', decisionType: 'reconciliation' }).length
    expect(reconciliations()).toBe(1)
    const freed = await ctx.agentWorkers.free({ agentRun: id, agentGone: true, note: 'the host restarted; no agent of it runs' })
    expect(freed).toMatchObject({ agentRun: id, worker: 'agent:reviewer', again: false, freed: [`session ${session}`], worktrees: [] })
    const decision = ctx.artifacts.get(freed.decision)!.body as Record<string, unknown>
    new SchemaRegistry().assertRecord(decision as { schema: string })
    expect(decision).toMatchObject({
      decisionType: 'reconciliation', decider: { type: 'operator', id: 'operator.free', version: '1' }, deterministic: false, rationale: 'the host restarted; no agent of it runs',
      outcome: { option: 'free', detail: { agentRun: id, sessionId: session, verdict: 'unknown', again: false, worktrees: [] } },
    })
    expect((decision.candidates as Array<{ reasons: string[] }>)[0]!.reasons).toEqual([
      'the operator confirms its agent is gone: the host restarted; no agent of it runs', expect.stringMatching(/^it ended without being known to be gone \(liveness unknown, decision sha256:/),
      'as this host shows them now: the holder\'s process gone (it is this process, which runs no agent of this run now); the agent process unknown (never reported)',
    ])
    expect(ctx.eventLog.query({ type: 'agent-workers.run.freed' })).toEqual([expect.objectContaining({ sessionId: session, decision: freed.decision, data: { agentRun: id, worker: 'agent:reviewer', again: false, worktrees: 0 } })])
    expect(ctx.workers.source('agents')!.get(id)!.decisions).toContain(freed.decision)
    // Free: nothing holds the session, nothing is listed, and its next run runs.
    expect(await ctx.workers.held!(session)).toBeUndefined()
    expect((await ctx.workers.liveness!()).counts.unknown).toBe(0)
    const admitted = await ctx.workers.route(requirement())
    const later = ctx.workers.source('agents')!.start({ key: 'k-later', worker: 'agent:reviewer', prompt: 'next', sessionId: session, requirement: requirement(), decisions: admitted.decisions })
    expect(await ctx.workers.source('agents')!.wait(later.id, 10_000)).toMatchObject({ status: 'completed' })
    expect(again.runs).toHaveLength(1)
    // Freed again: only for a worktree, and it has none, so nothing is decided; a run that holds nothing is refused.
    const decided = ctx.artifacts.list({ kind: 'decision', decisionType: 'reconciliation' }).length
    await expect(ctx.agentWorkers.free({ agentRun: id, agentGone: true })).rejects.toThrow(new RegExp(`was freed already \\(decision ${freed.decision}\\), and no worktree of it is left`))
    expect(ctx.artifacts.list({ kind: 'decision', decisionType: 'reconciliation' })).toHaveLength(decided)
    await expect(ctx.agentWorkers.free({ agentRun: later.id, agentGone: true })).rejects.toThrow(/completed, so it holds nothing to free/)
    await expect(ctx.agentWorkers.free({ agentRun: 'arun_0000000000000000', agentGone: true })).rejects.toThrow(/no agent run/)
  }, 30_000)

  it('refuses to free a run whose liveness is still being looked at', async () => {
    const { dir, id } = await started(new ScriptedAgent({ holdMs: 30_000 }))
    const { ctx } = await restart(dir)
    await looked(ctx, id, 1)
    await expect(ctx.agentWorkers.free({ agentRun: id, agentGone: true })).rejects.toThrow(/still being looked at \(1 of 3 verdicts\)/)
    expect(ctx.artifacts.list({ kind: 'decision', decisionType: 'reconciliation' })).toEqual([])
  }, 30_000)

  // T74's gap: an operator cancel of a started run whose lease was free failed it `aborted` with no verdict, freeing its session.
  it('gives an operator cancel of a started run that no process holds a verdict: not known to be gone, it ends aborted with its session held; dead, it ends aborted and frees it (REQ-WRK-4, INV-15)', async () => {
    const cancelled = async (gone: boolean) => {
      const { dir, id, session } = await started(new ScriptedAgent({ holdMs: 30_000 }))
      const booted = await restart(dir)
      // Between two looks no process holds it: the next one is a minute away.
      await looked(booted.ctx, id, 1)
      if (gone) {
        // Its agent process positively gone (its pid now another process's), and quiet past deadAfterSeconds.
        booted.ctx.store.db.prepare('UPDATE agent_runs SET agent_process = ?, submitted_at = ?, activity_at = ? WHERE run_id = ?')
          .run(JSON.stringify({ ...processIdentity(process.pid)!, startTicks: 1 }), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', id)
      }
      const source = booted.ctx.workers.source('agents')!
      expect(source.cancel!(id)).toBe(true)
      const done = await source.wait(id, 10_000)
      return { ...booted, id, session, done, decision: decisionOf(booted.ctx, done)! }
    }
    const unknown = await cancelled(false)
    expect(unknown.done).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'aborted', message: expect.stringContaining(`it is not known to be gone (liveness unknown`) } })
    expect(unknown.decision).toMatchObject({ outcome: { option: 'operator', detail: { verdict: 'unknown', cause: 'cancel', looks: 1 } } })
    expect(await unknown.ctx.workers.held!(unknown.session)).toMatch(new RegExp(`^its run ${unknown.id} ended without being known to be gone`))
    expect(unknown.ctx.eventLog.query({ type: 'agent-workers.run.unknown' })).toEqual([expect.objectContaining({ data: expect.objectContaining({ agentRun: unknown.id, cause: 'cancel' }) })])
    expect((await unknown.ctx.workers.liveness!()).runs).toEqual([expect.objectContaining({ execution: unknown.id, state: 'unknown' })])
    expect(unknown.again.runs).toEqual([])
    await unknown.stop()
    const dead = await cancelled(true)
    expect(dead.done).toMatchObject({ status: 'failed', error: { kind: 'aborted', message: expect.stringContaining('it is gone (liveness dead') } })
    expect(dead.decision).toMatchObject({ outcome: { option: 'dead', detail: { verdict: 'dead', cause: 'cancel' } } })
    expect(await dead.ctx.workers.held!(dead.session)).toBeUndefined()
    expect(dead.ctx.eventLog.query({ type: 'agent-workers.run.unknown' })).toEqual([])
    expect(dead.again.runs).toEqual([])
  }, 60_000)
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

// Real git repositories, worktrees, and a workflow run end to end: slower than the 5 s default on CI runners.
describe('agents source: a git worktree per workflow run (worktreePerRun; PROP-0010 B3)', { timeout: 60_000 }, () => {
  const ORIGINAL = 'def add(a, b):\n    return a - b\n'
  const FIXED = 'def add(a, b):\n    return a + b\n'
  const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim()
  const temp = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    return dir
  }
  /** A repository on `main` with one commit; never one of the operator's. */
  const repository = (): string => {
    const dir = temp('system-wt-repo-')
    git(dir, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'calc.py'), ORIGINAL)
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'init')
    return dir
  }
  /** The main working tree as the operator left it: on `main`, at `head`, clean, with its own calc.py. */
  const untouched = (dir: string, head: string): void => {
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(dir, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(dir, 'calc.py'), 'utf8')).toBe(ORIGINAL)
  }
  const writer = (workspace: string) => worker({ id: 'dev', sandbox: 'workspace-write', workspace, tools: [], worktreePerRun: true })
  const reviewer = (workspace: string) => worker({ id: 'reviewer', workspace, worktreePerRun: true })
  /** What a writing run does: it fixes calc.py and leaves a note named after the directory it works in. */
  const writes = (spec: RunSpec): string => {
    if (spec.sandbox !== 'workspace-write') return 'read'
    writeFileSync(join(spec.workspace, 'calc.py'), FIXED)
    writeFileSync(join(spec.workspace, `note-${basename(spec.workspace)}.txt`), `${spec.prompt}\n`)
    return 'done'
  }
  const SANDBOXES: SandboxMode[] = ['read-only', 'workspace-write']
  const developer = (options: ConstructorParameters<typeof ScriptedAgent>[0] = {}) => new ScriptedAgent({ sandboxes: SANDBOXES, act: writes, ...options })
  const run = async (ctx: Context, id: string, key: string, runId?: string): Promise<WorkerExecution> => {
    const source = ctx.workers.source('agents')!
    const capabilities = id === 'agent:dev' ? ['develop'] : ['review']
    return source.wait(source.start({ key, worker: id, prompt: key, ...(runId ? { runId } : {}), requirement: requirement({ capabilities }), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never }).id, 30_000)
  }
  const LATER = (): number => Date.now() + 169 * 60 * 60_000

  it('runs a writing run of a workflow run in that run\'s own worktree, on branch system/run/<runId>, and never touches the main working tree (INV-15, REQ-WF-5)', async () => {
    const repo = repository()
    const head = git(repo, 'rev-parse', 'HEAD')
    const root = temp('system-worktrees-')
    const agent = developer()
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: root })
    expect((await ctx.workers.list())[0]).toMatchObject({ worker: 'agent:dev', state: 'ready' })
    const done = await run(ctx, 'agent:dev', 'k-1', 'run_one')
    expect(done).toMatchObject({ status: 'completed', submitted: true })
    // <worktreeRoot>/<repository name>-<hash of its real path>/<runId>
    const workspace = agent.runs[0]!.workspace
    expect(dirname(dirname(workspace))).toBe(realpathSync(root))
    expect(basename(dirname(workspace))).toMatch(new RegExp(`^${basename(repo)}-[0-9a-f]{12}$`))
    expect(basename(workspace)).toBe('run_one')
    expect(agent.runs[0]).toMatchObject({ sandbox: 'workspace-write' })
    expect(git(workspace, 'symbolic-ref', '--short', 'HEAD')).toBe('system/run/run_one')
    // Branched from the repository's HEAD; the agent's change is in the worktree only.
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toBe(FIXED)
    untouched(repo, head)
    // The result names the worktree and its exact subject, which a review binds to.
    const body = ctx.artifacts.get(done.result!)!.body as { workspace: string; subject: unknown }
    expect(body.workspace).toBe(workspace)
    expect(body.subject).toEqual(captureGitSubject(workspace)!.subject)
    expect(body.subject).toMatchObject({ type: 'git-head', ref: head })
    // A run that belongs to no workflow run works in the configured workspace, as before.
    await run(ctx, 'agent:dev', 'k-alone')
    expect(agent.runs[1]!.workspace).toBe(repo)
  })

  it('reads a workflow run\'s change in its worktree for the operator, read only: each file with its lines and diff, an untracked file as added, a link never followed, a removed worktree\'s from its branch (T122, INV-2)', async () => {
    const repo = repository()
    const head = git(repo, 'rev-parse', 'HEAD')
    const outside = temp('system-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'not the run\'s\n')
    const agent = developer({ act: (spec) => { const done = writes(spec); if (spec.sandbox === 'workspace-write') symlinkSync(join(outside, 'secret.txt'), join(spec.workspace, 'leak.txt')); return done } })
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    expect((await run(ctx, 'agent:dev', 'k-1', 'run_seen')).status).toBe('completed')
    const workspace = agent.runs[0]!.workspace
    const status = git(workspace, 'status', '--porcelain', '--untracked-files=all')
    // The test's own status may refresh the index; what changes() does is measured after it.
    const index = statSync(join(git(workspace, 'rev-parse', '--absolute-git-dir'), 'index')).mtimeMs
    const source = ctx.workers.source('agents')!
    const [change, ...others] = (await source.changes!('run_seen'))!
    expect(others).toEqual([])
    expect(change).toMatchObject({ repository: repo, workspace, branch: 'system/run/run_seen', base: { branch: 'main', sha: head }, head, more: 0, truncated: false })
    expect(change!.files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([['calc.py', 'modified', 1, 1], ['leak.txt', 'added', undefined, undefined], ['note-run_seen.txt', 'added', 1, 0]])
    expect(change!.files[0]!.diff).toMatch(/^diff --git a\/calc.py b\/calc.py\n[\s\S]*-    return a - b\n\+    return a \+ b$/)
    // A link is named, never followed out of the worktree; an untracked file reads as added lines.
    expect(change!.files[1]).toEqual({ path: 'leak.txt', status: 'added', note: 'a link or a file that cannot be opened, not read' })
    expect(JSON.stringify(change)).not.toContain('not the run\'s')
    expect(change!.files[2]!.diff).toBe('new file note-run_seen.txt (untracked)\n+k-1')
    // Read only: the worktree, its index, and the repository are as they were.
    expect(statSync(join(git(workspace, 'rev-parse', '--absolute-git-dir'), 'index')).mtimeMs).toBe(index)
    expect(git(workspace, 'status', '--porcelain', '--untracked-files=all')).toBe(status)
    untouched(repo, head)
    // A run this source holds no worktree of reads as none; through the registry, with the source's name.
    expect(await source.changes!('run_other')).toBeUndefined()
    expect((await ctx.workers.changes!('run_seen')).changes.map((c) => c.source)).toEqual(['agents'])
    // A worktree whose .git file points elsewhere is not read: an error, never no change (INV-2).
    const pointer = readFileSync(join(workspace, '.git'), 'utf8')
    writeFileSync(join(workspace, '.git'), `gitdir: ${join(repo, '.git')}\n`)
    await expect(source.changes!('run_seen')).rejects.toThrow(/no longer points to the worktree's own directory/)
    expect((await ctx.workers.changes!('run_seen')).unread).toEqual([{ source: 'agents', detail: expect.stringMatching(/no longer points/) }])
    writeFileSync(join(workspace, '.git'), pointer)
    // Removed after the retention: read from its branch, the committed change only.
    rmSync(join(workspace, 'leak.txt'))
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [workspace], kept: [] })
    const [kept] = (await source.changes!('run_seen'))!
    expect(kept).toMatchObject({ fromBranch: true, base: { branch: 'main', sha: head }, head: git(repo, 'rev-parse', 'system/run/run_seen') })
    expect(kept!.files.map((f) => [f.path, f.status])).toEqual([['calc.py', 'modified'], ['note-run_seen.txt', 'added']])
    untouched(repo, head)
  })

  it('gives a reviewer of the same workflow run the writer\'s worktree, and binds its review to that subject (REQ-WF-5, REQ-TEAM-5, INV-15)', async () => {
    const repo = repository()
    const head = git(repo, 'rev-parse', 'HEAD')
    const subjectOf = (prompt: string): string => /^Subject: (\S+)$/m.exec(prompt)![1]!
    const read: string[] = []
    const agent = developer({
      act: (spec) => {
        if (spec.sandbox === 'workspace-write') return writes(spec)
        read.push(readFileSync(join(spec.workspace, 'calc.py'), 'utf8'))
        return '```json\n' + JSON.stringify({ subject: subjectOf(spec.prompt), verdict: 'approve', findings: [{ severity: 'info', title: 'add() now adds' }] }) + '\n```'
      },
    })
    const { ctx } = await boot(agent, { workers: [writer(repo), reviewer(repo)], worktreeRoot: temp('system-worktrees-') })
    chatWorker(ctx)
    const started = ctx.workflow.start({ template: 'develop', input: 'Fix add()' })
    const deadline = Date.now() + 30_000
    for (;;) {
      const view = ctx.workflow.get(started.runId)
      if (view && view.status !== 'running') break
      if (Date.now() > deadline) throw new Error('never finished')
      if (view?.blocked?.kind === 'gate') ctx.workflow.approve(started.runId, { verdict: 'approved', plan: view.blocked.plan })
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const done = await ctx.workflow.wait(started.runId, 30_000)
    expect(done.status).toBe('completed')
    const [develop, review] = agent.runs
    expect([develop!.sandbox, review!.sandbox]).toEqual(['workspace-write', 'read-only'])
    // One worktree per (repository, workflow run): the writer's, read by the reviewer.
    expect(basename(develop!.workspace)).toBe(started.runId)
    expect(review!.workspace).toBe(develop!.workspace)
    expect(read).toEqual([FIXED])
    expect(git(develop!.workspace, 'symbolic-ref', '--short', 'HEAD')).toBe(`system/run/${started.runId}`)
    expect(subjectOf(review!.prompt)).toBe(subjectId(captureGitSubject(develop!.workspace)!.subject))
    expect(review!.prompt).toContain('+    return a + b')
    const [stored] = ctx.artifacts.list({ kind: 'assessment' })
    expect(stored!.body).toMatchObject({ verdict: 'approve', reviewer: 'agent:reviewer' })
    expect(`git:${(stored!.body as { subject: { ref: string } }).subject.ref}:${(stored!.body as { subject: { version: string } }).subject.version}`).toBe(subjectOf(review!.prompt))
    untouched(repo, head)
  })

  it('gives two workflow runs two worktrees on two branches, each with only its own change (INV-15)', async () => {
    const repo = repository()
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = developer()
    const { ctx } = await boot(agent, { workers: [writer(repo), reviewer(repo)], worktreeRoot: temp('system-worktrees-') })
    expect((await run(ctx, 'agent:dev', 'k-a', 'run_a')).status).toBe('completed')
    expect((await run(ctx, 'agent:dev', 'k-b', 'run_b')).status).toBe('completed')
    const [a, b] = agent.runs.map((r) => r.workspace) as [string, string]
    expect(a).not.toBe(b)
    expect([basename(a), basename(b)]).toEqual(['run_a', 'run_b'])
    expect([git(a, 'symbolic-ref', '--short', 'HEAD'), git(b, 'symbolic-ref', '--short', 'HEAD')]).toEqual(['system/run/run_a', 'system/run/run_b'])
    expect(readdirSync(a).sort()).toEqual(['.git', 'calc.py', 'note-run_a.txt'])
    expect(readdirSync(b).sort()).toEqual(['.git', 'calc.py', 'note-run_b.txt'])
    // A reviewer of run_b reads run_b's tree; of no workflow run, the configured workspace.
    await run(ctx, 'agent:reviewer', 'k-review-b', 'run_b')
    await run(ctx, 'agent:reviewer', 'k-review-alone')
    expect(agent.runs.slice(2).map((r) => r.workspace)).toEqual([b, repo])
    untouched(repo, head)
  })

  it('reuses the stored worktree of a workflow run after a restart, wherever the worktree root now is', async () => {
    const repo = repository()
    const dir = temp('system-agents-')
    const first = developer()
    const before = await boot(first, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') }, dir)
    expect((await run(before.ctx, 'agent:dev', 'k-1', 'run_keep')).status).toBe('completed')
    await before.stop()
    const elsewhere = temp('system-worktrees-')
    const second = developer({ act: () => 'looked again' })
    const after = await boot(second, { workers: [writer(repo)], worktreeRoot: elsewhere }, dir)
    expect((await run(after.ctx, 'agent:dev', 'k-2', 'run_keep')).status).toBe('completed')
    expect(second.runs[0]!.workspace).toBe(first.runs[0]!.workspace)
    expect(readFileSync(join(second.runs[0]!.workspace, 'note-run_keep.txt'), 'utf8')).toBe('k-1\n')
    expect(readdirSync(elsewhere)).toEqual([])
  })

  /** A board task's brief whose files hold `text` as the board's TASKS.md (brief@1.2 files). */
  const taskBrief = (ctx: Context, text: string): `sha256:${string}` => {
    const ref = ctx.artifacts.put({
      kind: 'evidence', bodySchema: 'board-projection@1.0', classification: 'operator-shared', producer: { type: 'system', ref: 'workflow' },
      body: { schema: 'board-projection@1.0', projectId: 'p1', format: 'tasks-md', text, tasks: 1, truncated: false },
    }).id
    return ctx.artifacts.put({
      kind: 'objective', bodySchema: 'brief@1.2', classification: 'operator-shared', producer: { type: 'system', ref: 'workflow' }, inputs: [ref],
      body: {
        schema: 'brief@1.2', projectId: 'p1', taskId: 'task-1', attempt: 1, goal: 'fix add', acceptance: [{ id: 'a1', statement: 'add adds' }], artifacts: [],
        instructions: [{ text: 'fix add' }], files: [{ path: '.system/TASKS.md', ref, note: 'the board of project p1' }],
        budget: { remaining: [] }, sandbox: { mode: 'read-only', network: 'allow-list', commands: false }, classification: 'operator-shared',
      },
    }).id as `sha256:${string}`
  }
  const briefed = async (ctx: Context, key: string, brief: `sha256:${string}`, runId?: string): Promise<WorkerExecution> => {
    const source = ctx.workers.source('agents')!
    return source.wait(source.start({ key, worker: 'agent:dev', brief, ...(runId ? { runId } : {}), requirement: requirement({ capabilities: ['develop'] }), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never }).id, 30_000)
  }

  it('writes a board task brief\'s TASKS.md into the run\'s worktree before the agent starts, read-only, under a .system/ git ignores: never in its subject or the retention commit (PROP-0010, INV-15)', async () => {
    const repo = repository()
    const head = git(repo, 'rev-parse', 'HEAD')
    const seen: Array<{ text?: string; mode?: number }> = []
    const agent = developer({
      act: (spec) => {
        const file = join(spec.workspace, '.system', 'TASKS.md')
        seen.push(existsSync(file) ? { text: readFileSync(file, 'utf8'), mode: statSync(file).mode & 0o777 } : {})
        return writes(spec)
      },
    })
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    const done = await briefed(ctx, 'k-files', taskBrief(ctx, '# p1\n\n### fix add\n'), 'run_files')
    expect(done).toMatchObject({ status: 'completed' })
    expect(seen[0]).toEqual({ text: '# p1\n\n### fix add\n', mode: 0o444 })
    // The prompt names the file, since this source wrote it.
    expect(agent.runs[0]!.prompt).toContain('Files in your workspace, written by system before this run (read-only; edits are never read back):\n- .system/TASKS.md: the board of project p1')
    const workspace = agent.runs[0]!.workspace
    // Ignored by git: the run's subject is its change alone.
    expect(git(workspace, 'status', '--porcelain', '--untracked-files=all').split('\n').map((l) => l.trim()).sort()).toEqual(['?? note-run_files.txt', 'M calc.py'])
    expect(captureGitSubject(workspace)!.diff).not.toContain('new file .system/')
    expect((ctx.artifacts.get(done.result!)!.body as { subject: unknown }).subject).toEqual(captureGitSubject(workspace)!.subject)
    // The retention commit keeps the work and never the board's file.
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [workspace], kept: [] })
    expect(git(repo, 'ls-tree', '-r', '--name-only', 'system/run/run_files').split('\n').sort()).toEqual(['calc.py', 'note-run_files.txt'])
    untouched(repo, head)
    // A run of no workflow run works in the configured workspace: no file there, and the prompt does not name one.
    await briefed(ctx, 'k-alone', taskBrief(ctx, '# p1\n'))
    expect(existsSync(join(repo, '.system'))).toBe(false)
    expect(agent.runs[1]!.prompt).not.toContain('Files in your workspace')
  })

  it('replaces the brief\'s files whole on a later run of the workflow run, whatever the agent did to them, and never writes through a link it left there (INV-15)', async () => {
    const repo = repository()
    const outside = join(temp('system-outside-'), 'kept.txt')
    writeFileSync(outside, 'not the workspace\'s\n')
    const seen: Array<{ text: string; mode: number }> = []
    const agent = developer({
      act: (spec) => {
        const file = join(spec.workspace, '.system', 'TASKS.md')
        seen.push({ text: readFileSync(file, 'utf8'), mode: statSync(file).mode & 0o777 })
        if (seen.length === 1) {
          // Made writable and edited: the next run's brief replaces it whole, read-only again.
          chmodSync(file, 0o644)
          writeFileSync(file, 'edited by the agent\n')
        } else {
          // A link left in its place: the next run is refused, and what it points to is untouched.
          rmSync(file)
          symlinkSync(outside, file)
        }
        return writes(spec)
      },
    })
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    expect(await briefed(ctx, 'k-first', taskBrief(ctx, '# p1\n\n### first\n'), 'run_again')).toMatchObject({ status: 'completed' })
    expect(await briefed(ctx, 'k-second', taskBrief(ctx, '# p1\n\n### second\n'), 'run_again')).toMatchObject({ status: 'completed' })
    expect(seen).toEqual([{ text: '# p1\n\n### first\n', mode: 0o444 }, { text: '# p1\n\n### second\n', mode: 0o444 }])
    const refused = await briefed(ctx, 'k-third', taskBrief(ctx, '# p1\n\n### third\n'), 'run_again')
    expect(refused).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error' } })
    expect(refused.error!.message).toMatch(/TASKS\.md is not a plain file/)
    expect(readFileSync(outside, 'utf8')).toBe('not the workspace\'s\n')
    expect(agent.runs).toHaveLength(2)
    // No temporary file is left beside the brief's files.
    expect(readdirSync(join(agent.runs[0]!.workspace, '.system')).sort()).toEqual(['.gitignore', 'TASKS.md'])
  })

  it('refuses a .system the agent replaced with a link, writing nothing through it, and its retirement leaves what the link points to (INV-15)', async () => {
    const repo = repository()
    const outside = temp('system-outside-')
    writeFileSync(join(outside, 'kept.txt'), 'not the workspace\'s\n')
    const agent = developer({
      act: (spec) => {
        // A link out of the workspace in place of system's directory.
        rmSync(join(spec.workspace, '.system'), { recursive: true, force: true })
        symlinkSync(outside, join(spec.workspace, '.system'))
        return writes(spec)
      },
    })
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    expect(await briefed(ctx, 'k-first', taskBrief(ctx, '# p1\n\n### first\n'), 'run_link')).toMatchObject({ status: 'completed' })
    const refused = await briefed(ctx, 'k-second', taskBrief(ctx, '# p1\n\n### second\n'), 'run_link')
    expect(refused).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error' } })
    expect(refused.error!.message).toMatch(/\.system is not a directory of the worktree; nothing is written/)
    expect(agent.runs).toHaveLength(1)
    expect(readdirSync(outside)).toEqual(['kept.txt'])
    // Retired, the link is not system's directory: nothing it points to is removed.
    const workspace = agent.runs[0]!.workspace
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [workspace], kept: [] })
    expect(readFileSync(join(outside, 'kept.txt'), 'utf8')).toBe('not the workspace\'s\n')
  })

  it('opens a directory as itself and works through its descriptor: a link swapped in at its name afterwards is never used (INV-15)', () => {
    const base = temp('system-directory-')
    const outside = temp('system-outside-')
    mkdirSync(join(base, '.system'))
    writeFileSync(join(base, 'file'), '')
    symlinkSync(outside, join(base, 'link'))
    expect([openDirectory(join(base, 'link')), openDirectory(join(base, 'file')), openDirectory(join(base, 'none'))]).toEqual(['other', 'other', 'absent'])
    const opened = openDirectory(join(base, '.system'))
    if (typeof opened === 'string') throw new Error(`.system opened as ${opened}`)
    try {
      renameSync(join(base, '.system'), join(base, 'moved'))
      symlinkSync(outside, join(base, '.system'))
      writeFileSync(join(opened.at, 'TASKS.md'), '# p1\n')
      expect(readdirSync(outside)).toEqual([])
      expect(readFileSync(join(base, 'moved', 'TASKS.md'), 'utf8')).toBe('# p1\n')
    } finally {
      closeSync(opened.fd)
    }
  })

  it('checks the brief\'s files at egress with the prompt, and writes none into a repository that tracks .system/: nothing reaches the agent (INV-12, INV-2)', async () => {
    const repo = repository()
    const agent = developer()
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    // Generated at run time: never a real secret in the repository.
    const secret = String(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }))
    const leaked = await briefed(ctx, 'k-leak', taskBrief(ctx, `# p1\n${secret}`), 'run_leak')
    expect(leaked).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'egress_denied' } })
    const tracked = repository()
    mkdirSync(join(tracked, '.system'))
    writeFileSync(join(tracked, '.system', 'notes.txt'), 'the repository\'s own\n')
    git(tracked, 'add', '.')
    git(tracked, 'commit', '-q', '-m', 'notes')
    const other = await boot(agent, { workers: [writer(tracked)], worktreeRoot: temp('system-worktrees-') })
    const refused = await briefed(other.ctx, 'k-tracked', taskBrief(other.ctx, '# p1\n'), 'run_tracked')
    expect(refused).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error' } })
    expect(refused.error!.message).toMatch(/tracks files under \.system\//)
    expect(agent.runs).toEqual([])
  })

  it('commits a finished workflow run\'s pending changes on its branch, then removes its worktree after the retention, by a recorded decision; a later run of it adds the worktree again from that branch (INV-9, INV-13)', async () => {
    const repo = repository()
    const head = git(repo, 'rev-parse', 'HEAD')
    // What each run found in its tree before it wrote.
    const found: Array<string | undefined> = []
    const agent = developer({
      act: (spec) => {
        const note = join(spec.workspace, 'note-run_done.txt')
        found.push(existsSync(note) ? readFileSync(note, 'utf8') : undefined)
        return writes(spec)
      },
    })
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    expect((await run(ctx, 'agent:dev', 'k-1', 'run_done')).status).toBe('completed')
    const workspace = agent.runs[0]!.workspace
    // Within the retention it stays.
    expect(await ctx.agentWorkers.sweepWorktrees()).toEqual({ removed: [], kept: [] })
    expect(existsSync(workspace)).toBe(true)
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [workspace], kept: [] })
    expect(existsSync(workspace)).toBe(false)
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(workspace)
    // The work is kept: one commit by the system, naming the run, on top of where the branch began.
    expect(git(repo, 'log', '-1', '--format=%an <%ae>|%cn <%ce>|%s', 'system/run/run_done')).toBe('system <system@localhost>|system <system@localhost>|system: keep the uncommitted work of workflow run run_done')
    expect(git(repo, 'rev-parse', 'system/run/run_done^')).toBe(head)
    expect(git(repo, 'show', 'system/run/run_done:calc.py')).toBe(FIXED.trim())
    expect(git(repo, 'show', 'system/run/run_done:note-run_done.txt')).toBe('k-1')
    untouched(repo, head)
    expect(git(repo, 'branch', '--list', '--format=%(refname:short)').split('\n').sort()).toEqual(['main', 'system/run/run_done'])
    // The rule's decision is an artifact of the workflow run (INV-13).
    const [decision, ...more] = ctx.artifacts.list({ kind: 'decision', decisionType: 'retention', runId: 'run_done' })
    expect(more).toEqual([])
    new SchemaRegistry().assertRecord(decision!.body as { schema: string })
    expect(decision!.body).toMatchObject({
      decider: { type: 'rule', id: 'agent-workers.worktree-retention' },
      outcome: { option: 'remove', detail: { runId: 'run_done', path: workspace, branch: 'system/run/run_done', retentionHours: 168 } },
    })
    // A later run of the same workflow run works in it again, from its branch, with that work.
    expect((await run(ctx, 'agent:dev', 'k-2', 'run_done')).status).toBe('completed')
    expect(agent.runs[1]!.workspace).toBe(workspace)
    expect(found).toEqual([undefined, 'k-1\n'])
    expect(git(workspace, 'symbolic-ref', '--short', 'HEAD')).toBe('system/run/run_done')
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'system/run/run_done'))
    untouched(repo, head)
  })

  it('keeps the worktree of a workflow run whose agent run ended without being known to be gone, and runs nothing more there, until a verdict says dead (INV-15, PROP-0013)', async () => {
    const repo = repository()
    const agent = new ScriptedAgent({ sandboxes: SANDBOXES, act: writes })
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    const first = await run(ctx, 'agent:dev', 'k-1', 'run_unknown')
    expect(first.status).toBe('completed')
    const workspace = agent.runs[0]!.workspace
    // As a restart leaves it when the verdicts stayed unknown: failed, for the operator, not dead.
    const reconcile = (verdict: string) => ctx.store.db.prepare("UPDATE agent_runs SET status = 'failed', liveness_verdict = ?, liveness_decision = ? WHERE run_id = ?").run(verdict, `sha256:${'1'.repeat(64)}`, first.id)
    reconcile('unknown')
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [], kept: [] })
    expect(existsSync(workspace)).toBe(true)
    const refused = await run(ctx, 'agent:dev', 'k-2', 'run_unknown')
    expect(refused).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error', message: expect.stringContaining(`run ${first.id} of the worktree of workflow run run_unknown ended without being known to be gone (liveness unknown`) } })
    expect(agent.runs).toHaveLength(1)
    reconcile('dead')
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [workspace], kept: [] })
  })

  it('frees the worktree a run that ended unknown held: a dirty one stays unless the operator asks its changes committed, a clean one is removed, and the branch always stays (PROP-0013, INV-15)', async () => {
    const repo = repository()
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = developer()
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    const first = await run(ctx, 'agent:dev', 'k-1', 'run_free')
    const workspace = agent.runs[0]!.workspace
    // As a restart leaves it when the verdicts stayed unknown; its writes are still uncommitted in the worktree.
    const reconciled = ctx.artifacts.recordDecision({
      decisionType: 'reconciliation', question: 'Is it gone?', inputs: [], candidates: [{ option: 'dead', selected: false, reasons: ['not dead: the verdict is unknown, and only dead is death', 'the agent process: unknown (never reported)'] }, { option: 'operator', selected: true, reasons: ['to the operator'] }],
      decider: { type: 'rule', id: 'agent-workers.reconcile', version: '2' }, outcome: { option: 'operator' }, deterministic: true,
    }, { producer: { type: 'system', ref: 'agent-workers' }, runId: 'run_free' }).id
    ctx.store.db.prepare("UPDATE agent_runs SET status = 'failed', liveness_verdict = 'unknown', liveness_looks = 3, liveness_decision = ? WHERE run_id = ?").run(reconciled, first.id)
    const told = (await ctx.workers.liveness!({ runId: 'run_free' })).runs
    expect(told).toEqual([expect.objectContaining({ execution: first.id, state: 'unknown', holds: [`worktree ${workspace} (branch system/run/run_free)`], reasons: ['the agent process: unknown (never reported)'] })])
    // Dirty, no commit asked: freed, the worktree kept with its changes, and said why.
    const freed = await ctx.agentWorkers.free({ agentRun: first.id, agentGone: true })
    expect(freed.freed).toEqual([`worktree ${workspace} (branch system/run/run_free)`])
    expect(freed.worktrees).toEqual([{ path: workspace, branch: 'system/run/run_free', outcome: 'kept', why: expect.stringContaining('it holds uncommitted changes, so it stays') }])
    expect(readFileSync(join(workspace, 'calc.py'), 'utf8')).toBe(FIXED)
    expect((ctx.artifacts.get(freed.decision)!.body as { outcome: { detail: { worktrees: unknown } } }).outcome.detail.worktrees).toEqual([{ path: workspace, branch: 'system/run/run_free', outcome: 'kept' }])
    // Freed again with the commit asked: its changes kept on its branch, then removed; the branch stays.
    const committed = await ctx.agentWorkers.free({ agentRun: first.id, agentGone: true, commitWorktree: true })
    expect(committed).toMatchObject({ again: true, freed: [], worktrees: [{ path: workspace, outcome: 'removed', commit: expect.stringMatching(/^[0-9a-f]{40}$/) }] })
    expect(existsSync(workspace)).toBe(false)
    expect(git(repo, 'show', 'system/run/run_free:calc.py')).toBe(FIXED.trim())
    expect(ctx.store.db.prepare('SELECT decision FROM agent_worktrees WHERE workflow_run_id = ?').get('run_free')).toEqual({ decision: committed.decision })
    untouched(repo, head)
    // The workflow run's next agent run is no longer refused: it works in its worktree again, added from its branch.
    expect((await run(ctx, 'agent:dev', 'k-2', 'run_free')).status).toBe('completed')
    expect(readFileSync(join(workspace, 'note-run_free.txt'), 'utf8')).toBe('k-2\n')
    // A clean worktree is removed without the flag.
    const second = ctx.store.db.prepare("SELECT run_id AS id FROM agent_runs WHERE workflow_run_id = 'run_free' AND run_id != ?").get(first.id) as { id: string }
    git(workspace, 'add', '--all')
    git(workspace, 'commit', '-q', '-m', 'the operator kept it')
    ctx.store.db.prepare("UPDATE agent_runs SET status = 'failed', liveness_verdict = 'unknown', liveness_decision = ? WHERE run_id = ?").run(reconciled, second.id)
    expect((await ctx.agentWorkers.free({ agentRun: second.id, agentGone: true })).worktrees).toEqual([{ path: workspace, branch: 'system/run/run_free', outcome: 'removed', why: 'it holds nothing uncommitted: it is removed, and its branch stays' }])
    expect(existsSync(workspace)).toBe(false)
    expect(git(repo, 'log', '-1', '--format=%s', 'system/run/run_free')).toBe('the operator kept it')
  })

  it('keeps a worktree while its workflow run has an agent run to finish, and leaves one it cannot remove in place, committed, for the next sweep (INV-9)', async () => {
    const repo = repository()
    const options = { sandboxes: SANDBOXES, act: writes, holdMs: 0 }
    const agent = new ScriptedAgent(options)
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    expect((await run(ctx, 'agent:dev', 'k-1', 'run_busy')).status).toBe('completed')
    // A second agent run of the workflow run is still running: the worktree is not looked at.
    options.holdMs = 30_000
    const source = ctx.workers.source('agents')!
    const busy = source.start({ key: 'k-2', worker: 'agent:dev', prompt: 'more', runId: 'run_busy', requirement: requirement({ capabilities: ['develop'] }), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never })
    while (agent.runs.length < 2) await new Promise((resolve) => setTimeout(resolve, 20))
    const workspace = agent.runs[0]!.workspace
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [], kept: [] })
    expect(source.cancel!(busy.id)).toBe(true)
    await source.wait(busy.id, 10_000)
    // Locked by the operator: its changes are committed, the removal is refused, and it stays.
    git(repo, 'worktree', 'lock', workspace)
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [], kept: [workspace] })
    expect(existsSync(join(workspace, 'note-run_busy.txt'))).toBe(true)
    expect(git(repo, 'log', '-1', '--format=%s', 'system/run/run_busy')).toBe('system: keep the uncommitted work of workflow run run_busy')
    git(repo, 'worktree', 'unlock', workspace)
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [workspace], kept: [] })
    expect(git(repo, 'rev-list', '--count', 'main..system/run/run_busy')).toBe('1')
    // Retried under the one decision that retires it.
    expect(ctx.artifacts.list({ kind: 'decision', decisionType: 'retention', runId: 'run_busy' })).toHaveLength(1)
  })

  it('forgets a worktree the operator removed by hand, and adds it again from its branch for a later run (INV-9)', async () => {
    const repo = repository()
    const agent = developer()
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    expect((await run(ctx, 'agent:dev', 'k-1', 'run_hand')).status).toBe('completed')
    const workspace = agent.runs[0]!.workspace
    git(workspace, 'add', '--all')
    git(workspace, 'commit', '-q', '-m', 'by hand')
    git(repo, 'worktree', 'remove', workspace)
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [workspace], kept: [] })
    expect(git(repo, 'log', '-1', '--format=%s', 'system/run/run_hand')).toBe('by hand')
    expect((await run(ctx, 'agent:dev', 'k-2', 'run_hand')).status).toBe('completed')
    expect(agent.runs[1]!.workspace).toBe(workspace)
    expect(git(workspace, 'log', '-1', '--format=%s')).toBe('by hand')
  })

  it('keeps every worktree with worktreeRetentionHours 0', async () => {
    const repo = repository()
    const agent = developer()
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-'), worktreeRetentionHours: 0 })
    expect((await run(ctx, 'agent:dev', 'k-1', 'run_kept')).status).toBe('completed')
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [], kept: [] })
    expect(existsSync(agent.runs[0]!.workspace)).toBe(true)
  })

  it('lists each run worktree with its state, what it holds, and when it retires, and removes the finished ones on the operator\'s recorded word: a clean one, a dirty one only with its changes committed on its branch, never one held; the branch stays (D12, INV-13, INV-15)', async () => {
    const repo = repository()
    const head = git(repo, 'rev-parse', 'HEAD')
    const agent = developer()
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-'), worktreeRetentionHours: 24 })
    for (const runId of ['run_clean', 'run_dirty', 'run_held']) expect((await run(ctx, 'agent:dev', `k-${runId}`, runId)).status).toBe('completed')
    const path = (runId: string): string => agent.runs.find((r) => basename(r.workspace) === runId)!.workspace
    // run_clean's work committed on its branch by hand; run_dirty's left uncommitted; run_held's agent not known to be gone.
    git(path('run_clean'), 'add', '--all')
    git(path('run_clean'), 'commit', '-q', '-m', 'kept by hand')
    ctx.store.db.prepare("UPDATE agent_runs SET status = 'failed', liveness_verdict = 'unknown', liveness_decision = ? WHERE workflow_run_id = 'run_held'").run(`sha256:${'1'.repeat(64)}`)

    const listing = await ctx.agentWorkers.runWorktrees()
    expect(listing).toMatchObject({ retentionHours: 24, total: 3 })
    expect(listing.worktrees.map((w) => [w.runId, w.state, w.changes, w.branch])).toEqual([
      ['run_clean', 'finished', 'clean', 'system/run/run_clean'], ['run_dirty', 'finished', 'uncommitted', 'system/run/run_dirty'], ['run_held', 'held', 'uncommitted', 'system/run/run_held'],
    ])
    const [clean, , held] = listing.worktrees
    expect(Date.parse(clean!.retiresAt!) - Date.parse(clean!.lastActivityAt)).toBe(24 * 60 * 60_000)
    expect(held!.retiresAt).toBeUndefined()
    expect(await ctx.agentWorkers.runWorktrees({ limit: 1 })).toMatchObject({ total: 3, worktrees: [{ runId: 'run_clean' }] })

    // Every finished one: the clean one removed, the dirty and the held ones kept, by one decision of the operator's.
    const removed = await ctx.agentWorkers.removeWorktrees({ note: 'merged' })
    expect(removed.worktrees.map((w) => [w.runId, w.outcome])).toEqual([['run_clean', 'removed'], ['run_dirty', 'kept'], ['run_held', 'kept']])
    expect(removed.worktrees[1]!.why).toMatch(/holds uncommitted changes, so it stays/)
    expect(removed.worktrees[2]!.why).toMatch(/ended without being known to be gone \(free it first: system free\)/)
    expect(existsSync(path('run_clean'))).toBe(false)
    expect(git(repo, 'log', '-1', '--format=%s', 'system/run/run_clean')).toBe('kept by hand')
    expect(readFileSync(join(path('run_dirty'), 'calc.py'), 'utf8')).toBe(FIXED)
    const decision = ctx.artifacts.get(removed.decision!)!
    new SchemaRegistry().assertRecord(decision.body as { schema: string })
    expect(decision).toMatchObject({ producer: { type: 'operator' }, body: {
      decisionType: 'retention', decider: { type: 'operator', id: 'operator.worktrees' }, rationale: 'merged',
      outcome: { option: 'remove', detail: { commitChanges: false, worktrees: [{ runId: 'run_clean', path: path('run_clean'), branch: 'system/run/run_clean' }] } },
    } })
    // The dirty one with its changes committed on its branch first: nothing is discarded.
    const committed = await ctx.agentWorkers.removeWorktrees({ runId: 'run_dirty', commitChanges: true })
    expect(committed.worktrees).toEqual([expect.objectContaining({ runId: 'run_dirty', outcome: 'removed', commit: expect.stringMatching(/^[0-9a-f]{40}$/) })])
    expect(git(repo, 'show', 'system/run/run_dirty:calc.py')).toBe(FIXED.trim())
    // Nothing left to remove: nothing is decided; the held one stays until the operator frees its run.
    const decisions = ctx.artifacts.list({ kind: 'decision', decisionType: 'retention' }).length
    expect(await ctx.agentWorkers.removeWorktrees({ commitChanges: true })).toEqual({ worktrees: [expect.objectContaining({ runId: 'run_held', outcome: 'kept' })], more: 0 })
    expect(ctx.artifacts.list({ kind: 'decision', decisionType: 'retention' })).toHaveLength(decisions)
    expect(existsSync(path('run_held'))).toBe(true)
    await expect(ctx.agentWorkers.removeWorktrees({ runId: '../x' })).rejects.toThrow(/not a workflow run id/)
    expect(git(repo, 'branch', '--list', '--format=%(refname:short)').split('\n').sort()).toEqual(['main', 'system/run/run_clean', 'system/run/run_dirty', 'system/run/run_held'])
    untouched(repo, head)
  })

  it('serves the run worktree tools to the operator, each output as its schema says, and checks the removal\'s output on its plan before anything is decided: a defect removes nothing (D12, INV-2, INV-14)', async () => {
    const repo = repository()
    const agent = developer()
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    expect((await run(ctx, 'agent:dev', 'k-1', 'run_tool')).status).toBe('completed')
    const workspace = agent.runs[0]!.workspace
    git(workspace, 'add', '--all')
    git(workspace, 'commit', '-q', '-m', 'done')
    const tools = new Map<string, { scope?: string; handler: ToolHandler }>()
    registerRunTools({ mcp: { tool: (name: string, spec: ToolSpec, handler: ToolHandler) => tools.set(name, { ...(spec.scope ? { scope: spec.scope } : {}), handler }) } } as unknown as Context, ctx.agentWorkers)
    expect([...tools].map(([name, t]) => [name, t.scope])).toEqual([['agent_run_free', 'operator'], ['agent_worktrees', 'operator'], ['agent_worktrees_remove', 'operator']])
    const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.handler(args, { scope: 'operator' })
    const listed = await call('agent_worktrees', {})
    new SchemaRegistry().assertDef('mcp-agent-runs@1.1', 'agent-worktrees-output', listed.structuredContent)
    expect(listed.content[0]).toMatchObject({ text: expect.stringContaining('run_tool  finished, clean, retires ') })
    expect((await call('agent_worktrees_remove', { runId: 'run tool' })).content[0]).toMatchObject({ text: expect.stringMatching(/^invalid input, nothing done/) })
    // A defect: the removal's output is one its schema refuses.
    const assertDef = SchemaRegistry.prototype.assertDef
    const spy = vi.spyOn(SchemaRegistry.prototype, 'assertDef').mockImplementation(function (this: SchemaRegistry, tag, def, value) {
      if (def === 'agent-worktrees-remove-output') throw new SchemaError(`${tag}#/$defs/${def}`, [], 'a defect')
      assertDef.call(this, tag, def, value)
    })
    onTestFinished(() => spy.mockRestore())
    const refused = await call('agent_worktrees_remove', {})
    expect([refused.isError, refused.content[0]]).toEqual([true, { type: 'text', text: expect.stringMatching(/^agent_worktrees_remove would make an output its schema refuses \(a defect\), so nothing changed/) }])
    expect(existsSync(workspace)).toBe(true)
    expect(ctx.artifacts.list({ kind: 'decision', decisionType: 'retention' })).toEqual([])
    spy.mockRestore()
    const removed = await call('agent_worktrees_remove', { note: 'merged' })
    new SchemaRegistry().assertDef('mcp-agent-runs@1.1', 'agent-worktrees-remove-output', removed.structuredContent)
    expect(removed.structuredContent).toMatchObject({ decision: expect.stringMatching(/^sha256:/), worktrees: [{ runId: 'run_tool', outcome: 'removed' }], more: 0 })
    expect(existsSync(workspace)).toBe(false)
  })

  it('distrusts a worktree whose .git file the agent pointed elsewhere: the run fails, and git never runs there again', async () => {
    const repo = repository()
    const decoy = repository()
    const agent = developer({
      act: (spec) => {
        writeFileSync(join(spec.workspace, '.git'), `gitdir: ${join(decoy, '.git')}\n`)
        return 'done'
      },
    })
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    const done = await run(ctx, 'agent:dev', 'k-1', 'run_moved')
    expect(done).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'reconciliation_failed', message: expect.stringContaining('.git file') } })
    // A later run of the workflow run and the sweep both refuse it, and leave it for the operator.
    expect(await run(ctx, 'agent:dev', 'k-2', 'run_moved')).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error', message: expect.stringContaining('no longer points') } })
    expect(await ctx.agentWorkers.sweepWorktrees(LATER())).toEqual({ removed: [], kept: [agent.runs[0]!.workspace] })
    expect(agent.runs).toHaveLength(1)
    expect(git(decoy, 'branch', '--list', '--format=%(refname:short)')).toBe('main')
    expect(git(decoy, 'status', '--porcelain')).toBe('')
  })

  it('fails a run whose working tree git cannot read afterwards: its result is never stored without its subject (INV-2, INV-5)', async () => {
    const repo = repository()
    const agent = developer({
      act: (spec) => {
        // git now refuses the repository ("bad config line"): its subject is unknown, not absent.
        writeFileSync(join(spec.workspace, '.git', 'config'), '[broken\n')
        return 'done'
      },
    })
    const { ctx } = await boot(agent, { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-') })
    const done = await run(ctx, 'agent:dev', 'k-unreadable')
    expect(agent.runs[0]!.workspace).toBe(repo)
    expect(done).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'reconciliation_failed', message: expect.stringMatching(/cannot be read: git rev-parse failed \(fatal: bad config line 1/) } })
    expect(done.result).toBeUndefined()
  })

  it('refuses worktreePerRun on a workspace that is not the top level of a git repository: the Worker takes no work, and a run fails as config_error before the agent starts', async () => {
    const plain = temp('system-plain-')
    const agent = developer()
    const root = temp('system-worktrees-')
    const { ctx } = await boot(agent, { workers: [writer(plain)], worktreeRoot: root })
    expect((await ctx.workers.list())[0]).toMatchObject({ worker: 'agent:dev', state: 'unavailable', capabilities: [] })
    expect(await run(ctx, 'agent:dev', 'k-1', 'run_x')).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error', message: expect.stringContaining('not a git working tree') } })
    // A directory inside a repository is not one either: a worktree is of the whole repository.
    const inside = join(repository(), 'pkg')
    mkdirSync(inside)
    const nested = await boot(agent, { workers: [writer(inside)], worktreeRoot: root })
    expect((await nested.ctx.workers.list())[0]).toMatchObject({ state: 'unavailable' })
    expect(await run(nested.ctx, 'agent:dev', 'k-2', 'run_x')).toMatchObject({ status: 'failed', error: { kind: 'config_error', message: expect.stringContaining('not the top level') } })
    // Nor is a repository that holds the worktree root: its worktrees would be files of its main working tree.
    const holder = repository()
    const holding = await boot(agent, { workers: [writer(holder)], worktreeRoot: join(holder, 'worktrees') })
    expect((await holding.ctx.workers.list())[0]).toMatchObject({ state: 'unavailable' })
    expect(await run(holding.ctx, 'agent:dev', 'k-4', 'run_x')).toMatchObject({ status: 'failed', error: { kind: 'config_error', message: expect.stringContaining('lies inside') } })
    expect(existsSync(join(holder, 'worktrees'))).toBe(false)
    expect(agent.runs).toEqual([])
    expect(readdirSync(root)).toEqual([])
    // A run id is a branch and a directory name: anything else is refused at once.
    expect(() => ctx.workers.source('agents')!.start({ key: 'k-3', worker: 'agent:dev', prompt: 'x', runId: '../escape', requirement: requirement({ capabilities: ['develop'] }), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never }))
      .toThrow(/run id/)
  })

  it('refuses at load Workers that share a workspace and disagree on worktreePerRun: a reviewer must read the writer\'s tree', () => {
    const repo = repository()
    expect(() => new AgentWorkers(new Context(), { workers: [writer(repo), worker({ id: 'reviewer', workspace: repo })] })).toThrow(/share the workspace/)
  })
})
