---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-report": minor
"@tsuuanmi/system-cli": minor
---

The lead's daily digest and a health table, read-only (PROP-0019 rank 10, D108).
- MCP `lead_digest` and `system lead digest [--project] [--day]`: for a UTC day, what landed, what the lead decided on its own token, what waits on the operator with its expiry, what failed, and the day's measures (landed by System and by hand, lead touches, reruns, red dev, incidents). A finished day is stored as `lead-digest@1.0` and read back unchanged; a measure no source could give is `unknown`, never 0.
- MCP `lead_health` and `system lead health`: one row per source (dispatch, Workers, quota, sinks, live update, landing queue, worktrees, enforce switches), each ok, degraded, or unknown with its reason; a source that cannot be read is unknown, never ok.
