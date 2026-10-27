# ADR-0045: The feedback loop's guarantee seams: an experiment registry and an evaluation engine

- **Status:** Proposed
- **Date:** 2026-10-23
- **Related:** [PROP-0011](../../proposals/0011-feedback-loop.md),
  [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0037](0037-schema-and-protocol-first.md),
  [ADR-0039](0039-base-guarantee-seam-contract-changes.md),
  [ADR-0046](0046-evaluation-and-promotion-integrity.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-5](../../architecture/invariants.md#inv-5-exact-subject-binding),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

PROP-0011 asks for a loop that records research, hypotheses, experiments, evaluations, and
lessons, never redoes an experiment blindly, judges candidates by a deterministic engine under a
versioned objective contract, and promotes only on evidence. Two of its parts could make `system`
incorrect if a worse provider served them: an evaluation engine that misreads evidence could let a
regression be promoted, and a registry that loses an experiment's identity breaks the record the
loop rests on. Under ADR-0036 both are guarantee seams, and adding one, a decision type, or an
action class changes the core, so each needs an ADR. ADR-0037 asks that a new seam ship its
schemas, an abstract definition, a written protocol, and a conformance suite first; the operator
started milestone F1, the specification, on 2026-10-23.

## Options

1. **One seam** holding both the registry and the engine. Simpler, but the work state machine
   (which experiments exist and in what state) and the gate (whether evidence is valid, and what it
   says) would share one provider, so a provider replaced for its engine could also lose the
   registry's identities, and neither could be tested on its own.
2. **Two guarantee seams**, an experiment registry of the work state machine and an evaluation
   engine of the gate, each with its own definition, protocol, and suite; the engine moves an
   experiment's state only through the registry.
3. **Capability plugins only**, the loop as workflow templates and verification plugins over the
   existing seams. Nothing would hold an experiment's identity or the verdict rule to a contract,
   so a template could re-run an experiment or misjudge one unnoticed.

## Decision

Option 2.

**`experiments` (core: work state machine), contract 1.0**
([experiments](../../design/experiments.md)). An abstract `Experiments` in
`system-feedback-core` owns `ctx.experiments`: `lookup`, `register`, `get`, `list`, `link`, the
evaluation engine's `begin`, `settle`, and `close`, `recordLesson`, and `lessons`. It computes the
exact identity and the structured fingerprint by pure functions pinned by their versions, answers
every registration EXACT_REPEAT, RELATED, CONTEXT_CHANGED, or NOVEL, checks the retry predicates
against the records, and pre-registers or refuses the registration, recorded first as a decision.
An exact repeat is always refused. With the registry unavailable, nothing is pre-registered.

**`evaluations` (core: gate), contract 1.0**
([evaluations](../../design/evaluations.md)). An abstract `Evaluations` in
`system-feedback-core` owns `ctx.evaluations`: `collector`, `start`, `sweep`, `get`, and `list`.
It checks pins, seals, the judge, the families, and the collectors before any trial; schedules
paired, interleaved trials from the seed; records each trial before its run starts and never
starts one twice; measures through collectors and the resource ledger; analyses once at the
horizon by the pinned statistics library's methods; and applies a deterministic verdict rule. It
decides no promotion. With the engine unavailable, no evaluation or verdict is recorded and no
promotion can be asked.

**Collectors** are the verification family, registered through `evaluations.collector` as
acceptance contracts register through `workers.contract`; they fail open in the capability sense
only: a value they do not return is missing, and a missing value makes the evaluation `invalid`.

**Records.** `objective-contract@1.0`, `hypothesis@1.0`, `experiment@1.0`, `evaluation@1.0`, and
`lesson@1.0`, each the body of an artifact of an existing kind (`criteria`, `criteria`, `plan`,
`evidence`, `finding`), as every Base record is: the envelope's kind stays a family, the body
schema names the record, and the `artifacts` seam does not change. An objective contract is
written only by the operator.

**`decision@1.7`** adds two decision types, each refused before 1.7:

- `registration`, the registry's answer: pre-registered or refused, decider rule
  `experiments.registry`, hashed with the vocabulary. The proposal names the verdict only; a
  registration decides whether an experiment may run, so INV-13 requires it to be a decision
  artifact too.
- `verdict`, the engine's classification of one evaluation (`supported`, `refuted`,
  `inconclusive`, `invalid`), decider rule `evaluations.verdict`, hashed with the experiment's
  protocol.

**`approvals`: the action class `promotion`** joins the classes that always ask (`ALWAYS_ASK`,
the load-time rule, and the judge that raises a class to `ask`), so the loop never approves its
own change. It is a new value of `common@1`'s action classes; `autonomy-policy@1.0` stays at its
version, and its schema refuses `auto` and `notify` for `promotion` from the start, which tightens
nothing since no record named it before. The approvals contract stays 1.1, amended in place while
unreleased, as ADR-0039 did for `remediation`; its suite's always-ask scenario covers the class.

**Not decided here**, each with its own ADR when its milestone needs it: a `workflow` contract
change that fixes a trial's run to its arm's Workers from a trusted envelope (PROP-0011 Q2; F4 or
F5); the plugin host refusing a move to `default` that no approved promotion names (Q10); and the
two invariant candidates, proposed in [ADR-0046](0046-evaluation-and-promotion-integrity.md).

## Consequences

- F1 ships both definitions with their suites, passed by fakes (`FakeExperiments`,
  `FakeEvaluations`); no provider is in the bundle, so nothing else changes. F3 and F4 add the
  store-backed providers, their bundle rows off by default, and run the same suites.
- The statistics stay pending (F2): the engine's contract names the pinned library's methods
  (`AnalysisMethod`), and the suite analyses with a stand-in that is never shipped.
- A guarantee seam's suite now covers the loop's fail-closed rules, so a replacement registry or
  engine found later is held to the same contract.
- Revisit if a third provider family's judge needs a validator seam of its own, or if online
  evaluation (shadow, canary) needs the engine to run trials on live work.
