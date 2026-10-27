# @tsuuanmi/system-feedback-core

The feedback loop's **seam definitions and library** ([PROP-0011](../../docs/proposals/0011-feedback-loop.md#milestones)):
two guarantee seams and the statistics they pin, in one package (PROP-0018 T12).
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2). A seam's
contract changes only by an ADR ([ADR-0036](../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md),
[ADR-0045](../../docs/decisions/adr/0045-feedback-loop-guarantee-seams.md)).

| Folder | What it holds |
|---|---|
| `src/experiments` | `ctx.experiments`, the experiment registry ([experiments](../../docs/design/experiments.md)) |
| `src/evaluations` | `ctx.evaluations`, the evaluation engine ([evaluations](../../docs/design/evaluations.md)) |
| `src/statistics` | the pinned statistics library ([statistics](../../docs/design/statistics.md)) |

## `ctx.experiments`

A guarantee seam of the work state machine.

| Seam | Definition | Provider |
|---|---|---|
| `ctx.experiments` | abstract `Experiments` with `lookup(registration)`, `register(registration, at?)`, `get(experimentId, revision?)`, `list(filter?)`, `link(link, at?)`, the evaluation engine's `begin`, `settle`, and `close`, `recordLesson(lesson, producer, at?)`, and `lessons(filter, current)`; `Hypothesis`, `Experiment`, `Lesson`, `ObjectiveContract`, `Registration`, `ExperimentEntry`, `Match`, `Link`, `Lookup`, `CurrentEnvironment`, `Vocabulary`, `ExperimentsError`; `EXPERIMENTS_CONTRACT` (1.0), `PREDICATES`, `REGISTRY_ANSWERS`, `OUTCOMES`, `COUNTED` | none yet: the store-backed provider is F3 of PROP-0011; the fake `FakeExperiments` |

- The types mirror `hypothesis@1.0`, `experiment@1.0`, `lesson@1.0`, `objective-contract@1.0`, and
  the `registration` decision of `decision@1.7`; the schemas in `schemas/` are canonical. It depends
  on Cordis and the libraries (canonical JSON hashing, schema validation).
