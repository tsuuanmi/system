/**
 * The exact paired sign-flip test and its confidence interval (docs/design/statistics.md): inference
 * only, pure and deterministic. Under the null hypothesis the arms of each pair are exchangeable, so
 * each paired difference is as likely negated as not; the test enumerates all 2^n sign vectors of
 * the n differences. Its conventions are SciPy's `permutation_test(..., permutation_type='samples')`,
 * the golden reference: ties count as at least as extreme, and the two-sided p-value is twice the
 * smaller one-sided one, at most 1. Nothing here holds a threshold or decides anything: the verdict
 * rule reads the interval.
 */

/** The fewest pairs the test takes: SciPy's least sample, so every output has a golden reference. */
export const MIN_PAIRS = 2
/** The most pairs it enumerates (2^20 sign vectors). Above it the library refuses: it offers no Monte Carlo test. */
export const MAX_PAIRS = 20
/**
 * Ties: a sign vector ties the observed one when the differences it flips sum to within
 * `TIE_TOLERANCE × Σ(|candidate| + |baseline|)` of zero: about 400 times the most rounding such a
 * sum of up to 20 differences can carry (21 × 2^-53 of the same magnitude, the values' own
 * representation included), and far below any difference a metric records.
 */
export const TIE_TOLERANCE = 2 ** -40

/** Why the library refused an input: it computes nothing it cannot compute exactly and check against its goldens. */
export type StatisticsFailure = 'unpaired' | 'too-few-pairs' | 'too-many-pairs' | 'not-finite' | 'confidence' | 'ratio' | 'unverified'
export class StatisticsError extends Error {
  constructor(readonly failure: StatisticsFailure, message: string) {
    super(message)
    this.name = 'StatisticsError'
  }
}

interface Pairs {
  n: number
  /** The differences, candidate minus baseline, in the canonical order. */
  differences: Float64Array
  zeros: number
  /** The mean difference: the sum in the canonical order, over n. */
  mean: number
  tolerance: number
}

/**
 * The pairs in the canonical order (by difference, then candidate, then baseline), so every output
 * depends on the multiset of pairs only, never on the order they came in.
 */
function pairsOf(candidate: readonly number[], baseline: readonly number[], fewest: number): Pairs {
  if (candidate.length !== baseline.length) throw new StatisticsError('unpaired', `${candidate.length} candidate values and ${baseline.length} baseline values are not pairs`)
  const n = candidate.length
  if (n < fewest) throw new StatisticsError('too-few-pairs', `the sign-flip test takes at least ${fewest} pairs; ${n} given`)
  if (n > MAX_PAIRS) throw new StatisticsError('too-many-pairs', `the sign-flip test enumerates at most ${MAX_PAIRS} pairs (2^${MAX_PAIRS} sign vectors) and offers no Monte Carlo test; ${n} given`)
  const pairs = candidate.map((c, i) => ({ c, b: baseline[i]!, d: c - baseline[i]! }))
  if (pairs.some((p) => !Number.isFinite(p.c) || !Number.isFinite(p.b) || !Number.isFinite(p.d))) throw new StatisticsError('not-finite', 'every value and every difference must be a finite number')
  pairs.sort((x, y) => x.d - y.d || x.c - y.c || x.b - y.b)
  let sum = 0
  let scale = 0
  let zeros = 0
  for (const p of pairs) {
    sum += p.d
    scale += Math.abs(p.c) + Math.abs(p.b)
    if (p.d === 0) zeros++
  }
  return { n, differences: Float64Array.from(pairs, (p) => p.d), zeros, mean: sum / n, tolerance: scale * TIE_TOLERANCE }
}

/**
 * The sum of the differences of every subset, indexed by its bit mask, each built in the canonical
 * order (the subset with bit i is the one without it, plus the i-th difference); and, when asked,
 * each subset's size.
 */
function subsetSums(differences: Float64Array, withSizes: boolean): { sums: Float64Array; sizes?: Uint8Array } {
  const sums = new Float64Array(2 ** differences.length)
  const sizes = withSizes ? new Uint8Array(sums.length) : undefined
  for (let i = 0, half = 1; i < differences.length; i++, half *= 2) {
    const d = differences[i]!
    for (let m = 0; m < half; m++) {
      sums[half + m] = sums[m]! + d
      if (sizes) sizes[half + m] = sizes[m]! + 1
    }
  }
  return sizes ? { sums, sizes } : { sums }
}

