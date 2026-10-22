---
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-board": minor
---

A workflow run serves one attempt of a board task (B4):
- MCP `run` (and `ctx.workflow.start`) takes `task: { taskId, holder?, generation? }`. The run claims the ready task, or takes the claim a lead hands it from `board_claim`; a task not ready, or a stale claim, refuses the run with nothing started.
- The board records the run before any step runs, and the run renews the task's lease while it lives. A completed run's result, on the exact subject the task writes, is submitted with the run's acceptance decision; a failed or stopped run, and a run whose lease was lost (across a restart, say), is reported with `reconcileRun`. A run that lost its lease starts nothing new. An acceptance the board refuses for want of a required check leaves the task in review.
- Such a run is not continued or superseded: the board decides the next attempt, which runs as a new run. The workflow conformance contract is now 1.2.
- `board_complete` is gone: the run that serves an attempt submits its result, so one attempt has one writer.
