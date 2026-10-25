---
"@tsuuanmi/system-workflow": patch
---

Dispatch fixes after review T202 of PR #37 (ADR-0064):

- A dispatched run's writing step is bound to the Worker dispatch chose. If routing refuses that Worker, the step no longer moves to another Worker that no dispatch decision names. It waits for the chosen Worker for up to `dispatch.approvedHoldMinutes` from the run's start, sending nothing and spending no attempt. After that the attempt fails for you, and the task's next attempt is dispatch's to choose again.
- A start a crash interrupted before its run was admitted (a row left `starting`) is checked again on restart, just like an approved one. A run already admitted for it is adopted first. Otherwise the pause, the hold, the task, the Worker, and the bounds are all checked before anything starts.
- `dispatch.approvedHoldMinutes` is checked before every start: an approval older than that starts nothing, even with its Worker free and fresh readings.
- `dispatch.maxPerPass` is now one allowance for the whole pass. Starts of approved asks during settlement count against it, alongside the starts and new asks the pass makes when it picks ready tasks. A request counts as soon as the approval queue opens it, even if recording it on its ask then fails.