- The registry's rule is pure and the same for every provider ([two keys](../../docs/design/experiments.md#two-keys),
  [a registration](../../docs/design/experiments.md#a-registration)):
  - the keys, each pinned by its version: `fingerprintOf` (`FINGERPRINT_VERSION` 1) from the
    vocabulary (`canonicalTag`, `vocabularyProblems`, `vocabularyHash`), `environmentHash`,
    `identityOf` (`IDENTITY_VERSION` 1), and `protocolHash`;
  - the answer: `changedPredicates`, `answerOf` (EXACT_REPEAT, CONTEXT_CHANGED, RELATED, NOVEL),
    and `admit`;
  - the checks: `contractProblems`, `protocolProblems`, `independenceProblems`,
    `experimentProblems`, and `prepareRegistration`, which runs them all and answers, recording
    nothing; `experimentRecord` and `registrationDecision` build what a provider records;
    `registrationHash` keys a retried registration;
  - lessons: `fired`, `firedPredicates`, and `lessonEvidenceProblems`.
- The conformance suite is [`conformance/experiments.ts`](conformance/experiments.ts), run through
  the [conformance runner](../libs/conformance/runner.ts) at contract 1.0. `boot()` gives a
  registry configured with `VOCABULARY` over one durable state, and `start()` restarts it. Its
  scenarios build registrations from the examples in `schemas/examples`, over a contract and a
  funding approval the suite records as the operator:
  - a novel registration pre-registered, with its records and a `registration` decision@1.7;
  - an exact repeat, reworded, re-seeded, or named by an alias, refused, with the earlier
    experiment, its verdict, and its lessons returned;
  - CONTEXT_CHANGED and RELATED, each pre-registered only with its citations, and for an equal
    fingerprint a retry predicate the records confirm, with why;
  - links made by hand, and a hypothesis naming an earlier experiment;
  - invalid registrations refused with nothing recorded; a retried registration returned as
    recorded; revisions superseding a pre-registered one only;
  - the evaluation engine's moves fenced by its evaluation, bound to its evaluation record and
    verdict; lessons checked against their verdicts and read against the current environment;
    and the registry's state kept across a restart.

  It also exports `FakeExperiments`, which passes it over a state its caller keeps across
  restarts, and the helpers the evaluations suite builds on (`operatorRecords`, `registrationOf`,
  `recordEvaluation`, `recordVerdict`, `closeWith`).

## `ctx.evaluations`

A guarantee seam of the gate.

| Seam | Definition | Provider |
|---|---|---|
| `ctx.evaluations` | abstract `Evaluations` with `collector(collector)`, `start(experimentId, at?)`, `sweep(at)`, `get(evaluationId)`, and `list(filter?)`; `Evaluation`, `EvaluationEntry`, `Trial`, `TrialSpec`, `Route`, `Collector`, `CollectedTrial`, `Collection`, `AnalysisMethod`, `AnalysisInput`, `EvaluationsError`; `EVALUATIONS_CONTRACT` (1.0), `CHECKS` | none yet: the store-backed provider is F4 of PROP-0011; the fake `FakeEvaluations`. The pinned statistics library is `src/statistics` (F2) |

- The types mirror `evaluation@1.0` and the `verdict` decision of `decision@1.7`; the schemas in
  `schemas/` are canonical. It reads the experiment registry's records and moves its experiments'
  states.
- The protocol's steps are pure and the same for every provider
  ([an evaluation](../../docs/design/evaluations.md#an-evaluation)): `schedule`
  (`SCHEDULE_VERSION` 1, from the seed) and `evaluationIdOf`; the checks `pinProblems`,
  `sealProblems`, `judgeTouched`, `collectorProblems`, `trialInvalid`, `canAfford`, and
  `missingOf`; `requirementsOf` (what every trial must be measured for); `analysisInput` and
  `armVector`, the arithmetic around the pinned analysis. None of them is a statistic: the methods
  are the pinned library's (`AnalysisMethod`).
- The verdict rule ([the verdict rule](../../docs/design/evaluations.md#the-verdict-rule)) is
  `verdictOf` (`VERDICT_RULE`, version 1), and `verdictDecision` builds the `verdict` decision a
  provider records; `netBenefit` gives the bounds a promotion request shows, never part of the
  verdict.
- The conformance suite is [`conformance/evaluations.ts`](conformance/evaluations.ts), run through
  the [conformance runner](../libs/conformance/runner.ts) at contract 1.0. `boot(world)` gives an
  engine beside a `ctx.experiments`, over one durable state; the `World` stands for the live
  environment, the suite's partitions, what the candidate changes, and each trial's run, and the
  suite registers its own collectors and analyses with `SPAN`, a stand-in for the statistics
  library that is never shipped:
  - a supported evaluation: the seed's order, each trial started once, collectors and the ledger
    measuring it, one analysis at the horizon, and a `verdict` decision@1.7 closing the
    experiment;
  - refuted and inconclusive verdicts from the thresholds alone; a spent budget ending it at most
    inconclusive; a broken hard constraint ending it refuted;
  - an integrity breach ending it invalid at once: a same-family fallback, a run outside its arm,
    another model version, a missing metric, a contaminated trial, a pin or a seal changed mid-run;
  - restart by reconciliation: an ended run measured once, an unknown one lost and never run again;
  - refusals that start nothing: not pre-registered, pins or seals changed, a candidate touching
    its judge, no pinned statistics, collectors missing, at another version, or dependent.

  It also exports `FakeEvaluations`, which passes it over a `World` and a state its caller keeps
  across restarts.

## Statistics

A **library, not a plugin**: pure logic with one correct answer, no service and no `apply`
([plugin model](../../docs/architecture/plugin-model.md#what-is-not-a-plugin)). It is inference only:
it holds no threshold and decides nothing; the verdict rule reads the intervals it gives.

| Export | Purpose |
|---|---|
| `signFlipTest`, `MIN_PAIRS`, `MAX_PAIRS`, `TIE_TOLERANCE` | the exact paired sign-flip test of the mean difference, 2 to 20 pairs, every sign vector enumerated: `greater`, `less`, and two-sided p-values by SciPy's conventions (ties at least as extreme, two-sided twice the smaller, at most 1), zero differences kept, ties within `2⁻⁴⁰ × Σ(|candidate| + |baseline|)`, the pairs in a canonical order ([the sign-flip test](../../docs/design/statistics.md#the-sign-flip-test)) |
| `signFlipInterval`, `fewestPairs` | the interval that inverts the test: the `K`-th smallest and largest subset means, `K = floor((1 − c) × 2ⁿ⁻¹)`, widened by the tie tolerance; unbounded with one pair or too few for the confidence ([the interval](../../docs/design/statistics.md#the-interval)) |
| `signFlipMethod`, `METHODS`, `UNBOUNDED`, `PairedCases` | the `sign-flip` method in the shape of the engine's `AnalysisMethod`: per case, each arm's mean over its repetitions; the paired difference's interval at the protocol's confidence; no interval for the candidate's own level; an unbounded side as `±Number.MAX_VALUE` ([the analysis method](../../docs/design/statistics.md#the-analysis-method)) |
| `STATISTICS` | `@tsuuanmi/system-statistics` version `1`, what an experiment pins in `environment.statistics` |
| `GOLDENS` | the golden reference (SciPy 1.18.1, NumPy 2.5.4, Python 3.14.2) and the content id of the fixture the tests verified; with `verified: false` the method refuses every analysis ([golden tests](../../docs/design/statistics.md#golden-tests)) |
| `StatisticsError` | a refusal: `unverified`, `ratio`, `unpaired`, `too-few-pairs`, `too-many-pairs`, `not-finite`, `confidence` |

- **Tests:** [`tests/sign-flip.spec.ts`](tests/sign-flip.spec.ts) against the SciPy goldens in
  [`tests/fixtures/sign-flip.scipy.json`](tests/fixtures/sign-flip.scipy.json), generated once by
  [`scripts/statistics/sign-flip-goldens.py`](../../scripts/statistics/sign-flip-goldens.py);
  [`tests/method.spec.ts`](tests/method.spec.ts) for the method and the verdicts it leads to.
- Not built: a Monte Carlo test above 20 pairs, and the `bootstrap` and `bayesian` methods
  ([where the design leaves room](../../docs/design/statistics.md#where-the-design-leaves-room)). No
  evaluation engine calls the library until the store-backed `evaluations` provider (PROP-0011 F4).
