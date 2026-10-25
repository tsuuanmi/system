---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-report": minor
"@tsuuanmi/system-cli": minor
---

Quota drawn per run (PROP-0015 E2): what each agent run of a derived Worker on a declared pool drew from each window of its account's pool is recorded and shown. It only records: no start, route, or cap reads it yet.
- `quota-draw@1.0`: one entry per window with the reading before the run (its latest when submitted) and after it (its latest once the account's usage report after the run is recorded), and the draw in percentage points. A draw needs both shares in the same window epoch (the later of `resetsAt` and `cooldownUntil`, as `accountQuotaOf` reads it). An epoch that changed, a reading with no reset, or a share that went down is `reset-crossing`, with no draw. A missing reading or share is `no-reading`, with no draw. Another run on the same account in flight meanwhile makes it `confounded`, kept out of the figures. Nothing is estimated, and a draw is never negative.
- The `agents` source stores it as an `evidence` artifact and a `quota.draw` event, naming the run, Worker, account, pool, kind of work (`WorkRequirement.kind`), template step, board task, and outcome. The workflow engine names each start's template step (`WorkerStart.step`, optional). The run keeps its kind and step (agent-workers migration 19).
- `libs`: `drawEntries`, `quotaDraw`, `quotaDrawOf`, `drawFigures` (per kind and window, or per kind, template step, and window: clean draws counted, median, p90 by nearest rank, and the entries left out by state), and `drawFigureText`.
- `system usage` (MCP `usage`, `draws`) shows them over the latest 1,000 records. The report shows them for its period (`mcp-report` 1.4, `usage.draws`).
