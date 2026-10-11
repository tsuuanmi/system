/**
 * Conformance suite for `ctx.workers` (plugin rule 7; docs/design/routing.md#algorithm).
 * `boot` returns a context that provides `ctx.workers` and `ctx.artifacts`, with no Worker
 * source registered and no routing preferences configured.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import { describe, expect, it } from 'vitest'
import { AdmissionFailure, type CapabilityDescriptor, type WorkRequirement } from '../src/index.ts'

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
        ctx.workers.register({ name: 'conformance', describe: async () => workers })
        await run(ctx)
      } finally {
        await dispose()
      }
    }

    it('lists a source\'s Workers for the contributing plugin\'s lifetime only', async () => {
      const { ctx, dispose } = await boot()
      try {
        const fiber = ctx.plugin({ inject: ['workers'], apply: (c: Context) => c.workers.register({ name: 'temp', describe: async () => [worker('w:b'), worker('w:a')] }) })
        await fiber
        expect((await ctx.workers.list()).map((w) => w.worker)).toEqual(['w:a', 'w:b'])
        expect(() => ctx.workers.register({ name: 'temp', describe: async () => [] })).toThrow()
        await fiber.dispose()
        expect(await ctx.workers.list()).toEqual([])
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

    it('honours a restriction, such as a persistent session bound to its account', async () => {
      await withWorkers([worker('w:a'), worker('w:b')], async (ctx) => {
        const admitted = await ctx.workers.route(requirement(), { restrict: { workers: ['w:b'], reason: 'the session is bound to b' } })
        expect(admitted.worker.worker).toBe('w:b')
        const a = body(ctx, admitted.decisions.route).candidates.find((c) => c.option === 'w:a')!
        expect(a.reasons).toEqual(['the session is bound to b'])
      })
    })

    it('refuses a malformed work requirement', async () => {
      await withWorkers([worker('w:a')], async (ctx) => {
        await expect(ctx.workers.route({ ...requirement(), capabilities: [] })).rejects.toThrow()
      })
    })
  })
}
