---
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-workers": minor
"@tsuuanmi/system-gateway-core": minor
"@tsuuanmi/system-workflow": patch
"@tsuuanmi/system-web-ui": patch
"@tsuuanmi/system-resources-core": patch
"@tsuuanmi/system-schemas": minor
---

Quota in every route (PROP-0014 D3, T185): every step of every run now goes to the Worker whose account has the most quota to use, by one rule ([quota in every route](../docs/design/routing.md#quota-in-every-route), decided in ADR-0065):
- One implementation of a pool's headroom and its order, in `libs` (`accountQuotaOf`, `headroomOrderOf`, `headroomKeysOf`, `compareHeadroom`). A window's headroom is what is left above your reserve (20 % of each window). An unread window (no reading, stale, unknown, no used share, or a reading from before its reset) never counts as headroom. The order: an account over its reserve last while another one is free; known before unknown; the window that resets soonest with headroom first (use it or lose it); the most headroom; ties by id.
- `quotaScoreOf` is now `quota-score@2` and calls it. A dispatch ask opened under `@1` is asked again after the upgrade.
- Routing (`ctx.workers`) reads the ledger's pools and your quota settings on every route. A Worker whose account is over its reserve (above 80 % of a window, or at its limit) ranks last and gets no new step while another admitted Worker has headroom. The rest of the quota order sits after quota class and before load. Each route decision (`workers.route.deterministic` version 2) lists every admitted Worker's score, and why a Worker lost on quota. With no ledger mounted, routing orders as before.
- Capacity now (`system capacity`, MCP `roster`, the Workers page) lists free Workers in the same order, from the same function: the old "left per minute to reset" order is gone. Each free Worker's quota gains `headroom`, and `resetsAt` is optional when a reading names no reset (`mcp-roster@1.7`).
- An account's canonical gauge is the windows its pool lists; a Claude Code plan's pool lists only its five-hour window (D70).
