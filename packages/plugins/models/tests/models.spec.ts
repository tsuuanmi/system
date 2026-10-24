import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LlmRuntime, { type RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import Artifacts from '@tsuuanmi/system-artifacts'
import Vault from '@tsuuanmi/system-credentials-vault'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { ModelError, type ModelEntry } from '@tsuuanmi/system-models-core'
import * as ScientificResearch from '@tsuuanmi/system-profile-scientific-research'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter, { type WorkerExecution, type WorkRequirement } from '@tsuuanmi/system-workers'
import Workflow from '@tsuuanmi/system-workflow'
import { describe, expect, it, onTestFinished } from 'vitest'
import { CATALOG, FakeModels, type FakeScript, modelsConformance } from '../../../models-core/conformance/models.ts'
import * as Models from '../src/index.ts'
import { type CatalogEntry, LlmModels, ModelWorkers } from '../src/index.ts'
import { type FakeOpenAi, fakeOpenAi } from './fake-openai.ts'

// A credential-shaped value made at run time: no key-shaped literal sits in the repository.
const awsKeyId = (): string => `AKIA${Array.from(randomBytes(16), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[b % 32]).join('')}`

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const KEY = 'SYSTEM_TEST_MODEL_KEY'

/**
 * The DSH rows alone, as the bundle mounts them: the vault (`ctx.credentials`), `llm`, and the
 * `llm-pi-ai` adapter with one hand-declared OpenAI-compatible route to the fake server. No
 * dsh-base, no telemetry row, no vendor default row, no attachments service.
 */
async function llmRows(server: FakeOpenAi, retryPolicy: RetryPolicyConfig = { mode: 'normal', maxRetries: 5, backoff: { initialDelayMs: 1, maxDelayMs: 5 } }) {
  const dir = temp('system-models-')
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }),
    ctx.plugin(LlmRuntime),
    ctx.plugin(PiAi, { providers: { fake: { api: 'openai-completions', baseURL: server.baseURL, apiKeyEnv: KEY, models: [{ id: 'm1' }], retryPolicy } } }),
  ]
  await Promise.all(fibers)
  await ctx.credentials.set(credentialRef(KEY), 'sk-test-0123456789')
  return { ctx, dir, fibers }
}

/** The conformance catalog: `echo` and `local` reach the fake route, `gone` names a route not mounted. */
const routed = (catalog: readonly ModelEntry[]): CatalogEntry[] => catalog.map((m) => ({ ...m, route: m.id === 'gone' ? 'missing' : 'fake', model: 'm1' }))

describe('the DSH llm rows (spike, ADR-0025): they mount without dsh-base and stream a completion', () => {
  it('mounts llm and llm-pi-ai with only ctx.credentials, and the route key resolves through the vault (REQ-WRK-10)', async () => {
    const server = await fakeOpenAi()
    onTestFinished(() => server.close())
    const { ctx, fibers } = await llmRows(server)
    onTestFinished(async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
    })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'fake', name: 'fake' }])
    for (const absent of ['attachments', 'settings', 'authorization', 'agents', 'sessionProjections']) expect(ctx.get(absent as never)).toBeUndefined()
    await ctx.plugin(LlmModels, { models: routed(CATALOG) })
    const completion = await ctx.models.complete({ model: 'echo', prompt: 'hello' })
    expect(completion).toEqual({ model: 'echo', text: 'echo: hello', usage: { inputTokens: 7, outputTokens: 3 }, finish: 'stop', maxTokens: 64, attempts: 1 })
    // The key never sits in configuration: the route names a reference, the vault holds the value.
    expect(server.requests[0]).toMatchObject({ authorization: 'Bearer sk-test-0123456789', body: { model: 'm1', max_completion_tokens: 64, messages: [{ role: 'user', content: 'hello' }] } })
    // A session's history goes first, in order, then the prompt (ADR-0031).
    await ctx.models.complete({ model: 'echo', prompt: 'and now?', history: [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'echo: first' }] })
    expect((server.requests.at(-1)!.body as { messages: unknown[] }).messages).toEqual([
      { role: 'user', content: 'first' }, { role: 'assistant', content: 'echo: first' }, { role: 'user', content: 'and now?' },
    ])
    // A missing key fails closed as a credential failure, before anything reaches the provider.
    await ctx.credentials.unset(credentialRef(KEY))
    await expect(ctx.models.complete({ model: 'echo', prompt: 'again' })).rejects.toMatchObject({ failure: 'credential' })
    expect(server.requests).toHaveLength(2)
  })
})

modelsConformance('llm (DSH llm + llm-pi-ai, against a fake OpenAI-compatible server)', async () => {
  const server = await fakeOpenAi()
  const { ctx, fibers } = await llmRows(server)
  fibers.push(ctx.plugin(LlmModels, { models: routed(CATALOG) }))
  await fibers.at(-1)
  return {
    ctx,
    dispose: async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
      await server.close()
    },
  }
})

