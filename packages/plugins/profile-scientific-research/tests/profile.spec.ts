import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter, { type WorkerExecution } from '@tsuuanmi/system-workers'
import Workflow from '@tsuuanmi/system-workflow'
import { afterEach, describe, expect, it } from 'vitest'
import * as Science from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'system-science-'))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, { retryDelayMs: 100 }),
  ]
  await Promise.all(fibers)
  cleanups.push(async () => { for (const f of [...fibers].reverse()) await f.dispose() }, () => rmSync(dir, { recursive: true, force: true }))
  return ctx
}

const json = (value: unknown) => '```json\n' + JSON.stringify(value) + '\n```'
const HYPOTHESES = { question: 'Does X lower Y?', hypotheses: [{ id: 'H1', statement: 'X lowers Y.' }, { id: 'H2', statement: 'The effect is from Z.' }] }
const EVIDENCE = { evidence: [{ id: 'E1', claim: 'A trial found X lowered Y.', source: 'https://example.org/trial', bears: [{ hypothesis: 'H1', direction: 'supports' }], strength: 'moderate' }] }

/** A scripted chat Worker that answers each study step, and records the prompts. */
function scholar(ctx: Context): string[] {
  const prompts: string[] = []
  const executions = new Map<string, WorkerExecution>()
  ctx.workers.register({
    name: 'chat',
    describe: async () => [{ schema: 'capability-descriptor@1.0', worker: 'chat:a', provider: 'test', tier: 'standard', quotaClass: 'subscription-chat', locality: 'remote',
      capabilities: [{ capability: 'reason', evidence: { kind: 'conformance', at: '2026-10-12T00:00:00Z' } }, { capability: 'web-search', evidence: { kind: 'probe', at: '2026-10-12T00:00:00Z' } }], state: 'ready', observedAt: '2026-10-12T00:00:00Z' }],
    start: (request) => {
      prompts.push(request.prompt)
      const p = request.prompt
      const text = p.includes('Frame the research question') ? json(HYPOTHESES)
        : p.includes('Review the published evidence') ? 'One trial (n=120) found X lowered Y: https://example.org/trial'
          : p.includes('Extract an evidence table') ? json(EVIDENCE)
            : p.includes('independent critic') ? 'E1 is a single trial; its strength is at most moderate.'
              : `H1 is supported with moderate confidence [${p.includes('"E2"') ? 'E2' : 'E1'}]. H2 is insufficient.`
      const result = ctx.artifacts.put({ kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'operator-shared', producer: { type: 'worker', ref: 'chat:a' },
        body: { schema: 'provider-answer@1.0', provider: 'test', account: 'a', turnId: `t-${prompts.length}`, conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text } }).id
      const execution: WorkerExecution = { id: `chat-${prompts.length}`, status: 'completed', submitted: true, result: result as `sha256:${string}`, decisions: [] }
      executions.set(execution.id, execution)
      return execution
    },
    get: (id) => executions.get(id),
    wait: async (id) => executions.get(id)!,
  })
  return prompts
}

const { profileConformance } = await import('../../workflow/conformance/profiles.ts')
profileConformance('scientific-research', async () => ({ ctx: await boot(), dispose: async () => undefined }), Science, { research: Science.RESEARCH })

