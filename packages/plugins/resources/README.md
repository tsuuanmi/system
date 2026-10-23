# @tsuuanmi/system-resources

**`ctx.resources`**: the resource ledger on `ctx.store`, the provider of the `Resources` seam of
[`resources-core`](../../resources-core/README.md) ([resources](../../../docs/design/resources.md),
[ADR-0036](../../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md)). A
guarantee seam: it fails closed (INV-2).

- **Owns:**
  - `pools(filter?, at?)`: every configured pool, sorted by id, with the latest reading of each
    window in configuration order, and whether it is available at `at`. A window with no reading,
    or an `unknown` one, makes the pool unavailable unless the pool is configured
    `unknown: available`. A `limited` window keeps it unavailable until the later of
    `cooldownUntil` and `resetsAt` (`until`). A stored reading of another account than the
    pool's (the configuration changed) counts as no reading.
  - `observe(reading)`: validates the `limit-state@1.0` reading, stores it as an `evidence`
    artifact, and makes it the window's latest unless a reading observed later is already
    there (instants compared, so an offset never reorders them; of two equal ones the later
    call stands). Refused: a pool, account, window id, or window kind not configured
    (`unknown-pool`); a schema violation or a time that does not parse (`invalid`), so a limit
    never reads as already past.
  - `reserve(request, at?)`: in one write transaction (`BEGIN IMMEDIATE`), checks that every
    pool of the request's lines is configured and available, and that every cap holds, then
    records a `decision@1.4` `budget` decision and, when reserved, holds the lines. Both
    candidates carry reasons; the decision's inputs are the evidence artifacts of the readings
    of the pools it drew on. A cap counts, for its scope (the task, else the project), every
    counted record of its pool plus every hold of its pool and unit, plus the lines asked for;
    a cap with neither task nor project bounds the run's own lines. Amounts are compared at a
    millionth. A malformed request (an id that is not one, no line, more than 64 lines or caps,
    a unit or amount out of `budgetLine`'s bounds) is refused `invalid`, recording nothing.
  - A reservation's holds last `holdSeconds` (the request's, else the configured default) and
    return its `expiresAt`; an expired hold stops counting against caps and is deleted at the next
    reservation, so a crashed run cannot keep a budget (INV-9).
  - `release(reservationId)`: marks a held reservation released and drops its holds; an
    unknown or already released one is refused (`unknown-reservation`). Released reservations
    are kept, so their `budget` decisions stay referenced.
  - `record(usage)`: validates the `usage-record@1.0` record, its cached input against its
    input, and per-model usage against the totals it sums to (`invalid` otherwise); refuses an
    unconfigured pool of the account (`unknown-pool`); stores it as a `receipt` artifact, and
    counts it unless its `(source, requestId)` was counted before, or it is a `transcript`
    record of a run with a counted `runtime-result` record (a duplicate, stored, not counted).
    A record that names no project or task counts against the scope its run was reserved for.
  - `usage(filter?)`: the counted records that match, oldest first by `observedAt`, and their
    totals per pool. More than `maxRecords` matching is refused (`invalid`): narrow the filter
    or page.
  - `page(filter?, { limit?, after? })`: one page of the same, for the MCP tool, with the totals
    over every match and an opaque `next` cursor while more remain.
- **Records:** `resource_usage` (counted records, one per `(source, requestId)`, indexed by
  run, project, task, account, pool, and time), `resource_readings` (the latest reading per
  pool and window, with its artifact), `resource_reservations` and `resource_holds`. Every
  write is one store transaction; a restarted provider over the same store and configuration
  answers the same.
- **MCP** (client scope, when `ctx.mcp` is present): `resources_pools` and `resources_usage`,
  whose structured outputs are `mcp-resources@1`'s `$defs/resources-pools-output` and
  `$defs/resources-usage-output`.
- **Config:** `pools` (each `pool`, `account`, `kind`, `windows` of `{ id, kind, seconds? }`,
  `unknown`, default `unavailable`), `pageSize` (default 20), `maxRecords` (default 10000),
  `holdSeconds` (default 14400). A reading timed more than 5 minutes in the future, or of a
  window whose kind or account changed in configuration since, counts as no reading.
  Pools come from configuration only, never a plan named in code
  ([INV-11](../../../docs/architecture/invariants.md#inv-11-no-tool-lock-in)). At load, a
  duplicate pool or window id, a pool with no window or more than 8, more than 64 pools, or an
  id that is not one refuses the plugin. The bundle's row configures none: every pool is
  unavailable until the operator configures it.
- **Injects:** `store`, `artifacts`; `mcp` is optional.
- **Not yet:** only agent Workers report to it, and the engine reserves only for a board
  task's run that declares a budget (its lines as caps), not before every run. Released and expired reservations, older readings, and duplicate
  records stay (as rows and artifacts) until a retention rule exists for them.
- Tests: [`tests/conformance.spec.ts`](tests/conformance.spec.ts) runs the seam's suite,
  [`resources-core/conformance/resources.ts`](../../resources-core/conformance/resources.ts),
  at contract 1.0 with no known failure; [`tests/resources.spec.ts`](tests/resources.spec.ts)
  covers restart, configuration, paging, the MCP outputs, and a reservation race across
  processes.
