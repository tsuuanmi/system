import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import { type ArtifactRef, digestTool, digestToolHandlers, type DigestView } from '@tsuuanmi/system-digest-core'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { type Brief, SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerRouter from '@tsuuanmi/system-workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BENCH, draft, type Drafter, LOG } from '../../../digest-core/conformance/digests.ts'
import { DigestWorker } from '../../../digest-core/conformance/worker.ts'
import StoreDigests, { type Config } from '../src/index.ts'

vi.setConfig({ testTimeout: 60_000 })
const schemas = new SchemaRegistry()
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/** The provider over real routing and leases, a scripted digest Worker, and two raw artifacts. */
async function boot(drafter: ((refs: { log: ArtifactRef; bench: ArtifactRef }) => Drafter) | undefined, config: Config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-digest-'))
  const ctx = new Context()
  const refs = {} as { log: ArtifactRef; bench: ArtifactRef }
  const worker = new DigestWorker(drafter ? (sources, tier) => drafter(refs)(sources, tier) : undefined)
  const fibers: Fiber[] = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(WorkerRouter, {}),
    ctx.plugin({ name: 'digest-worker', inject: ['workers', 'artifacts'], apply: (c: Context) => void c.workers.register(worker.source(c)) }),
  ]
  await Promise.all(fibers)
  let provider = ctx.plugin(StoreDigests, config)
  await provider
  const raw = (text: string): ArtifactRef => ctx.artifacts.put({
    kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'operator-shared', producer: { type: 'worker', ref: 'w:raw' },
    body: { schema: 'provider-answer@1.0', provider: 'raw', account: 'raw', turnId: `t-${text.length}`, conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text },
  }).id as ArtifactRef
  refs.log = raw(LOG)
  refs.bench = raw(BENCH)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), async () => {
    await provider.dispose()
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  return {
    ctx, worker, ...refs,
    /** Stop the provider, run `between` while it is down, and start it again on the same store. */
    restart: async (between?: () => void) => {
      await provider.dispose()
      between?.()
      provider = ctx.plugin(StoreDigests, config)
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

describe('ctx.digests on the store', () => {
  it('starts its Worker with a brief recorded before the run, pointing at the sources by content id and never carrying their content, which the source renders verbatim', async () => {
    const { ctx, worker, log, bench } = await boot((r) => () => ({ text: draft(r.log, r.bench) }))
    const view = await ctx.digests.wait((await ctx.digests.request({ sources: [log, bench] })).requestId, 30_000)
    expect(view).toMatchObject({ state: 'written', worker: 'w:digest', claims: { kept: 2, dropped: 0 } })
    const [run] = worker.started
    expect(run!.brief).toBe(view.brief)
    expect(run!.requirement).toMatchObject({ capabilities: ['review', 'local-data'], tier: { min: 'economy', max: 'economy' }, data: { refs: [log, bench] }, acceptance: { resultSchema: 'digest@1.0' } })
    const envelope = ctx.artifacts.get(view.brief!)!
    expect(envelope).toMatchObject({ kind: 'objective', bodySchema: 'brief@1.1' })
    expect(envelope.inputs).toEqual([log, bench].sort())
    const brief = envelope.body as Brief
    schemas.assertRecord(brief)
    expect(brief.artifacts.map((p) => [p.ref, p.role])).toEqual([[log, 'input'], [bench, 'input']])
    expect(brief.sandbox).toEqual({ mode: 'read-only', network: 'allow-list', commands: false })
    expect(JSON.stringify(brief)).not.toContain('end-gaps')
    expect(run!.prompt).toContain(`<artifact id="${log}">\n${LOG}\n</artifact>`)
    expect(run!.prompt).toContain('valid against this JSON Schema (digest@1.0)')
    expect(ctx.artifacts.get(view.digest!)!.producer).toEqual({ type: 'worker', ref: 'w:digest' })
  })

  it('asks for a Worker of its tier only: with none, it fails open, naming the admission decision that found none (ADR-0036, INV-11)', async () => {
    const { ctx, worker, log } = await boot((r) => () => ({ text: draft(r.log, r.bench) }))
    worker.tiers = ['standard', 'frontier']
    const view = await ctx.digests.wait((await ctx.digests.request({ sources: [log] })).requestId, 30_000)
    expect(view).toMatchObject({ state: 'bypassed' })
    expect(view.reason).toMatch(/read-only Worker on the economy tier/)
    expect(worker.started).toHaveLength(0)
    const decision = ctx.artifacts.get(view.decision!)!.body as { inputs: string[] }
    const admission = decision.inputs.map((ref) => ctx.artifacts.get(ref)?.body as { decisionType?: string } | undefined).find((b) => b?.decisionType === 'admission')
    expect(admission).toBeDefined()
  })

  it('goes on with a pending request after a restart, never starting its Worker run twice (INV-4)', async () => {
    const { ctx, worker, log, bench, restart } = await boot((r) => () => ({ text: draft(r.log, r.bench) }))
    worker.hold = true
    const requested = await ctx.digests.request({ sources: [log, bench] })
    await until(() => worker.started.length === 1, 'the digest run')
    await restart()
    worker.release(worker.started[0]!.id)
    const view = await ctx.digests.wait(requested.requestId, 30_000)
    expect(view.state).toBe('written')
    expect(worker.started).toHaveLength(1)
  })

  it('cancels a run that outlives timeoutMinutes, and bypasses its request (INV-9)', async () => {
    const { ctx, worker, log, restart } = await boot((r) => () => ({ text: draft(r.log, r.bench) }))
    worker.hold = true
    const requested = await ctx.digests.request({ sources: [log] })
    await until(() => worker.started.length === 1, 'the digest run')
    await restart(() => ctx.store.db.prepare('UPDATE digest_requests SET created_at = ? WHERE request_id = ?').run(new Date(Date.now() - 2 * 3_600_000).toISOString(), requested.requestId))
    const view = await ctx.digests.wait(requested.requestId, 30_000)
    expect(view).toMatchObject({ state: 'bypassed' })
    expect(view.reason).toMatch(/did not finish within 30 minutes/)
    expect(worker.cancelled).toEqual([worker.started[0]!.id])
  })

  it('escalates once to a Worker of the standard tier when every economy claim fails the quote check, its run keyed apart, and records the decision before it (PROP-0008, INV-13)', async () => {
    const { ctx, worker, log, bench } = await boot((r) => (_sources, tier) => ({ text: draft(r.log, r.bench, tier === 'economy' ? [{ id: 'C1', kind: 'finding', text: 'x', citation: { artifact: r.log, quote: 'not in the log' } }] : undefined) }))
    const view = await ctx.digests.wait((await ctx.digests.request({ sources: [log, bench] })).requestId, 30_000)
    expect(view).toMatchObject({ state: 'written', worker: 'w:digest:standard', claims: { kept: 2, dropped: 0 } })
    expect(worker.started.map((s) => [s.tier, s.key])).toEqual([['economy', `digests:${view.requestId}`], ['standard', `digests:${view.requestId}:standard`]])
    expect(worker.started[1]!.requirement.tier).toEqual({ min: 'standard', max: 'standard', source: 'decision', decision: view.escalation })
    const escalated = ctx.artifacts.get(view.escalation!)!.body as { inputs: string[] }
    // The sources, and the economy answer whose claims all failed.
    expect(escalated.inputs).toEqual(expect.arrayContaining([log, bench]))
    expect(escalated.inputs).toHaveLength(3)
    expect((ctx.artifacts.get(view.decision!)!.body as { inputs: string[] }).inputs).toContain(view.escalation)
  })

  it('lets the economy answer stand when no Worker of the standard tier is admitted: not-written, with why, never bypassed (ADR-0036)', async () => {
    const { ctx, worker, log } = await boot((r) => () => ({ text: draft(r.log, r.bench, [{ id: 'C1', kind: 'finding', text: 'x', citation: { artifact: r.log, quote: 'not in the log' } }]) }))
    worker.tiers = ['economy']
    const view = await ctx.digests.wait((await ctx.digests.request({ sources: [log] })).requestId, 30_000)
    expect(view).toMatchObject({ state: 'not-written', claims: { kept: 0, dropped: 1 } })
    expect(view.escalation).toBeDefined()
    expect(view.reason).toMatch(/no claim survived the quote check.*the escalation to standard did not answer \(no Worker can write it \(a read-only Worker on the standard tier\)/)
    expect(worker.started).toHaveLength(1)
  })

  it('never escalates above standard: a request configured on standard gives up on its own answer (INV-9)', async () => {
    const { ctx, worker, log } = await boot((r) => () => ({ text: draft(r.log, r.bench, [{ id: 'C1', kind: 'finding', text: 'x', citation: { artifact: r.log, quote: 'not in the log' } }]) }), { tier: 'standard' })
    const view = await ctx.digests.wait((await ctx.digests.request({ sources: [log] })).requestId, 30_000)
    expect(view).toMatchObject({ state: 'not-written' })
    expect(view.escalation).toBeUndefined()
    expect(worker.started.map((s) => s.tier)).toEqual(['standard'])
  })

  it('goes on with an escalated request after a restart, starting its standard run once (INV-4)', async () => {
    const { ctx, worker, log, bench, restart } = await boot((r) => (_sources, tier) => ({ text: draft(r.log, r.bench, tier === 'economy' ? [{ id: 'C1', kind: 'finding', text: 'x', citation: { artifact: r.log, quote: 'not in the log' } }] : undefined) }))
    worker.hold = true
    const requested = await ctx.digests.request({ sources: [log, bench] })
    await until(() => worker.started.length === 1, 'the economy run')
    worker.release(worker.started[0]!.id)
    await until(() => worker.started.length === 2, 'the standard run')
    await restart()
    worker.release(worker.started[1]!.id)
    const view = await ctx.digests.wait(requested.requestId, 30_000)
    expect(view).toMatchObject({ state: 'written' })
    expect(worker.started.map((s) => s.tier)).toEqual(['economy', 'standard'])
  })

  it('bounds the requests pending at once, refusing more as overloaded (INV-9)', async () => {
    const { ctx, worker, log, bench } = await boot((r) => () => ({ text: draft(r.log, r.bench) }), { maxPending: 1 })
    worker.hold = true
    await ctx.digests.request({ sources: [log] })
    await expect(ctx.digests.request({ sources: [bench] })).rejects.toMatchObject({ failure: 'overloaded' })
  })

  it('serves digests_request and digests_get with every input and output checked against mcp-digests@1.0, refusing a bad input with nothing done', async () => {
    const { ctx, log, bench } = await boot((r) => () => ({ text: draft(r.log, r.bench) }))
    const behavior = digestToolHandlers(ctx.digests)
    const call = (name: 'digests_request' | 'digests_get', args: Record<string, unknown>) => digestTool(name, behavior[name])(args, { scope: 'client' })
    const bad = await call('digests_request', { sources: ['the test log'] })
    expect(bad).toMatchObject({ isError: true })
    expect(String((bad.content[0] as { text: string }).text)).toMatch(/^invalid input, nothing done/)
    expect(await call('digests_request', { sources: [log], extra: 1 })).toMatchObject({ isError: true })
    const written = await call('digests_request', { sources: [log, bench], clientRequestId: 'r1', waitSeconds: 30 })
    expect(written.isError).toBeUndefined()
    const view = written.structuredContent as unknown as DigestView
    expect(view.state).toBe('written')
    schemas.assertDef('mcp-digests@1.0', 'digests-request-output', view)
    expect((await call('digests_get', { requestId: view.requestId })).structuredContent).toEqual(view)
    expect(await call('digests_get', { requestId: 'dig-unknown' })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^unknown-request/) }] })
    expect(await call('digests_request', { sources: [log], clientRequestId: 'r1' })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^invalid/) }] })
  })
})
