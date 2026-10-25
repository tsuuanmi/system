---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-agent-runtime-core": minor
"@tsuuanmi/system-runtime-claude-agent-sdk": minor
"@tsuuanmi/system-runtime-codex-sdk": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-resources": minor
"@tsuuanmi/system-mcp-server": minor
"@tsuuanmi/system-report": patch
"@tsuuanmi/system-workflow": patch
---

A run that ends before its runtime's final count records what its runtime reported, health says which run and why, and a cap never counts usage it could not see as 0 (INV-2, ADR-0065).

- Why a run went `not-reported`: its numbers come from the runtime's final message (the Claude Agent SDK's `result`, Codex's turn count). A run stopped by the operator, past its timeout, drained at the host's stop, or at a deferred call never got that message, and what the runtime had reported while it ran was dropped.
- `RunMetering.partial` (at most 300 characters, no `resultId`): such a run reports what the agent did report, marked as a lower bound with why. The Claude Agent SDK provider sums the `usage` of the assistant messages it streamed (each message id once, at its largest counts; the main loop's messages are its turns); the Codex provider reports the turns it completed. With nothing reported, no number, never 0. The conformance suite checks it.
- The `agents` source records a partial report with a number above 0 as the run's `usage-record` and a `not-reported` fact, `usage-unknown@1.1`, whose new `partial` names that record; its own record never reconciles the run (`reconciledBy`, one rule for health, the report, and the ledger). A fact's `reason` now says in plain words how the run ended (`it completed`, `it was stopped: cancelled by the operator`, `it ran past its timeout of … ms and was stopped`, `the host stopped while it ran, and stopped it (a drain at stop or restart)`, `it stopped at a <tool> call that waits for approval request <id>`, `it failed (<kind>)`) and what its runtime reported.
- The store-backed ledger refuses a reservation whose caps have a scope (a task, else a project) while a run of that scope has usage it could not count in a capped pool and is not reconciled, for every pool kind, naming each run, its Worker, and why in the `budget` decision; and when no event log is loaded, more than 10,000 `usage.unknown` entries are kept, or one is not a valid record. This replaces D25's count-as-0 for caps. Until transcript reconciliation exists, the way out is to cancel the task and file it again without that cap (runbook).
- The health `usage` check names each pool's latest three such runs: the run, its Worker, its kind, whether a lower bound was counted, and its reason. The report's note says what a cap does with them.
- `scripts/check-docs.ts` skips `.claude`, an agent harness's own directory.