describe('LlmModels: bounded re-attempts by the route\'s retry policy (INV-9)', () => {
  const boot = async (maxRetries: number, retryPolicy?: RetryPolicyConfig, idleTimeoutMs?: number) => {
    const server = await fakeOpenAi()
    const { ctx, fibers } = await llmRows(server, retryPolicy)
    if (idleTimeoutMs) {
      // The route's first request loads its client, silently: not a stall these tests measure.
      for await (const chunk of ctx.llm.stream({ provider: 'fake', model: 'm1', messages: [{ role: 'user', content: [{ type: 'text', text: 'warm' }] }] })) void chunk
      server.requests.length = 0
    }
    await ctx.plugin(LlmModels, { models: routed(CATALOG), maxRetries, ...(idleTimeoutMs ? { idleTimeoutMs } : {}) })
    onTestFinished(async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
      await server.close()
    })
    return { ctx, server }
  }

  it('re-attempts a transient failure, at most maxRetries times', async () => {
    const { ctx, server } = await boot(1)
    server.script.push({ status: 500 })
    expect((await ctx.models.complete({ model: 'echo', prompt: 'x' })).text).toBe('echo: x')
    expect(server.requests).toHaveLength(2)
    server.script.push({ status: 500 }, { status: 500 })
    await expect(ctx.models.complete({ model: 'echo', prompt: 'y' })).rejects.toMatchObject({ failure: 'transient' })
    expect(server.requests).toHaveLength(4)
  })

  it('never re-attempts a refused key under a bounded route policy', async () => {
    const { ctx, server } = await boot(2)
    server.script.push({ status: 401 })
    await expect(ctx.models.complete({ model: 'echo', prompt: 'z' })).rejects.toMatchObject({ failure: 'credential' })
    expect(server.requests).toHaveLength(1)
  })

  it('stays bounded under an unbounded route policy, and never re-attempts what cannot succeed', async () => {
    const { ctx, server } = await boot(2, { mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 5 } })
    server.script.push({ status: 500 }, { status: 500 }, { status: 500 })
    const failure = await ctx.models.complete({ model: 'echo', prompt: 'z' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ModelError)
    // Always mode retries transient failures; the plugin's bound still stops it after 1 + 2 sends.
    expect(server.requests).toHaveLength(3)
    // A refused key, a spent quota, or an invalid request only bills again: one request, and the
    // provider's own text (which can echo part of a key) is not repeated.
    server.script.push({ status: 401 })
    const refused = await ctx.models.complete({ model: 'echo', prompt: 'z' }).catch((error: unknown) => error) as ModelError
    expect(server.requests).toHaveLength(4)
    expect(refused.message).toMatch(/refused the credential, or none is stored/)
  })

  it('stops a stream silent past idleTimeoutMs as a timeout, saying how far it got, and re-attempts it as the route allows', async () => {
    const { ctx, server } = await boot(1, undefined, 1_000)
    // A stall, then an answer: the stalled request is stopped and the re-attempt answers.
    server.script.push({ holdMs: 30_000 })
    expect(await ctx.models.complete({ model: 'echo', prompt: 'x' })).toMatchObject({ text: 'echo: x', attempts: 2 })
    expect(server.requests).toHaveLength(2)
    // Stalled on every attempt: a timeout that says it was a stall, not a slow answer.
    server.script.push({ holdMs: 30_000 }, { holdMs: 30_000 })
    const stalled = await ctx.models.complete({ model: 'echo', prompt: 'y' }).catch((error: unknown) => error) as ModelError
    expect(stalled).toMatchObject({ failure: 'timeout' })
    expect(stalled.message).toMatch(/^echo: TIMEOUT: no progress for 1000 ms \(idleTimeoutMs\) after \d+ stream event\(s\) and 0 characters of answer; the stream was stopped$/)
    expect(server.requests).toHaveLength(4)
  })

  it('never stops a slow answer that keeps streaming, however long it takes in all', async () => {
    const { ctx, server } = await boot(0, undefined, 1_000)
    // Ten parts, one every 350 ms: about 3.5 s in all, more than three times the silence bound.
    server.script.push({ drip: ['one ', 'two ', 'three ', 'four ', 'five ', 'six ', 'seven ', 'eight ', 'nine ', 'ten'], everyMs: 350 })
    expect(await ctx.models.complete({ model: 'echo', prompt: 'slow' })).toMatchObject({ text: 'one two three four five six seven eight nine ten', finish: 'stop', attempts: 1 })
    expect(server.requests).toHaveLength(1)
  })

  it('stops a stalled stream at the caller\'s abort as aborted, not as a stall', async () => {
    const { ctx, server } = await boot(2, undefined, 5_000)
    server.script.push({ holdMs: 5_000 })
    const caller = new AbortController()
    setTimeout(() => caller.abort(), 100)
    await expect(ctx.models.complete({ model: 'echo', prompt: 'z' }, caller.signal)).rejects.toMatchObject({ failure: 'aborted' })
    expect(server.requests).toHaveLength(1)
  })

  it('reports an answer cut at the bound as max-tokens', async () => {
    const { ctx, server } = await boot(0)
    server.script.push({ text: 'partial', finish: 'length' })
    expect(await ctx.models.complete({ model: 'local', prompt: 'long' })).toMatchObject({ text: 'partial', finish: 'max-tokens', maxTokens: 32 })
  })
})

