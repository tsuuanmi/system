---
"@tsuuanmi/system-workflow": patch
---

Dispatch no longer uses up a board task's attempts when an attempt continues a session (T215, a regression of T205):

- When a task's next attempt resumes the previous attempt's session, dispatch chooses that session's Worker, even when another account's Worker has more quota. Every other Worker is refused in `dispatch.choice` with the step's restriction as the reason. If the session's Worker is not free, the task is not started that pass, and the pass reports "waits for its session's Worker". Before this fix, dispatch picked another account's Worker, and the step failed within seconds with nothing sent, using up the attempt.
- Second line of defence: a dispatched start whose chosen Worker the step's own restriction leaves out is refused before the run takes the task. The refusal is recorded as a `workflow.task-admission` decision and the ask closes as `refused`. No attempt is used, and dispatch chooses again.
