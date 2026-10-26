---
"@tsuuanmi/system-decision-core": minor
"@tsuuanmi/system-workflow": minor
---

The dispatch advisor is now a seam of its own, `ctx.dispatchAdvisor`, defined in the new package `@tsuuanmi/system-decision-core` (ADR-0037). That package is also where PROP-0002's planned `decisions` seam will go.
- The definition is the abstract `DispatchAdvisor`. The package also holds the call every provider answers (`Advisor`), its vocabulary (features, advice, `AdvisorSignal`, `advisorStop`, `adviceProblem`), and the seam's conformance suite (`conformance/dispatch-advisor.ts`, contract 1.0), moved from the workflow package. The workflow package still exports the same names.
- A plugin that provides `ctx.dispatchAdvisor` is asked at each dispatch choice in place of the advisor `dispatch.advisor.provider` configures, within the same bounds, in shadow as before (workflow contract 1.12, additive). `ctx.workflow.setDispatchAdvisor` still works: it is the thin path and swaps one in place of both. With neither, dispatch behaves exactly as before.
- The workflow engine's `local` and `model` advisors are still the configured providers. The suite runs against both, and against a fake, through `setDispatchAdvisor` and through `ctx.dispatchAdvisor`.
