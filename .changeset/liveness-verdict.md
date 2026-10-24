---
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-leases": minor
"@tsuuanmi/system-agent-runtime-core": minor
"@tsuuanmi/system-runtime-claude-agent-sdk": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-workers": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-workflow": minor
---

A run is gone only on evidence, and a session blocked on an approval takes no automated input (PROP-0013 L1 and L2, ADR-0056):
- A lease heartbeat whose renewal merely fails (the store busy) no longer stops a live agent run: `lost` fires only when the lease was expired, taken over, or invalidated, or its expiry passed unrenewed (leases contract 1.1).
- After a restart, a started agent run fails as `reconciliation_failed` only once a liveness verdict finds it `dead`: its holder and its agent process positively gone, and no activity for `deadAfterSeconds` (default 120). The verdict is a `reconciliation` decision on the run. Anything else is looked at again, and after `maxUnknownVerdicts` (default 3) goes to the operator, never declared dead, its session and worktree held. Claude Code reports its agent process; Codex, ACP, and the Antigravity CLI do not yet, so their interrupted runs reach the operator as `unknown`.
- A running agent whose process is present and that has been quiet for `stallSeconds` (default 300) is reported once per stall (`agent-workers.run.stalled`); nothing is sent to it or stopped.
- A board task's next attempt no longer resumes a session whose latest run waits on an open approval request, has not finished, or is not known to be gone: it starts fresh and says why (workflow contract 1.6). A peer's message to such a session waits, unread, until the session takes input.
