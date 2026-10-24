# Statistics

> Target state. Boundary: a library, not a plugin
> ([what is not a plugin](../architecture/plugin-model.md#what-is-not-a-plugin)): pure logic with one
> correct answer, pinned by version in each experiment. Proposal:
> [PROP-0011](../proposals/0011-feedback-loop.md#statistics-library), milestone F2; chosen by the
> research run of 2026-10-23 ([research](../research/statistics-tooling-2026-10-23.md)) and recorded in
> the [dependency register](../engineering/dependencies.md). Consumer: the evaluation engine, which
> finds a method by kind, library, and version ([evaluations](evaluations.md#an-evaluation)).
>
> Implemented in [`statistics`](../../packages/statistics/README.md); differs from target: no
> evaluation engine calls it until the store-backed `evaluations` provider (F4).

The statistics library turns one metric's paired values per case into the interval the verdict rule
reads. It is inference only. It holds no threshold and decides nothing: the
[verdict rule](evaluations.md#the-verdict-rule) is the decision policy. That rule reads every interval
once, at the horizon, against the margins the contract and the experiment declared before the first
trial; every guardrail must clear; a judged metric without an analysis makes the evaluation
`invalid`. Keeping the two apart lets each be pinned on its own: the verdict rule by its version and
the experiment's protocol hash, the library by `environment.statistics`.

The library has one method, `sign-flip`: the exact paired sign-flip test of the mean difference and
the confidence interval that inverts it. It is pure: no I/O, no clock, no randomness, no dependency;
the same input gives the same output.

| Export | What it is |
|---|---|
| `signFlipTest` | the exact test: its three p-values, the counts behind them, the observed statistic |
| `signFlipInterval` | the interval that inverts the test at a confidence, with its exact bounds and its rank |
| `fewestPairs` | the fewest pairs whose interval is bounded at a confidence |
| `signFlipMethod`, `METHODS` | the `sign-flip` method in the shape of the engine's `AnalysisMethod` |
| `STATISTICS` | the library and version an experiment pins |
| `GOLDENS` | the golden results the method was verified against, and whether it was |
| `StatisticsError` | a refusal, with its `failure` |

## The sign-flip test

**Model.** The unit of analysis is the case. Each case has a level per arm, the mean of that arm's
repetitions, and a paired difference `d = candidate − baseline`. Under the null hypothesis the two
arms of a case are exchangeable (the [schedule](evaluations.md#the-schedule) draws which arm runs
first in each pair), so each difference is as likely negated as not.

**Statistic and null distribution.** The statistic is the mean difference `T = (1/n) Σ dᵢ`. The test
enumerates all `2ⁿ` sign vectors `s` and their statistics `T(s) = (1/n) Σ sᵢdᵢ`, the observed one
(every sign positive) included. Enumeration is exhaustive for 2 to 20 pairs.

**p-values.** The conventions are SciPy's `permutation_test` with `permutation_type='samples'`, the
golden reference:

| p-value | Is |
|---|---|
| `greater` (the candidate better) | the share of sign vectors with `T(s) ≥ T` |
| `less` | the share with `T(s) ≤ T` |
| `twoSided` | `min(1, 2 × min(greater, less))` |

A tie counts as at least as extreme in both directions, which only ever raises a p-value. For the
sign-flip null distribution, which is symmetric about zero, the two-sided p-value equals the share of
sign vectors with `|T(s)| ≥ |T|`.

**Zero differences** are kept, not dropped (as the Wilcoxon signed-rank test's `wilcox` zero method
drops them). Flipping a
zero leaves every statistic unchanged, so each zero doubles every count and no p-value changes; the
estimate and the interval average over all `n` cases.

**Ties and the float tolerance.** Flipping the subset `F` of the differences gives
`T(s) = T − (2/n) Σ_{i∈F} dᵢ`, so a sign vector is at least as large as the observed one exactly when
the differences it flips sum to at most zero, and ties it when they sum to zero. Decimal data (rates
in tenths, latencies in seconds) are not exact in binary, and a difference computed from two large
levels carries their rounding, so a sum that is zero in exact arithmetic may come out a few units in
the last place away from it. A flipped subset therefore ties the observed sign vector when its sum is
within

```text
τ = 2⁻⁴⁰ × Σᵢ (|candidateᵢ| + |baselineᵢ|)
```

of zero: about 400 times the most rounding such a sum of up to 20 differences can carry (21 × 2⁻⁵³
of the same magnitude, the values' own decimal representation included), and far below any
difference a metric records. SciPy's own tolerance, 100 machine epsilons of the observed statistic,
vanishes when the observed mean difference is near zero or small against the levels, and then misses
ties exact arithmetic has; the [golden tests](#golden-tests) show where. On a flipped sum SciPy's
tolerance is `50 × 2⁻⁵² × |Σ dᵢ|`, which `τ` exceeds more than 80 times; a larger tolerance only
counts more ties, so the library is never less conservative than SciPy.

**Canonical order.** The pairs are sorted by difference, then candidate, then baseline, and every sum
is taken in that order. Every output depends on the multiset of pairs only, never on the order the
cases came in, so no sample order needs recording.

**Domain.** The test takes 2 to 20 pairs (`MIN_PAIRS`, `MAX_PAIRS`). SciPy takes no fewer than 2, so
nothing below has a golden reference. Above 20 the library refuses: the research run recommends
exhaustive enumeration up to 20, and a Monte Carlo test only where its RNG algorithm and state, the
sample order, the versions, and the serialization are recorded with the analysis. `evaluation@1.0`
has no field to record them, so the library offers no Monte Carlo test
([where the design leaves room](#where-the-design-leaves-room)).

## The interval

The interval of the mean difference at confidence `c` is every shift `δ` that the two-sided test at
level `α = 1 − c` does not reject when `δ` is subtracted from each difference. With the differences
shifted, flipping a non-empty subset `F` gives a statistic at least as large as the observed one
exactly when the mean of the differences in `F`, `m_F`, is at most `δ`. So the `greater` p-value at
`δ` is `(1 + #{F ≠ ∅ : m_F ≤ δ}) / 2ⁿ` (the 1 is the observed sign vector), which grows with `δ`, and
the test rejects `δ` from below, at `α / 2` on each side, exactly when fewer than `K` subset means lie
at or below it, with

```text
K = floor((1 − c) × 2ⁿ⁻¹)
```

The bounds are therefore the `K`-th smallest and the `K`-th largest of the `2ⁿ − 1` subset means,
both included. These are Hartigan's typical values (1969): when the differences are symmetric about
the true mean difference, each of the `2ⁿ` gaps between the ordered subset means holds it with
probability `2⁻ⁿ`, so the interval covers it with probability at least `c` (exactly, for continuous
data; ties make it conservative).

- `K` is computed exactly: `1 − c` has no rounding for `c` in [0.5, 1] (Sterbenz), and the power of
  two scales it exactly.
- **Unbounded.** When `K` is 0 the confidence cannot be reached with `n` pairs, and the interval is
  unbounded on both sides. One pair is always unbounded. The fewest pairs with a bounded interval
  (`fewestPairs`):

  | Confidence | 0.8 | 0.9 | 0.95 | 0.99 | 0.999 |
  |---|---|---|---|---|---|
  | Fewest pairs | 4 | 5 | 6 | 8 | 11 |

  With fewer cases a metric analysed by `sign-flip` can only be inconclusive; the first experiment's
  two seeded cases are an example ([PROP-0011](../proposals/0011-feedback-loop.md#the-first-experiment-worker-agnosticism-on-review)).
- **Widened by the tolerance.** The bounds given are the exact ones moved outward by `τ`, so a bound
  that equals a threshold up to rounding never clears it: the verdict rule clears a threshold only
  when the interval lies strictly past it.
- The **estimate** is the mean difference, its sum taken in the canonical order.

## The analysis method

`signFlipMethod()` gives the `sign-flip` method in the shape of the engine's `AnalysisMethod`
(matched structurally: the library imports nothing). Its `analyse(input)` takes one metric's values
per case, as `analysisInput` gathers them ([an evaluation](evaluations.md#an-evaluation)):

| Gives | How |
|---|---|
| `difference` | the [interval](#the-interval) of the mean paired difference over cases, each arm's level the mean of its repetitions (summed in ascending order), at the protocol's `confidence` |
| `candidate` | the mean of the candidate's levels, unbounded on both sides: a test on paired differences says nothing about one arm's level, so a [floor](evaluations.md#the-verdict-rule) read from a `sign-flip` analysis never clears, and a contract that holds a guardrail to a floor needs another method for it |

- **Unbounded sides** are written as `±Number.MAX_VALUE`: a record is JSON, which has no infinity. The
  verdict rule reads such a side as neither clearing nor excluding any threshold, except one that
  bounds nothing (a floor of `−Number.MAX_VALUE`).
- **Refusals.** `analyse` throws `StatisticsError` with its `failure` rather than give an interval
  that could be passed on: `unverified` (the [goldens](#golden-tests) are not verified), `ratio` (a
  ratio metric is a ratio of sums over cases, analysed by a paired bootstrap in
  [PROP-0011](../proposals/0011-feedback-loop.md#evaluation), not a mean of paired differences),
  `unpaired` (no case, or an arm with no value), `too-many-pairs` (more than 20 cases), `not-finite`,
  and `confidence` (not above 0.5 and below 1). The engine gets no interval for that metric, and an
  evaluation whose judged metric has no analysis is `invalid` under the verdict rule.

### Pinning

`STATISTICS` (`@tsuuanmi/system-statistics`, version `1`) is what an experiment pins in
`environment.statistics` and what every analysis names; the engine's pin check compares it with the
live library ([an evaluation](evaluations.md#an-evaluation)). Any change that can change an output for
the same input (a method, a convention, the tolerance, the canonical order, the written form of an
unbounded side) or that adds or removes a method is a new version. The package's release version is
not the pin.

## Golden tests

The research run requires golden results from SciPy before the library may decide anything. The
reference is SciPy 1.18.1 (NumPy 2.5.4, Python 3.14.2), `scipy.stats.permutation_test` with
`permutation_type='samples'` and `n_resamples=inf`, which enumerates every sign vector.

- **Generation.** [`scripts/statistics/sign-flip-goldens.py`](../../scripts/statistics/sign-flip-goldens.py)
  is run once, by hand, with `uv run --with` (its command names the exact versions, fetched into
  uv's cache, never into the repository), and writes
  [`sign-flip.scipy.json`](../../packages/statistics/tests/fixtures/sign-flip.scipy.json), which is
  committed with the versions it ran with. Python is used only there: the tests read the fixture.
- **Datasets.** Two to twenty pairs: integers, halves and quarters (every sum exact), zero and equal
  differences, every difference zero, every one positive, small counts on 20 pairs, continuous draws
  on 12 and 20 pairs, a candidate mostly worse, and four decimal datasets (rates in tenths; the
  differences 0.1, 0.2, −0.3; latencies near 30 s that differ by 0.05 s; and the same, level on
  average).
- **What SciPy gives for each.** Its three p-values and its statistic on the pairs; for a decimal
  dataset, also its p-values on the same data written as integers, which are the p-values in exact
  arithmetic, since the test does not depend on scale; and, at confidences 0.8, 0.9, 0.95, 0.99, and
  0.999, the interval's bounds as the library computes them, each checked by SciPy's one-sample test
  just outside it (rejected) and just inside it (not), with those p-values recorded.
- **What the tests assert.** The library's p-values equal SciPy's exactly, and, on decimal data, the
  exact-arithmetic ones; its statistic is within 10⁻¹² of SciPy's; its interval's bounds and rank are
  bit for bit those of the fixture; its own p-values at every checked shift equal SciPy's. Where
  SciPy's tolerance loses a tie, the library's p-values are the exact-arithmetic ones, never below
  SciPy's: on the differences 0.1, 0.2, −0.3, SciPy's `greater` p-value is 0.5 where exact
  arithmetic gives 0.625, and on the level latencies its `less` p-value is 0.5 where exact
  arithmetic gives 0.637; on every other dataset the two agree.
- **The guard.** `GOLDENS` names the reference, its versions, and the content id of the fixture, and
  says whether the goldens are verified; a test binds it to the fixture. With `verified: false` the
  method refuses every analysis (`unverified`), so nothing can be decided on it. A fixture regenerated
  with another SciPy is a new fixture: its versions and content id change, and the tests show any
  difference.

## Fail-closed rules

1. The library computes only where its goldens reach: 2 to 20 pairs for the test, 1 to 20 for the
   interval (one pair is always unbounded), never by sampling.
2. A refusal is an error with its cause, never a default value.
3. Ties count as at least as extreme, with a tolerance that only ever raises a p-value or widens an
   interval.
4. An unbounded side neither clears nor excludes a threshold; a level's interval is never claimed from
   a test on differences.
5. One analysis at the horizon: the library has no stopping rule and no interim look, and the engine
   calls it once ([the verdict rule](evaluations.md#the-verdict-rule)).

## Where the design leaves room

- **Monte Carlo above 20 cases.** It needs the RNG algorithm and state, the sample order, the
  versions, and the serialization recorded with each analysis: an optional field of
  `evaluation@1.x`, written by the engine (F4). Without both, the library refuses.
- **Other methods.** A ratio metric (the review contract's primary) needs a paired bootstrap, and a
  floor needs a method that gives a level's interval. The research run advises against building a
  BCa bootstrap or a general engine and found no case for a Python sidecar, so the library has no
  `bootstrap` or `bayesian` method: an experiment that declares one is refused at start
  (`unavailable`), and one that holds a floor to a `sign-flip` analysis can only be inconclusive.
- **Checks before the first trial.** The case count against `MAX_PAIRS`, a ratio metric or a floor
  under `sign-flip`, and a horizon below `fewestPairs` are known before any trial is spent. The
  seam's `AnalysisMethod` has no member that says so, so the engine (F4) or the registry (F3) reads
  them from this library; refusing a start on them is theirs to define, as is how the engine
  records an analysis the method refused.
- **Open evidence from the research run:** the coverage and Type I error of any sequential procedure
  (none is offered), and a benchmark of this library against a Python subprocess or sidecar.