// --- the `models` Worker source ---

const CATALOG_W: ModelEntry[] = [
  { id: 'fast', tier: 'standard', quotaClass: 'metered', locality: 'remote', maxTokens: 64, description: 'Quick answers for the lead' },
  { id: 'gone', tier: 'standard', quotaClass: 'metered', locality: 'remote', maxTokens: 64 },
  { id: 'private', tier: 'standard', quotaClass: 'local', locality: 'local', maxTokens: 32 },
  { id: 'strong', tier: 'frontier', quotaClass: 'metered', locality: 'remote', maxTokens: 64 },
]

async function boot(options: { script?: FakeScript; workers?: Record<string, unknown>; egress?: Record<string, unknown>; workflow?: Record<string, unknown>; dir?: string; research?: boolean } = {}) {
  const dir = options.dir ?? temp('system-model-workers-')
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, options.egress ?? {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(FakeModels, { catalog: CATALOG_W, script: options.script ?? {} }),
    ctx.plugin(ModelWorkers, { callTimeoutMs: 5_000, ...options.workers }), ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, { retryDelayMs: 100, ...options.workflow }),
  ]
  await Promise.all(fibers)
  if (options.research) {
    fibers.push(ctx.plugin(ScientificResearch))
    await fibers.at(-1)
  }
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  }
  onTestFinished(stop)
  return { ctx, dir, stop, fake: ctx.models as FakeModels }
}

const requirement = (overrides: Partial<WorkRequirement> = {}): WorkRequirement => ({
  schema: 'work-requirement@1.0', objective: 'answer', capabilities: ['reason'],
  data: { classification: 'operator-shared', refs: [] }, egressPolicy: 'egress.classification-and-secrets',
  tier: { min: 'economy', source: 'caller' }, acceptance: { contract: 'acceptance.answer' }, ...overrides,
})

const DECISIONS = { tier: `sha256:${'1'.repeat(64)}`, route: `sha256:${'2'.repeat(64)}` } as const

async function settle(ctx: Context, execution: WorkerExecution): Promise<WorkerExecution> {
  return ctx.workers.source('models')!.wait(execution.id, 10_000)
}

