---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-gateway-core": minor
"@tsuuanmi/system-mcp-server": minor
"@tsuuanmi/system-web-ui": minor
"@tsuuanmi/system-cli": minor
---

The roster: every Worker in one read model (REQ-HOST-8, docs/design/roster.md).
- Each Worker with its provider and family, account (id, the operator's label, and the account's enrolled, ready, signed-out, or quarantined state), role, tier, quota class, availability (ready, busy N of M, resting at a limit until its reset, unavailable with why, quarantined), the steps and board tasks it serves now, its load, and its account's pools with each window's used share, reset, and the runs whose usage the ledger could not count.
- Computed on read from the Worker registry, the agent and website account records, the resource ledger, the event log, the workflow runs, and the board; nothing is stored. A fact a source could not give reads `unknown (why)`, never a default, and every read is bounded (256 Workers, the newest 500 runs, 32 steps per Worker, 64 board tasks, 10,000 usage entries).
- MCP `roster` (client scope, as `status` is; a client gets no account labels), its record `mcp-roster@1.0`; `system roster [--json]`; and the `/ui` Roster page.
- The count of runs whose usage the ledger could not count is one function now (`countUnknownUsage` in `system-libs`), shared by health's `usage` check and the roster; health's output is unchanged.
