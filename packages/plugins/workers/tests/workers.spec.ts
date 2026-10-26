import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it, vi } from 'vitest'
import { requirement, source, worker, workersConformance } from '../../../workers-core/conformance/workers.ts'
import WorkerRouter, { AdmissionFailure, type Config } from '../src/index.ts'

// The router's describe deadline waits on node:timers/promises, which fake timers do not reach:
// here it waits on the global setTimeout, which they replace, so a test can pass the 5 s deadline
// at once. With real timers it behaves as node's does (a rejection on abort, which the router ignores).
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:timers/promises')>(),
  setTimeout: <T>(ms: number, value?: T, options: { signal?: AbortSignal } = {}): Promise<T> => new Promise<T>((resolve, reject) => {
    const { signal } = options
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve(value as T)
    }, ms)
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  }),
}))

async function boot(config: Config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-workers-'))
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(WorkerRouter, config)]
  await Promise.all(fibers)
  return {
    ctx,
    dispose: async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

workersConformance('@tsuuanmi/system-workers', () => boot())

/** One account's five-hour pool on a fake ledger: `used` percent read a minute ago, resetting in `resetsIn` minutes; no reading when `used` is undefined. */
type FakePool = { pool: string; account: string; kind: string; available: boolean; windows: Array<{ id: string; kind: string; seconds: number }>; readings: unknown[] }
const fivehour = (account: string, used?: number, resetsIn = 240): FakePool => ({
  pool: `plan/${account}`, account, kind: 'interactive', available: true, windows: [{ id: 'five-hour', kind: 'rolling', seconds: 18_000 }],
  readings: used === undefined ? [] : [{ window: { id: 'five-hour' }, state: 'ok', usedPercentage: used, resetsAt: new Date(Date.now() + resetsIn * 60_000).toISOString(), observedAt: new Date(Date.now() - 60_000).toISOString() }],
})

/** Boot the router beside a fake resource ledger (`ctx.resources`) holding these pools. */
async function bootWithLedger(pools: FakePool[], config: Config = {}) {
  class Ledger extends Service {
    constructor(ctx: Context) {
      super(ctx, 'resources')
    }

    async pools(): Promise<FakePool[]> {
      return pools
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'system-workers-'))
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(Ledger), ctx.plugin(WorkerRouter, config)]
  await Promise.all(fibers)
  return {
    ctx,
    dispose: async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** A Worker on its own account (`capability-descriptor@1.5`), idle unless `load` says otherwise. */
const onAccount = (id: string, account: string, extra: Parameters<typeof worker>[1] = {}) => worker(id, {
  schema: 'capability-descriptor@1.5', family: 'plan', account: { id: account, group: 'plan', mode: 'assigned' }, load: { running: 0, queued: 0, pending: 0, slots: 2 }, ...extra,
})

describe('ctx.workers: quota in every route (PROP-0014 D3, quota-score@2)', () => {
  const routeBody = (ctx: Context, ref: string) => ctx.artifacts.get(ref)?.body as { decider: { version: string }; candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }

  it('chooses the account at 10 % over one at 85 %, above its 20 % reserve, whatever their load, ids, or tiers, and records each score', async () => {
    // w:a is at 85 % (above 100 − 20), idle, first by id; w:b is at 10 % and busier.
    const { ctx, dispose } = await bootWithLedger([fivehour('acct-a', 85, 60), fivehour('acct-b', 10, 240)])
    try {
      ctx.workers.register(source('test', [onAccount('w:a', 'acct-a'), onAccount('w:b', 'acct-b', { load: { running: 1, queued: 0, pending: 0, slots: 2 } })]))
      const admitted = await ctx.workers.route(requirement({ capabilities: ['reason'] }))
      expect(admitted.worker.worker).toBe('w:b')
      admitted.release()
      const route = routeBody(ctx, admitted.decisions.route)
      // Version 3 (ADR-0073): a Worker that offers several tiers is served and scored at one of them.
      expect(route.decider.version).toBe('3')
      const [a, b] = route.candidates
      expect(b).toMatchObject({ option: 'w:b', selected: true })
      expect(b!.reasons.at(-1)).toMatch(/^quota \(quota-score@2\): known, 5 h: used 10 %, resets in 3 h 5\d min, headroom 70$/)
      expect(a!.selected).toBe(false)
      expect(a!.reasons[0]).toBe('admitted; w:b\'s account has headroom; this one\'s 5 h window is used 85 %, above 80 % (the 20 % reserve), so it ranks last while another has headroom')
      expect(a!.reasons[1]).toMatch(/^quota \(quota-score@2\): known, 5 h: used 85 %, resets in 5\d min, headroom -5$/)
    } finally {
      await dispose()
    }
    // Above its reserve, it gets no new step even at a lower tier, while another admitted Worker has headroom.
    const tiered = await bootWithLedger([fivehour('acct-a', 85), fivehour('acct-b', 10)])
    try {
      tiered.ctx.workers.register(source('test', [onAccount('w:a', 'acct-a'), onAccount('w:b', 'acct-b', { tier: 'frontier', proves: ['reason', 'develop'] })]))
      expect((await tiered.ctx.workers.route(requirement({ capabilities: ['reason'] }))).worker.worker).toBe('w:b')
    } finally {
      await tiered.dispose()
    }
  })

  it('never prefers an unknown reading: no reading, no pool, or no account comes after a known one, and one above its reserve still ranks by its reading when none has headroom', async () => {
    const { ctx, dispose } = await bootWithLedger([fivehour('acct-a'), fivehour('acct-b', 50), fivehour('acct-c', 85)])
    try {
      ctx.workers.register(source('test', [
        onAccount('w:a', 'acct-a'), onAccount('w:b', 'acct-b', { load: { running: 2, queued: 1, pending: 0, slots: 2 } }), onAccount('w:none', 'acct-none'), worker('w:bare'),
      ]))
      const admitted = await ctx.workers.route(requirement())
      expect(admitted.worker.worker).toBe('w:b')
      admitted.release()
      const lost = routeBody(ctx, admitted.decisions.route).candidates.find((c) => c.option === 'w:a')!
      expect(lost.reasons[0]).toBe('admitted; w:b\'s windows are all known; this one\'s are unknown')
      expect(lost.reasons[1]).toBe('quota (quota-score@2): unknown')
    } finally {
      await dispose()
    }
    // Only an unknown reading and one at 85 %: none has headroom, so the known one still comes before the unknown one.
    const none = await bootWithLedger([fivehour('acct-a'), fivehour('acct-c', 85)])
    try {
      none.ctx.workers.register(source('test', [onAccount('w:a', 'acct-a'), onAccount('w:c', 'acct-c')]))
      expect((await none.ctx.workers.route(requirement())).worker.worker).toBe('w:c')
    } finally {
      await none.dispose()
    }
  })

  it('breaks a tie of equal quota by load, then id', async () => {
    const { ctx, dispose } = await bootWithLedger([fivehour('acct-y', 30, 300), fivehour('acct-x', 30, 300)])
    try {
      ctx.workers.register(source('test', [onAccount('w:y', 'acct-y'), onAccount('w:x', 'acct-x')]))
      const admitted = await ctx.workers.route(requirement())
      expect(admitted.worker.worker).toBe('w:x')
      admitted.release()
      expect(routeBody(ctx, admitted.decisions.route).candidates.find((c) => c.option === 'w:y')!.reasons[0]).toBe('admitted; w:x comes first by id')
    } finally {
      await dispose()
    }
  })

  it('orders as before when no ledger is mounted: no quota line in the route decision', async () => {
    const { ctx, dispose } = await boot()
    try {
      ctx.workers.register(source('test', [onAccount('w:a', 'acct-a'), onAccount('w:b', 'acct-b')]))
      const admitted = await ctx.workers.route(requirement())
      expect(admitted.worker.worker).toBe('w:a')
      expect(routeBody(ctx, admitted.decisions.route).candidates.flatMap((c) => c.reasons).some((r) => r.startsWith('quota ('))).toBe(false)
    } finally {
      await dispose()
    }
  })
})

describe('ctx.workers: one Worker, several tiers (ADR-0073)', () => {
  const NOW = new Date('2026-10-26T10:00:00.000Z')
  const BACK = '2026-10-29T09:00:00.000Z'
  const body = (ctx: Context, ref: string) => ctx.artifacts.get(ref)?.body as { outcome: { option: string }; candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }
  /** A Worker on account `acct-t` that offers every tier; `closed` tiers are at their model's limit until {@link BACK}. */
  const tiered = (closed: string[] = [], pools?: Record<string, string[]>) => onAccount('w:t', 'acct-t', {
    schema: 'capability-descriptor@1.10', tier: 'economy',
    tiers: (['economy', 'standard', 'frontier'] as const).map((tier) => ({ tier, ...(pools?.[tier] ? { pools: pools[tier] } : {}), ...(closed.includes(tier) ? { closed: true as const, until: BACK } : {}) })),
  })

  it('serves a Worker that offers three tiers at the lowest one the work admits, and says so in the tier and route decisions', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    const { ctx, dispose } = await boot()
    try {
      ctx.workers.register(source('test', [tiered(), onAccount('w:s', 'acct-s', { tier: 'standard' })]))
      const cheap = await ctx.workers.route(requirement())
      expect([cheap.worker.worker, cheap.tier]).toEqual(['w:t', 'economy'])
      cheap.release()
      const top = await ctx.workers.route(requirement({ tier: { min: 'frontier', source: 'caller' } }))
      expect([top.worker.worker, top.tier]).toEqual(['w:t', 'frontier'])
      expect(body(ctx, top.decisions.tier).outcome.option).toBe('frontier')
      const chosen = body(ctx, top.decisions.route).candidates.find((c) => c.selected)!
      expect(chosen.reasons).toContain('lowest admissible tier frontier')
      // No tier of it has a pool of its model's own (as on Codex, which reports no window per model): explain says its tiers share its account's windows.
      expect(chosen.reasons).toContain('serves tier frontier of the tiers it offers (economy, standard, frontier); tier frontier has no window of its model\'s own: its tiers share its account\'s windows')
      expect(body(ctx, top.decisions.route).candidates.find((c) => c.option === 'w:s')!.reasons).toEqual(['tier standard is below the minimum frontier'])
      top.release()
      // The candidates' look says the tier each admitted Worker would serve at.
      const look = await ctx.workers.candidates!(requirement({ tier: { min: 'standard', source: 'caller' } }))
      expect(look.workers.map((c) => [c.worker.worker, c.tier])).toEqual([['w:s', 'standard'], ['w:t', 'standard']])
      // With none of its tiers within the bounds, it is refused for its tier.
      ctx.workers.register(source('gap', [onAccount('w:g', 'acct-g', { schema: 'capability-descriptor@1.10', tier: 'economy', tiers: [{ tier: 'economy' }, { tier: 'frontier' }] })]))
      const gap = await ctx.workers.route(requirement({ tier: { min: 'standard', max: 'standard', source: 'caller' } }), { restrict: { workers: ['w:g'], reason: 'test' } }).catch((error: unknown) => error as AdmissionFailure)
      expect((gap as AdmissionFailure).rejections[0]!.failed).toEqual([{ check: 'tier', reason: 'none of its tiers economy, frontier is from standard to standard' }])
    } finally {
      vi.useRealTimers()
      await dispose()
    }
  })

  it('closes only the tier whose model is at its limit: the frontier window at its limit leaves the standard tier admissible, and frontier work waits for it on an assigned account', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    const { ctx, dispose } = await boot()
    try {
      ctx.workers.register(source('test', [tiered(['frontier'])]))
      const standard = await ctx.workers.route(requirement({ tier: { min: 'standard', source: 'caller' } }))
      expect([standard.worker.worker, standard.tier]).toEqual(['w:t', 'standard'])
      standard.release()
      const refused = await ctx.workers.route(requirement({ tier: { min: 'frontier', source: 'caller' } })).catch((error: unknown) => error as AdmissionFailure)
      expect(refused).toBeInstanceOf(AdmissionFailure)
      expect((refused as AdmissionFailure).rejections).toEqual([{ worker: 'w:t', state: 'ready', failed: [{ check: 'cooldown', reason: `tier frontier limit until ${BACK} (its model's limit)` }] }])
      // Refused only for its limit, on an assigned account: the caller may wait for the frontier model's reset.
      expect((refused as AdmissionFailure).limitUntil).toBe(new Date(BACK).toISOString())
      // Work a closed tier would not serve anyway is not held: a lower tier still serves it.
      const both = await ctx.workers.route(requirement({ tier: { min: 'economy', source: 'caller' } }))
      expect(both.tier).toBe('economy')
      both.release()
    } finally {
      vi.useRealTimers()
      await dispose()
    }
  })

  it('ranks a tier\'s Worker by that tier\'s headroom: its account\'s pool and its model\'s, never another model\'s (quota-score@2)', async () => {
    const plan = { ...fivehour('acct-t', 10), pool: 'plan/acct-t' }
    const frontier = { ...fivehour('acct-t', 90), pool: 'model-frontier/acct-t' }
    const { ctx, dispose } = await bootWithLedger([plan, frontier, fivehour('acct-o', 50)])
    try {
      const pools = { economy: ['plan/acct-t'], standard: ['plan/acct-t'], frontier: ['plan/acct-t', 'model-frontier/acct-t'] }
      ctx.workers.register(source('test', [tiered([], pools), onAccount('w:o', 'acct-o', { tier: 'standard' })]))
      // At standard, its account's pool alone: 10 % used, against the other account's 50 %.
      const standard = await ctx.workers.route(requirement({ tier: { min: 'standard', source: 'caller' } }))
      expect([standard.worker.worker, standard.tier]).toEqual(['w:t', 'standard'])
      expect(body(ctx, standard.decisions.route).candidates.find((c) => c.selected)!.reasons)
        .toContain('serves tier standard of the tiers it offers (economy, standard, frontier); tier standard has no window of its model\'s own: its tiers share its account\'s windows')
      standard.release()
      // Its frontier tier draws on its model's own window too, and the route decision says so.
      const own = await ctx.workers.route(requirement({ tier: { min: 'frontier', source: 'caller' } }), { restrict: { workers: ['w:t'], reason: 'test' } })
      expect(body(ctx, own.decisions.route).candidates.find((c) => c.selected)!.reasons)
        .toContain('serves tier frontier of the tiers it offers (economy, standard, frontier); tier frontier draws on its model\'s own window beside its account\'s')
      own.release()
      // At frontier, its frontier model's window too: 90 % used, above the reserve, so the other account comes first.
      ctx.workers.register(source('other', [onAccount('w:f', 'acct-o', { tier: 'frontier' })]))
      const top = await ctx.workers.route(requirement({ tier: { min: 'frontier', source: 'caller' } }))
      expect([top.worker.worker, top.tier]).toEqual(['w:f', 'frontier'])
      const lost = body(ctx, top.decisions.route).candidates.find((c) => c.option === 'w:t')!
      expect(lost.reasons[0]).toMatch(/^admitted; w:f's account has headroom; this one's 5 h window is used 90 %/)
      top.release()
    } finally {
      await dispose()
    }
  })
})