describe('the scientific-research profile, on the unchanged engine (REQ-WF-9)', () => {
  it('runs the deep variant\'s literature review with Deep research, and refuses a variant it does not have (PROP-0004)', async () => {
    const ctx = await boot()
    await ctx.plugin(Science)
    const deep = ctx.workflow.start({ template: 'research', input: 'Does X lower Y?', variant: 'deep' })
    const plain = ctx.workflow.start({ template: 'research', input: 'Does X lower Y?' })
    expect(deep.nodes.find((n) => n.nodeId === 'literature:1')).toMatchObject({ minTier: 'frontier' })
    expect(plain.nodes.find((n) => n.nodeId === 'literature:1')).toMatchObject({ minTier: 'standard' })
    expect(deep.specHash).not.toBe(plain.specHash)
    expect(() => ctx.workflow.start({ template: 'research', input: 'q', variant: 'fast' })).toThrow('template research has no variant fast (it has: deep)')
    expect(() => ctx.workflow.start({ template: 'research-deep', input: 'q' })).toThrow('unknown workflow template research-deep')
  })

  it('runs research: hypotheses, a cited review, an evidence table, an independent critique, conclusions citing evidence', async () => {
    const ctx = await boot()
    await ctx.plugin(Science)
    const prompts = scholar(ctx)
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'research', input: 'Does X lower Y?' }).runId, 30_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'H1 is supported with moderate confidence [E1]. H2 is insufficient.' })
    expect(done.nodes.map((n) => n.nodeId)).toEqual(['frame:1', 'literature:1', 'evidence:1', 'critique:1', 'conclusion:1'])
    // A structured step is given its schema verbatim, and its result is checked against it (REQ-ART-5).
    expect(prompts[0]).toContain('"$id":"urn:tsuuanmi:system:schema:hypothesis-set:v1"')
    expect(ctx.artifacts.get(ctx.workflow.records(done.runId)[0]!.outputReceipt!.acceptance)!.body).toMatchObject({ candidates: [{ option: 'accept', reasons: ['a valid hypothesis-set@1.0', expect.any(String)] }, expect.anything()] })
    // The critic sees the hypotheses and the evidence, never the review it came from.
    expect(prompts[3]).toContain('"E1"')
    expect(prompts[3]).not.toContain('n=120')
    // Typed artifacts, derived from the accepted results.
    const criteria = ctx.artifacts.list({ kind: 'criteria', runId: done.runId })
    expect(criteria).toHaveLength(1)
    expect(criteria[0]).toMatchObject({ bodySchema: 'hypothesis-set@1.0', body: { schema: 'hypothesis-set@1.0', hypotheses: [{ id: 'H1' }, { id: 'H2' }] } })
    expect(ctx.artifacts.list({ kind: 'evidence', runId: done.runId })[0]).toMatchObject({ bodySchema: 'evidence-table@1.0', inputs: [ctx.workflow.records(done.runId)[2]!.outputReceipt!.result] })
  })

  it('refuses a step result that is not its typed body, before anything downstream runs', () => {
    expect(Science.typedBody(json({ question: 'q', hypotheses: [{ id: 'X1', statement: 's' }] }), 'hypothesis-set@1.0')).toMatchObject({ ok: false })
    expect(Science.typedBody('no json here', 'evidence-table@1.0')).toMatchObject({ ok: false, reason: expect.stringMatching(/no evidence-table/) })
    expect(Science.typedBody(json(EVIDENCE), 'evidence-table@1.0')).toMatchObject({ ok: true })
  })

  it('invalidates on a superseded evidence table: the critique and conclusion run again, and the typed artifact is superseded', async () => {
    const ctx = await boot()
    await ctx.plugin(Science)
    scholar(ctx)
    const run = await ctx.workflow.wait(ctx.workflow.start({ template: 'research', input: 'Does X lower Y?' }).runId, 30_000)
    const corrected = { evidence: [...EVIDENCE.evidence, { id: 'E2', claim: 'A larger trial found no effect.', source: 'https://example.org/big', bears: [{ hypothesis: 'H1', direction: 'refutes' }], strength: 'strong' }] }
    ctx.workflow.supersede(run.runId, 'evidence:1', { text: json(corrected), note: 'a missed trial' })
    const again = await ctx.workflow.wait(run.runId, 30_000)
    expect(again).toMatchObject({ status: 'completed', answer: 'H1 is supported with moderate confidence [E2]. H2 is insufficient.' })
    const tables = ctx.artifacts.list({ kind: 'evidence', runId: run.runId })
    expect(tables).toHaveLength(2)
    expect(tables[1]!.lineage).toEqual({ supersedes: [tables[0]!.id] })
    expect((tables[1]!.body as { evidence: unknown[] }).evidence).toHaveLength(2)
  })
})
