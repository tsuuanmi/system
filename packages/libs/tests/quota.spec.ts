import { describe, expect, it } from 'vitest'
import { accountQuotaOf, compareHeadroom, headroomOrderOf, QUOTA_DEFAULTS, QUOTA_SCORE, type QuotaCandidate, type QuotaPool, quotaScoreOf, type QuotaSettings, quotaSettingsProblems, windowName } from '../src/index.ts'

const NOW = new Date('2026-10-25T12:00:00.000Z')
const minutes = (n: number): string => new Date(NOW.getTime() + n * 60_000).toISOString()
const ago = (n: number): string => new Date(NOW.getTime() - n * 60_000).toISOString()
const S: QuotaSettings = { ...QUOTA_DEFAULTS }

/** A pool of one account: a 5 h and a 7 day window, each read `used` percent, observed `age` minutes ago. */
function pool(name: string, windows: Array<{ id?: string; seconds?: number; used?: number; resetsIn?: number; age?: number; state?: 'ok' | 'limited' | 'unknown'; none?: true }>, extra: Partial<QuotaPool> = {}): QuotaPool {
  return {
    pool: name, kind: 'interactive', available: true,
    windows: windows.map((w, i) => ({ id: w.id ?? `w${i}`, kind: 'rolling', ...(w.seconds !== undefined ? { seconds: w.seconds } : {}) })),
    readings: windows.flatMap((w, i) => (w.none ? [] : [{
      window: { id: w.id ?? `w${i}` }, state: w.state ?? 'ok', ...(w.used !== undefined ? { usedPercentage: w.used } : {}),
      ...(w.resetsIn !== undefined ? { resetsAt: minutes(w.resetsIn) } : {}), observedAt: ago(w.age ?? 5),
    }])),
    ...extra,
  }
}

const FIVE_H = 5 * 3600
const WEEK = 7 * 86_400

/** A candidate admitted by routing, on standard tier and agent-plan, idle, its account's pools as given. */
function candidate(worker: string, pools: QuotaCandidate['pools'], extra: Partial<QuotaCandidate> = {}): QuotaCandidate {
  return {
    worker, tier: 'standard', tierRank: 1, quotaClass: 'agent-plan', quotaRank: 2, metered: false,
    load: { running: 0, queued: 0, pending: 0, slots: 1 }, priorityRank: 0, pools, ...extra,
  }
}
const open = (used = 0, resetsIn = 300): QuotaPool[] => [pool('p', [{ seconds: FIVE_H, used, resetsIn }])]
const order = (score: ReturnType<typeof quotaScoreOf>): string[] => score.candidates.map((c) => c.worker)

describe('quota settings (ADR-0064, D63)', () => {
  it('defaults to a 20 % reserve of every window, and validates each setting in its range', () => {
    expect(QUOTA_DEFAULTS).toEqual({ reservePercent: 20, useSoonMinutes: 90, minHeadroomPercent: 10, headroomBucketPercent: 5, staleReadingSeconds: 1800 })
    expect(quotaSettingsProblems(QUOTA_DEFAULTS)).toEqual([])
    expect(quotaSettingsProblems({ ...S, reservePercent: 91 })).toEqual(['quota.reservePercent must be a whole number from 0 to 90, not 91'])
    expect(quotaSettingsProblems({ ...S, reservePercent: 0, useSoonMinutes: 0 })).toEqual([])
    expect(quotaSettingsProblems({ ...S, headroomBucketPercent: 0, staleReadingSeconds: 59.5 })).toHaveLength(2)
    expect(quotaSettingsProblems({ ...S, extra: 1 })).toEqual(['quota.extra is not a quota setting (reservePercent, useSoonMinutes, minHeadroomPercent, headroomBucketPercent, staleReadingSeconds)'])
    expect(quotaSettingsProblems(null)[0]).toMatch(/must be an object/)
    expect(() => quotaScoreOf([], { ...S, reservePercent: -1 }, NOW)).toThrow(RangeError)
  })

  it('names a window by its length', () => {
    expect(windowName({ id: 'five-hour', seconds: FIVE_H })).toBe('5 h')
    expect(windowName({ id: 'weekly', seconds: WEEK })).toBe('7 days')
    expect(windowName({ id: 'daily', seconds: 86_400 })).toBe('1 day')
    expect(windowName({ id: 'odd', seconds: 61 })).toBe('odd')
    expect(windowName({ window: 'credit' })).toBe('credit')
  })
})