describe('ctx.workers source `models`: API and local models as Workers (REQ-WRK-10)', () => {
  it('describes one Worker per catalog entry: reason, proven by a probe of its route; unavailable when the route is missing', async () => {
    const { ctx } = await boot()
    const workers = Object.fromEntries((await ctx.workers.list()).map((w) => [w.worker, w]))
    expect(workers['model:fast']).toMatchObject({ tier: 'standard', quotaClass: 'metered', locality: 'remote', state: 'ready' })
    // A session is the source's own (ADR-0031): its conformance is the evidence.
    expect(workers['model:fast']!.capabilities.map((c) => [c.capability, c.evidence.kind])).toEqual([['reason', 'probe'], ['persistent-conversation', 'conformance']])
    expect(workers['model:private']).toMatchObject({ quotaClass: 'local', locality: 'local', state: 'ready' })
    expect(workers['model:private']!.capabilities.map((c) => c.capability)).toEqual(['reason', 'persistent-conversation'])
    expect(workers['model:gone']).toMatchObject({ state: 'unavailable', capabilities: [] })
    // The operator's description of an entry is its Worker's (capability-descriptor@1.7); an entry without one is described as before (T85).
    expect(workers['model:fast']).toMatchObject({ schema: 'capability-descriptor@1.7', description: 'Quick answers for the lead' })
    expect(workers['model:private']).not.toHaveProperty('description')
  })

  it('refuses a model entry whose description is not plain text on one line of at most 200 characters (T85)', () => {
    const entry = { id: 'fast', route: 'fake', model: 'm1', tier: 'standard' as const, quotaClass: 'metered' as const, locality: 'remote' as const, maxTokens: 64 }
    for (const description of ['', 'one\ntwo', 'x'.repeat(201)]) {
      expect(() => Models.apply(new Context(), { models: [{ ...entry, description }] }), JSON.stringify(description)).toThrow(/model fast: description must be plain text on one line, 1 to 200 characters/)
    }
  })

  it('answers an ask end to end: routed, egress-checked, stored as model-answer, tokens in the usage report (REQ-WRK-10)', async () => {
    const { ctx, fake } = await boot()
    const run = ctx.workflow.start({ template: 'ask', input: 'What is two plus two?', classification: 'public' })
    const done = await ctx.workflow.wait(run.runId, 10_000)
    // The local model's quota is preferred over metered quota (quotaPreference).
    expect(done).toMatchObject({ status: 'completed', answer: 'echo: What is two plus two?' })
    expect(done.nodes[0]).toMatchObject({ worker: 'model:private', quotaClass: 'local', usage: { inputTokens: 7, outputTokens: 3 } })
    const body = ctx.artifacts.get(done.result!)!.body
    expect(body).toMatchObject({ schema: 'model-answer@1.0', worker: 'model:private', model: 'private', quotaClass: 'local', locality: 'local', finish: 'stop', maxTokens: 32 })
    expect(fake.calls).toHaveLength(1)
    const decisions = ctx.workflow.explain(run.runId)!.nodes[0]!.decisions
    expect(decisions.map((d) => [d.type, d.outcome])).toEqual(expect.arrayContaining([['egress', 'allow'], ['route', 'model:private']]))
    expect(ctx.workflow.usage(1)[0]!.nodes[0]!.usage).toEqual({ inputTokens: 7, outputTokens: 3 })
  })

  it('is durable and idempotent by key; a key reused with another prompt is refused', async () => {
    const { ctx, fake } = await boot()
    const source = ctx.workers.source('models')!
    const start = (prompt: string) => source.start({ key: 'k-1', worker: 'model:fast', prompt, requirement: requirement(), decisions: DECISIONS })
    const first = start('hello')
    expect(start('hello').id).toBe(first.id)
    expect(await settle(ctx, first)).toMatchObject({ status: 'completed', submitted: true })
    expect(fake.calls).toHaveLength(1)
    expect(() => start('other')).toThrow(/different prompt/)
    // A key is one call: reused for a session turn, it is refused too.
    expect(() => source.start({ key: 'k-1', worker: 'model:fast', prompt: 'hello', sessionId: 's-1', requirement: requirement(), decisions: DECISIONS })).toThrow(/different prompt or session/)
  })

  describe('sessions by replay (ADR-0031)', () => {
    const turn = (ctx: Context, key: string, prompt: string, sessionId: string, worker = 'model:fast', classification: WorkRequirement['data']['classification'] = 'operator-shared') =>
      ctx.workers.source('models')!.start({ key, worker, prompt, sessionId, requirement: requirement({ data: { classification, refs: [] } }), decisions: DECISIONS })
    const seen = (fake: FakeModels) => fake.calls.map((c) => (c.history ?? []).map((t) => `${t.role}:${t.text}`))

    it('replays a session\'s turns in order before each prompt, and proves persistent-conversation by its own conformance', async () => {
      const { ctx, fake } = await boot({ script: { answer: (prompt, request) => `${prompt}#${request.history?.length ?? 0}` } })
      for (const [i, prompt] of ['one', 'two', 'three'].entries()) expect(await settle(ctx, turn(ctx, `s${i}`, prompt, 'ses_a'))).toMatchObject({ status: 'completed' })
      expect(seen(fake)).toEqual([[], ['user:one', 'assistant:one#0'], ['user:one', 'assistant:one#0', 'user:two', 'assistant:two#2']])
      const source = ctx.workers.source('models')!
      expect(source.handle!('ses_a')).toBe('model-session:ses_a')
      // It stays with its model's family: every model Worker of that family may serve it.
      expect(source.affinity!('ses_a')).toEqual(expect.arrayContaining(['model:fast']))
      const fast = (await ctx.workers.list()).find((w) => w.worker === 'model:fast')!
      expect(fast.capabilities.map((c) => [c.capability, c.evidence.kind])).toEqual([['reason', 'probe'], ['persistent-conversation', 'conformance']])
    })

    it('runs one turn of a session at a time', async () => {
      const { ctx } = await boot({ script: { holdMs: 1000 } })
      const first = turn(ctx, 'o1', 'one', 'ses_b')
      expect(() => turn(ctx, 'o2', 'two', 'ses_b')).toThrow(/turn in flight/)
      expect(await settle(ctx, first)).toMatchObject({ status: 'completed' })
      expect(await settle(ctx, turn(ctx, 'o2', 'two', 'ses_b'))).toMatchObject({ status: 'completed' })
    })

    it('fails a turn past its bounds, with nothing sent: the row\'s default, and an entry\'s own (INV-9)', async () => {
      const capped = await boot({ workers: { maxSessionTurns: 2 } })
      await settle(capped.ctx, turn(capped.ctx, 'c1', 'one', 'ses_c'))
      await settle(capped.ctx, turn(capped.ctx, 'c2', 'two', 'ses_c'))
      expect(await settle(capped.ctx, turn(capped.ctx, 'c3', 'three', 'ses_c'))).toMatchObject({ status: 'failed', error: { kind: 'invalid_input', message: expect.stringMatching(/would have 3 turns; fast allows 2 \(maxSessionTurns\)/) } })
      expect(capped.fake.calls).toHaveLength(2)
      // The local model's own, smaller bound: a history of more than 10 characters is not replayed to it.
      const small = await boot()
      ;(small.fake as unknown as { config: { catalog: ModelEntry[] } }).config.catalog = CATALOG_W.map((m) => (m.id === 'private' ? { ...m, maxHistoryChars: 10 } : m))
      await settle(small.ctx, turn(small.ctx, 'h1', 'a long first prompt', 'ses_d', 'model:private'))
      expect(await settle(small.ctx, turn(small.ctx, 'h2', 'two', 'ses_d', 'model:private'))).toMatchObject({ status: 'failed', error: { kind: 'invalid_input', message: expect.stringMatching(/replays at most 10 \(maxHistoryChars\)/) } })
      expect(small.fake.calls).toHaveLength(1)
    })

    it('ends a transcript only with its session: a reset or release clears it, and a call\'s own retention never does', async () => {
      const { ctx, fake } = await boot()
      const source = ctx.workers.source('models')!
      await settle(ctx, turn(ctx, 'e1', 'one', 'ses_e'))
      // Its call expires, as retention removes finished calls: the live session keeps its turn.
      ctx.store.db.prepare("DELETE FROM model_calls WHERE status IN ('completed', 'failed')").run()
      await settle(ctx, turn(ctx, 'e2', 'two', 'ses_e'))
      expect(seen(fake).at(-1)).toEqual(['user:one', 'assistant:echo: one'])
      // A turn accepted before a reset is not replayed as if nothing had happened.
      const stale = turn(ctx, 'e3', 'three', 'ses_e')
      expect(source.reset!('ses_e')).toBe(true)
      expect(await settle(ctx, stale)).toMatchObject({ status: 'failed', error: { kind: 'invalid_input', message: expect.stringMatching(/changed after this turn was accepted/) } })
      await settle(ctx, turn(ctx, 'e4', 'fresh', 'ses_e'))
      expect(seen(fake).at(-1)).toEqual([])
      source.release!(['ses_e'], 'run deleted')
      expect(source.handle!('ses_e')).toBeUndefined()
    })

    it('labels a session\'s answers as sensitive as all it replayed, and never moves a session to another locality (REQ-WRK-7, INV-12)', async () => {
      // The operator lets the local model take local-private data, and never the remote one.
      const { ctx, fake } = await boot({ egress: { workerClasses: { model: ['public', 'operator-shared'], 'model-local': ['public', 'operator-shared', 'local-private'] } } })
      expect(await settle(ctx, turn(ctx, 'g1', 'my diary', 'ses_g', 'model:private', 'local-private'))).toMatchObject({ status: 'completed' })
      // A public question in that session is answered from the diary: its answer is local-private too.
      const second = await settle(ctx, turn(ctx, 'g2', 'summarize it', 'ses_g', 'model:private', 'public'))
      expect(ctx.artifacts.get(second.result!)!.classification).toBe('local-private')
      const egress = second.decisions.map((id) => ctx.artifacts.get(id)!.body as { decisionType: string; outcome: { detail: { classification?: string } } }).find((d) => d.decisionType === 'egress')!
      expect(JSON.stringify(egress)).toContain('local-private')
      // The remote model never takes over the session.
      expect(() => turn(ctx, 'g3', 'and now?', 'ses_g', 'model:fast', 'public')).toThrow(/escalation within its family and locality/)
      expect(fake.calls).toHaveLength(2)
    })

    it('stays on its model, and escalates only within its family and locality, replaying the history', async () => {
      const { ctx, fake } = await boot()
      await ctx.workers.list()
      const source = ctx.workers.source('models')!
      await settle(ctx, turn(ctx, 'x1', 'one', 'ses_x', 'model:fast'))
      expect(source.affinity!('ses_x')).toEqual(['model:fast', 'model:strong'])
      // The same tier elsewhere is no escalation.
      expect(() => turn(ctx, 'x2', 'two', 'ses_x', 'model:private')).toThrow(/escalation/)
      expect(await settle(ctx, turn(ctx, 'x3', 'two', 'ses_x', 'model:strong'))).toMatchObject({ status: 'completed' })
      expect(seen(fake).at(-1)).toEqual(['user:one', 'assistant:echo: one'])
    })

    it('appends nothing for a turn that finishes after its session was released or reset, and a reset keeps the session on its model', async () => {
      const { ctx, fake } = await boot()
      const source = ctx.workers.source('models')!
      await settle(ctx, turn(ctx, 'y1', 'one', 'ses_y'))
      fake.script.holdMs = 800
      const late = turn(ctx, 'y2', 'two', 'ses_y')
      await expect.poll(() => fake.calls.length).toBe(2)
      expect(source.reset!('ses_y')).toBe(true)
      expect(await settle(ctx, late)).toMatchObject({ status: 'completed' })
      expect(ctx.eventLog.query({ type: 'models.session.turn-dropped' })).toEqual([expect.objectContaining({ data: expect.objectContaining({ reason: 'the session was reset' }) })])
      // Still on its model, and starting over: the late turn did not join.
      expect(source.affinity!('ses_y')).toEqual(expect.arrayContaining(['model:fast']))
      fake.script.holdMs = 0
      await settle(ctx, turn(ctx, 'y3', 'fresh', 'ses_y'))
      expect(seen(fake).at(-1)).toEqual([])
      // Released while a turn runs: the session is gone, and stays gone.
      fake.script.holdMs = 800
      const orphan = turn(ctx, 'y4', 'four', 'ses_y')
      await expect.poll(() => fake.calls.length).toBe(4)
      source.release!(['ses_y'], 'run deleted')
      expect(await settle(ctx, orphan)).toMatchObject({ status: 'completed' })
      expect(source.handle!('ses_y')).toBeUndefined()
      expect(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM model_session_turns WHERE session_id = ?').get('ses_y')).toEqual({ n: 0 })
    })

    it('a compaction (a reset) frees a long session\'s history before its bound fails it (INV-9)', async () => {
      const { ctx } = await boot({ workers: { maxHistoryChars: 40 } })
      const source = ctx.workers.source('models')!
      await settle(ctx, turn(ctx, 'z1', 'a fairly long first prompt', 'ses_z'))
      // The session layer compacts it into a handoff: the turns go, the session stays.
      source.reset!('ses_z')
      expect(await settle(ctx, turn(ctx, 'z2', 'the handoff, and a fairly long second prompt', 'ses_z'))).toMatchObject({ status: 'completed' })
    })

    it('lets model Workers be team members: each member keeps its own session across its turns (one family, recorded)', async () => {
      // Two members of one family on model Workers, each answering in its own session.
      const answer = (prompt: string): string => (prompt.includes('Answer on your own')
        ? `My proposal.\n${JSON.stringify({ recommendation: `option of ${/member (\d)/.exec(prompt)?.[1]}`, rationale: 'it fits', risks: [] })}`
        : JSON.stringify({ choice: 'O1', ranking: ['O1', 'O2'], rationale: 'I prefer O1', evidence: [], strongest: { O2: 'it is simpler' }, objections: [], confidence: 'high' }))
      const { ctx, fake } = await boot({ script: { answer }, workflow: { allowSameFamily: true } })
      const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'brainstorm', input: 'Which store?', classification: 'public' }).runId, 30_000)
      expect(done.status).toBe('completed')
      // Each member's ballot replays its own proposal, and nobody else's.
      const ballots = fake.calls.filter((c) => !c.prompt.includes('Answer on your own'))
      expect(ballots.length).toBeGreaterThanOrEqual(2)
      for (const b of ballots) {
        expect(b.history).toHaveLength(2)
        expect(b.history![0]!.text).toContain('Answer on your own')
      }
      expect(new Set(ballots.map((b) => b.history![1]!.text)).size).toBe(ballots.length)
    })

    it('after a restart, re-sends a session turn with exactly the history it was accepted with', async () => {
      const first = await boot()
      await settle(first.ctx, turn(first.ctx, 'r1', 'one', 'ses_r'))
      first.fake.script.holdMs = 60_000
      const held = turn(first.ctx, 'r2', 'two', 'ses_r')
      await expect.poll(() => first.fake.calls.length).toBe(2)
      await first.stop()
      const second = await boot({ dir: first.dir })
      expect(await second.ctx.workers.source('models')!.wait(held.id, 10_000)).toMatchObject({ status: 'completed' })
      expect(seen(second.fake)).toEqual([['user:one', 'assistant:echo: one']])
    })
  })

  it('checks egress on the exact prompt: a remote model never receives local-private data; a credential never leaves (INV-12)', async () => {
    const { ctx, fake } = await boot()
    const source = ctx.workers.source('models')!
    const denied = await settle(ctx, source.start({ key: 'p-1', worker: 'model:fast', prompt: 'my diary', requirement: requirement({ data: { classification: 'local-private', refs: [] } }), decisions: DECISIONS }))
    expect(denied).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'egress_denied' } })
    const egress = ctx.artifacts.get(denied.decisions[0]!)!.body as { outcome: { option: string; detail: { workerClass: string } } }
    expect(egress.outcome).toMatchObject({ option: 'deny', detail: { workerClass: 'model' } })
    // A model the catalog calls local gets local-private data only once the operator also widens its
    // class: `locality` alone is one unchecked field (INV-12).
    const unwidened = await settle(ctx, source.start({ key: 'p-0', worker: 'model:private', prompt: 'my diary', requirement: requirement({ data: { classification: 'local-private', refs: [] } }), decisions: DECISIONS }))
    expect(unwidened).toMatchObject({ status: 'failed', error: { kind: 'egress_denied' } })
    const widened = await boot({ egress: { workerClasses: { model: ['public', 'operator-shared'], 'model-local': ['public', 'operator-shared', 'local-private'] } } })
    const local = await settle(widened.ctx, widened.ctx.workers.source('models')!.start({ key: 'p-2', worker: 'model:private', prompt: 'my diary', requirement: requirement({ data: { classification: 'local-private', refs: [] } }), decisions: DECISIONS }))
    expect(local).toMatchObject({ status: 'completed' })
    expect((widened.ctx.artifacts.get(local.decisions[0]!)!.body as { outcome: { detail: { workerClass: string } } }).outcome.detail.workerClass).toBe('model-local')
    // ...but a credential in the payload is refused whatever the class.
    const secret = await settle(ctx, source.start({ key: 'p-3', worker: 'model:private', prompt: `key ${awsKeyId()} here`, requirement: requirement(), decisions: DECISIONS }))
    expect(secret).toMatchObject({ status: 'failed', error: { kind: 'egress_denied' } })
    // Nothing reached the model where the class was not widened; the widened one got the diary once.
    expect(fake.calls).toEqual([])
    expect(widened.fake.calls.map((c) => c.prompt)).toEqual(['my diary'])
    // Routing keeps local-private work off remote models in the first place.
    expect((await ctx.workers.route(requirement({ data: { classification: 'local-private', refs: [] } }))).worker.worker).toBe('model:private')
  })

  it('bounds every call: the requirement\'s token budget reaches the model, and a call past its deadline fails as timeout (INV-9)', async () => {
    const { ctx, fake } = await boot({ script: {}, workers: { callTimeoutMs: 50 } })
    const source = ctx.workers.source('models')!
    const short = await settle(ctx, source.start({ key: 'b-1', worker: 'model:fast', prompt: 'short', requirement: requirement({ budget: { maxTokens: 16 } }), decisions: DECISIONS }))
    expect(fake.calls[0]).toMatchObject({ model: 'fast', maxTokens: 16 })
    expect(ctx.artifacts.get(short.result!)!.body).toMatchObject({ maxTokens: 16 })
    fake.script.holdMs = 1_000
    const slow = await settle(ctx, source.start({ key: 'b-2', worker: 'model:fast', prompt: 'slow', requirement: requirement(), decisions: DECISIONS }))
    expect(slow).toMatchObject({ status: 'failed', submitted: true, error: { kind: 'timeout' } })
    expect(slow.error!.message).toBe('model:fast did not finish within 50 ms (callTimeoutMs, the ceiling over every attempt); the call was stopped')
  })

  it('maps a failure to its class: a refused key needs the operator, a rate limit backs off', async () => {
    const { ctx } = await boot({ script: { fail: ['credential', 'rate-limit'] } })
    const source = ctx.workers.source('models')!
    expect(await settle(ctx, source.start({ key: 'f-1', worker: 'model:fast', prompt: 'a', requirement: requirement(), decisions: DECISIONS }))).toMatchObject({ error: { kind: 'reauth_required', disposition: 'USER_ACTION' } })
    expect(await settle(ctx, source.start({ key: 'f-2', worker: 'model:fast', prompt: 'b', requirement: requirement(), decisions: DECISIONS }))).toMatchObject({ error: { kind: 'overloaded', disposition: 'BACKOFF' } })
  })

  it('cancels (REQ-WRK-4): a running call is aborted, a queued one is never sent', async () => {
    const { ctx, fake } = await boot({ script: { holdMs: 5_000 }, workers: { maxConcurrentCalls: 1 } })
    const source = ctx.workers.source('models')!
    const running = source.start({ key: 'c-1', worker: 'model:fast', prompt: 'one', requirement: requirement(), decisions: DECISIONS })
    const queued = source.start({ key: 'c-2', worker: 'model:fast', prompt: 'two', requirement: requirement(), decisions: DECISIONS })
    await expect.poll(() => fake.calls.length).toBe(1)
    expect(source.cancel!(queued.id)).toBe(true)
    expect(source.cancel!(running.id)).toBe(true)
    expect(await settle(ctx, running)).toMatchObject({ status: 'failed', error: { kind: 'aborted' } })
    expect(await settle(ctx, queued)).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'aborted' } })
    expect(fake.calls.map((c) => c.prompt)).toEqual(['one'])
  })

  it('after a restart, a call that was running is sent once more, and never a third time (INV-4)', async () => {
    const first = await boot({ script: { holdMs: 60_000 } })
    const source = first.ctx.workers.source('models')!
    const call = source.start({ key: 'r-1', worker: 'model:fast', prompt: 'restart me', requirement: requirement(), decisions: DECISIONS })
    await expect.poll(() => first.fake.calls.length).toBe(1)
    await first.stop()
    // Stopped again while answering: the second send is the last.
    const second = await boot({ dir: first.dir, script: { holdMs: 60_000 } })
    await expect.poll(() => second.fake.calls.length).toBe(1)
    expect(second.ctx.workers.source('models')!.get(call.id)).toMatchObject({ status: 'running', submitted: true })
    await second.stop()
    const third = await boot({ dir: first.dir })
    const failed = await third.ctx.workers.source('models')!.wait(call.id, 10_000)
    expect(failed).toMatchObject({ status: 'failed', error: { kind: 'reconciliation_failed' } })
    expect(third.fake.calls).toHaveLength(0)
    // Each decision is recorded (INV-13): resend after the first stop, fail after the second.
    const outcomes = failed.decisions.map((id) => third.ctx.artifacts.get(id)!.body as { decisionType: string; outcome: { option: string } })
      .filter((d) => d.decisionType === 'reconciliation').map((d) => d.outcome.option)
    expect(outcomes).toEqual(['resend', 'fail'])
    expect(third.ctx.eventLog.query({ type: 'models.call.abandoned' })).toHaveLength(1)
  })

  it('a restart re-sends an interrupted call once and completes it', async () => {
    const first = await boot({ script: { holdMs: 60_000 } })
    const call = first.ctx.workers.source('models')!.start({ key: 'r-2', worker: 'model:fast', prompt: 'again', requirement: requirement(), decisions: DECISIONS })
    await expect.poll(() => first.fake.calls.length).toBe(1)
    await first.stop()
    const second = await boot({ dir: first.dir })
    const done = await second.ctx.workers.source('models')!.wait(call.id, 10_000)
    expect(done).toMatchObject({ status: 'completed' })
    expect(second.fake.calls.map((c) => c.prompt)).toEqual(['again'])
    // The resend is a recorded decision and an event, egress is checked again, and the answer
    // says it was the second send (INV-4, INV-12, INV-13).
    const kinds = done.decisions.map((id) => (second.ctx.artifacts.get(id)!.body as { decisionType: string }).decisionType)
    expect(kinds).toEqual(['egress', 'reconciliation', 'egress'])
    expect(second.ctx.eventLog.query({ type: 'models.call.resent' })).toHaveLength(1)
    expect(second.ctx.artifacts.get(done.result!)!.body).toMatchObject({ sends: 2, attempts: 1 })
  })

  it('with only model Workers, templates that need website capabilities fail admission with the reason (ADR-0025, INV-2)', async () => {
    // A model frames the question (in the run's conversation, ADR-0031); the cited reviews need the web.
    const framed = '```json\n' + JSON.stringify({ question: 'Does caffeine improve recall?', hypotheses: [{ id: 'H1', statement: 'Caffeine improves recall.' }] }) + '\n```'
    const { ctx, fake } = await boot({ research: true, script: { answer: () => framed } })
    for (const [variant, capability] of [['deep', 'deep-research'], [undefined, 'web-search']] as const) {
      const run = ctx.workflow.start({ template: 'research', variant, input: 'Does caffeine improve recall?', classification: 'public' })
      const done = await ctx.workflow.wait(run.runId, 10_000)
      expect(done.status).toBe('failed')
      expect(done.nodes.find((n) => n.nodeId === 'literature:1')!.error!.message).toMatch(new RegExp(`^no Worker can take this work: no Worker proves ${capability}\\b`))
    }
    // Only the framing steps ran on a model; nothing was sent for the website-only steps.
    expect(fake.calls).toHaveLength(2)
  })
})

