---
"@tsuuanmi/system-workflow": patch
---

Three fixes from the pre-merge review of the per-step budget and session escalation (T62):
- A session step's answer no longer fails because another Worker source cannot describe itself: the Workers its session holds it to are listed only once its result is rejected, and a listing that fails leaves them unknown, so the step does not escalate (`acceptance_rejected`, "held Workers unknown") and is never failed as `internal`.
- A board task's run that finished before any step reserved ends its budget `released`: a start no longer selects and rewrites its row every time.
- A step's budget hold is released as soon as its execution settles, not when the slowest sibling of its batch finishes, so a sibling that reserves later is not refused (`budget-spent`) for a hold no step needs.
