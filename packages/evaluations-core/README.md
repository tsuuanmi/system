# @tsuuanmi/system-evaluations-core

Evaluation engine **seam definition**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[evaluations](../../docs/design/evaluations.md)). A guarantee seam of the gate: its contract
changes only by an ADR ([ADR-0036](../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md),
[ADR-0045](../../docs/decisions/adr/0045-feedback-loop-guarantee-seams.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.evaluations` | abstract `Evaluations` with `collector(collector)`, `start(experimentId, at?)`, `sweep(at)`, `get(evaluationId)`, and `list(filter?)`; `Evaluation`, `EvaluationEntry`, `Trial`, `TrialSpec`, `Route`, `Collector`, `CollectedTrial`, `Collection`, `AnalysisMethod`, `AnalysisInput`, `EvaluationsError`; `EVALUATIONS_CONTRACT` (1.0), `CHECKS` | none yet: the store-backed provider is F4 of [PROP-0011](../../docs/proposals/0011-feedback-loop.md#milestones); the fake `FakeEvaluations`. The pinned statistics library is [`statistics`](../statistics/README.md) (F2) |

- The types mirror `evaluation@1.0` and the `verdict` decision of `decision@1.7`; the schemas in
  `schemas/` are canonical. It depends on Cordis, the libraries, and the experiment registry's
  definition, whose records it reads and whose experiments' states it moves.
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