describe('accountQuotaOf: the windows of an account by its readings (INV-2)', () => {
  it('computes headroom above the reserve, the binding window, and the soonest reset', () => {
    const q = accountQuotaOf([pool('p', [{ id: '5h', seconds: FIVE_H, used: 30, resetsIn: 40 }, { id: '7d', seconds: WEEK, used: 50, resetsIn: 3000 }])], S, NOW)
    expect(q).toMatchObject({ knowledge: 'known', free: true, why: [], binding: { window: '7d', used: 50, headroom: 30 }, soonest: { window: '5h', resetsInMinutes: 40, headroom: 50 } })
  })

  it('never counts an unknown window as capacity: no reading, a stale, unknown, or limited reading, no used share', () => {
    const cases: Array<[string, QuotaPool, RegExp]> = [
      ['no reading', pool('p', [{ seconds: FIVE_H, none: true }]), /no reading yet/],
      ['stale', pool('p', [{ seconds: FIVE_H, used: 0, age: 31 }]), /31 min old, more than 30 min \(stale\)/],
      ['unknown', pool('p', [{ seconds: FIVE_H, state: 'unknown' }]), /latest reading is unknown/],
      ['limited', pool('p', [{ seconds: FIVE_H, state: 'limited', resetsIn: 60 }], { available: false, until: minutes(60) }), /at its limit until/],
      ['no used share', pool('p', [{ seconds: FIVE_H }]), /gives no used share/],
    ]
    for (const [name, p, why] of cases) {
      const q = accountQuotaOf([p], S, NOW)
      expect(q.knowledge, name).toBe('unknown')
      expect(q.free, name).toBe(false)
      expect(q.binding, name).toBeUndefined()
      expect(q.why.join('; '), name).toMatch(why)
    }
    // A reading exactly at the stale bound is still known.
    expect(accountQuotaOf([pool('p', [{ seconds: FIVE_H, used: 0, age: 30 }])], S, NOW).knowledge).toBe('known')
  })

  it('reads no pool, no account, or a ledger that could not tell as unknown, never free', () => {
    expect(accountQuotaOf([], S, NOW)).toMatchObject({ knowledge: 'unknown', free: false, why: [expect.stringMatching(/has no pool/)] })
    expect(accountQuotaOf(undefined, S, NOW)).toMatchObject({ knowledge: 'unknown', free: false, why: [expect.stringMatching(/names no account/)] })
    expect(accountQuotaOf({ unknown: 'the resource ledger is not mounted' }, S, NOW).why).toEqual(['its quota is unknown: the resource ledger is not mounted'])
  })

  it('never reads a pool available only by its unknown: available configuration as having headroom', () => {
    const q = accountQuotaOf([pool('local', [{ seconds: FIVE_H, none: true }], { unknown: 'available' })], S, NOW)
    expect(q).toMatchObject({ knowledge: 'assumed', free: false })
    expect(q.why.join('; ')).toMatch(/configured unknown: available/)
    // Its windows read: it is known like any other pool.
    expect(accountQuotaOf([pool('local', [{ seconds: FIVE_H, used: 10 }], { unknown: 'available' })], S, NOW).knowledge).toBe('known')
  })

  it('keeps the reserve: free only with headroom above it, at 0 and at 90', () => {
    expect(accountQuotaOf(open(79), S, NOW)).toMatchObject({ free: true, binding: { headroom: 1 } })
    expect(accountQuotaOf(open(80), S, NOW)).toMatchObject({ free: false, binding: { headroom: 0 } })
    expect(accountQuotaOf(open(80), S, NOW).why[0]).toMatch(/used 80 %, no headroom above the 20 % reserve/)
    expect(accountQuotaOf(open(99), { ...S, reservePercent: 0 }, NOW)).toMatchObject({ free: true, binding: { headroom: 1 } })
    expect(accountQuotaOf(open(100), { ...S, reservePercent: 0 }, NOW).free).toBe(false)
    expect(accountQuotaOf(open(9), { ...S, reservePercent: 90 }, NOW)).toMatchObject({ free: true, binding: { headroom: 1 } })
    expect(accountQuotaOf(open(10), { ...S, reservePercent: 90 }, NOW).free).toBe(false)
  })

  it('is not free while a pool is unavailable, whatever its windows read', () => {
    const q = accountQuotaOf([pool('p', [{ seconds: FIVE_H, used: 0 }], { available: false, until: minutes(30) })], S, NOW)
    expect(q.free).toBe(false)
    expect(q.why).toEqual([`pool p is not available until ${minutes(30)}`])
  })

  it('takes every window of every pool of the account: one unknown window makes it unknown', () => {
    const q = accountQuotaOf([pool('a', [{ seconds: FIVE_H, used: 0 }]), pool('b', [{ seconds: WEEK, none: true }])], S, NOW)
    expect(q.knowledge).toBe('unknown')
    expect(q.why).toEqual(['7 days window of b: no reading yet'])
  })
})

