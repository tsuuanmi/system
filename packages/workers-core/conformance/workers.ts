/**
 * Conformance suite for `ctx.workers` (plugin rule 7; docs/design/routing.md#algorithm).
 * `boot` returns a context that provides `ctx.workers` and `ctx.artifacts`, with no Worker
 * source registered and no routing preferences configured.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import { describe, expect, it } from 'vitest'
import { AdmissionFailure, type CapabilityDescriptor, type WorkRequirement, type WorkerSource } from '../src/index.ts'

export type Boot = () => Promise<{ ctx: Context; dispose: () => Promise<void> }>

const AT = '2026-10-12T00:00:00Z'

export function worker(id: string, overrides: Partial<CapabilityDescriptor> & { proves?: string[] } = {}): CapabilityDescriptor {
  const { proves = ['reason'], ...rest } = overrides
  return {
    schema: 'capability-descriptor@1.0', worker: id, provider: 'conformance', tier: 'standard', quotaClass: 'subscription-chat', locality: 'remote',
    capabilities: proves.map((capability) => ({ capability, evidence: { kind: 'conformance', at: AT } })),
    state: 'ready', observedAt: AT, ...rest,
  }
}

/** A source for routing tests: it describes Workers; running work on them is not part of the test. */
export function source(name: string, workers: CapabilityDescriptor[] | (() => Promise<CapabilityDescriptor[]>), extra: Partial<WorkerSource> = {}): WorkerSource {
  const unused = (): never => {
    throw new Error(`source ${name} runs no work in this test`)
  }
  return { name, describe: typeof workers === 'function' ? workers : async () => workers, start: unused, get: unused, wait: unused, ...extra }
}

export function requirement(overrides: Partial<WorkRequirement> = {}): WorkRequirement {
  return {
    schema: 'work-requirement@1.0', objective: 'conformance', capabilities: ['reason'],
    data: { classification: 'public', refs: [] }, egressPolicy: 'egress.conformance',
    tier: { min: 'economy', source: 'caller' }, acceptance: { contract: 'acceptance.conformance' }, ...overrides,
  }
}

type Candidate = { option: string; selected: boolean; reasons: string[] }
const body = (ctx: Context, id: string) => ctx.artifacts.get(id as `sha256:${string}`)?.body as { decisionType: string; candidates: Candidate[]; outcome: { option: string } }

