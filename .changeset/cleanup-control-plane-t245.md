---
"@tsuuanmi/system-gateway-core": patch
"@tsuuanmi/system-board": patch
---

Clean-up (T245), no behaviour change: the roster's `NODE_STARTED`, `stepKey`, and `spanText` (gateway-core) and the board's `BoardTool`, `SCOPES`, `OutputCheck`, `handlers`, and `tool` (board `src/tools.ts`) are module-private, since nothing else imports them. The gateway-core README names the roster schema it checks, `mcp-roster@1.9`.
