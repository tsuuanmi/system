# @tsuuanmi/system-ledger-core

**The ledger seam definitions**: `ctx.store`, `ctx.artifacts` and `ctx.eventLog`, the ledger of
record ([plugin model](../../docs/architecture/plugin-model.md), rule 2 and "Seam definitions").

Each seam is an abstract `Service` class with the types, errors and constants its contract names.
A provider extends it, and every consumer imports it from here, never from the provider's package.

- **One package for three seams, because they are one layer**: the plugin model's core table names
  them together as the ledger of record. `artifacts` and `eventLog` keep their records in
  `ctx.store` and migrate their own tables through it, and a consumer of one nearly always uses the
  others, so three packages would add edges, not remove them. Leases and egress are not ledger
  seams: leases belong to the work state machine (INV-15) and egress to the gate, and each moves to
  the definition package of its own component (T316c): [`board-core`](../board-core/README.md) and
  [`workers-core`](../workers-core/README.md).
- **`ctx.store`** ([`src/store.ts`](src/store.ts)): `db`, `transaction`, `afterCommit`, `migrate`,
  `updateRevision`, `RevisionConflict`, `Migration`, `TransactionCallback`. Provider:
  [`@tsuuanmi/system-store`](../plugins/store/README.md).
- **`ctx.artifacts`** ([`src/artifacts.ts`](src/artifacts.ts)): `put`, `recordDecision`, `get`, `list`,
  `read`, `explain`, `collect`, with `Envelope`, `Decision`, `ArtifactKind`, `ExplainNode`, `ArtifactRead`.
  Provider: [`@tsuuanmi/system-artifacts`](../plugins/artifacts/README.md).
- **`ctx.eventLog`** ([`src/event-log.ts`](src/event-log.ts)): `append`, `query`, `trim`, with
  `SystemEvent`, `NewEvent`, `EventQuery` and the `system/event` event. Provider:
  [`@tsuuanmi/system-event-log`](../plugins/event-log/README.md).
- **Conformance suites**: [`conformance/store.ts`](conformance/store.ts),
  [`conformance/artifacts.ts`](conformance/artifacts.ts) and
  [`conformance/event-log.ts`](conformance/event-log.ts), run by each provider's own
  `tests/conformance.spec.ts` (ADR-0036, ADR-0037).
- Configuration is a provider's, not the definition's: each provider keeps its `Config`.
