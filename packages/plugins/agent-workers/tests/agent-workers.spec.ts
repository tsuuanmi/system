import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { workspaceReadBounds } from '@tsuuanmi/system-agent-runtime-core'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { AdmissionFailure, type WorkRequirement } from '@tsuuanmi/system-workers'
import { describe, expect, it, onTestFinished } from 'vitest'
import { ScriptedAgent, SlowProbeAgent, WORKSPACE, worker, boot, requirement, chatWorker } from './stack.ts'
import { checkConfig } from '../src/index.ts'

describe('the workspace reads server\'s bounds are configuration with validated ranges (T200b, INV-9)', () => {
  it('takes bounds within their ranges and refuses one outside, or one it does not know, at load', () => {
    expect(checkConfig({ workspaceReads: { maxEntries: 50, searchTimeoutMs: 2000 } })).toEqual([])
    expect(checkConfig({ workspaceReads: { maxEntries: 0 } })).toEqual([expect.stringContaining('workspaceReads: the workspace reads bound maxEntries is 0')])
    expect(checkConfig({ workspaceReads: { searchTimeoutMs: 600_000 } })).toEqual([expect.stringContaining('searchTimeoutMs')])
    expect(checkConfig({ workspaceReads: { maxBytes: 1 } as never })).toEqual([expect.stringContaining('is not a workspace reads bound')])
  })
})

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

  it('says why an unavailable Worker takes no work on its descriptor, at most 300 characters on one line, and nothing on a ready one (capability-descriptor@1.9, T214)', async () => {
    const { ctx } = await boot(new ScriptedAgent({ resume: true }), {
      workers: [worker(), worker({ id: 'writer', sandbox: 'workspace-write' }), worker({ id: 'ghost', runtime: 'missing' })],
    })
    const workers = Object.fromEntries((await ctx.workers.list()).map((w) => [w.worker, w]))
    expect(workers['agent:reviewer']).not.toHaveProperty('unavailableReason')
    expect(workers['agent:writer']).toMatchObject({ schema: 'capability-descriptor@1.9', state: 'unavailable', unavailableReason: expect.stringContaining('cannot enforce its workspace-write sandbox') })
    expect(workers['agent:ghost']).toMatchObject({ schema: 'capability-descriptor@1.9', state: 'unavailable', unavailableReason: expect.stringContaining('no missing runtime is registered') })
    const unconfined = await boot(new ScriptedAgent({ readsConfined: false }), { workers: [worker()] })
    const [refused] = await unconfined.ctx.workers.list()
    expect(refused).toMatchObject({ state: 'unavailable', unavailableReason: expect.stringContaining('cannot keep host state unreadable') })
    for (const w of Object.values(workers)) expect([...(w.unavailableReason ?? '')].length).toBeLessThanOrEqual(300)
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
    // The workspace reads server's bounds go with every run, each at its default unless configured (T200b).
    expect(agent.runs).toEqual([{ prompt: 'look at it', workspace: WORKSPACE, sandbox: 'read-only', tools: ['Read', 'Grep'], model: 'model-x', workspaceReads: workspaceReadBounds(), toolGate: expect.any(Function) }])
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