describe('the models row', () => {
  it('mounts ctx.models and the Worker source from one catalog; an empty catalog contributes no Worker', async () => {
    const server = await fakeOpenAi()
    const { ctx, fibers } = await llmRows(server)
    const dir = temp('system-models-row-')
    fibers.push(
      ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}), ctx.plugin(WorkerRouter, {}),
      ctx.plugin(Models, { models: [{ id: 'fast', route: 'fake', model: 'm1', tier: 'economy', quotaClass: 'metered', locality: 'remote', maxTokens: 4096 }] }),
    )
    await Promise.all(fibers)
    onTestFinished(async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
      await server.close()
    })
    await expect.poll(async () => (await ctx.workers.list()).map((w) => [w.worker, w.state, w.quotaClass, w.locality])).toEqual([['model:fast', 'ready', 'metered', 'remote']])
    const empty = new Context()
    const store = mkdtempSync(join(tmpdir(), 'system-models-empty-'))
    onTestFinished(() => rmSync(store, { recursive: true, force: true }))
    const parts = [empty.plugin(LlmRuntime), empty.plugin(Store, { path: join(store, 'system.db') }), empty.plugin(Artifacts, {}), empty.plugin(Leases, {}), empty.plugin(Egress, {}), empty.plugin(WorkerRouter, {}), empty.plugin(Models, { models: [] })]
    await Promise.all(parts)
    onTestFinished(async () => {
      for (const fiber of [...parts].reverse()) await fiber.dispose()
    })
    await expect.poll(async () => empty.get('models') !== undefined).toBe(true)
    expect(await empty.workers.list()).toEqual([])
  })

  it('bounds a call twice: a silence bound per attempt for a stalled stream, and a ceiling over every attempt (INV-9)', async () => {
    // The defaults: a call that answered under the old five-minute deadline was never silent longer.
    expect(Models.Config({ models: [] })).toMatchObject({ idleTimeoutMs: 300_000, callTimeoutMs: 900_000, maxRetries: 2 })
    expect(() => Models.Config({ models: [], idleTimeoutMs: 0 })).toThrow()
    // The row hands its silence bound to ctx.models.
    const server = await fakeOpenAi()
    const { ctx, fibers } = await llmRows(server)
    const dir = temp('system-models-idle-')
    fibers.push(
      ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}), ctx.plugin(WorkerRouter, {}),
      ctx.plugin(Models, { models: [{ id: 'fast', route: 'fake', model: 'm1', tier: 'economy', quotaClass: 'metered', locality: 'remote', maxTokens: 64 }], maxRetries: 0, idleTimeoutMs: 100 }),
    )
    await Promise.all(fibers)
    onTestFinished(async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
      await server.close()
    })
    await expect.poll(async () => ctx.get('models') !== undefined).toBe(true)
    server.script.push({ holdMs: 5_000 })
    await expect(ctx.models.complete({ model: 'fast', prompt: 'x' })).rejects.toThrow(/no progress for 100 ms \(idleTimeoutMs\)/)
  })
})
