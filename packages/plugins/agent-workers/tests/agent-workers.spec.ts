import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeRegistry, { type AgentRuntimeProvider, type RunSpec, type SandboxMode } from '@tsuuanmi/system-agent-runtimes'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import Store from '@tsuuanmi/system-store'
import WorkerRouter, { type WorkRequirement } from '@tsuuanmi/system-workers'
import Workflow from '@tsuuanmi/system-workflow'
import { afterEach, describe, expect, it } from 'vitest'
import AgentWorkers, { type Config } from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/** A scripted agent: it answers with the prompt, and records every run's policy. */
class ScriptedAgent implements AgentRuntimeProvider {
  readonly kind = 'scripted'
  readonly runs: RunSpec[] = []
  constructor(private readonly options: { sandboxes?: SandboxMode[]; resume?: boolean; available?: boolean; holdMs?: number; fail?: Error; executes?: boolean } = {}) {}
  async probe() {
    return {
      available: this.options.available ?? true, detail: 'scripted 1.0', version: '1.0', sandboxes: this.options.sandboxes ?? ['read-only'],
      resume: this.options.resume ?? true, executes: this.options.executes ?? false,
    }
  }
  async run(spec: RunSpec, signal: AbortSignal, onHandle?: (handle: string) => void) {
    this.runs.push(spec)
    onHandle?.(spec.resume ?? `h-${this.runs.length}`)
    if (this.options.holdMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, this.options.holdMs)
        signal.addEventListener('abort', () => (clearTimeout(timer), reject(new ProviderError('aborted', 'stopped'))), { once: true })
      })
    }
    if (this.options.fail) throw this.options.fail
    return { text: `echo: ${spec.prompt}`, nativeHandle: spec.resume ?? `h-${this.runs.length}`, turns: 1 }
  }
}

const WORKSPACE = mkdtempSync(join(tmpdir(), 'system-agent-ws-'))
const worker = (overrides: Partial<Config['workers'][number]> = {}): Config['workers'][number] => ({
  id: 'reviewer', runtime: 'scripted', workspace: WORKSPACE, sandbox: 'read-only', tier: 'standard', tools: ['Read', 'Grep'], model: 'model-x', ...overrides,
})

async function boot(agent: AgentRuntimeProvider, config: Config = { workers: [worker()] }, dir = mkdtempSync(join(tmpdir(), 'system-agents-'))) {
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry), ctx.plugin(AgentWorkers, config), ctx.plugin(Workflow, { retryDelayMs: 100 }),
  ]
  await Promise.all(fibers)
  ctx.agentRuntimes.register(agent)
  const stop = async (): Promise<void> => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  }
  cleanups.push(stop, () => rmSync(dir, { recursive: true, force: true }))
  return { ctx, dir, stop }
}

const requirement = (overrides: Partial<WorkRequirement> = {}): WorkRequirement => ({
  schema: 'work-requirement@1.0', objective: 'review the change', capabilities: ['review', 'local-data'],
  data: { classification: 'local-private', refs: [] }, egressPolicy: 'egress.classification-and-secrets',
  tier: { min: 'economy', source: 'caller' }, acceptance: { contract: 'acceptance.answer' }, ...overrides,
})

describe('ctx.workers source `agents`: agent runtimes as Workers', () => {
  it('describes each configured Worker with the capabilities its probe proves, never plain reason', async () => {
    const { ctx } = await boot(new ScriptedAgent({ resume: true }), {
      workers: [worker(), worker({ id: 'writer', sandbox: 'workspace-write' }), worker({ id: 'ghost', runtime: 'missing' })],
    })
    const workers = Object.fromEntries((await ctx.workers.list()).map((w) => [w.worker, w]))
    expect(workers['agent:reviewer']).toMatchObject({ locality: 'local', quotaClass: 'agent-plan', tier: 'standard', state: 'ready', provider: 'scripted' })
    expect(workers['agent:reviewer']!.capabilities.map((c) => [c.capability, c.evidence.kind])).toEqual([
      ['review', 'probe'], ['local-data', 'probe'], ['persistent-conversation', 'probe'],
    ])
    // The runtime cannot enforce workspace-write: that Worker is unavailable, never loosened.
    expect(workers['agent:writer']).toMatchObject({ state: 'unavailable', capabilities: [] })
    expect(workers['agent:ghost']).toMatchObject({ state: 'unavailable', capabilities: [] })
  })

  it('proves develop for a confined writable Worker, and validate only when the runtime can run commands', async () => {
    const config = { workers: [worker({ id: 'writer', sandbox: 'workspace-write' as const })] }
    const without = await boot(new ScriptedAgent({ sandboxes: ['read-only', 'workspace-write'] }), config)
    expect((await without.ctx.workers.list())[0]!.capabilities.map((c) => c.capability)).toEqual(['review', 'local-data', 'develop', 'persistent-conversation'])
    const runs = await boot(new ScriptedAgent({ sandboxes: ['read-only', 'workspace-write'], executes: true }), config)
    expect((await runs.ctx.workers.list())[0]!.capabilities.map((c) => c.capability)).toEqual(['review', 'local-data', 'develop', 'validate', 'persistent-conversation'])
  })

  it('runs work once with the policy from configuration, and stores the result as agent-result@1.0', async () => {
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
    expect(agent.runs).toEqual([{ prompt: 'look at it', workspace: WORKSPACE, sandbox: 'read-only', tools: ['Read', 'Grep'], model: 'model-x' }])
    const result = ctx.artifacts.get(done.result!)!
    expect(result).toMatchObject({ kind: 'report', bodySchema: 'agent-result@1.0', classification: 'local-private' })
    expect(result.body).toMatchObject({ worker: 'agent:reviewer', runtime: 'scripted', sandbox: 'read-only', text: 'echo: look at it', nativeHandle: 'h-1' })
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

  it('never runs a started run again after a restart: it fails for the operator to inspect (INV-4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-agents-'))
    const first = await boot(new ScriptedAgent({ holdMs: 30_000 }), undefined, dir)
    const admitted = await first.ctx.workers.route(requirement())
    const source = first.ctx.workers.source('agents')!
    const started = source.start({ key: 'k', worker: 'agent:reviewer', prompt: 'long', requirement: requirement(), decisions: admitted.decisions })
    await new Promise((resolve) => setTimeout(resolve, 300))
    await first.stop()
    cleanups.splice(cleanups.indexOf(first.stop), 1)
    const again = new ScriptedAgent()
    const second = await boot(again, undefined, dir)
    const done = await second.ctx.workers.source('agents')!.wait(started.id, 10_000)
    expect(done).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'reconciliation_failed', disposition: 'USER_ACTION' } })
    expect(done.error!.message).toContain('h-1')
    expect(again.runs).toEqual([])
  })

  it('routes a review run to the local agent by capability, end to end through the engine', async () => {
    const agent = new ScriptedAgent()
    const { ctx } = await boot(agent)
    const run = await ctx.workflow.wait(ctx.workflow.start({ template: 'review', input: 'Check the diff', classification: 'local-private' }).runId, 10_000)
    expect(run).toMatchObject({ status: 'completed', answer: 'echo: Check the diff', nodes: [{ nodeId: 'review:1', source: 'agents', worker: 'agent:reviewer', quotaClass: 'agent-plan' }] })
  })
})