export function workersConformance(name: string, boot: Boot): void {
  describe(`ctx.workers conformance: ${name}`, () => {
    const withWorkers = async (workers: CapabilityDescriptor[], run: (ctx: Context) => Promise<void>): Promise<void> => {
      const { ctx, dispose } = await boot()
      try {
        ctx.workers.register(source('conformance', workers))
        await run(ctx)
      } finally {
        await dispose()
      }
    }

    it('lists a source\'s Workers for the contributing plugin\'s lifetime only', async () => {
      const { ctx, dispose } = await boot()
      try {
        const fiber = ctx.plugin({ inject: ['workers'], apply: (c: Context) => c.workers.register(source('temp', [worker('w:b'), worker('w:a')])) })
        await fiber
        expect((await ctx.workers.list()).map((w) => w.worker)).toEqual(['w:a', 'w:b'])
        expect(() => ctx.workers.register(source('temp', []))).toThrow()
        expect(ctx.workers.source('temp')?.name).toBe('temp')
        await fiber.dispose()
        expect(await ctx.workers.list()).toEqual([])
        expect(ctx.workers.source('temp')).toBeUndefined()
      } finally {
        await dispose()
      }
    })

    it('admits only Workers that prove every required capability, and records why others were rejected', async () => {
      await withWorkers([worker('w:plain'), worker('w:research', { proves: ['reason', 'deep-research'] })], async (ctx) => {
        const admitted = await ctx.workers.route(requirement({ capabilities: ['reason', 'deep-research'] }))
        expect(admitted.worker.worker).toBe('w:research')
        const route = body(ctx, admitted.decisions.route)
        expect(route).toMatchObject({ decisionType: 'route', outcome: { option: 'w:research' } })
        const plain = route.candidates.find((c) => c.option === 'w:plain')!
        expect(plain.selected).toBe(false)
        expect(plain.reasons.join(' ')).toMatch(/deep-research/)
      })
    })

    it('fails closed with an admission decision listing every candidate when nothing is admissible', async () => {
      await withWorkers([worker('w:a', { state: 'reauth-required' }), worker('w:b', { tier: 'economy' })], async (ctx) => {
        const failure = await ctx.workers.route(requirement({ tier: { min: 'frontier', source: 'caller' } })).catch((e: unknown) => e)
        expect(failure).toBeInstanceOf(AdmissionFailure)
        const { rejections, decision } = failure as AdmissionFailure
        expect(rejections.map((r) => [r.worker, r.failed.map((f) => f.check)])).toEqual([['w:a', ['state', 'tier']], ['w:b', ['tier']]])
        const admission = body(ctx, decision)
        expect(admission.decisionType).toBe('admission')
        expect(admission.candidates.filter((c) => !c.selected).map((c) => c.option)).toEqual(['w:a', 'w:b'])
        expect(admission.candidates.every((c) => c.reasons.length > 0)).toBe(true)
      })
    })

    it('chooses the lowest admissible tier at or above the minimum, within the maximum, and records a tier decision', async () => {
      const workers = [worker('w:eco', { tier: 'economy' }), worker('w:std', { tier: 'standard' }), worker('w:top', { tier: 'frontier' })]
      await withWorkers(workers, async (ctx) => {
        expect((await ctx.workers.route(requirement())).worker.worker).toBe('w:eco')
        const admitted = await ctx.workers.route(requirement({ tier: { min: 'standard', source: 'caller' } }))
        expect(admitted.worker.worker).toBe('w:std')
        expect(body(ctx, admitted.decisions.tier)).toMatchObject({ decisionType: 'tier', outcome: { option: 'standard' } })
        await expect(ctx.workers.route(requirement({ tier: { min: 'frontier', max: 'standard', source: 'caller' } }))).rejects.toBeInstanceOf(AdmissionFailure)
      })
    })

    it('keeps local-private work on local Workers (REQ-WRK-7)', async () => {
      await withWorkers([worker('w:remote', { tier: 'economy' }), worker('w:local', { locality: 'local', quotaClass: 'local' })], async (ctx) => {
        const admitted = await ctx.workers.route(requirement({ data: { classification: 'local-private', refs: [] } }))
        expect(admitted.worker.worker).toBe('w:local')
      })
    })

    it('prefers subscription-chat quota, then a stable id, and is deterministic (REQ-WRK-2, REQ-WRK-8)', async () => {
      const workers = [worker('w:c', { quotaClass: 'metered' }), worker('w:b'), worker('w:a', { quotaClass: 'agent-plan' }), worker('w:d')]
      await withWorkers(workers, async (ctx) => {
        const first = await ctx.workers.route(requirement())
        const second = await ctx.workers.route(requirement())
        expect(first.worker.worker).toBe('w:b')
        expect(second.decisions).toEqual(first.decisions)
        expect((await ctx.workers.route(requirement({ budget: { preferQuota: ['agent-plan'] } }))).worker.worker).toBe('w:a')
      })
    })

    it('names the source of the admitted Worker, and asks the owning source for a session\'s affinity and handle', async () => {
      const { ctx, dispose } = await boot()
      try {
        ctx.workers.register(source('one', [worker('w:a')]))
        ctx.workers.register(source('two', [worker('w:b', { tier: 'economy' })], {
          affinity: (id) => (id === 'ses_two' ? ['w:b'] : undefined), handle: (id) => (id === 'ses_two' ? 'https://example.test/c/two' : undefined),
        }))
        expect((await ctx.workers.route(requirement())).source).toBe('two')
        expect(ctx.workers.affinity('ses_two')).toEqual(['w:b'])
        expect(ctx.workers.affinity('ses_other')).toBeUndefined()
        expect(ctx.workers.handle('ses_two')).toBe('https://example.test/c/two')
        expect(ctx.workers.handle('ses_other')).toBeUndefined()
      } finally {
        await dispose()
      }
    })

    it('honours a restriction, such as a persistent session bound to its account', async () => {
      await withWorkers([worker('w:a'), worker('w:b')], async (ctx) => {
        const admitted = await ctx.workers.route(requirement(), { restrict: { workers: ['w:b'], reason: 'the session is bound to b' } })
        expect(admitted.worker.worker).toBe('w:b')
        const a = body(ctx, admitted.decisions.route).candidates.find((c) => c.option === 'w:a')!
        expect(a.reasons).toEqual(['the session is bound to b'])
      })
    })

    it('accepts or rejects a stored result by contract, records the decision, and fails closed on unknowns (REQ-WRK-3)', async () => {
      const { ctx, dispose } = await boot()
      try {
        ctx.workers.contract('conformance.has-text', (result) => {
          const text = (result.body as { text?: unknown }).text
          return typeof text === 'string' && text.trim() ? { accepted: true, reasons: ['has text'] } : { accepted: false, reasons: ['no text'] }
        })
        expect(() => ctx.workers.contract('conformance.has-text', () => ({ accepted: true, reasons: ['x'] }))).toThrow()
        expect(ctx.workers.contracts()).toContain('conformance.has-text')
        const put = (text: string) => ctx.artifacts.put({
          kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'operator-shared', producer: { type: 'system', ref: 'conformance' },
          body: { schema: 'provider-answer@1.0', provider: 'p', account: 'a', turnId: 't', conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text },
        }).id as `sha256:${string}`
        const good = ctx.workers.accept(put('an answer'), 'conformance.has-text', { runId: 'run-1', nodeId: 'n:1' })
        expect(good).toMatchObject({ accepted: true, reasons: ['has text'] })
        expect(body(ctx, good.decision)).toMatchObject({ decisionType: 'acceptance', outcome: { option: 'accept' } })
        const bad = ctx.workers.accept(put(' '), 'conformance.has-text')
        expect(bad).toMatchObject({ accepted: false, reasons: ['no text'] })
        expect(body(ctx, bad.decision)).toMatchObject({ decisionType: 'acceptance', outcome: { option: 'reject' } })
        expect(() => ctx.workers.accept(put('x'), 'conformance.unknown')).toThrow()
        expect(() => ctx.workers.accept(`sha256:${'f'.repeat(64)}`, 'conformance.has-text')).toThrow()
      } finally {
        await dispose()
      }
    })

    it('refuses a malformed work requirement', async () => {
      await withWorkers([worker('w:a')], async (ctx) => {
        await expect(ctx.workers.route({ ...requirement(), capabilities: [] })).rejects.toThrow()
      })
    })
  })
}
