---
"@tsuuanmi/system-web-ui": minor
---

Web UI follow-ups (T160):
- A review card lists each check the policy requires with its state, read from the acceptance the run recorded (ADR-0063): passed or failed with its exit code only on a record, not run and why, or pending; never passed without a record. The warning under it names a pending check the run recorded as failed under *Checks that failed*, never under *Checks not run*. `GET reviews` adds each review's optional `checks` (`{value, requiredUnknown?}`).
- Home's *Since you last looked* leads a failed run with the run page's own plain-words reason (one function, from its kind and disposition), the system's raw text folded under *What the system said*; the run page now says that same reason first, then the system's text (*its account must sign in again (it needs you) — …*). `GET activity` adds a failed run's optional `failure {kind, disposition}` beside its `error`.
- Home's *Workers at a glance* renders *Right now* by the same function as the Workers page, from the same capacity summary (T152), so both name the same free, stalled, and no-quota Workers; a free Worker kept out of teams (D58) is said free for other steps, not for team work.
