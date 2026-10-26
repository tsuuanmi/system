---
"@tsuuanmi/system-board-core": minor
"@tsuuanmi/system-board": minor
"@tsuuanmi/system-gateway-core": minor
"@tsuuanmi/system-mcp-server": minor
"@tsuuanmi/system-report": minor
"@tsuuanmi/system-workflow": minor
---

Escaped defects and Worker availability are recorded, and `system metrics` reads them (PROP-0016 I4 part 2, D83):
- A board task may carry a `defect` link, `fixes: <taskId>@<landing sha>` (`board-task@1.2`): set when the task is filed (`board_propose` `fixes`) or later, once, by the lead, the reviewer, or the operator (`board_defect`, `mcp-board@1.4`). It must name a done task of the project.
- A merged landing records the commits its change reverts (`reverts` on its `workflow.task.landing` entry).
- Escaped defects per 100 landed counts each task with a defect linked, reverted, or recorded as an escape in the window, over the results merged in it. It is a lower bound.
- The MCP server records each change of a Worker's ability to take work as `roster.worker.unavailable` (with the reason: `quota-exhausted`, `login-lost`, `quarantined`, `stalled`, `unavailable`) or `roster.worker.available` (`availabilitySeconds`, default 60).
- Worker availability is the share of observed hours each Worker could take work. Hours at a usage limit are left out; a lost login counts as unavailable.
