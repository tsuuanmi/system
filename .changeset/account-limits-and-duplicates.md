---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-worker-sessions": minor
"@tsuuanmi/system-workflow": patch
"@tsuuanmi/system-turns": patch
"@tsuuanmi/system-mcp-server": patch
"@tsuuanmi/system-agent-workers": minor
---

Account limits and duplicate sign-ins are no longer missed (PROP-0012, phase C in part):
- An Antigravity CLI team member's session is recorded with the runtime `antigravity-cli` (`worker-session@1.1`, the `workerSessions` contract 1.1); before, it was recorded as `local-tool`. Other sessions are still written as `worker-session@1.0`.
- Two website accounts of the catalog signed in as the same person take no work (REQ-ACC-7): every Worker of both reads `unavailable`, a turn routed to one before the collision fails `reauth_required` before anything is sent, and health `accounts` is degraded, naming them. Signing one of them in as another person, or removing it from the catalog, clears it.
- An agent run that fails `quota_exhausted` with no limit reading (Codex and the Antigravity CLI report none) closes every window of its Worker's pool for `limitCooldownSeconds`. A Worker with no pool, or whose ledger did not take the reading, cools down every Worker of its runtime instead (they share one home, so one sign-in): until the reset the runtime named, else `limitCooldownSeconds`, at most seven days, across a restart. Its Workers read `quota-exhausted`, a run queued on one fails before the agent starts, and the event `agent-workers.cooldown` names it. No command ends a cooldown early.
