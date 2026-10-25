---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-mcp-server": minor
---

The agent Workers' tool events have a payload contract (T211, the open finding of T207's review).
- `schemas/agent-tool-event.v1.json` (`agent-tool-event@1.0`) declares the data of `agent-workers.tool.denied`, `.deferred`, `.notified`, and `.checks-pending`, one definition per event type: a denial's `reason` as an enum of the gate's stable codes, its `explanation` at most 300 characters, `workerKind` and `tool` at most 100, `actionClass`, `requestId`, `decision`, and `pendingChecks`. Additive: the fields T207 added are optional, so an entry from before T207 stays valid.
- `@tsuuanmi/system-libs` reads them: `agentToolEventOf(type, data)` and `agentToolDenialOf(data)` validate an entry's data, undefined when it is not valid.
- `system health`'s `tool-denials` check validates each denial and counts one that is not valid apart (`N entry(ies) not a valid denial`), never by reason; `countDenials` returns `{ counts, invalid }`.
