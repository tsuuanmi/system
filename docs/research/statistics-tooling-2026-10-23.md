# Statistics and experiment tooling for the feedback loop

Non-normative. The research run that [PROP-0011](../proposals/0011-feedback-loop.md#statistics-library)
asked for before any statistic is built: which statistics and experiment tooling the loop should
reuse, and what F2 should build. Run `run_f73859d402279e63` (the `research` template: ChatGPT
website and Gemini API members, the critique on Gemini API), completed 2026-10-23; a first attempt,
`run_9d2a2eb730e220b9`, failed on a Gemini API timeout.

## Recommendation

TypeScript first. The content-addressed store stays the authoritative experiment registry; SciPy is
the statistical reference; one narrow exact test is written in TypeScript, and only after golden
tests against SciPy.

| Hypothesis | Finding | Strength |
|---|---|---|
| H1: existing libraries cover the methods | SciPy (BSD-3-Clause) covers the paired permutation test (exact and Monte Carlo) and paired bootstrap intervals; statsmodels (BSD-3-Clause) adds paired equivalence (`ttost_paired` is an equivalence test, not a one-sided non-inferiority test). Do not build a BCa bootstrap or a general statistics engine | supported, moderate |
| H2: inference and the decision policy stay apart | Default to a fixed, pre-declared sample size; no statistical early stopping until a procedure passes Type I error, coverage, and power simulations under the paired-task design. An operational early end is never "success". Missing or undefined statistics never count as passing (fail closed) | supported, high |
| H3: the registry stays ours | Immutable hashes of the plan, the suite, the configurations, the observations, the metrics, the environment, the inference, and the decisions; experiment, attempt, and analysis identities kept apart. MLflow (Apache-2.0) is at most an optional downstream projection | supported, moderate |
| H4: a Python sidecar is worth it | Not shown. Keep the statistical adapter replaceable and Python optional | insufficient |

Excluded as the core engine: GrowthBook's `gbstats` (MIT; independent-sample A/B tests, no native
paired resampling), Optuna (MIT) and Ax/BoTorch (MIT, heavy), which optimize rather than infer on
paired confirmatory data. PyMC and ArviZ (Apache-2.0) stay optional, for a Bayesian method with an
explicit prior. simple-statistics is ISC-licensed and needs a licence-policy decision before any use.

**First implementation (F2):** the exact paired sign-flip test in TypeScript, exhaustive up to 20
pairs, with its two-sided p-value convention, zero differences and ties, and float tolerance
specified; golden datasets from SciPy before it may decide anything; for any sampling, the RNG
algorithm and state, the sample order, the versions, and the serialization recorded, not just a
seed. A fixed horizon (30 or 50 tasks, for example), pre-declared margins, and every guardrail must
pass.

**Open evidence:** TypeScript-against-SciPy conformance; simulations of sequential validity (at least
10,000 replicates); the registry's crash, concurrency, and replay invariants; a benchmark of
TypeScript only against a Python subprocess and a sidecar.

## Adopted

- The exact paired sign-flip test and its interval, in TypeScript, exhaustive up to 20 pairs, with
  golden tests against SciPy 1.18.1 ([statistics](../design/statistics.md)).
- SciPy as the reference, run once to generate the goldens; never a runtime dependency.
- Inference apart from the decision policy: the library gives intervals; the verdict rule of
  [evaluations](../design/evaluations.md#the-verdict-rule) is the fixed-horizon decision with
  pre-declared margins, every guardrail needing to clear.
- Fail closed on a missing or undefined statistic.

## Not adopted

- A Monte Carlo test above 20 pairs: no record holds what it must record yet.
- A bootstrap or Bayesian method, statsmodels, PyMC, and ArviZ: not built; an experiment that
  declares such a method is refused at start.
- GrowthBook `gbstats`, Optuna, Ax/BoTorch, and MLflow as the engine or the record.
- simple-statistics: no licence-policy decision.
- A Python sidecar.
