# @tsuuanmi/system-statistics

The evaluation engine's statistics library ([statistics](../../docs/design/statistics.md)). A
**library, not a plugin**: pure logic with one correct answer, no service and no `apply`
([plugin model](../../docs/architecture/plugin-model.md#what-is-not-a-plugin)). It is inference only:
it holds no threshold and decides nothing; the verdict rule of
[`evaluations-core`](../evaluations-core/README.md) reads the intervals it gives. Part of the
orchestration layer ([components](../../docs/architecture/components.md#orchestration)).

| Export | Purpose |
|---|---|
| `signFlipTest`, `MIN_PAIRS`, `MAX_PAIRS`, `TIE_TOLERANCE` | the exact paired sign-flip test of the mean difference, 2 to 20 pairs, every sign vector enumerated: `greater`, `less`, and two-sided p-values by SciPy's conventions (ties at least as extreme, two-sided twice the smaller, at most 1), zero differences kept, ties within `2⁻⁴⁰ × Σ(|candidate| + |baseline|)`, the pairs in a canonical order ([the sign-flip test](../../docs/design/statistics.md#the-sign-flip-test)) |
| `signFlipInterval`, `fewestPairs` | the interval that inverts the test: the `K`-th smallest and largest subset means, `K = floor((1 − c) × 2ⁿ⁻¹)`, widened by the tie tolerance; unbounded with one pair or too few for the confidence ([the interval](../../docs/design/statistics.md#the-interval)) |
| `signFlipMethod`, `METHODS`, `UNBOUNDED`, `PairedCases`, `AnalysisMethod` | the `sign-flip` method in the shape of the engine's `AnalysisMethod`: per case, each arm's mean over its repetitions; the paired difference's interval at the protocol's confidence; no interval for the candidate's own level; an unbounded side as `±Number.MAX_VALUE` ([the analysis method](../../docs/design/statistics.md#the-analysis-method)) |
| `STATISTICS` | `@tsuuanmi/system-statistics` version `1`, what an experiment pins in `environment.statistics` |
| `GOLDENS` | the golden reference (SciPy 1.18.1, NumPy 2.5.4, Python 3.14.2) and the content id of the fixture the tests verified; with `verified: false` the method refuses every analysis ([golden tests](../../docs/design/statistics.md#golden-tests)) |
| `StatisticsError` | a refusal: `unverified`, `ratio`, `unpaired`, `too-few-pairs`, `too-many-pairs`, `not-finite`, `confidence` |

- **Depends on:** nothing. The method matches `AnalysisMethod` structurally; its tests check that it
  is one, and run it under the verdict rule (development dependencies on `evaluations-core`,
  `experiments-core`, and `libs`).
- **Tests:** [`tests/sign-flip.spec.ts`](tests/sign-flip.spec.ts) against the SciPy goldens in
  [`tests/fixtures/sign-flip.scipy.json`](tests/fixtures/sign-flip.scipy.json), generated once by
  [`scripts/statistics/sign-flip-goldens.py`](../../scripts/statistics/sign-flip-goldens.py);
  [`tests/method.spec.ts`](tests/method.spec.ts) for the method and the verdicts it leads to.
- Not built: a Monte Carlo test above 20 pairs, and the `bootstrap` and `bayesian` methods
  ([where the design leaves room](../../docs/design/statistics.md#where-the-design-leaves-room)). No
  evaluation engine calls the library until the store-backed `evaluations` provider (PROP-0011 F4).