describe('headroomOrderOf: the one headroom order, which the score, routing, and capacity now all call (T185)', () => {
  const ordered = (accounts: Record<string, QuotaCandidate['pools']>, settings = S): string[] =>
    headroomOrderOf(Object.keys(accounts), (id) => accounts[id], settings, NOW).sort((a, b) => compareHeadroom(a.keys, b.keys) || (a.item < b.item ? -1 : 1)).map((o) => o.item)

  it('puts an account above its reserve (85 % of a 20 % reserve) last while another has headroom, whatever resets sooner', () => {
    expect(ordered({ a: open(85, 20), b: open(10, 600) })).toEqual(['b', 'a'])
    const [a] = headroomOrderOf(['a', 'b'], (id) => (id === 'a' ? open(85, 20) : open(10, 600)), S, NOW)
    expect(a!.quota.over).toMatchObject({ window: 'w0', used: 85, headroom: -5, overReserve: true })
    expect(a!.keys.reserve).toBe(1)
    // At the edge: 80 % leaves no headroom, so it is over; 79 % is not.
    expect(accountQuotaOf(open(80), S, NOW).over).toBeDefined()
    expect(accountQuotaOf(open(79), S, NOW).over).toBeUndefined()
    // A reading at its limit is over its reserve too; with the reserve at 0, 85 % is not.
    expect(accountQuotaOf([pool('p', [{ seconds: FIVE_H, state: 'limited', resetsIn: 30 }])], S, NOW).over).toBeDefined()
    expect(ordered({ a: open(85, 20), b: open(10, 600) }, { ...S, reservePercent: 0 })).toEqual(['a', 'b'])
  })

  it('never prefers an unknown reading, and with no account free orders those above the reserve by their readings', () => {
    expect(ordered({ a: [pool('u', [{ seconds: FIVE_H, none: true }])], b: open(50) })).toEqual(['b', 'a'])
    expect(ordered({ a: undefined, b: { unknown: 'the ledger could not be read' }, c: open(85) })).toEqual(['c', 'a', 'b'])
  })

  it('reads a reading from before its reset as unknown, never as headroom', () => {
    const q = accountQuotaOf(open(5, -10), S, NOW)
    expect(q).toMatchObject({ knowledge: 'unknown', free: false })
    expect(q.why[0]).toMatch(/from before its reset/)
  })

  it('ties by id, and gives quotaScoreOf the same order', () => {
    expect(ordered({ y: open(30, 300), x: open(30, 300) })).toEqual(['x', 'y'])
    const score = quotaScoreOf([candidate('a', open(85, 20)), candidate('b', open(10, 600)), candidate('c', [pool('u', [{ seconds: FIVE_H, none: true }])])], S, NOW)
    expect(order(score)).toEqual(['b', 'c', 'a'])
    expect(score.chosen).toBe('b')
    expect(score.candidates[2]!.reasons[0]).toMatch(/^not free: 5 h window of p: used 85 %, no headroom above the 20 % reserve/)
  })
})