describe('ctx.workers: configured preferences', () => {
  it('orders by the configured priority list after tier and quota class, and says why each admitted Worker lost (REQ-ART-1)', async () => {
    const { ctx, dispose } = await boot({ priority: ['w:z'] })
    try {
      ctx.workers.register(source('test', [worker('w:a'), worker('w:z'), worker('w:eco', { tier: 'economy', quotaClass: 'metered' })]))
      const admitted = await ctx.workers.route(requirement({ tier: { min: 'standard', source: 'caller' } }))
      expect(admitted.worker.worker).toBe('w:z')
      const route = ctx.artifacts.get(admitted.decisions.route)?.body as { candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }
      expect(route.candidates).toEqual([
        { option: 'w:a', selected: false, reasons: ['admitted; w:z comes first in the configured priority list'] },
        { option: 'w:eco', selected: false, reasons: ['tier economy is below the minimum standard'] },
        { option: 'w:z', selected: true, reasons: ['proves reason', 'lowest admissible tier standard', 'quota class subscription-chat', 'first in the configured priority list'] },
      ])
    } finally {
      await dispose()
    }
  })

  it('orders quota classes as configured: the api-first order puts local and metered models before website quota (REQ-WRK-8)', async () => {
    const workers = [worker('w:site'), worker('w:api', { quotaClass: 'metered' }), worker('w:local', { quotaClass: 'local', locality: 'local' })]
    const order = async (config: Config): Promise<string[]> => {
      const { ctx, dispose } = await boot(config)
      try {
        ctx.workers.register(source('test', workers))
        const first = (await ctx.workers.route(requirement())).worker.worker
        const second = (await ctx.workers.route(requirement({}), { restrict: { workers: ['w:site', 'w:api'], reason: 'test' } })).worker.worker
        return [first, second]
      } finally {
        await dispose()
      }
    }
    expect(await order({})).toEqual(['w:site', 'w:site'])
    expect(await order({ quotaPreference: ['local', 'metered', 'agent-plan', 'subscription-chat'] })).toEqual(['w:local', 'w:api'])
  })

  it('ships the acceptance.answer and acceptance.cited contracts', async () => {
    const { ctx, dispose } = await boot()
    try {
      const put = (text: string) => ctx.artifacts.put({
        kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'operator-shared', producer: { type: 'system', ref: 'test' },
        body: { schema: 'provider-answer@1.0', provider: 'p', account: 'a', turnId: 't', conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text },
      }).id as `sha256:${string}`
      expect(ctx.workers.accept(put('fine'), 'acceptance.answer').accepted).toBe(true)
      const uncited = ctx.workers.accept(put('fine'), 'acceptance.cited')
      expect(uncited).toMatchObject({ accepted: false, reasons: ['the answer cites no source link'] })
      const cited = 'See [A](https://a.example/x) and https://b.example/y, again https://a.example/x.'
      const accepted = ctx.workers.accept(put(cited), 'acceptance.cited')
      expect(accepted).toMatchObject({ accepted: true, reasons: ['the answer cites 2 source link(s)'] })
      // A link ending in a long run of punctuation is counted in linear time (no polynomial backtracking).
      const started = performance.now()
      expect(ctx.workers.accept(put(`See https://a.example/x${'!'.repeat(100_000)}y and https://a.example/x?!.`), 'acceptance.cited')).toMatchObject({ reasons: ['the answer cites 2 source link(s)'] })
      expect(performance.now() - started).toBeLessThan(1000)
      // The losing option says why it lost (INV-13): the failed check, or that every check passed.
      const candidates = (decision: string) => (ctx.artifacts.get(decision)!.body as { candidates: unknown[] }).candidates
      expect(candidates(uncited.decision)).toEqual([
        { option: 'accept', selected: false, reasons: ['not accept: the answer cites no source link'] },
        { option: 'reject', selected: true, reasons: ['the answer cites no source link'] },
      ])
      expect(candidates(accepted.decision)).toEqual([
        { option: 'accept', selected: true, reasons: ['the answer cites 2 source link(s)'] },
        { option: 'reject', selected: false, reasons: ['not reject: every check of acceptance.cited passed'] },
      ])
    } finally {
      await dispose()
    }
  })

  it('rejects a structured result that fails its schema with a bounded reason, however long the validation errors (REQ-ART-5)', async () => {
    const { ctx, dispose } = await boot()
    try {
      const text = '```json\n' + JSON.stringify({ question: 'q', hypotheses: Array.from({ length: 40 }, (_, i) => ({ id: `bad-${i}`, statement: 1 })) }) + '\n```'
      const result = ctx.artifacts.put({
        kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'operator-shared', producer: { type: 'system', ref: 'test' },
        body: { schema: 'provider-answer@1.0', provider: 'p', account: 'a', turnId: 't', conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text },
      }).id as `sha256:${string}`
      const verdict = ctx.workers.accept(result, 'acceptance.answer', { resultSchema: 'hypothesis-set@1.0' })
      expect(verdict.accepted).toBe(false)
      expect(verdict.reasons[0]!.length).toBeLessThanOrEqual(300)
    } finally {
      await dispose()
    }
  })

  it('fails a read with the error of a source whose describe throws, as before, and keeps it as that source\'s last read', async () => {
    const { ctx, dispose } = await boot()
    try {
      ctx.workers.register(source('broken', async () => {
        throw new Error('the vault is locked')
      }))
      ctx.workers.register(source('live', [worker('w:a')]))
      await expect(ctx.workers.list()).rejects.toThrow('the vault is locked')
      await expect(ctx.workers.route(requirement())).rejects.toThrow('the vault is locked')
      expect(ctx.workers.sources!().map((s) => [s.source, s.state, s.detail])).toEqual([['broken', 'failed', 'failed to describe its Workers: the vault is locked'], ['live', 'described', undefined]])
    } finally {
      await dispose()
    }
  })

  it('keeps the read that started last as a source\'s last read, whichever ends first', async () => {
    const { ctx, dispose } = await boot()
    // The 5 s describe deadline and the slow source's own wait run on fake time.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      // The first read is slow and silent; the second, started later, answers at once.
      let calls = 0
      ctx.workers.register(source('slow', async () => {
        calls++
        if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 5500))
        return [worker('w:s')]
      }))
      const first = ctx.workers.list()
      await vi.advanceTimersByTimeAsync(50)
      expect((await ctx.workers.list()).map((w) => w.worker)).toEqual(['w:s'])
      // Past the deadline, the first read counts the slow source as silent, then the source answers late.
      await vi.advanceTimersByTimeAsync(5000)
      expect(await first).toEqual([])
      await vi.advanceTimersByTimeAsync(500)
      expect(ctx.workers.sources!()).toEqual([{ source: 'slow', state: 'described', at: expect.any(String), workers: 1 }])
    } finally {
      vi.useRealTimers()
      await dispose()
    }
  })

  it('says a silent source is still describing until one of its describes lands, even past the bound, and never after (T99 D8)', async () => {
    const { ctx, dispose } = await boot()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      // Its first describe (a start's first probe) takes 7 s; every later one hangs.
      let calls = 0
      ctx.workers.register(source('slow', async () => {
        calls++
        await new Promise((resolve) => (calls === 1 ? setTimeout(resolve, 7000) : undefined))
        return [worker('w:s')]
      }))
      ctx.workers.register(source('live', [worker('w:a')]))
      const first = ctx.workers.list()
      await vi.advanceTimersByTimeAsync(5000)
      expect((await first).map((w) => w.worker)).toEqual(['w:a'])
      expect(ctx.workers.sources!().find((s) => s.source === 'slow')).toEqual({ source: 'slow', state: 'silent', at: expect.any(String), workers: 0, detail: 'did not describe its Workers within 5 s', describing: true })
      // The first describe lands, late; a later silent read is no longer the source's first.
      await vi.advanceTimersByTimeAsync(2000)
      const second = ctx.workers.list()
      await vi.advanceTimersByTimeAsync(5000)
      expect((await second).map((w) => w.worker)).toEqual(['w:a'])
      expect(ctx.workers.sources!().find((s) => s.source === 'slow')).toEqual({ source: 'slow', state: 'silent', at: expect.any(String), workers: 0, detail: 'did not describe its Workers within 5 s' })
    } finally {
      vi.useRealTimers()
      await dispose()
    }
  })

  it('refuses a source that describes an invalid or duplicate Worker', async () => {
    const { ctx, dispose } = await boot()
    try {
      ctx.workers.register(source('one', [worker('w:a')]))
      ctx.workers.register(source('two', [worker('w:a')]))
      await expect(ctx.workers.list()).rejects.toThrow(/w:a/)
    } finally {
      await dispose()
    }
  })

})

