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
  `workflow.graph.grown`, `workflow.gate.opened|closed`, `approvals.batched`, `usage.unknown`, `quota.draw`,
  `agent-workers.run.stalled|unknown|freed`, and, for a project, `workflow.node.started`),
  `ctx.artifacts` (the decisions those name), and `ctx.digests` when loaded (the claims of the
  digests attached, and which runs wrote them).
- **Agent runs whose liveness asked for the operator** (PROP-0013, `mcp-report` 1.2,
  `attention.liveness`): the stalls, the runs that ended without being known to be gone, those the
  operator freed, and those still held at the period's end, in the attention section, only when
  there is any, and never counted as interruptions.
- **Reviews held for the operator** (T99 D6, `mcp-report` 1.3, `attention.reviewsHeld`): the
  scope's tasks in review waiting `operator-review` as the report is made, the soonest to expire
  first, each with its title, its pending checks, and `expiresAt` (at most 64, the rest counted in
  `reviewsHeldOmitted`), only when there is any; the rendering says how long each has left as of
  `asOf`, since an unanswered review expires and its task waits for input that only a re-opening revives (`board_reopen_review`).
- **The dispatch advisor in shadow** (PROP-0015 J1, `mcp-report` 1.5, `advice`): choices advised
  and not (`workflow.dispatch.advised`), dispatched attempts whose outcome was recorded
  (`workflow.dispatch.outcome`) and how many were advised, D74's 100 attempts, and per question
  (`accepted`, `limit`, `needs-operator`) the Brier score of the chosen candidate's probability (read
  from its advice decision's `modelAnswers`) against the recorded label, beside the observed rate and
  the score of always answering it (`brierScores`, libs); only when there is any.
- **The maturity metrics** (PROP-0016 §1, I4 part 1, `mcp-report` 1.6,
  [design](../../../docs/design/maturity-metrics.md)): MCP `metrics` (client scope; `projectId`,
  `days` default 30, `until`) and `system metrics` read every metric of §1 over a rolling window.
  Each is measured, with its value, sample, and sources, and marked when only a bound, or not
  measurable, with why and no value. Then the L3 reading. Beside the report's reads, it reads
  `workflow.run.started` (with `startedBy`), `workflow.task.landing`, the decisions people made on
  the runs (`ctx.artifacts.list` by run), and the board's moves to ready. The report's last section,
  `maturity`, is the same over the 30 days to its end. [`src/metrics.ts`](src/metrics.ts) is pure.
- **What a cap counts as 0** (D25, `mcp-report` 1.1,
  [resources](../../../docs/design/resources.md#usage-the-ledger-cannot-count)): per pool and in all,
  the records without token counts, a cost, or turns, and the runs recorded in the period whose
  usage the ledger could not count (`usage.unknown`, read back as `usage-unknown@1.0` records) and
  has not counted a record of since (`resources.usage` by run and pool); and those runs in all, by
  kind, with how many were reconciled. Each field only when there is any; the rendering says them
  per pool and in a line of their own.
- **Quota drawn per run** (PROP-0015 E2, `mcp-report` 1.4, `usage.draws`,
  [resources](../../../docs/design/resources.md#quota-drawn-per-run)): the `quota.draw` records of
  the period in scope, read back as `quota-draw@1.0` records, per kind and window and per kind,
  template step, and window: the clean draws counted, their median and p90 in percentage points,
  and the entries left out (`confounded`, `reset-crossing`, `no-reading`); at most 256 figures of
  each list. Only when there is any; an entry that is not a valid record is counted in `notes`.
- **Fails closed** (INV-2): with the board, the queue, or the ledger not loaded, it makes no report
  (`unavailable`), never a partial one; an unknown project is `unknown-project`. Bounded (INV-9): at
  most 100 000 entries of one event type, the ledger's own bound on the records of a period
  (`maxRecords`), 64 pools, 100 projects listed (the rest counted); past a bound it refuses (`overloaded`),
  never truncates. What it could not count (an event log trimmed by retention within the period, no
  digest provider to read the digests' claims or runs, digests the provider loaded does not know
  because another settled them before a swap, records with no token counts, cost, or turns, runs
  whose usage the ledger could not count, a `usage.unknown` entry that is not a valid record) is
  listed in `notes`.
- **Deterministic:** [`src/report.ts`](src/report.ts) computes the report from what was read, and
  [`src/render.ts`](src/render.ts) renders it; both are pure, sort before they count or sum, and
  write numbers without a locale. The same records and period give the same report; only `asOf`,
  when the board and the queue were read, differs between two calls.
- **Injects:** `artifacts`, `eventLog`; reads `board`, `approvals`, `resources`, and `digests` when
  present; registers its tool on `mcp` when present.
- **Bundle:** its row, `report`, is on. Off, nothing else changes.
- **Tests:** [`tests/report.spec.ts`](tests/report.spec.ts) checks the computation on a week of
  records (period bounds, scope, waits, attention against the charter, usage per pool, the
  baseline, determinism, the bounds, the rendering, what a cap counts as 0, the agent runs whose
  liveness asked for the operator, the reviews held for the operator);
  [`tests/metrics.spec.ts`](tests/metrics.spec.ts) checks each maturity metric on a fixture log of
  30 days, an empty log, and the window's bounds;
  [`tests/pilot.spec.ts`](tests/pilot.spec.ts) runs the `algorithm-development` template on the
  software-development profile's [pilot in miniature](../profile-software-development/tests/pilot.ts)
  and reads what it recorded through the tool: a project's report, the studio's, the same period
  twice, the refusals, no board, a trimmed event log, runs whose usage the ledger could not count,
  and a digest the provider loaded does not know after a swap.
