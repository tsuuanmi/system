# @tsuuanmi/system-decision-core

Decision **seam definitions**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[ADR-0037](../../docs/decisions/adr/0037-schema-and-protocol-first.md)). Capability seams of the
decision family (they take state and typed questions and return typed answers with
probabilities): their contracts change by a versioned definition and their conformance suites
([ADR-0036](../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md)). The first is
the dispatch advisor; PROP-0002's `decisions` seam, typed decisions for intake and routing, is
planned here too.

| Seam | Definition | Providers |
|---|---|---|
| `ctx.dispatchAdvisor` | abstract `DispatchAdvisor` (`id`, `advise(features, signal)`), the call every provider answers `Advisor`, and its vocabulary: `AdvisorFeatures` (`dispatch-features@1`, `FEATURES_SCHEMA`), `AdvisorCandidate`, `AdvisorWindow`, `AdvisorCounts`, `Advice`, `CandidateAdvice` (`dispatch-advice@1`, `QUESTION_SET`, `QUESTIONS`), `AdvisorSignal` and `advisorStop()`, the answer check `adviceProblem(advice, features)`, `MAX_CANDIDATES`, `ALIASES`; `DISPATCH_ADVISOR_CONTRACT` (1.0) | the workflow engine's `local` (a logistic regression on this host's recorded outcomes) and `model` (a configured model Worker), each when `dispatch.advisor.provider` names it ([workflow](../plugins/workflow/README.md)); any plugin that provides `ctx.dispatchAdvisor` |

- **The dispatch advisor** (PROP-0015 J1, [the dispatch advisor in shadow](../../docs/design/workflow-engine.md#the-dispatch-advisor-in-shadow))
  is asked once per dispatch choice, after the choice is made, with frozen features only (D73:
  kind, template, step, the admitted candidates by alias with their quota lines and recorded
  counts; never a task's title, goal, or any other text), and answers three probabilities per
  candidate under a pinned model version, or `unavailable` with why. Its consumer, the workflow
  engine's dispatch pass, records the answer beside the choice, as its input (INV-13), and nothing
  it says changes a choice; an error, a timeout, a malformed answer, or the hourly bound is
  recorded as `unavailable` (it fails open).
- **Which provider answers** (workflow contract 1.12): one set through
  `ctx.workflow.setDispatchAdvisor`, the thin path; else the provider of `ctx.dispatchAdvisor`, while
  a plugin registers one; else the one `dispatch.advisor.provider` names; else none.
- `AdvisorSignal` is deliberately not an `AbortSignal`: its stop listeners run inside a guard
  (`advisorStop`), so one that throws is recorded, never uncaught.
- It depends on Cordis (a peer) and [`libs`](../libs/README.md) (the question set and its questions,
  which the report scores too).
- The conformance suite is [`conformance/dispatch-advisor.ts`](conformance/dispatch-advisor.ts),
  run through the [conformance runner](../libs/conformance/runner.ts) at contract 1.0, over a
  dispatch harness the test supplies (the workflow engine's is
  [`plugins/workflow/conformance/advisor.ts`](../plugins/workflow/conformance/advisor.ts)):
  - it is asked once per dispatch choice with features only, the chosen Worker as alias `A`, the
    snapshot frozen;
  - it never changes the choice: the same Worker, request, subject version, and candidates as with
    no advisor, its advice recorded beside the choice as its input;
  - it answers within `dispatch-advice@1` (every candidate once, three probabilities in [0, 1],
    a pinned model version, all recorded as `modelAnswers`) or `unavailable` with its own reason,
    asked through dispatch or given features directly;
  - it settles soon after its call is stopped, and none of its stop listeners throws.

  `workflow/tests/dispatch.spec.ts` runs it against `local` (fitted, and with too few labelled
  attempts), `model` (over a scripted model Worker), and a fake whose advice opposes every choice,
  each set through `setDispatchAdvisor` and as the provider of `ctx.dispatchAdvisor`.