export interface SignFlipTest {
  pairs: number
  /** Pairs whose difference is exactly zero: kept, they double every count and change no p-value. */
  zeros: number
  /** The sign vectors enumerated: 2^pairs. */
  permutations: number
  /** The observed statistic: the mean paired difference, candidate minus baseline. */
  statistic: number
  /** The tie tolerance on a flipped subset's sum, from the pairs' magnitude. */
  tolerance: number
  /** Sign vectors whose statistic is at least as large as the observed one, ties and the observed one included; and at most as large. */
  atLeast: number
  atMost: number
  /** `greater`: the candidate is better (the mean difference above zero); `less`: below; `twoSided`: `min(1, 2 × min(greater, less))`. */
  p: { greater: number; less: number; twoSided: number }
}

/**
 * The exact paired sign-flip test of the mean difference, candidate minus baseline, for 2 to 20
 * pairs. A sign vector's statistic is the observed one less twice the sum of the differences it
 * flips, so it is at least as large exactly when that sum is at most zero, and ties when the sum is
 * within the tolerance of zero. Refuses (`StatisticsError`) unequal arms, fewer than 2 or more than
 * 20 pairs, and a value or difference that is not finite.
 */
export function signFlipTest(candidate: readonly number[], baseline: readonly number[]): SignFlipTest {
  const pairs = pairsOf(candidate, baseline, MIN_PAIRS)
  const { sums } = subsetSums(pairs.differences, false)
  let atLeast = 0
  let atMost = 0
  for (const s of sums) {
    if (s <= pairs.tolerance) atLeast++
    if (s >= -pairs.tolerance) atMost++
  }
  const greater = atLeast / sums.length
  const less = atMost / sums.length
  return {
    pairs: pairs.n, zeros: pairs.zeros, permutations: sums.length, statistic: pairs.mean, tolerance: pairs.tolerance, atLeast, atMost,
    p: { greater, less, twoSided: Math.min(1, 2 * Math.min(greater, less)) },
  }
}

export interface SignFlipInterval {
  confidence: number
  pairs: number
  /** The mean paired difference. */
  estimate: number
  /**
   * K, the rank of each bound among the 2^n − 1 subset means: floor((1 − confidence) × 2^(n−1)).
   * Zero when n pairs cannot reach the confidence: the interval is then unbounded.
   */
  rank: number
  /** The exact bounds: the K-th smallest and the K-th largest subset mean; ±Infinity when K is 0. */
  exact: { lower: number; upper: number }
  /** The exact bounds widened outward by the tie tolerance, so a bound equal to a threshold up to rounding never clears it. */
  lower: number
  upper: number
  tolerance: number
}

/**
 * The confidence interval of the mean paired difference that inverts the two-sided sign-flip test:
 * every shift δ the test at level 1 − confidence does not reject when it is subtracted from each
 * difference. A shift is rejected below exactly when the means of fewer than K non-empty subsets
 * of the differences lie at or below it, so the bounds are the K-th smallest and largest subset
 * means (Hartigan's typical values), exact for any n. With one pair, or too few for the
 * confidence, K is 0 and the interval is unbounded. Refuses what `signFlipTest` refuses (one pair
 * excepted), and a confidence that is not above 0.5 and below 1.
 */
export function signFlipInterval(candidate: readonly number[], baseline: readonly number[], confidence: number): SignFlipInterval {
  if (!(confidence > 0.5 && confidence < 1)) throw new StatisticsError('confidence', `a confidence must be above 0.5 and below 1; ${confidence} given`)
  const pairs = pairsOf(candidate, baseline, 1)
  // 1 − confidence is exact for a confidence in [0.5, 1] (Sterbenz), and the power of two scales it exactly.
  const rank = Math.floor((1 - confidence) * 2 ** (pairs.n - 1))
  const base = { confidence, pairs: pairs.n, estimate: pairs.mean, rank, tolerance: pairs.tolerance }
  if (rank === 0) return { ...base, exact: { lower: -Infinity, upper: Infinity }, lower: -Infinity, upper: Infinity }
  const { sums, sizes } = subsetSums(pairs.differences, true)
  const means = new Float64Array(sums.length - 1)
  for (let m = 1; m < sums.length; m++) means[m - 1] = sums[m]! / sizes![m]!
  means.sort()
  const lower = means[rank - 1]!
  const upper = means[means.length - rank]!
  return { ...base, exact: { lower, upper }, lower: lower - pairs.tolerance, upper: upper + pairs.tolerance }
}

/**
 * The fewest pairs whose sign-flip interval at this confidence is bounded (K ≥ 1): below it every
 * interval is unbounded, so a metric analysed with it can only be inconclusive. Undefined when no
 * count up to `MAX_PAIRS` reaches it.
 */
export function fewestPairs(confidence: number): number | undefined {
  if (!(confidence > 0.5 && confidence < 1)) throw new StatisticsError('confidence', `a confidence must be above 0.5 and below 1; ${confidence} given`)
  for (let n = MIN_PAIRS; n <= MAX_PAIRS; n++) if (Math.floor((1 - confidence) * 2 ** (n - 1)) >= 1) return n
  return undefined
}
