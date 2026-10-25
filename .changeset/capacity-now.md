---
"@tsuuanmi/system-gateway-core": minor
"@tsuuanmi/system-mcp-server": minor
"@tsuuanmi/system-web-ui": minor
"@tsuuanmi/system-cli": minor
"@tsuuanmi/system-schemas": minor
---

Capacity now as data (T152): the Workers page's *Right now* is made once, on the server, and a lead reads it in any session to give work where capacity is free ([capacity now](../docs/design/roster.md#capacity-now)):
- `readCapacity`, beside `readRoster` in `gateway-core`, makes `now` on every roster (`mcp-roster@1.7`, additive): each account's windows and whether it takes new work now; the free Workers, the one whose quota would be lost unused soonest first (what is left of its window over the minutes to its reset; ties by id); the Workers whose quota cannot be read, never counted free (INV-2); the stalled runs; the accounts with no quota left and until when; the Workers that cannot work and why; and the ready tasks of the active board projects, each with the Worker a start would most likely go to, as the start preview tells it. Each list holds at most 16, `more` counting the rest (INV-9).
- MCP `roster` carries it as `now`, and its text ends with a *Right now* block. `system roster --json` includes it; `system capacity [--json]` prints that block, or the record.
- The Workers page's *Right now* renders `now` as the server made it and computes none of it; it now also says what each free Worker has left, whose quota is unknown, and which Worker each ready task would likely go to.
- The start preview and capacity now share one test of whether a Worker could take a step (`canTakeStep`).