describe('quotaScoreOf (quota-score@2): the order of admitted Workers by quota (REQ-WRK-12)', () => {
  it('in the operator\'s case chooses a free account at 0 % with a known reset, and says why each other one lost', () => {
    const score = quotaScoreOf([
      candidate('agent:codex-1/develop', open(0, 40)),
      candidate('agent:codex-2/develop', open(0, 200)),
      candidate('agent:claude-1/develop', open(10, 30), { busy: ['busy 1 of 1'], load: { running: 1, queued: 0, pending: 0, slots: 1 } }),
      candidate('agent:claude-2/review', undefined, { refused: ['does not prove develop'] }),
    ], S, NOW)
    expect(score.version).toBe(QUOTA_SCORE)
    expect(score.chosen).toBe('agent:codex-1/develop')
    const [busy, first, second, refused] = score.candidates
    expect(first!.reasons).toEqual(['free: every window has headroom above the 20 % reserve', 'tier standard, agent-plan, known, 5 h: used 0 %, resets in 40 min, headroom 80, load 0 of 1', `first in the quota order (${QUOTA_SCORE})`])
    expect(second!.reasons[0]).toBe('free, but agent:codex-1/develop\'s 5 h window resets in 40 min, within 90 min, with headroom 80: its unused share is used before it is lost')
    // Busy elsewhere: ranked (its window resets soonest), never chosen, and the decision says why.
    expect(busy).toMatchObject({ worker: 'agent:claude-1/develop', free: false, place: 1 })
    expect(busy!.reasons[0]).toBe('not free: busy 1 of 1')
    expect(refused).toMatchObject({ admitted: false, free: false, reasons: ['refused by routing: does not prove develop'] })
    expect(order(score)).toEqual(['agent:claude-1/develop', 'agent:codex-1/develop', 'agent:codex-2/develop', 'agent:claude-2/review'])
    // Among windows used soon, the earlier reset comes first.
    const sooner = quotaScoreOf([candidate('b', open(0, 60)), candidate('a', open(0, 80))], S, NOW)
    expect(sooner.candidates[1]!.reasons[0]).toBe('free, but b\'s window resets sooner (in 1 h; this one in 1 h 20 min)')
  })

  it('orders by each key alone: tier, quota class, known before unknown, use soon, headroom, load, priority, id', () => {
    const pair = (a: Partial<QuotaCandidate>, b: Partial<QuotaCandidate>, poolsA = open(0), poolsB = open(0)): string[] =>
      order(quotaScoreOf([candidate('b', poolsB, b), candidate('a', poolsA, a)], S, NOW))
    // Each key: the candidate named second wins on that key alone, all else equal.
    expect(pair({ tierRank: 2, tier: 'frontier' }, { tierRank: 1 })).toEqual(['b', 'a'])
    expect(pair({ quotaRank: 3 }, { quotaRank: 2 })).toEqual(['b', 'a'])
    expect(pair({}, {}, [pool('p', [{ seconds: FIVE_H, none: true }])], open(0))).toEqual(['b', 'a'])
    expect(pair({}, {}, open(0, 300), open(0, 45))).toEqual(['b', 'a'])
    expect(pair({}, {}, open(50, 600), open(10, 600))).toEqual(['b', 'a'])
    expect(pair({ load: { running: 1, queued: 0, pending: 0, slots: 2 } }, {})).toEqual(['b', 'a'])
    expect(pair({ priorityRank: 1 }, {})).toEqual(['b', 'a'])
    expect(pair({}, {})).toEqual(['a', 'b'])
  })

  it('puts metered pools last, and never chooses one (D65)', () => {
    const score = quotaScoreOf([candidate('metered', open(0), { metered: true, quotaRank: 0 }), candidate('plan', open(70))], S, NOW)
    expect(order(score)).toEqual(['plan', 'metered'])
    expect(score.chosen).toBe('plan')
    const alone = quotaScoreOf([candidate('metered', open(0), { metered: true })], S, NOW)
    expect(alone.chosen).toBeUndefined()
    expect(alone.candidates[0]!.reasons[0]).toBe('not free: metered: dispatch never starts work on a metered pool by itself (D65)')
  })

  it('ranks an unknown: available pool after every known one of its class, and an unknown one after both', () => {
    const score = quotaScoreOf([
      candidate('unknown', [pool('u', [{ seconds: FIVE_H, none: true }])]),
      candidate('assumed', [pool('a', [{ seconds: FIVE_H, none: true }], { unknown: 'available' })]),
      candidate('known', open(85)),
    ], S, NOW)
    expect(order(score)).toEqual(['known', 'assumed', 'unknown'])
    expect(score.chosen).toBeUndefined()
    expect(score.candidates.map((c) => c.keys?.knowledge)).toEqual([0, 1, 2])
  })

  it('uses a window about to reset first only within useSoonMinutes and with minHeadroomPercent', () => {
    const at = (resetsIn: number, used = 0): QuotaCandidate['pools'] => open(used, resetsIn)
    const first = (a: QuotaCandidate['pools'], b: QuotaCandidate['pools'], settings = S): string => quotaScoreOf([candidate('a', a), candidate('b', b)], settings, NOW).chosen!
    // b resets within 90 min, so it comes first despite less headroom; at the bound it still does, past it headroom decides.
    expect(first(at(600, 0), at(90, 50))).toBe('b')
    expect(first(at(600, 0), at(91, 50))).toBe('a')
    // Its headroom must be at least minHeadroomPercent (10): 70 % used leaves 10, 71 % leaves 9.
    expect(first(at(600, 0), at(30, 70))).toBe('b')
    expect(first(at(600, 0), at(30, 71))).toBe('a')
    // useSoonMinutes 0: no use-soon key at all.
    expect(first(at(600, 0), at(30, 50), { ...S, useSoonMinutes: 0 })).toBe('a')
    // A reset already past is no reason to use a window soon.
    expect(quotaScoreOf([candidate('a', at(-5, 0))], S, NOW).candidates[0]!.keys!.useSoon).toBe(1)
  })

  it('compares headroom in buckets, so readings a few points apart keep the order by load and id', () => {
    const keys = (used: number): number => quotaScoreOf([candidate('a', open(used, 600))], S, NOW).candidates[0]!.keys!.headroom
    // Headroom 80 is in bucket 16; 76 and 75 share bucket 15; 74.9 is in 14.
    expect([keys(0), keys(4), keys(5), keys(5.1)]).toEqual([-16, -15, -15, -14])
    expect(order(quotaScoreOf([candidate('b', open(0, 600)), candidate('a', open(3, 600))], S, NOW))).toEqual(['b', 'a'])
    expect(order(quotaScoreOf([candidate('b', open(1, 600)), candidate('a', open(3, 600))], S, NOW))).toEqual(['a', 'b'])
    expect(order(quotaScoreOf([candidate('b', open(1, 600)), candidate('a', open(3, 600))], { ...S, headroomBucketPercent: 1 }, NOW))).toEqual(['b', 'a'])
  })

  it('chooses the first free candidate in order, never one routing refused, an unknown, a stale, or a limited one', () => {
    const score = quotaScoreOf([
      candidate('limited', [pool('l', [{ seconds: FIVE_H, state: 'limited', resetsIn: 30 }], { available: false })], { tierRank: 0 }),
      candidate('stale', [pool('s', [{ seconds: FIVE_H, used: 0, age: 600 }])], { tierRank: 0 }),
      candidate('refused', open(0), { refused: ['state reauth-required'], tierRank: 0 }),
      candidate('free', open(60)),
    ], S, NOW)
    expect(score.chosen).toBe('free')
    expect(score.candidates.find((c) => c.worker === 'free')!.reasons[0]).toMatch(/^free:/)
    expect(score.candidates.find((c) => c.worker === 'stale')!.reasons[0]).toMatch(/stale/)
    expect(score.candidates.find((c) => c.worker === 'limited')!.reasons.join(' ')).toMatch(/not available/)
  })

  it('chooses none when none is free, and every candidate says why', () => {
    const score = quotaScoreOf([candidate('a', open(90)), candidate('b', undefined), candidate('c', open(0), { busy: ['its account has 1 dispatched run (dispatch.maxRunningPerAccount 1)'] })], S, NOW)
    expect(score.chosen).toBeUndefined()
    for (const c of score.candidates) expect(c.reasons[0]).toMatch(/^not free: /)
  })

  it('gives the same order and choice for the same inputs, whatever order they come in', () => {
    const list = [candidate('c', open(10, 45)), candidate('a', open(10, 45)), candidate('b', open(40, 500)), candidate('d', undefined, { refused: ['tier economy is below the minimum standard'] })]
    const one = quotaScoreOf(list, S, NOW)
    const two = quotaScoreOf([...list].reverse(), S, NOW)
    expect(two).toEqual(one)
    expect(order(one)).toEqual(['a', 'c', 'b', 'd'])
  })
})
