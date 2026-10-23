---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-mcp-server": minor
"@tsuuanmi/system-report": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-cli": minor
---

Usage the resource ledger cannot count is recorded and shown (operator decision D25). A cap still counts it as 0: the Resources seam and its cap semantics do not change.
- A metered agent run the ledger counted nothing for is a fact: one `usage.unknown` event, its data a `usage-unknown@1.0` record naming the run, Worker, pool, board task, how it ended, and why: `not-reported` (the runtime reported neither tokens nor turns), `interrupted` (the host stopped while it ran), `refused` (the ledger refused its record, which is kept as an `evidence` artifact), or `failed`. A record refused as invalid with a per-model split is first offered again with its totals alone. A fact that cannot be appended is logged.
- `system health` has a `usage` check: degraded while a configured pool has such a run in its current window (its longest) that the ledger has not counted a record of since, naming the pool and the count; also while such a run names a pool the ledger does not configure (an `unconfigured pool` line), and when the windows hold more entries than it reads (10,000, a page at a time), so it is never `ok` on part of them.
- The report (`mcp-report` 1.1) gives, per pool and in all, the records without token counts, a cost, or turns, and the runs whose usage is unknown and not reconciled; in all, those runs by kind and how many were counted since.
- `system usage` (MCP `usage`) marks such a step `usage unknown (<why>)`.
- Failing closed for metered pools is deferred until transcript reconciliation exists, with its own ADR.
