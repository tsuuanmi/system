# @tsuuanmi/system-report

**The baseline report** (PROP-0010 B8): what the recorded data says about a period, for one
project or every one, as PROP-0008's baseline and its investor report ask
([design](../../../docs/design/reports.md)). A surface plugin: it reads the core, writes nothing,
decides nothing, and no model takes part.

- **MCP `report`** (client scope; input and output checked against
  [`schemas/mcp-report.v1.json`](../../../schemas/mcp-report.v1.json)): `projectId` (absent: every
  project), and the period by `since` or `days` (default 7) before `until` (default now), at most
  366 days. It answers with the report as structured content and its one-screen rendering as text.
  `system report` prints it ([CLI](../../../docs/reference/cli.md)); with no flag it is the weekly
  investor report.
- **What it reads**, through the definitions only: `ctx.board` (projects and their tasks now),
  `ctx.approvals` (every request, `list`), `ctx.resources` (the counted usage records observed in
  the period, `usage`), `ctx.eventLog` (`workflow.task.reported`, `workflow.task.digest`,
  `workflow.graph.grown`, `workflow.gate.opened|closed`, `approvals.batched`, and, for a project,
  `workflow.node.started`), `ctx.artifacts` (the decisions those name), and `ctx.digests` when
  loaded (the claims of the digests attached, and which runs wrote them).
- **Fails closed** (INV-2): with the board, the queue, or the ledger not loaded, it makes no report
  (`unavailable`), never a partial one; an unknown project is `unknown-project`. Bounded (INV-9): at
  most 100 000 entries of one event type, the ledger's own bound on the records of a period
  (`maxRecords`), 64 pools, 100 projects listed (the rest counted); past a bound it refuses (`overloaded`),
  never truncates. What it could not count (an event log trimmed by retention within the period, no
  digest provider to read the digests' claims or runs, digests the provider loaded does not know
  because another settled them before a swap, records with no token counts) is listed in `notes`.
- **Deterministic:** [`src/report.ts`](src/report.ts) computes the report from what was read, and
  [`src/render.ts`](src/render.ts) renders it; both are pure, sort before they count or sum, and
  write numbers without a locale. The same records and period give the same report; only `asOf`,
  when the board and the queue were read, differs between two calls.
- **Injects:** `artifacts`, `eventLog`; reads `board`, `approvals`, `resources`, and `digests` when
  present; registers its tool on `mcp` when present.
- **Bundle:** its row, `report`, is on. Off, nothing else changes.
- **Tests:** [`tests/report.spec.ts`](tests/report.spec.ts) checks the computation on a week of
  records (period bounds, scope, waits, attention against the charter, usage per pool, the
  baseline, determinism, the bounds, the rendering);
  [`tests/pilot.spec.ts`](tests/pilot.spec.ts) runs the `algorithm-development` template on the
  software-development profile's [pilot in miniature](../profile-software-development/tests/pilot.ts)
  and reads what it recorded through the tool: a project's report, the studio's, the same period
  twice, the refusals, no board, a trimmed event log.
