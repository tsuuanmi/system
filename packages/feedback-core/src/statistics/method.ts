/**
 * The library's analysis method in the shape the evaluation engine calls: `AnalysisMethod` of
 * `../evaluations` (docs/design/evaluations.md#an-evaluation), matched structurally (its
 * tests check that it is one). Per case, each arm's level is the mean of its
 * repetitions (the case is the unit of analysis); the method gives the sign-flip interval of the
 * paired difference at the protocol's confidence. Inference only: the thresholds and the outcome
 * are the verdict rule's (`verdictOf`), which reads these intervals once, at the horizon.
 */
import type { Interval } from '../evaluations/index.ts'
import { MAX_PAIRS, signFlipInterval, StatisticsError } from './sign-flip.ts'

/** What an experiment pins (`environment.statistics`) and every analysis names: a change that can change any output is a new version. */
export const STATISTICS = { library: '@tsuuanmi/system-statistics', version: '1' } as const

/**
 * The golden results the methods were verified against (docs/design/statistics.md#golden-tests):
 * the reference and its versions, and the content id of the fixture the tests read. A library
 * whose goldens are not verified gives no interval, so no verdict can rest on it.
 */
export interface Goldens {
  readonly verified: boolean
  readonly reference: { readonly library: string; readonly version: string; readonly numpy: string; readonly python: string; readonly function: string }
  readonly fixture: `sha256:${string}`
}
export const GOLDENS: Goldens = Object.freeze({
  verified: true,
  reference: Object.freeze({ library: 'scipy', version: '1.18.1', numpy: '2.5.4', python: '3.14.2', function: 'scipy.stats.permutation_test' }),
  fixture: 'sha256:b57b048e5b258f3a79889139744510e519f92a2dc92bda95fa8e35aee653aad4',
})

/**
 * An unbounded side as a record writes it: JSON has no infinity, so −∞ and +∞ are the largest
 * finite doubles. No threshold the verdict rule reads lies past them, so such a side neither clears
 * nor excludes anything but a threshold that bounds nothing.
 */
export const UNBOUNDED = Number.MAX_VALUE

/** Per case, one arm's values over its repetitions; a ratio metric's numerator's and denominator's. */
export type PairedArmValues = { values: readonly number[] } | { numerator: readonly number[]; denominator: readonly number[] }
/** What the engine passes a method: one metric's paired values per case, at the protocol's confidence (`AnalysisInput`). */
export interface PairedCases {
  confidence: number
  ratio: boolean
  cases: ReadonlyArray<{ case: string; baseline: PairedArmValues; candidate: PairedArmValues }>
}
export interface SignFlipMethod {
  readonly kind: 'sign-flip'
  readonly library: string
  readonly version: string
  analyse(input: PairedCases): { difference: Interval; candidate: Interval }
}

/** The sum of the values in ascending order, so it does not depend on the order they came in. */
const sorted = (xs: readonly number[]): number => [...xs].sort((a, b) => a - b).reduce((s, x) => s + x, 0)

function level(values: PairedArmValues, arm: string, id: string): number {
  if (!('values' in values)) throw new StatisticsError('ratio', `case ${id}: the ${arm} arm has a ratio's parts, but the metric is not a ratio`)
  if (values.values.length === 0) throw new StatisticsError('unpaired', `case ${id}: the ${arm} arm has no value`)
  return sorted(values.values) / values.values.length
}

const bounded = (x: number): number => (x === Infinity ? UNBOUNDED : x === -Infinity ? -UNBOUNDED : x)

/**
 * The `sign-flip` method: the exact interval of the mean paired difference over cases, from 1 to 20
 * cases (one case, or too few for the confidence, give an unbounded interval: the metric can only be
 * inconclusive). The candidate's own level gets no interval, since a test on paired differences
 * says nothing about one arm's level: a floor read from it never clears. Refuses
 * (`StatisticsError`), and so gives no interval a verdict could pass on: goldens not verified, a
 * ratio metric (a ratio of sums over cases, not a mean of paired differences), no case, more than
 * 20 cases, an arm with no value, a value that is not finite, and a confidence outside (0.5, 1).
 */
export function signFlipMethod(goldens: Pick<Goldens, 'verified'> = GOLDENS): SignFlipMethod {
  return {
    kind: 'sign-flip',
    library: STATISTICS.library,
    version: STATISTICS.version,
    analyse(input: PairedCases): { difference: Interval; candidate: Interval } {
      if (!goldens.verified) throw new StatisticsError('unverified', 'the statistics library\'s golden results are not verified, so it gives no interval and nothing may be decided on it')
      if (input.ratio) throw new StatisticsError('ratio', 'a ratio metric is a ratio of sums over cases, not a mean of paired differences: the sign-flip method does not analyse it')
      if (input.cases.length === 0) throw new StatisticsError('unpaired', 'no case was measured in both arms')
      if (input.cases.length > MAX_PAIRS) throw new StatisticsError('too-many-pairs', `the sign-flip method enumerates at most ${MAX_PAIRS} cases and offers no Monte Carlo test; ${input.cases.length} given`)
      const candidate = input.cases.map((c) => level(c.candidate, 'candidate', c.case))
      const baseline = input.cases.map((c) => level(c.baseline, 'baseline', c.case))
      const interval = signFlipInterval(candidate, baseline, input.confidence)
      const own = sorted(candidate) / candidate.length
      if (!Number.isFinite(own)) throw new StatisticsError('not-finite', 'the candidate\'s mean level is not a finite number')
      return {
        difference: { estimate: interval.estimate, lower: bounded(interval.lower), upper: bounded(interval.upper) },
        candidate: { estimate: own, lower: -UNBOUNDED, upper: UNBOUNDED },
      }
    },
  }
}

/** Every method of the library, as the engine finds them by kind, library, and version. */
export const METHODS: readonly SignFlipMethod[] = [signFlipMethod()]
