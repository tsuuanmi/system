/**
 * What the specs of the `agents` Worker source share: a scripted agent runtime, the stack they boot
 * (the kernel, routing, the agent runtimes registry, this source, worker sessions, and the engine
 * with the software-development profile), stopped when its test finishes, and the Workers and work
 * they configure. The specs are split by theme so they run side by side.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { RunMetering, RunObserver } from '@tsuuanmi/system-agent-runtime-core'
import AgentRuntimeRegistry, { type AgentRuntimeProvider, type RunSpec, type SandboxMode } from '@tsuuanmi/system-agent-runtimes'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { startPrompt } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import type { PoolConfig } from '@tsuuanmi/system-resources-core'
import Store from '@tsuuanmi/system-store'
import WorkerRouter, { type WorkerExecution, type WorkRequirement } from '@tsuuanmi/system-workers'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import Workflow from '@tsuuanmi/system-workflow'
import * as SoftwareDevelopment from '@tsuuanmi/system-profile-software-development'
import { FakeResources } from '../../../resources-core/conformance/resources.ts'
import { DEVELOP } from './develop.ts'
import { onTestFinished } from 'vitest'
import AgentWorkers, { type Config } from '../src/index.ts'

/**
 * A scripted agent: it answers with the prompt, and records every run's policy. With `process`, each
 * run starts a real child process that stands for the agent, reports it (PROP-0013), and ends it when
 * the run ends; with `activity`, it reports activity every so many milliseconds while it holds.
 */
export class ScriptedAgent implements AgentRuntimeProvider {
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
export class SlowProbeAgent extends ScriptedAgent {
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

export const WORKSPACE = mkdtempSync(join(tmpdir(), 'system-agent-ws-'))
export const worker = (overrides: Partial<Config['workers'][number]> = {}): Config['workers'][number] => ({
  id: 'reviewer', runtime: 'scripted', workspace: WORKSPACE, sandbox: 'read-only', tier: 'standard', tools: ['Read', 'Grep'], model: 'model-x', ...overrides,
})

export async function boot(agent: AgentRuntimeProvider, config: Config = { workers: [worker()] }, dir = mkdtempSync(join(tmpdir(), 'system-agents-')), ledger?: { pools: readonly PoolConfig[]; provider?: typeof FakeResources }) {
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

export const requirement = (overrides: Partial<WorkRequirement> = {}): WorkRequirement => ({
  schema: 'work-requirement@1.0', objective: 'review the change', capabilities: ['review', 'local-data'],
  // An agent's model is remote: local-private never reaches it by default (INV-12).
  data: { classification: 'operator-shared', refs: [] }, egressPolicy: 'egress.classification-and-secrets',
  tier: { min: 'economy', source: 'caller' }, acceptance: { contract: 'acceptance.answer' }, ...overrides,
})

/** A scripted chat Worker (reason) that stands in for the website planner and reporter of `develop`. */
export function chatWorker(ctx: Context): string[] {
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
