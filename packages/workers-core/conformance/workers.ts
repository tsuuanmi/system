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
        // A provider that keeps each source's last read (optional) keeps it for the source's lifetime only.
        if (ctx.workers.sources) expect(ctx.workers.sources()).toEqual([{ source: 'temp', state: 'described', at: expect.any(String), workers: 2 }])
        await fiber.dispose()
        expect(await ctx.workers.list()).toEqual([])
        expect(ctx.workers.source('temp')).toBeUndefined()
        if (ctx.workers.sources) expect(ctx.workers.sources()).toEqual([])
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

    it('names a required capability that no Worker proves, in the failure and the admission decision (INV-2)', async () => {
      await withWorkers([worker('w:a'), worker('w:b', { state: 'unavailable', capabilities: [] })], async (ctx) => {
        const failure = await ctx.workers.route(requirement({ capabilities: ['reason', 'web-search'] })).catch((e: unknown) => e) as AdmissionFailure
        expect(failure.message).toMatch(/no Worker proves web-search\b/)
        expect(body(ctx, failure.decision).candidates.find((c) => c.selected)!.reasons).toEqual(['no Worker proves web-search'])
      })
    })

    it('counts an offer scoped to a kind of work for that work only, and says it is scoped when it refuses (ADR-0049)', async () => {
      const at = '2026-10-23T00:00:00Z'
      const scoped = worker('w:scoped', {
        schema: 'capability-descriptor@1.4', quotaClass: 'agent-plan',
        capabilities: [{ capability: 'review', evidence: { kind: 'probe', at } }, { capability: 'reason', evidence: { kind: 'probe', at }, scope: 'review-member' }],
      })
      await withWorkers([scoped], async (ctx) => {
        // Work of that scope: the scoped offer proves it.
        const member = requirement({ schema: 'work-requirement@1.1', scope: 'review-member' })
        const admitted = await ctx.workers.route(member)
        expect(admitted.worker.worker).toBe('w:scoped')
        expect(body(ctx, admitted.decisions.route).candidates.find((c) => c.selected)!.reasons[0]).toBe('proves reason for review-member work')
        // Any other work: refused, fail closed, the scope named; no Worker proves the capability for it.
        const failure = await ctx.workers.route(requirement()).catch((e: unknown) => e) as AdmissionFailure
        expect(failure).toBeInstanceOf(AdmissionFailure)
        expect(failure.rejections).toEqual([{ worker: 'w:scoped', state: 'ready', failed: [{ check: 'capability', reason: 'does not prove reason (it proves reason only for review-member work)' }] }])
        expect(failure.message).toMatch(/no Worker proves reason\b/)
        // An unscoped capability of the same Worker still counts for any work.
        expect((await ctx.workers.route(requirement({ capabilities: ['review'] }))).worker.worker).toBe('w:scoped')
      })
      // An unscoped offer proves its capability for work of every scope.
      await withWorkers([worker('w:plain')], async (ctx) => {
        expect((await ctx.workers.route(requirement({ schema: 'work-requirement@1.1', scope: 'review-member' }))).worker.worker).toBe('w:plain')
      })
    })

    it('refuses a scope below the schema version that carries it: a descriptor below @1.4, a requirement below @1.1 (ADR-0049)', async () => {
      const at = '2026-10-23T00:00:00Z'
      const early = worker('w:early', { schema: 'capability-descriptor@1.3', capabilities: [{ capability: 'reason', evidence: { kind: 'probe', at }, scope: 'review-member' }] })
      await withWorkers([early], async (ctx) => {
        await expect(ctx.workers.route(requirement())).rejects.toThrow(/capability-descriptor@1\.3/)
      })
      await withWorkers([worker('w:a')], async (ctx) => {
        await expect(ctx.workers.route(requirement({ scope: 'review-member' }))).rejects.toThrow(/work-requirement@1\.0/)
      })
    })

    it('routes work by its kind: a Worker given kinds takes only work of those kinds, a Worker given none takes any, and a refusal says so (REQ-WRK-11, ADR-0057)', async () => {
      const code = worker('w:code', { schema: 'capability-descriptor@1.6', kinds: ['code'], proves: ['develop'] })
      const docs = worker('w:docs', { schema: 'capability-descriptor@1.6', kinds: ['docs', 'tests'], proves: ['develop', 'validate'] })
      const kinded = (kind: string): WorkRequirement => requirement({ schema: 'work-requirement@1.2', kind, capabilities: ['develop'] })
      await withWorkers([code, docs], async (ctx) => {
        // Each kind lands on the Worker given it, whatever the order would otherwise choose.
        const admitted = await ctx.workers.route(kinded('code'))
        expect(admitted.worker.worker).toBe('w:code')
        expect(body(ctx, admitted.decisions.route).candidates.find((c) => c.option === 'w:docs')!.reasons).toEqual(['takes docs, tests work only; this work is code work'])
        expect(body(ctx, admitted.decisions.route).candidates.find((c) => c.selected)!.reasons).toContain('takes code work, one of its kinds')
        expect((await ctx.workers.route(kinded('tests'))).worker.worker).toBe('w:docs')
        // A kind no Worker is given: refused, fail closed, saying no Worker takes it although they prove the capabilities.
        const failure = await ctx.workers.route(kinded('brainstorm')).catch((e: unknown) => e) as AdmissionFailure
        expect(failure).toBeInstanceOf(AdmissionFailure)
        expect(failure.rejections.map((r) => [r.worker, r.failed])).toEqual([
          ['w:code', [{ check: 'capability', reason: 'takes code work only; this work is brainstorm work' }]],
          ['w:docs', [{ check: 'capability', reason: 'takes docs, tests work only; this work is brainstorm work' }]],
        ])
        expect(body(ctx, failure.decision).candidates.find((c) => c.selected)!.reasons).toEqual(['no Worker that proves develop takes brainstorm work'])
        // Work that names no kind is not taken by a Worker given kinds.
        const plain = await ctx.workers.route(requirement({ capabilities: ['develop'] })).catch((e: unknown) => e) as AdmissionFailure
        expect(plain.message).toMatch(/no Worker that proves develop takes work that names no kind/)
        // A kind never proves a capability: the Worker given tests still needs what the work needs.
        const missing = await ctx.workers.route(requirement({ schema: 'work-requirement@1.2', kind: 'code', capabilities: ['validate'] })).catch((e: unknown) => e) as AdmissionFailure
        expect(missing.rejections.find((r) => r.worker === 'w:code')!.failed).toEqual([{ check: 'capability', reason: 'does not prove validate' }])
      })
      // A Worker given no kinds takes work of every kind, and work that names none.
      await withWorkers([worker('w:any', { proves: ['develop'] })], async (ctx) => {
        const admitted = await ctx.workers.route(kinded('docs'))
        expect(admitted.worker.worker).toBe('w:any')
        expect(body(ctx, admitted.decisions.route).candidates.find((c) => c.selected)!.reasons).toContain('takes work of any kind')
        expect((await ctx.workers.route(requirement({ capabilities: ['develop'] }))).worker.worker).toBe('w:any')
      })
    })

    it('refuses kinds below the schema version that carries them: a descriptor below @1.6, a requirement below @1.2 (ADR-0057)', async () => {
      await withWorkers([worker('w:early', { schema: 'capability-descriptor@1.5', kinds: ['code'] })], async (ctx) => {
        await expect(ctx.workers.route(requirement())).rejects.toThrow(/capability-descriptor@1\.5/)
      })
      await withWorkers([worker('w:a')], async (ctx) => {
        await expect(ctx.workers.route(requirement({ schema: 'work-requirement@1.1', kind: 'code' }))).rejects.toThrow(/work-requirement@1\.1/)
        await expect(ctx.workers.route(requirement({ schema: 'work-requirement@1.2', kind: 'Code Work' }))).rejects.toThrow()
      })
    })

    it('chooses the lowest admissible tier at or above the minimum, within the maximum, and records a tier decision (QA-12)', async () => {
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

    it('prefers subscription-chat quota, then a stable id, and is deterministic (REQ-WRK-2, REQ-WRK-8, QA-12)', async () => {
      const workers = [worker('w:c', { quotaClass: 'metered' }), worker('w:b'), worker('w:a', { quotaClass: 'agent-plan' }), worker('w:d')]
      await withWorkers(workers, async (ctx) => {
        const first = await ctx.workers.route(requirement())
        const second = await ctx.workers.route(requirement())
        expect(first.worker.worker).toBe('w:b')
        expect(second.decisions).toEqual(first.decisions)
        expect((await ctx.workers.route(requirement({ budget: { preferQuota: ['agent-plan'] } }))).worker.worker).toBe('w:a')
      })
    })

    it('names the source of the admitted Worker, and asks the owning source for a session\'s affinity, handle, and reset', async () => {
      const { ctx, dispose } = await boot()
      try {
        ctx.workers.register(source('one', [worker('w:a')]))
        ctx.workers.register(source('two', [worker('w:b', { tier: 'economy' })], {
          affinity: (id) => (id === 'ses_two' ? ['w:b'] : undefined), handle: (id) => (id === 'ses_two' ? 'https://example.test/c/two' : undefined),
          reset: (id) => id === 'ses_two',
        }))
        expect((await ctx.workers.route(requirement())).source).toBe('two')
        expect(ctx.workers.affinity('ses_two')).toEqual(['w:b'])
        expect(ctx.workers.affinity('ses_other')).toBeUndefined()
        expect(ctx.workers.handle('ses_two')).toBe('https://example.test/c/two')
        expect(ctx.workers.handle('ses_other')).toBeUndefined()
        expect(ctx.workers.reset('ses_two')).toBe(true)
        expect(ctx.workers.reset('ses_other')).toBe(false)
      } finally {
        await dispose()
      }
    })

    it('says why a session takes no input now, from the source that owns it, and never shows a session free when its source cannot tell (PROP-0013, INV-2)', async () => {
      const { ctx, dispose } = await boot()
      try {
        // Optional on the seam; a provider that offers it holds to the rule.
        if (typeof ctx.workers.held !== 'function') return
        ctx.workers.register(source('one', [worker('w:a')]))
        ctx.workers.register(source('two', [worker('w:b')], { held: async (id) => (id === 'ses_blocked' ? 'its latest run waits on approval request apr_1' : undefined) }))
        ctx.workers.register(source('broken', [worker('w:c')], {
          held: async (id) => {
            if (id === 'ses_broken') throw new Error('the store failed')
            return undefined
          },
        }))
        expect(await ctx.workers.held('ses_blocked')).toBe('its latest run waits on approval request apr_1')
        expect(await ctx.workers.held('ses_free')).toBeUndefined()
        expect(await ctx.workers.held('ses_broken')).toMatch(/cannot tell.*the store failed/)
      } finally {
        await dispose()
      }
    })

    it('lists the runs whose liveness needs a look from every source that tells it, and never reads a source that cannot tell as having none (PROP-0013, INV-2)', async () => {
      const { ctx, dispose } = await boot()
      try {
        // Optional on the seam; a provider that offers it holds to the rule.
        if (typeof ctx.workers.liveness !== 'function') return
        const run = (execution: string, state: 'stalled' | 'looking' | 'unknown', since: string) => ({
          execution, worker: `w:${execution}`, state, since, reasons: ['the agent process: unknown (never reported)'], holds: [`session ses_${execution}`], action: 'confirm its agent is gone, then free it',
          ...(execution === 'a1' ? { runId: 'run_1' } : {}),
        })
        ctx.workers.register(source('quiet', [worker('w:q')]))
        ctx.workers.register(source('one', [worker('w:a')], {
          liveness: async (query) => {
            const runs = [run('a1', 'unknown', '2026-10-24T01:00:00Z'), run('a2', 'stalled', '2026-10-24T03:00:00Z')].filter((r) => (!query?.runId || r.runId === query.runId) && (!query?.execution || r.execution === query.execution))
            return { runs, counts: { unknown: runs.filter((r) => r.state === 'unknown').length, looking: 0, stalled: runs.filter((r) => r.state === 'stalled').length } }
          },
        }))
        const asked: unknown[] = []
        ctx.workers.register(source('two', [worker('w:b')], {
          liveness: async (query) => {
            asked.push(query)
            return query?.runId ? { runs: [], counts: { unknown: 0, looking: 0, stalled: 0 } } : { runs: [run('b1', 'looking', '2026-10-24T02:00:00Z')], counts: { unknown: 0, looking: 1, stalled: 0 } }
          },
        }))
        const all = await ctx.workers.liveness()
        // Each run with its source, the latest first; the counts across every source.
        expect(all.runs.map((r) => [r.source, r.execution, r.state])).toEqual([['one', 'a2', 'stalled'], ['two', 'b1', 'looking'], ['one', 'a1', 'unknown']])
        expect(all.counts).toEqual({ unknown: 1, looking: 1, stalled: 1 })
        expect(all.unread).toEqual([])
        // The query reaches every source.
        const ofRun = await ctx.workers.liveness({ runId: 'run_1' })
        expect(ofRun.runs.map((r) => r.execution)).toEqual(['a1'])
        expect(ofRun.counts).toEqual({ unknown: 1, looking: 0, stalled: 0 })
        expect(asked.at(-1)).toEqual({ runId: 'run_1' })
        ctx.workers.register(source('broken', [worker('w:c')], {
          liveness: async () => {
            throw new Error('the store failed')
          },
        }))
        const told = await ctx.workers.liveness()
        expect(told.unread).toEqual([{ source: 'broken', detail: 'the store failed' }])
        expect(told.counts).toEqual({ unknown: 1, looking: 1, stalled: 1 })
      } finally {
        await dispose()
      }
    })

    it('releases sessions at every source that owns some of them, and counts what became due', async () => {
      const { ctx, dispose } = await boot()
      try {
        const released: Array<{ source: string; sessions: readonly string[]; reason: string }> = []
        const releasing = (name: string, owned: string[]) => source(name, [worker(`w:${name}`)], {
          release: (sessions, reason) => {
            released.push({ source: name, sessions, reason })
            return { due: sessions.filter((s) => owned.includes(s)).length }
          },
        })
        ctx.workers.register(releasing('one', ['ses_a']))
        ctx.workers.register(releasing('two', ['ses_b', 'ses_c']))
        ctx.workers.register(source('none', [worker('w:none')]))
        expect(ctx.workers.release(['ses_a', 'ses_b', 'ses_c', 'ses_x'], 'run deleted')).toEqual({ due: 3 })
        expect(released.map((r) => r.source).sort()).toEqual(['one', 'two'])
        expect(released.every((r) => r.reason === 'run deleted')).toBe(true)
        expect(ctx.workers.release([], 'nothing')).toEqual({ due: 0 })
      } finally {
        await dispose()
      }
    })

    it('leaves out the Workers an earlier attempt failed on unsent, and says why (ADR-0034)', async () => {
      await withWorkers([worker('w:a'), worker('w:b')], async (ctx) => {
        const admitted = await ctx.workers.route(requirement(), { excludeWorkers: { workers: ['w:a'], reason: 'an earlier attempt failed here before anything was sent' } })
        expect(admitted.worker.worker).toBe('w:b')
        expect(body(ctx, admitted.decisions.route).candidates.find((c) => c.option === 'w:a')!.reasons).toEqual(['an earlier attempt failed here before anything was sent'])
        await expect(ctx.workers.route(requirement(), { excludeWorkers: { workers: ['w:a', 'w:b'], reason: 'failed' } })).rejects.toMatchObject({ rejections: [{ failed: [{ check: 'excluded' }] }, { failed: [{ check: 'excluded' }] }] })
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

    it('admits only a Worker of another provider family, says why without naming one, and fails closed (ADR-0027)', async () => {
      const fam = (family: string) => ({ schema: 'capability-descriptor@1.1' as const, family })
      await withWorkers([worker('w:a', fam('fam-1')), worker('w:b', fam('fam-1')), worker('w:c', fam('fam-2')), worker('w:none')], async (ctx) => {
        const exclude = { families: ['fam-1'], reason: 'differs from node lit:a' }
        const admitted = await ctx.workers.route(requirement(), { exclude })
        expect(admitted.worker.worker).toBe('w:c')
        const route = body(ctx, admitted.decisions.route)
        expect(route.candidates.find((c) => c.option === 'w:a')!.reasons).toEqual(['same provider family (differs from node lit:a)'])
        expect(route.candidates.find((c) => c.option === 'w:none')!.reasons).toEqual(['declares no provider family, so it cannot differ (differs from node lit:a)'])
        expect(JSON.stringify(route)).not.toMatch(/fam-[12]/)
        await expect(ctx.workers.route(requirement(), { exclude: { families: ['fam-1', 'fam-2'], reason: 'differs from nodes x, y' } })).rejects.toThrow(/same provider family/)
      })
    })

    it('admits only a Worker that takes the input\'s length, says why, and fails closed when none does (ADR-0032)', async () => {
      const bound = (maxInputChars: number) => ({ schema: 'capability-descriptor@1.2' as const, maxInputChars })
      await withWorkers([worker('w:short', bound(1000)), worker('w:exact', { ...bound(5000), tier: 'frontier' }), worker('w:open', { tier: 'frontier' })], async (ctx) => {
        // The short Worker is refused; one that takes exactly the input, or declares no bound, is admitted.
        const admitted = await ctx.workers.route(requirement(), { input: { chars: 5000 } })
        expect(['w:exact', 'w:open']).toContain(admitted.worker.worker)
        const route = body(ctx, admitted.decisions.route)
        expect(route.candidates.find((c) => c.option === 'w:short')!.reasons).toEqual(['the input has 5000 characters; it takes at most 1000'])
        // Without an input to measure, nothing is refused for its length.
        expect((await ctx.workers.route(requirement())).worker.worker).toBe('w:short')
      })
      await withWorkers([worker('w:short', bound(1000))], async (ctx) => {
        await expect(ctx.workers.route(requirement(), { input: { chars: 1001 } })).rejects.toMatchObject({ rejections: [{ worker: 'w:short', failed: [{ check: 'input' }] }] })
      })
    })

    it('routes to the least busy of equally ranked Workers, after tier and quota, before priority and id, and says so (ADR-0033)', async () => {
      const load = (running: number, queued = 0, pending = 0) => ({ schema: 'capability-descriptor@1.3' as const, load: { running, queued, pending, slots: 2 } })
      await withWorkers([worker('w:a', load(2, 1)), worker('w:b', { ...load(2), state: 'busy' }), worker('w:c', load(1)), worker('w:eco', { ...load(2, 3), tier: 'economy' })], async (ctx) => {
        // The lower tier still comes first, however busy.
        expect((await ctx.workers.route(requirement())).worker.worker).toBe('w:eco')
        const admitted = await ctx.workers.route(requirement({ tier: { min: 'standard', source: 'caller' } }))
        expect(admitted.worker.worker).toBe('w:c')
        const route = body(ctx, admitted.decisions.route)
        expect(route.candidates.find((c) => c.option === 'w:c')!.reasons).toContain('load 1 of 2')
        // Busy is admissible: it only orders the Worker after less busy ones.
        expect(route.candidates.find((c) => c.option === 'w:b')!.reasons).toEqual(['admitted; w:c is less busy (load 1 of 2; this one load 2 of 2)'])
        expect(route.candidates.find((c) => c.option === 'w:a')!.reasons).toEqual(['admitted; w:c is less busy (load 1 of 2; this one load 2 of 2, 1 queued)'])
      })
      // Equally busy: the configured order, then the id, decide as before; a source that reports no load reads 0.
      await withWorkers([worker('w:b', load(1)), worker('w:a', load(1)), worker('w:x', load(2))], async (ctx) => {
        expect((await ctx.workers.route(requirement())).worker.worker).toBe('w:a')
      })
      await withWorkers([worker('w:b'), worker('w:a', load(1))], async (ctx) => {
        expect((await ctx.workers.route(requirement())).worker.worker).toBe('w:b')
      })
    })

    it('counts an admission as pending on its Worker until released, routing one at a time, so two routes spread (ADR-0033)', async () => {
      const { ctx, dispose } = await boot()
      try {
        const pending = new Map<string, number>()
        const describe = async () => {
          // A slow description: concurrent routes would read the same counts without one lock.
          await new Promise((resolve) => setTimeout(resolve, 20))
          return ['w:a', 'w:b'].map((id) => worker(id, { schema: 'capability-descriptor@1.3', load: { running: 0, queued: 0, pending: pending.get(id) ?? 0, slots: 2 } }))
        }
        ctx.workers.register(source('pool', describe, {
          reserve: (id) => {
            pending.set(id, (pending.get(id) ?? 0) + 1)
            return () => pending.set(id, pending.get(id)! - 1)
          },
        }))
        const [first, second] = await Promise.all([ctx.workers.route(requirement()), ctx.workers.route(requirement())])
        expect([first.worker.worker, second.worker.worker]).toEqual(['w:a', 'w:b'])
        expect(body(ctx, second.decisions.route).candidates.find((c) => c.option === 'w:a')!.reasons).toEqual(['admitted; w:b is less busy (load 0 of 2; this one load 0 of 2, 1 pending)'])
        // Released once, however often it is called.
        first.release()
        first.release()
        second.release()
        expect([...pending.values()]).toEqual([0, 0])
        expect((await ctx.workers.route(requirement())).worker.worker).toBe('w:a')
      } finally {
        await dispose()
      }
    })

    it('keeps work that needs a capability under a usage limit off that Worker, and only that work, until the limit lapses (ADR-0034)', async () => {
      const later = new Date(Date.now() + 3_600_000).toISOString()
      const lapsed = new Date(Date.now() - 1000).toISOString()
      const v13 = { schema: 'capability-descriptor@1.3' as const }
      await withWorkers([
        worker('w:a', { ...v13, proves: ['reason', 'deep-research'], cooldowns: [{ capability: 'deep-research', until: later }] }),
        worker('w:b', { ...v13, proves: ['reason', 'deep-research'], cooldowns: [{ capability: 'deep-research', until: lapsed }] }),
      ], async (ctx) => {
        const research = await ctx.workers.route(requirement({ capabilities: ['reason', 'deep-research'] }))
        expect(research.worker.worker).toBe('w:b')
        expect(body(ctx, research.decisions.route).candidates.find((c) => c.option === 'w:a')!.reasons).toEqual([`deep-research limit until ${later}`])
        // Work that does not need the limited capability is admitted there as before.
        expect((await ctx.workers.route(requirement())).worker.worker).toBe('w:a')
      })
      await withWorkers([worker('w:a', { ...v13, proves: ['reason', 'deep-research'], cooldowns: [{ capability: 'deep-research', until: later }] })], async (ctx) => {
        await expect(ctx.workers.route(requirement({ capabilities: ['reason', 'deep-research'] }))).rejects.toMatchObject({ rejections: [{ worker: 'w:a', failed: [{ check: 'cooldown' }] }] })
      })
    })

    const account = (id: string, group: string, mode: 'assigned' | 'pooled' = 'assigned', limitUntil?: string) =>
      ({ schema: 'capability-descriptor@1.5' as const, family: group, account: { id, group, mode, ...(limitUntil ? { limitUntil } : {}) } })

    it('keeps work an assigned account at its limit could take off the other accounts of its group, admits other groups, and says why (REQ-ACC-10, ADR-0052)', async () => {
      const later = new Date(Date.now() + 3_600_000).toISOString()
      const research = requirement({ capabilities: ['reason', 'deep-research'] })
      const proves = ['reason', 'deep-research']
      await withWorkers([
        worker('w:g-a', { ...account('a', 'g'), proves, cooldowns: [{ capability: 'deep-research', until: later }] }),
        worker('w:g-b', { ...account('b', 'g'), proves }),
        worker('w:h-c', { ...account('c', 'h'), proves, tier: 'frontier' }),
      ], async (ctx) => {
        // Another group still takes it, though its tier ranks after the refused account's.
        const admitted = await ctx.workers.route(research)
        expect(admitted.worker.worker).toBe('w:h-c')
        const reasons = body(ctx, admitted.decisions.route).candidates.find((c) => c.option === 'w:g-b')!.reasons
        expect(reasons).toEqual([`w:g-a is at its limit until ${later}; assigned accounts do not take another account's work at its limit`])
        expect(JSON.stringify(body(ctx, admitted.decisions.route))).not.toMatch(/"(g|h)"/)
        // Work the limited account is not limited for is admitted as before, on either account.
        expect((await ctx.workers.route(requirement())).worker.worker).toBe('w:g-a')
      })
      // With no other group, the work is refused, and the failure says when the limit lapses.
      await withWorkers([
        worker('w:g-a', { ...account('a', 'g'), proves, cooldowns: [{ capability: 'deep-research', until: later }] }),
        worker('w:g-b', { ...account('b', 'g'), proves }),
      ], async (ctx) => {
        const failure = await ctx.workers.route(research).catch((e: unknown) => e) as AdmissionFailure
        expect(failure).toBeInstanceOf(AdmissionFailure)
        expect(failure.rejections.map((r) => [r.worker, r.failed.map((f) => f.check)])).toEqual([['w:g-a', ['cooldown']], ['w:g-b', ['assignment']]])
        expect(failure.limitUntil).toBe(later)
        expect(body(ctx, failure.decision).candidates.find((c) => c.selected)!.reasons[0]).toContain(`at their limit, the first back at ${later}`)
      })
    })

    it('waits for the earliest known reset of an assigned account out of quota, and gives none when no reset is known (ADR-0052)', async () => {
      const soon = new Date(Date.now() + 600_000).toISOString()
      const later = new Date(Date.now() + 3_600_000).toISOString()
      await withWorkers([
        worker('w:g-a', { ...account('a', 'g', 'assigned', later), state: 'quota-exhausted' }),
        worker('w:h-b', { ...account('b', 'h', 'assigned', soon), state: 'quota-exhausted' }),
        worker('w:x', { state: 'reauth-required' }),
      ], async (ctx) => {
        const failure = await ctx.workers.route(requirement()).catch((e: unknown) => e) as AdmissionFailure
        expect(failure.limitUntil).toBe(soon)
      })
      await withWorkers([worker('w:g-a', { ...account('a', 'g'), state: 'quota-exhausted' })], async (ctx) => {
        expect((await ctx.workers.route(requirement()).catch((e: unknown) => e) as AdmissionFailure).limitUntil).toBeUndefined()
      })
      // A limit on a Worker with no assigned account is not this rule's: no wait is offered.
      await withWorkers([
        worker('w:g-a', { ...account('a', 'g', 'assigned', later), state: 'quota-exhausted' }),
        worker('w:plain', { schema: 'capability-descriptor@1.3', state: 'quota-exhausted' }),
      ], async (ctx) => {
        expect((await ctx.workers.route(requirement()).catch((e: unknown) => e) as AdmissionFailure).limitUntil).toBeUndefined()
      })
    })

    it('moves nothing under pooled accounts: a limit leaves the group\'s other accounts admissible, as ADR-0034 (ADR-0052)', async () => {
      const later = new Date(Date.now() + 3_600_000).toISOString()
      await withWorkers([
        worker('w:g-a', { ...account('a', 'g', 'pooled', later), state: 'quota-exhausted' }),
        worker('w:g-b', { ...account('b', 'g', 'pooled'), tier: 'frontier' }),
      ], async (ctx) => {
        expect((await ctx.workers.route(requirement())).worker.worker).toBe('w:g-b')
      })
    })

    it('keeps the work on one account of its group when asked to, and leaves other groups and other tiers of that account open (ADR-0052)', async () => {
      await withWorkers([
        worker('w:g-a-eco', { ...account('a', 'g'), tier: 'economy' }), worker('w:g-b', { ...account('b', 'g'), tier: 'economy' }),
        worker('w:h-c', account('c', 'h')), worker('w:plain'),
      ], async (ctx) => {
        const assignment = { group: 'g', account: 'b', reason: 'an earlier attempt failed on account b before anything was sent' }
        const admitted = await ctx.workers.route(requirement(), { assignment })
        expect(admitted.worker.worker).toBe('w:g-b')
        expect(body(ctx, admitted.decisions.route).candidates.find((c) => c.option === 'w:g-a-eco')!.reasons).toEqual([assignment.reason])
        const away = await ctx.workers.route(requirement(), { assignment, excludeWorkers: { workers: ['w:g-b'], reason: 'failed here' } })
        expect(['w:h-c', 'w:plain']).toContain(away.worker.worker)
      })
    })

    it('chooses exactly as before when each group has one account, as on a host with one account per provider (ADR-0052)', async () => {
      const later = new Date(Date.now() + 3_600_000).toISOString()
      const plain = [
        worker('w:a', { schema: 'capability-descriptor@1.3', family: 'g', load: { running: 1, queued: 0, pending: 0, slots: 2 } }),
        worker('w:b', { schema: 'capability-descriptor@1.3', family: 'h', load: { running: 0, queued: 0, pending: 0, slots: 2 } }),
        worker('w:c', { schema: 'capability-descriptor@1.3', family: 'k', tier: 'economy', cooldowns: [{ capability: 'reason', until: later }] }),
        worker('w:d', { schema: 'capability-descriptor@1.3', family: 'm', state: 'quota-exhausted' }),
      ]
      const groups = ['g', 'h', 'k', 'm']
      const accounted = plain.map((w, i) => ({ ...w, schema: 'capability-descriptor@1.5' as const, account: { id: `acct-${i}`, group: groups[i]!, mode: 'assigned' as const } }))
      const chosen = async (workers: CapabilityDescriptor[]) => {
        let out: { worker: string; decisions: unknown; failed: unknown } | undefined
        await withWorkers(workers, async (ctx) => {
          const admitted = await ctx.workers.route(requirement())
          const refused = await ctx.workers.route(requirement({ tier: { min: 'frontier', source: 'caller' } })).catch((e: unknown) => e) as AdmissionFailure
          out = { worker: admitted.worker.worker, decisions: admitted.decisions, failed: refused.rejections }
        })
        return out!
      }
      // The same Worker, the same decision artifacts (their content ids), and the same refusals.
      expect(await chosen(accounted)).toEqual(await chosen(plain))
    })

    it('refuses an account below the schema version that carries it (capability-descriptor@1.5)', async () => {
      await withWorkers([worker('w:a', { schema: 'capability-descriptor@1.4', account: { id: 'a', group: 'g', mode: 'assigned' } })], async (ctx) => {
        await expect(ctx.workers.route(requirement())).rejects.toThrow(/capability-descriptor@1\.4/)
      })
    })

    it('routes past a source that does not describe its Workers in time, and names it in the decision', async () => {
      const { ctx, dispose } = await boot()
      try {
        ctx.workers.register(source('stuck', () => new Promise<never>(() => undefined)))
        ctx.workers.register(source('live', [worker('w:a')]))
        const admitted = await ctx.workers.route(requirement())
        expect(admitted.worker.worker).toBe('w:a')
        expect(body(ctx, admitted.decisions.route).candidates.find((c) => c.option === 'source stuck')).toEqual({ option: 'source stuck', selected: false, reasons: ['did not describe its Workers within 5 s'] })
        // A provider that keeps each source's last read names the silent one, so health can; one that
        // tells a source still describing for the first time says so of this one, which never answered.
        if (ctx.workers.sources) {
          const reads = ctx.workers.sources()
          expect(reads).toEqual([
            { source: 'live', state: 'described', at: expect.any(String), workers: 1 },
            { source: 'stuck', state: 'silent', at: expect.any(String), workers: 0, detail: 'did not describe its Workers within 5 s', ...(reads[1]?.describing !== undefined ? { describing: true } : {}) },
          ])
        }
      } finally {
        await dispose()
      }
    }, 20_000)

    it('says a silent source is still describing until one of its describes lands, even past the bound: its Workers are not known yet, never none (T99 D8)', async () => {
      const { ctx, dispose } = await boot()
      try {
        let land!: (workers: CapabilityDescriptor[]) => void
        let calls = 0
        ctx.workers.register(source('slow', () => (++calls === 1 ? new Promise<CapabilityDescriptor[]>((resolve) => { land = resolve }) : new Promise<never>(() => undefined))))
        ctx.workers.register(source('live', [worker('w:a')]))
        expect((await ctx.workers.list()).map((w) => w.worker)).toEqual(['w:a'])
        const first = ctx.workers.sources?.().find((s) => s.source === 'slow')
        // A provider that does not tell a first read apart leaves nothing more to check.
        if (first?.describing === undefined) return
        expect(first).toEqual({ source: 'slow', state: 'silent', at: expect.any(String), workers: 0, detail: 'did not describe its Workers within 5 s', describing: true })
        // Its first describe lands past the bound; its next read, silent again, is no longer its first.
        land([worker('w:s')])
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect((await ctx.workers.list()).map((w) => w.worker)).toEqual(['w:a'])
        expect(ctx.workers.sources!().find((s) => s.source === 'slow')).toEqual({ source: 'slow', state: 'silent', at: expect.any(String), workers: 0, detail: 'did not describe its Workers within 5 s' })
      } finally {
        await dispose()
      }
    }, 30_000)

    it('keeps a source whose describe fails as failed in its last read, with why, until a later read hears it', async () => {
      const { ctx, dispose } = await boot()
      try {
        let broken = true
        ctx.workers.register(source('flaky', async () => {
          if (broken) throw new Error('the vault is locked')
          return [worker('w:f')]
        }))
        ctx.workers.register(source('live', [worker('w:a')]))
        // Whatever the read then gives, no Worker of the failed source is admitted from it.
        const listed = await ctx.workers.list().catch(() => [])
        expect(listed.map((w) => w.worker)).not.toContain('w:f')
        if (ctx.workers.sources) {
          expect(ctx.workers.sources().find((s) => s.source === 'flaky')).toEqual({ source: 'flaky', state: 'failed', at: expect.any(String), workers: 0, detail: 'failed to describe its Workers: the vault is locked' })
        }
        broken = false
        expect((await ctx.workers.list()).map((w) => w.worker)).toEqual(['w:a', 'w:f'])
        if (ctx.workers.sources) expect(ctx.workers.sources().map((s) => [s.source, s.state, s.workers])).toEqual([['flaky', 'described', 1], ['live', 'described', 1]])
      } finally {
        await dispose()
      }
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

    it('checks a structured result against its schema before the contract, and gives why (REQ-ART-5)', async () => {
      const { ctx, dispose } = await boot()
      try {
        ctx.workers.contract('conformance.any', () => ({ accepted: true, reasons: ['contract passed'] }))
        const put = (text: string) => ctx.artifacts.put({
          kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'operator-shared', producer: { type: 'system', ref: 'conformance' },
          body: { schema: 'provider-answer@1.0', provider: 'p', account: 'a', turnId: 't', conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text },
        }).id as `sha256:${string}`
        const tag = 'hypothesis-set@1.0'
        const valid = '```json\n' + JSON.stringify({ question: 'q', hypotheses: [{ id: 'H1', statement: 's' }] }) + '\n```'
        expect(ctx.workers.accept(put(valid), 'conformance.any', { resultSchema: tag })).toMatchObject({ accepted: true, reasons: [`a valid ${tag}`, 'contract passed'] })
        const wrong = ctx.workers.accept(put('```json\n{"question": "q", "hypotheses": []}\n```'), 'conformance.any', { resultSchema: tag })
        expect(wrong).toMatchObject({ accepted: false, reasons: [expect.stringMatching(/not a valid hypothesis-set@1\.0/)] })
        expect(ctx.workers.accept(put('no json'), 'conformance.any', { resultSchema: tag })).toMatchObject({ accepted: false, reasons: [expect.stringMatching(/no JSON object/)] })
        expect(() => ctx.workers.accept(put('{}'), 'conformance.any', { resultSchema: 'nothing@1.0' })).toThrow(/unknown result schema/)
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
