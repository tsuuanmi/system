import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import { type ArtifactRef, type DigestBody, digestTool, digestToolHandlers, type DigestView } from '@tsuuanmi/system-digest-core'
import EventLog from '@tsuuanmi/system-event-log'
import { McpTools, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import Leases from '@tsuuanmi/system-leases'
import { type Brief, SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerRouter from '@tsuuanmi/system-workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BENCH, type Drafter, FakeDigests, LOG } from '../../../digest-core/conformance/digests.ts'
import { DigestWorker } from '../../../digest-core/conformance/worker.ts'
import ExtractiveDigests, { type Config, type DigestExtract } from '../src/index.ts'
import { sourcesOfExtract } from './helpers.ts'

vi.setConfig({ testTimeout: 60_000 })
const schemas = new SchemaRegistry()
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/** A test log longer than what the Worker is given: 60 passing tests, two failures, a warning, and its totals. */
const LONG_LOG = [
  'RUN v4.1.11 /work/align',
  ...Array.from({ length: 60 }, (_, i) => `  ✓ tests/align/case-${i}.spec.ts (${i + 3} ms)`),
  '  × tests/align/end-gaps.spec.ts > scores a gap at the end (12 ms)',
  'AssertionError: expected -3 to be -2',
  'WARN tests/align/slow.spec.ts took 4.2 s',
  'Tests  2 failed | 60 passed (62)',
].join('\n')

/** A Worker that cites by extract id, as the brief asks: each extract line whose quote matches `pick`. */
const citing = (pick: RegExp, extra: Record<string, unknown> = {}): Drafter => (_sources, _tier, prompt = '') => {
  const lines = [...prompt.matchAll(/^(E\d+) S\d+: (.*)$/gm)].filter((m) => pick.test(m[2]!))
  const claims = lines.map((m, i) => ({ id: `C${i + 1}`, kind: 'failure', text: `Extract ${m[1]} says what failed.`, extract: m[1] }))
  return { text: `\`\`\`json\n${JSON.stringify({ status: 'failed', summary: 'Two end-gap checks fail.', claims, ...extra })}\n\`\`\`` }
}

/** The provider over real routing and leases, a scripted digest Worker, and three raw artifacts. */
async function boot(drafter: Drafter | undefined, config: Config = {}, before: (ctx: Context) => Fiber[] = () => []) {
  const dir = mkdtempSync(join(tmpdir(), 'system-digest-extractive-'))
  const ctx = new Context()
  const worker = new DigestWorker(drafter, sourcesOfExtract)
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(WorkerRouter, {}),
    ctx.plugin({ name: 'digest-worker', inject: ['workers', 'artifacts'], apply: (c: Context) => void c.workers.register(worker.source(c)) }),
  ]
  await Promise.all(fibers)
  fibers.push(...before(ctx))
  await Promise.all(fibers)
  let provider = ctx.plugin(ExtractiveDigests, config)
  await provider
  const raw = (text: string, classification: 'public' | 'operator-shared' = 'operator-shared'): ArtifactRef => ctx.artifacts.put({
    kind: 'report', bodySchema: 'provider-answer@1.0', classification, producer: { type: 'worker', ref: 'w:raw' },
    body: { schema: 'provider-answer@1.0', provider: 'raw', account: 'raw', turnId: `t-${text.length}`, conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text },
  }).id as ArtifactRef
  const refs = { log: raw(LONG_LOG), bench: raw(BENCH, 'public'), short: raw(LOG) }
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), async () => {
    await provider.dispose()
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  return {
    ctx, worker, raw, ...refs,
    /** Stop the provider, run `between` while it is down, and start it again on the same store. */
    restart: async (between?: () => void) => {
      await provider.dispose()
      between?.()
      provider = ctx.plugin(ExtractiveDigests, config)
      await provider
    },
  }
}

const until = async (check: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 30_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const settled = async (ctx: Context, view: DigestView): Promise<DigestView> => ctx.digests.wait(view.requestId, 30_000)
const decisionInputs = (ctx: Context, view: DigestView): string[] => (ctx.artifacts.get(view.decision!)!.body as { inputs: string[] }).inputs

describe('ctx.digests, extractive-first', () => {
  it('records the extract before the Worker runs and gives the Worker only the extract, by content id in its brief; a claim citing an extract is written with that extract\'s quote and offset (INV-12, INV-13)', async () => {
    const { ctx, worker, log, bench } = await boot(citing(/×|AssertionError/), { maxExtracts: 8 })
    const view = await settled(ctx, await ctx.digests.request({ sources: [log, bench] }))
    expect(view).toMatchObject({ state: 'written', worker: 'w:digest', claims: { kept: 2, dropped: 0 } })
    expect(view.requestId).toMatch(/^dgx-/)

    // The brief points at the extract, never at a source or its content.
    const brief = ctx.artifacts.get(view.brief!)!
    expect(brief).toMatchObject({ kind: 'objective', bodySchema: 'brief@1.1' })
    const body = brief.body as Brief
    schemas.assertRecord(body)
    expect(body.artifacts).toHaveLength(1)
    const extractRef = body.artifacts[0]!.ref as ArtifactRef
    expect(brief.inputs).toEqual([extractRef])
    expect(JSON.stringify(body)).not.toContain('end-gaps')

    // The extract: an evidence artifact over exactly the sources, as strict as the strictest, within maxExtracts.
    const envelope = ctx.artifacts.get(extractRef)!
    expect(envelope).toMatchObject({ kind: 'evidence', bodySchema: 'digest-extract@1.0', classification: 'operator-shared' })
    expect(envelope.inputs).toEqual([log, bench].sort())
    const extract = envelope.body as DigestExtract
    schemas.assertRecord(extract)
    expect(extract.extracts).toHaveLength(8)
    expect(extract.sources.map((s) => [s.ref, s.spans])).toEqual([[log, 65], [bench, 1]])

    // The Worker read the extract and no line left out of it.
    const [run] = worker.started
    expect(run!.prompt).toContain(`<extracts id="${extractRef}">\n${extract.text}\n</extracts>`)
    expect(run!.prompt).toContain('AssertionError: expected -3 to be -2')
    expect(run!.prompt).not.toContain('case-30.spec.ts')
    expect(run!.prompt).not.toContain('"$schema"')

    // Each claim's citation is the extract's, verbatim at its offset in the source.
    const digest = ctx.artifacts.get(view.digest!)!.body as DigestBody
    schemas.assertRecord(digest)
    const cited = extract.extracts.filter((e) => /×|AssertionError/.test(e.quote))
    expect(digest.claims.map((c) => c.citation)).toEqual(cited.map((e) => ({ artifact: log, quote: e.quote, offset: e.offset })))
    expect(decisionInputs(ctx, view)).toEqual(expect.arrayContaining([log, bench, extractRef, view.digest!]))
  })

  it('drops a claim citing an extract it was not given, saying so, and keeps the others', async () => {
    const drafter: Drafter = (sources, tier, prompt) => {
      const answer = JSON.parse(/```json\n(.*)\n```/s.exec((citing(/AssertionError/)(sources, tier, prompt) as { text: string }).text)![1]!) as { claims: unknown[] }
      answer.claims.push({ id: 'C9', kind: 'risk', text: 'Invented.', extract: 'E99' })
      return { text: `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`` }
    }
    const { ctx, log } = await boot(drafter)
    const view = await settled(ctx, await ctx.digests.request({ sources: [log] }))
    expect(view).toMatchObject({ state: 'written', claims: { kept: 1, dropped: 1 } })
    const digest = ctx.artifacts.get(view.digest!)!.body as DigestBody
    expect(digest.dropped).toEqual([{ what: 'claim C9', why: 'dropped by the quote check: it cites extract E99 (not given), which is not one of the digested artifacts' }])
  })

  it('asks no Worker when the sources hold no text to quote, and fails open (ADR-0036)', async () => {
    const { ctx, worker, raw } = await boot(citing(/./))
    const blank = raw(' \n\t\n')
    const view = await settled(ctx, await ctx.digests.request({ sources: [blank] }))
    expect(view).toMatchObject({ state: 'bypassed', reason: expect.stringMatching(/no text to quote/) })
    expect(worker.started).toHaveLength(0)
  })

  it('asks for a Worker of its tier only: with none, it fails open, naming the admission decision and the extract it would have given (ADR-0036, INV-11)', async () => {
    const { ctx, worker, log } = await boot(citing(/./))
    worker.tiers = ['standard']
    const view = await settled(ctx, await ctx.digests.request({ sources: [log] }))
    expect(view).toMatchObject({ state: 'bypassed', reason: expect.stringMatching(/read-only Worker on the economy tier/) })
    expect(worker.started).toHaveLength(0)
    const kinds = decisionInputs(ctx, view).map((ref) => ctx.artifacts.get(ref)!).map((a) => (a.bodySchema === 'digest-extract@1.0' ? 'extract' : (a.body as { decisionType?: string }).decisionType ?? 'source'))
    expect(kinds.sort()).toEqual(['admission', 'extract', 'source'])
  })

  it('escalates once to the standard tier on the same extract when every economy claim fails, its run keyed apart (PROP-0008, INV-13)', async () => {
    const drafter: Drafter = (sources, tier, prompt) => (tier === 'economy'
      ? { text: '```json\n{"status": "failed", "summary": "s", "claims": [{"id": "C1", "kind": "failure", "text": "t", "extract": "E77"}]}\n```' }
      : citing(/AssertionError/)(sources, tier, prompt))
    const { ctx, worker, log } = await boot(drafter)
    const view = await settled(ctx, await ctx.digests.request({ sources: [log] }))
    expect(view).toMatchObject({ state: 'written', worker: 'w:digest:standard', claims: { kept: 1, dropped: 0 } })
    expect(worker.started.map((s) => [s.tier, s.key])).toEqual([['economy', `digests:${view.requestId}`], ['standard', `digests:${view.requestId}:standard`]])
    const briefs = worker.started.map((s) => (ctx.artifacts.get(s.brief!)!.body as Brief).artifacts[0]!.ref)
    expect(briefs[0]).toBe(briefs[1])
    expect(decisionInputs(ctx, view)).toContain(view.escalation)
  })

  it('goes on with a pending request after a restart, never starting its Worker run twice (INV-4)', async () => {
    const { ctx, worker, log, restart } = await boot(citing(/AssertionError/))
    worker.hold = true
    const requested = await ctx.digests.request({ sources: [log] })
    await until(() => worker.started.length === 1, 'the digest run')
    await restart()
    worker.release(worker.started[0]!.id)
    const view = await settled(ctx, requested)
    expect(view.state).toBe('written')
    expect(worker.started).toHaveLength(1)
  })

  it('cancels a run that outlives timeoutMinutes and bypasses its request; bounds the requests pending at once (INV-9)', async () => {
    const { ctx, worker, log, bench, restart } = await boot(citing(/./), { maxPending: 1 })
    worker.hold = true
    const requested = await ctx.digests.request({ sources: [log] })
    await expect(ctx.digests.request({ sources: [bench] })).rejects.toMatchObject({ failure: 'overloaded' })
    await until(() => worker.started.length === 1, 'the digest run')
    await restart(() => ctx.store.db.prepare('UPDATE extractive_digest_requests SET created_at = ? WHERE request_id = ?').run(new Date(Date.now() - 2 * 3_600_000).toISOString(), requested.requestId))
    const view = await settled(ctx, requested)
    expect(view).toMatchObject({ state: 'bypassed', reason: expect.stringMatching(/did not finish within 30 minutes/) })
    expect(worker.cancelled).toEqual([worker.started[0]!.id])
  })

  it('serves the seam\'s digests_request and digests_get to the lead, each input and output checked against mcp-digests@1.0', async () => {
    const tools = new Map<string, { spec: ToolSpec; handler: ToolHandler }>()
    class RecordingMcp extends McpTools {
      tool(name: string, spec: ToolSpec, handler: ToolHandler): void {
        tools.set(name, { spec, handler })
      }
    }
    const { ctx, short, bench } = await boot((sources) => ({ text: `\`\`\`json\n${JSON.stringify({ status: 'partial', summary: 's', claims: [{ id: 'C1', kind: 'failure', text: 't', citation: { artifact: sources[0], quote: 'FAIL tests/align/end-gaps.spec.ts (2 failed)' } }] })}\n\`\`\`` }), {}, (c) => [c.plugin(RecordingMcp)])
    await until(() => tools.size === 2, 'the tools')
    expect([...tools].map(([name, t]) => [name, t.spec.scope])).toEqual([['digests_request', 'client'], ['digests_get', 'client']])
    const written = await tools.get('digests_request')!.handler({ sources: [short, bench], clientRequestId: 'r1', waitSeconds: 30 }, { scope: 'client' })
    const view = written.structuredContent as unknown as DigestView
    expect(view).toMatchObject({ state: 'written', claims: { kept: 1, dropped: 0 } })
    schemas.assertDef('mcp-digests@1.0', 'digests-request-output', view)
    expect((await digestTool('digests_get', digestToolHandlers(ctx.digests).digests_get)({ requestId: view.requestId }, { scope: 'client' })).structuredContent).toEqual(view)
    expect(await tools.get('digests_request')!.handler({ sources: ['the test log'] }, { scope: 'client' })).toMatchObject({ isError: true })
  })

  it('runs as the one provider of ctx.digests: beside another, it does not start, and the other keeps serving (INV-1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-digest-extractive-'))
    const ctx = new Context()
    const fibers: Fiber[] = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(Leases, {}), ctx.plugin(WorkerRouter, {})]
    await Promise.all(fibers)
    fibers.push(ctx.plugin(FakeDigests, {}))
    await fibers.at(-1)
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }), async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
    })
    const second = ctx.plugin(ExtractiveDigests, {})
    fibers.push(second)
    await expect(Promise.resolve(second)).rejects.toThrow(/service "digests" has been registered at <FakeDigests>/)
    expect(ctx.digests).toBeInstanceOf(FakeDigests)
  })
})
