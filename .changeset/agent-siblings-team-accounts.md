---
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-workers-core": patch
---

Every role of one agent runtime home is one account (PROP-0012, phase C completed):
- The `agents` source names every Worker of a runtime as each one's `siblings` (they share its one home, so one sign-in). An unsent failover now leaves all of them out, not only the Worker that failed.
- A Worker reads `quota-exhausted` while the pool of any Worker of its runtime is closed, not only its own, with `limitUntil` the latest of their resets; `unavailable` while such a pool cannot be read. A run queued on it fails before the agent starts. Before, an unmetered role on the same sign-in stayed ready and ran into the same limit.
- A team member avoids every sibling of a Worker another member holds, and every Worker whose descriptor names the same account (REQ-TEAM-4). Two roles of one home are no longer two independent members: with the same family allowed, such a team is recorded as `same-family-shared-account`. A member whose held account cannot be told apart (its siblings name different accounts, or no source describes it) is refused, `config_error`, with that cause and nothing sent, even with `allowSameFamily`. The `workflow` conformance suite is at contract 1.5.
