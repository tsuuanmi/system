---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-artifacts": patch
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-gateway-core": minor
"@tsuuanmi/system-approvals-core": minor
"@tsuuanmi/system-approvals": minor
"@tsuuanmi/system-mcp-server": minor
"@tsuuanmi/system-web-ui": minor
"@tsuuanmi/system-report": minor
"@tsuuanmi/system-cli": minor
"@tsuuanmi/system-workflow": patch
---

The lead acts as the lead, not as the operator (ADR-0076, PROP-0016 I2). Each project has a lead principal with its own token, and what it decides is recorded as `lead:<project>`:
- `system lead-token issue <project>` creates `lead-<project>.token` beside `operator.token` with the same permissions (issuing again replaces it); `revoke <project>` removes it and the host refuses it at once, no restart; `list` names the projects. The operator's token file is never touched.
- Its rights are a closed list System enforces, not the lead's scripts: verdicts on its project's commands and dispatch starts (`approvals_decide`, `/ui` approvals), merges into, and results accepted or rejected on, the project's listed dev branches (`devBranches` in the `approvals` row, never `main` or `master`), the board moves and answers to Workers it already had. A policy or charter change, a protected branch, a deploy, an external send, and every other tool or route are refused for the lead token with the reason; a call with one verdict off the list decides none. A lead's acceptance never skips the policy's checks or a heavy tier's hold.
- A lead's verdict, acceptance, and tie vote are `client` deciders `lead:<project>` (`decision@1.10` lets a `client` decider decide more than a vote); the operator's decisions are decider version 2, and a version 1 record reads "before the lead principal" (not migrated).
- The metrics read lead touches per task from these records, and count operator decisions per day for the operator principal only. `/ui` shows who decided each accepted result and its merge approval: operator, lead, or System.
