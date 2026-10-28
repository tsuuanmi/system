---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-lead-inbox": minor
"@tsuuanmi/system-approvals": patch
"@tsuuanmi/system-workflow": patch
"@tsuuanmi/system-cli": minor
---

`system lead brief --project <id> [--json] [--since <time>]` and MCP `lead_brief` (PROP-0019 rank 1): one read-only page a lead session reads at its start and whenever it is lost.
- Sections 1 to 8, 11, and 12 of the proposal's table: you, the inbox, what waits on the operator, what is held on you, pending decisions, running work (tasks, runs and their steps, landing queues, worktrees held), health, the last day, what could not be read, and the first moves. The switches and the handover note read "not yet available".
- A part whose source cannot be read (a row that is off, a source not built yet, or a source that holds more than one brief reads) is named in "what I could not read" with its reason and shows no value, never an empty list; each list holds at most 20 entries and says how many it left out.
- A tool of the `lead-inbox` row; a lead token reads its own project only, the operator names one, and nothing of another project is named in it (a shared landing queue's head is shown only when it is the project's own). It writes one event, `lead.brief-read` (who, which project).
- New schema `lead-brief@1.0`; the brief is validated before it is returned.
- `approvals.leadMay` (the lead's rights test `decideAsLead` applies) and `workflow.openLandings()` are public reads the brief uses.