describe('ctx.workers: what the work prefers (work-requirement@1.3 prefers, T262)', () => {
  const routeBody = (ctx: Context, ref: string) => ctx.artifacts.get(ref)?.body as { candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }

  it('ranks a Worker that proves what the work prefers first, before tier and quota class, never refuses one that does not, and records why', async () => {
    const { ctx, dispose } = await boot()
    try {
      // w:a reasons on the preferred quota class at the lowest tier; w:b also searches, on agent-plan quota at a higher tier.
      ctx.workers.register(source('test', [worker('w:a', { tier: 'economy' }), worker('w:b', { tier: 'standard', quotaClass: 'agent-plan', proves: ['reason', 'web-search'] })]))
      const plain = await ctx.workers.route(requirement())
      expect(plain.worker.worker).toBe('w:a')
      plain.release()
      const preferring = await ctx.workers.route(requirement({ schema: 'work-requirement@1.3', prefers: ['web-search'] }))
      expect(preferring.worker.worker).toBe('w:b')
      preferring.release()
      const route = routeBody(ctx, preferring.decisions.route)
      expect(route.candidates.find((c) => c.selected)!.reasons).toContain('proves web-search, which the work prefers')
      expect(route.candidates.find((c) => c.option === 'w:a')!.reasons).toEqual(['admitted; w:b proves web-search, which the work prefers, and this one does not'])
      // With no Worker that proves it, the work still routes, and the decision says so.
      const none = await ctx.workers.route(requirement({ schema: 'work-requirement@1.3', prefers: ['deep-research'] }))
      expect(none.worker.worker).toBe('w:a')
      none.release()
      expect(routeBody(ctx, none.decisions.route).candidates.find((c) => c.selected)!.reasons).toContain('does not prove deep-research, which the work prefers (no Worker that does ranks before it)')
      // A preference is @1.3: an older record carrying one is refused.
      await expect(ctx.workers.route(requirement({ prefers: ['web-search'] }))).rejects.toThrow()
    } finally {
      await dispose()
    }
  })
})
