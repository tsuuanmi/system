import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeRegistry, { type AgentRuntimeProvider, type RunSpec, type SandboxMode } from '@tsuuanmi/system-agent-runtimes'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import Store from '@tsuuanmi/system-store'
import WorkerRouter, { type WorkerExecution, type WorkRequirement } from '@tsuuanmi/system-workers'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import Workflow from '@tsuuanmi/system-workflow'
import * as SoftwareDevelopment from '@tsuuanmi/system-profile-software-development'
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
  constructor(private readonly options: { sandboxes?: SandboxMode[]; resume?: boolean; available?: boolean; holdMs?: number; fail?: Error; executes?: boolean; readsConfined?: boolean; act?: (spec: RunSpec) => string | undefined } = {}) {}
  async probe() {
    return {
      available: this.options.available ?? true, detail: 'scripted 1.0', version: '1.0', sandboxes: this.options.sandboxes ?? ['read-only'],
      resume: this.options.resume ?? true, executes: this.options.executes ?? false, readsConfined: this.options.readsConfined ?? true,
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
    return { text: this.options.act?.(spec) ?? `echo: ${spec.prompt}`, nativeHandle: spec.resume ?? `h-${this.runs.length}`, turns: 1 }
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
    ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry), ctx.plugin(AgentWorkers, config), ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, { retryDelayMs: 100 }),
  ]
  await Promise.all(fibers)
  // The profile contributes its template once the engine is up.
  fibers.push(ctx.plugin(SoftwareDevelopment))
  await fibers.at(-1)
  ctx.agentRuntimes.register(agent)
  const stop = async (): Promise<void> => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  }
  cleanups.push(stop, () => rmSync(dir, { recursive: true, force: true }))
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
        plans.push(request.prompt)
        const text = request.prompt.includes('Plan the software change')
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

  it('proves develop (never review) for a confined writable Worker, and validate only when the runtime can run commands', async () => {
    const config = { workers: [worker({ id: 'writer', sandbox: 'workspace-write' as const })] }
    const without = await boot(new ScriptedAgent({ sandboxes: ['read-only', 'workspace-write'] }), config)
    expect((await without.ctx.workers.list())[0]!.capabilities.map((c) => c.capability)).toEqual(['local-data', 'develop', 'persistent-conversation'])
    const runs = await boot(new ScriptedAgent({ sandboxes: ['read-only', 'workspace-write'], executes: true }), config)
    expect((await runs.ctx.workers.list())[0]!.capabilities.map((c) => c.capability)).toEqual(['local-data', 'develop', 'validate', 'persistent-conversation'])
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
    expect(agent.runs).toEqual([{ prompt: 'look at it', workspace: WORKSPACE, sandbox: 'read-only', tools: ['Read', 'Grep'], model: 'model-x' }])
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
    const secret = String(generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs1', format: 'pem' }))
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
    cleanups.splice(cleanups.indexOf(first.stop), 1)
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
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
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
      const deadline = Date.now() + 60_000
      while (!ctx.workflow.get(run.runId)?.blocked) {
        if (Date.now() > deadline) throw new Error('never blocked')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      ctx.workflow.approve(run.runId, { verdict: 'approved' })
      return { ctx, agent, done: await ctx.workflow.wait(run.runId, 60_000) }
    }
    const subjectOf = (prompt: string): string => /^Subject: (\S+)$/m.exec(prompt)![1]!
    const assessment = (subject: string) => '```json\n' + JSON.stringify({ subject, verdict: 'approve', findings: [{ severity: 'info', title: 'add() now adds' }] }) + '\n```'
    const changes = (subject: string) => '```json\n' + JSON.stringify({ subject, verdict: 'changes-requested', findings: [{ severity: 'blocking', title: 'no test for add()', file: 'calc.py' }] }) + '\n```'

    it('remediates blocking findings: a fix, then a review of the new subject; the report waits for both', async () => {
      let reviews = 0
      const { ctx, agent, done } = await develop((prompt) => (++reviews === 1 ? changes(subjectOf(prompt)) : assessment(subjectOf(prompt))))
      expect(done.status).toBe('completed')
      const byId = Object.fromEntries(done.nodes.map((n) => [n.nodeId, n]))
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

    it('stops remediating at the review cycle bound, and says so (QA-8)', async () => {
      const { ctx, done } = await develop((prompt) => changes(subjectOf(prompt)))
      expect(done.status).toBe('completed')
      expect(done.nodes.map((n) => n.nodeId).filter((id) => id.includes(':review'))).toEqual([
        'plan:1:review', 'plan:1:review:fix:1', 'plan:1:review:review:2', 'plan:1:review:fix:2', 'plan:1:review:review:3',
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

  it('routes a review run to the local agent by capability, end to end through the engine', async () => {
    const agent = new ScriptedAgent()
    const { ctx } = await boot(agent)
    const run = await ctx.workflow.wait(ctx.workflow.start({ template: 'review', input: 'Check the diff', classification: 'operator-shared' }).runId, 10_000)
    expect(run).toMatchObject({ status: 'completed', answer: 'echo: Check the diff', nodes: [{ nodeId: 'review:1', source: 'agents', worker: 'agent:reviewer', quotaClass: 'agent-plan' }] })
  })
})
