---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-approvals": minor
"@tsuuanmi/system-approvals-core": minor
"@tsuuanmi/system-web-ui": patch
---

The approval queue can propose, never apply, a policy change from repeated identical approvals (ADR-0050). It is off by default; the operator turns it on with `repeatedApprovals` in the `approvals` row:
- When the operator approved the same studio command, by its exact argv, at least `approvals` times (default 5, from 3 to 100) among the requests of the last `windowSeconds` (default a week), and rejected none and let none expire, the queue asks one `policy-change` request: the studio policy at its next version with that one line added to `commands`, nothing else. Only the operator's approval applies it.
- It never proposes a project's command, a `local-private` one, another action class, or a class that always asks, never while another policy change waits, and never again for a command whose proposal was declined or expired; the operator can still propose it on the policy page.
- The change record names where it came from (`policy-change@1.1` `origin`), and each proposal is a `policy-change` decision (rule `approvals.repeated-approvals`) citing the approvals it counted. On `/ui`, the queue entry and the policy page's history say the queue proposed it, not the operator.
