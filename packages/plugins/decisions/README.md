# @tsuuanmi/system-decisions

**The operator's decisions, as records in System** (D109; PROP-0019 section 2.7), so they live in the
store and not in the lead's `decisions.json`. An optional surface row (`decisions`, off in the bundle):
turned off, System is healthy and the lead keeps its file.

- **Record** `operator-decision@1.0` ([schema](../../../schemas/operator-decision.v1.json)): `id`
  (`D<n>`), `projectId` (absent: studio-wide), `question`, `options`, `recommendation`, `links`,
  `askedAt`/`askedBy`, `answeredAt`/`answer`/`answeredBy`, `source`, `supersedes`. It is evidence of
  what the operator said, never an authority (INV-6).
- **One sequence per studio.** The store takes the next number inside the transaction that writes the
  record (`BEGIN IMMEDIATE`), so two writers, in one process or two, never share one (INV-15); a number
  is never reused. A question has its number when it is asked.
- **Never deleted, never edited once answered**: a trigger refuses both. A correction is a new record
  whose `supersedes` names the old one; `show` lists what supersedes a record.
- **Who may do what.** The operator's token asks, answers, reads, and imports. A project's lead token
  asks about its own project, records an answer for its own project **only on the operator's word**
  (`source` says where; the record says `answeredBy: lead:<project>`, never `operator`), and reads its
  project's and the studio-wide records. It never answers a studio-wide question or another project's.
- **Import**, once: `system decisions import <file>` reads the lead's `decisions.json`; the numbers must
  be exactly D1 to Dn, none twice and none skipped, or nothing is written. A second run changes nothing.
- **No seam of its own** (as `report`): nothing is added to `ctx`. Its contract is its tools, each input
  and output `mcp-decisions@1.0` ([schema](../../../schemas/mcp-decisions.v1.json),
  [reference](../../../docs/reference/schemas.md#mcp-tools-decisions_)), checked at the boundary; a write
  checks its output before it commits.
- **Bounded** (INV-9): an import reads at most 10,000 decisions and finds a gap from the sorted numbers;
  a page holds at most 200; `show` names at most 100 corrections.
- **MCP** `decisions_ask`, `decisions_answer`, `decisions_list`, `decisions_show`, `decisions_import`;
  **CLI** `system decisions list|show|ask|answer|import` ([runbook](../../../docs/operations/runbooks.md#record-a-decision)).
- Tests: `tests/decisions.spec.ts`, `tests/race-worker.ts` (two processes, one sequence).
