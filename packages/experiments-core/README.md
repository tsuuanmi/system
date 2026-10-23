# @tsuuanmi/system-experiments-core

Experiment registry **seam definition**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[experiments](../../docs/design/experiments.md)). A guarantee seam of the work state machine: its
contract changes only by an ADR ([ADR-0036](../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md),
[ADR-0044](../../docs/decisions/adr/0044-feedback-loop-guarantee-seams.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.experiments` | abstract `Experiments` with `lookup(registration)`, `register(registration, at?)`, `get(experimentId, revision?)`, `list(filter?)`, `link(link, at?)`, the evaluation engine's `begin`, `settle`, and `close`, `recordLesson(lesson, producer, at?)`, and `lessons(filter, current)`; `Hypothesis`, `Experiment`, `Lesson`, `ObjectiveContract`, `Registration`, `ExperimentEntry`, `Match`, `Link`, `Lookup`, `CurrentEnvironment`, `Vocabulary`, `ExperimentsError`; `EXPERIMENTS_CONTRACT` (1.0), `PREDICATES`, `REGISTRY_ANSWERS`, `OUTCOMES`, `COUNTED` | none yet: the store-backed provider is F3 of [PROP-0011](../../docs/proposals/0011-feedback-loop.md#milestones); the fake `FakeExperiments` |

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
