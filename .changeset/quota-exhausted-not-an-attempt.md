---
"@tsuuanmi/system-workflow": minor
---

A Worker's quota running out no longer spends a task's attempt (T272b, seen live on T268): a step that fails with `quota_exhausted` (a session or window limit) before its result landed is a `worker-unavailable` outcome, so the board gives the attempt back and the task is ready again. The reset is the one the error names, else the quota reading's, else one dispatch sweep on. Dispatch records the account's window as exhausted until then and does not take the task before it, and the task's dossier notes the lost time. A second failure of another kind still counts.
