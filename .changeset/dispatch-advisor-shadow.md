---
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-report": minor
---

Dispatch can now ask an advisor about each choice, in shadow only (PROP-0015 J1, adapted: no Jev adapter, since Jev is not verifiably usable yet). It is off unless you configure it:
- One provider-neutral seam (`Advisor`) is given features only (D73): the step's kind, the template, the step, and each admitted candidate under an alias (`A` is the chosen one), with its quota line and its recorded counts. It never sees a task's title or goal, a Worker id, or an account. In one call it answers three probabilities per candidate: accepted, a limit mid-task, and needs you. The answer carries the model and its version.
- The advice is recorded as a `route` decision (`advisor.dispatch`, every probability in `modelAnswers`), and `dispatch.choice` names it as an input. It never changes the choice: the same Worker, request, and version as without it. Any advisor error, timeout, malformed or unpinned answer, or the hourly bound is recorded as `unavailable` with why, and the choice goes on as before.
- An advisor is stopped through its own signal, not an `AbortSignal`: a stop listener that throws is recorded with the timeout and cannot crash the process.
- `dispatch.advisor.provider` picks the advisor:
  - `none` (default): no advisor is asked; each choice records that none was, with its features.
  - `local`: a regularized logistic regression fitted on this host's own recorded dispatch outcomes. No data leaves the host. It says `insufficient data` until `minLabelled` (30) labelled attempts exist.
  - `model`: the model Worker named by `model.worker` (for example the metered Gemini API entry), asked through the router with a JSON schema. It is never called unless you set this.
  - Other settings: `timeoutMs` (2000), `maxPerHour` (120), `l2` (1). `ctx.workflow.setDispatchAdvisor` swaps in another provider (workflow contract 1.11), which passes the seam's conformance suite (`conformance/advisor.ts`, contract 1.0).
- When a dispatched run reports its task, its labels are recorded (`workflow.dispatch.outcome`): accepted, met a limit, needed you.
- The report (`mcp-report@1.5`, `advice`) scores the advice against those labels: a Brier score per question, beside always answering the observed rate, and the count toward D74's 100 attempts.
