import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { contentId } from '@tsuuanmi/system-libs'
import { describe, expect, it } from 'vitest'
import { fewestPairs, GOLDENS, MAX_PAIRS, signFlipInterval, signFlipTest, StatisticsError, TIE_TOLERANCE } from '../src/index.ts'

type Alternative = 'greater' | 'less' | 'two-sided'
type Ps = Record<Alternative, number>
interface Check { bound: 'lower' | 'upper'; side: 'inside' | 'outside'; delta: number; alternative: 'greater' | 'less'; p: number }
interface Dataset {
  id: string
  about: string
  candidate: number[]
  baseline: number[]
  scipy: Ps & { statistic: number }
  /** SciPy on the same data as integers (decimal data only): the p-values in exact arithmetic. */
  exact?: Ps & { divisor: number; candidate: number[]; baseline: number[] }
  intervals: Array<{ confidence: number; rank: number; lower: number | null; upper: number | null; checks: Check[] }>
}
interface Fixture { generator: string; reference: { python: string; numpy: string; scipy: string; function: string }; confidences: number[]; datasets: Dataset[] }

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/sign-flip.scipy.json', import.meta.url)), 'utf8')) as Fixture
const ps = (test: ReturnType<typeof signFlipTest>): Ps => ({ greater: test.p.greater, less: test.p.less, 'two-sided': test.p.twoSided })
const only = (p: Ps): Ps => ({ greater: p.greater, less: p.less, 'two-sided': p['two-sided'] })
const failure = (f: () => unknown): string | undefined => {
  try {
    f()
  } catch (e) {
    if (e instanceof StatisticsError) return e.failure
    throw e
  }
  return undefined
}

describe('the sign-flip test against SciPy (golden)', () => {
  it('binds the library\'s goldens to the fixture they were verified on: its content id and SciPy\'s versions', () => {
    expect(GOLDENS).toEqual({
      verified: true,
      reference: { library: 'scipy', version: fixture.reference.scipy, numpy: fixture.reference.numpy, python: fixture.reference.python, function: fixture.reference.function },
      fixture: contentId(fixture),
    })
    expect(Object.isFrozen(GOLDENS) && Object.isFrozen(GOLDENS.reference)).toBe(true)
    expect(fixture.datasets.length).toBeGreaterThanOrEqual(10)
    expect(Math.max(...fixture.datasets.map((d) => d.candidate.length))).toBe(MAX_PAIRS)
  })

  it('gives SciPy\'s exact p-values, greater, less, and two-sided, and its statistic, on every golden dataset', () => {
    for (const d of fixture.datasets) {
      const test = signFlipTest(d.candidate, d.baseline)
      expect(ps(test), d.id).toEqual(only(d.exact ?? d.scipy))
      expect(test.permutations, d.id).toBe(2 ** d.candidate.length)
      expect(Math.abs(test.statistic - d.scipy.statistic), d.id).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(d.scipy.statistic)))
    }
  })

  it('counts ties within its tolerance, so decimal data get their exact-arithmetic p-values where SciPy\'s relative tolerance loses a tie, and is never less conservative than SciPy', () => {
    const decimal = fixture.datasets.filter((d) => d.exact)
    expect(decimal.map((d) => d.id)).toEqual(['rates-tenths', 'tolerance-tie', 'latency-seconds', 'latency-level'])
    for (const d of decimal) {
      expect(ps(signFlipTest(d.exact!.candidate, d.exact!.baseline)), d.id).toEqual(only(d.exact!))
      expect(d.candidate, d.id).toEqual(d.exact!.candidate.map((k) => k / d.exact!.divisor))
    }
    const lost = decimal.filter((d) => (['greater', 'less', 'two-sided'] as const).some((a) => d.scipy[a] !== d.exact![a]))
    expect(lost.map((d) => d.id)).toEqual(LOST_BY_SCIPY)
    for (const d of lost) for (const a of ['greater', 'less', 'two-sided'] as const) expect(d.exact![a], `${d.id} ${a}`).toBeGreaterThanOrEqual(d.scipy[a])
  })

  // One test per dataset: an interval over 20 pairs sorts 2^20 subset means, and all of them in one
  // test took 3.3 s of CPU, past the default bound whenever the host was loaded.
  for (const d of fixture.datasets) {
    it(`gives the exact interval SciPy's test inverts to at every confidence: the K-th smallest and largest subset means, unbounded when K is 0 (${d.id})`, () => {
      for (const g of d.intervals) {
        const interval = signFlipInterval(d.candidate, d.baseline, g.confidence)
        expect({ rank: interval.rank, ...interval.exact }, `${d.id} at ${g.confidence}`).toEqual({ rank: g.rank, lower: g.lower ?? -Infinity, upper: g.upper ?? Infinity })
      }
    })
  }

  it('rejects every shift just outside a bound and none just inside it, with SciPy\'s own one-sample p-values at those shifts', () => {
    let checks = 0
    for (const d of fixture.datasets) {
      const differences = d.candidate.map((c, i) => c - d.baseline[i]!)
      for (const g of d.intervals) {
        for (const check of g.checks) {
          const shifted = differences.map((x) => x - check.delta)
          const p = signFlipTest(shifted, shifted.map(() => 0)).p[check.alternative]
          expect(p, `${d.id} at ${g.confidence}: ${check.bound} ${check.side}`).toBe(check.p)
          expect(p <= (1 - g.confidence) / 2).toBe(check.side === 'outside')
          checks++
        }
      }
    }
    expect(checks).toBeGreaterThan(100)
  })
})

