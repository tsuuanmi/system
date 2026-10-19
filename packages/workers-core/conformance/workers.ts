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

    it('names a required capability that no Worker proves, in the failure and the admission decision (INV-2)', async () => {
      await withWorkers([worker('w:a'), worker('w:b', { state: 'unavailable', capabilities: [] })], async (ctx) => {
        const failure = await ctx.workers.route(requirement({ capabilities: ['reason', 'web-search'] })).catch((e: unknown) => e) as AdmissionFailure
        expect(failure.message).toMatch(/no Worker proves web-search\b/)
        expect(body(ctx, failure.decision).candidates.find((c) => c.selected)!.reasons).toEqual(['no Worker proves web-search'])
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

    it('routes past a source that does not describe its Workers in time, and names it in the decision', async () => {
      const { ctx, dispose } = await boot()
      try {
        ctx.workers.register(source('stuck', () => new Promise<never>(() => undefined)))
        ctx.workers.register(source('live', [worker('w:a')]))
        const admitted = await ctx.workers.route(requirement())
        expect(admitted.worker.worker).toBe('w:a')
        expect(body(ctx, admitted.decisions.route).candidates.find((c) => c.option === 'source stuck')).toEqual({ option: 'source stuck', selected: false, reasons: ['did not describe its Workers within 5 s'] })
      } finally {
        await dispose()
      }
    }, 20_000)

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
