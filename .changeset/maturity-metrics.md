---
"@tsuuanmi/system-report": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-cli": minor
---

The maturity metrics of PROP-0016 §1, computed from records only (I4 part 1, D83):
- `system metrics [--days n] [--project id] [--until time] [--json]` and the MCP `metrics` tool (client scope, `mcp-report@1.6`) read every metric over a rolling window, 30 days by default. Each metric gives its value, the sample it is over, and the records it read. One the records cannot give yet says why and has no value, never 0. A value the records only bound is marked `lower` or `upper`, with what it leaves out.
- Measured now: board coverage, lead touches per task, operator decisions per day, unattended completion, time ready-to-landed, stalls per 100 runs, and cost per accepted result.
- Not measurable yet, each with the record it needs: traced landings, gate coverage, escaped defects, Worker availability, and quota idle while work is ready.
- A lead touch is a run of the task the lead started, or a decision a client made on one of its runs. The lead's moves on its own coordination board leave no System record yet, so the count is a lower bound (docs/design/maturity-metrics.md).
- Each metric stands against its L3 line (starting lines, D83). L3 holds only when every line is met over 30 days and 30 finished tasks. Otherwise the reading says why. It is a reading, never a switch.
- The weekly report ends with the same reading over the 30 days to its end (`maturity`, `mcp-report@1.6`).
- The one record added: the `workflow.run.started` entry of a board task's run now names who started it (`startedBy`: dispatch, lead, or operator). It is additive.