/**
 * The golden datasets on which SciPy's tolerance, relative to an observed mean difference near
 * zero, misses ties that exact arithmetic has: the decimals 0.1, 0.2, −0.3, and latencies near 30 s
 * whose differences carry the rounding of 30 s.
 */
const LOST_BY_SCIPY = ['tolerance-tie', 'latency-level']

describe('the sign-flip test', () => {
  it('depends on the pairs only, never on their order', () => {
    const candidate = [0.3, 1.7, 2.2, 0.9, 3.1, 1.4, 2.8]
    const baseline = [0.1, 1.9, 1.2, 0.4, 2.0, 1.4, 2.1]
    const order = [3, 0, 6, 2, 5, 1, 4]
    expect(signFlipTest(order.map((i) => candidate[i]!), order.map((i) => baseline[i]!))).toEqual(signFlipTest(candidate, baseline))
    expect(signFlipInterval(order.map((i) => candidate[i]!), order.map((i) => baseline[i]!), 0.9)).toEqual(signFlipInterval(candidate, baseline, 0.9))
  })

  it('keeps a zero difference: it changes no p-value, and counts in the estimate and the interval', () => {
    const without = signFlipTest([3, 5, 9, 4, 6], [1, 2, 1, 5, 2])
    const withZero = signFlipTest([3, 5, 9, 4, 6, 7], [1, 2, 1, 5, 2, 7])
    expect(withZero.p).toEqual(without.p)
    expect(withZero).toMatchObject({ zeros: 1, permutations: 64, statistic: 16 / 6 })
    expect(without.statistic).toBe(16 / 5)
    expect(signFlipTest([1, 1, 1], [1, 1, 1]).p).toEqual({ greater: 1, less: 1, twoSided: 1 })
  })

  it('takes two-sided as twice the smaller one-sided p-value, at most 1, and every tie as at least as extreme', () => {
    expect(signFlipTest([2, 3, 4, 5], [1, 1, 1, 1])).toMatchObject({ atLeast: 1, atMost: 16, p: { greater: 1 / 16, less: 1, twoSided: 1 / 8 } })
    // Differences 1, −1, 2: flipping 1 and −1 together ties the observed sum and flipping −1 alone
    // exceeds it, so three of eight sign vectors are at least as large.
    expect(signFlipTest([1, 0, 2], [0, 1, 0])).toMatchObject({ atLeast: 3, atMost: 7, p: { greater: 3 / 8, less: 7 / 8, twoSided: 3 / 4 } })
  })

  it('refuses fewer than 2 pairs, more than 20, unequal arms, a value that is not finite, and a confidence outside (0.5, 1) (INV-2)', () => {
    expect(failure(() => signFlipTest([1], [0]))).toBe('too-few-pairs')
    expect(failure(() => signFlipTest(Array.from({ length: 21 }, (_, i) => i), Array.from({ length: 21 }, () => 0)))).toBe('too-many-pairs')
    expect(failure(() => signFlipInterval(Array.from({ length: 21 }, (_, i) => i), Array.from({ length: 21 }, () => 0), 0.9))).toBe('too-many-pairs')
    expect(failure(() => signFlipTest([1, 2], [0]))).toBe('unpaired')
    expect(failure(() => signFlipTest([1, Number.NaN], [0, 0]))).toBe('not-finite')
    expect(failure(() => signFlipTest([1, Number.MAX_VALUE], [0, -Number.MAX_VALUE]))).toBe('not-finite')
    for (const confidence of [0.5, 1, 0.3, Number.NaN]) expect(failure(() => signFlipInterval([1, 2, 3], [0, 0, 0], confidence))).toBe('confidence')
    expect(failure(() => fewestPairs(1))).toBe('confidence')
  })

  it('widens each exact bound outward by the tie tolerance, 2^-40 of the pairs\' magnitude, so a bound equal to a threshold up to rounding never clears it', () => {
    const interval = signFlipInterval([1, 2, 3, 4, 5, 6], [0, 0, 0, 0, 0, 0], 0.9)
    expect(interval.tolerance).toBe(21 * TIE_TOLERANCE)
    expect(interval.lower).toBe(interval.exact.lower - interval.tolerance)
    expect(interval.upper).toBe(interval.exact.upper + interval.tolerance)
    // Rates 0.8 against 0.7: every difference is 0.1 in exact arithmetic but rounds above it, so the
    // exact bound would clear a threshold of 0.1 that it only equals; the widened one does not.
    const tenth = signFlipInterval(Array(6).fill(0.8), Array(6).fill(0.7), 0.9)
    expect(tenth.exact.lower).toBeGreaterThan(0.1)
    expect(tenth.lower).toBeLessThan(0.1)
  })

  it('needs the fewest pairs the confidence can be reached with, and is unbounded below them or with one pair', () => {
    expect([0.8, 0.9, 0.95, 0.99, 0.999].map(fewestPairs)).toEqual([4, 5, 6, 8, 11])
    expect(signFlipInterval([1, 2, 3, 4], [0, 0, 0, 0], 0.9)).toMatchObject({ rank: 0, lower: -Infinity, upper: Infinity })
    expect(signFlipInterval([1, 2, 3, 4, 5], [0, 0, 0, 0, 0], 0.9)).toMatchObject({ rank: 1, exact: { lower: 1, upper: 5 } })
    expect(signFlipInterval([2], [1], 0.6)).toMatchObject({ pairs: 1, rank: 0, estimate: 1, lower: -Infinity, upper: Infinity })
  })
})
