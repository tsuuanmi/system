# @tsuuanmi/system-resources-core

Resource ledger **seam definition**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[resources](../../docs/design/resources.md)). A guarantee seam: its contract changes only by an
ADR ([ADR-0036](../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.resources` | abstract `Resources` with `pools(filter?, at?)`, `observe(reading)`, `reserve(request, at?)`, `release(reservationId)`, `record(usage)`, `usage(filter?)`; `PoolConfig`, `PoolState`, `LimitState`, `UsageRecord`, `TokenUsage`, `BudgetLine`, `ReservationRequest`, `Reservation`, `UsageTotal`, `ResourcesError`; `RESOURCES_CONTRACT` (1.0) | the fake `FakeResources` only (B2 adds the real one) |

- The types mirror `usage-record@1.0` and `limit-state@1.0`; the schemas in `schemas/` are
  canonical. Pools are configuration (`PoolConfig`), never a plan named in code
  ([INV-11](../../docs/architecture/invariants.md#inv-11-no-tool-lock-in)). It depends on nothing
  but Cordis.
- The conformance suite is [`conformance/resources.ts`](conformance/resources.ts), run through
  the [conformance runner](../libs/conformance/runner.ts) at contract 1.0:
  - pools from configuration; a limited window cools a pool down until its reset; readings with
    missing fields, the latest one kept; `unknown` failing closed where configured;
  - unknown pools refused;
  - reservations with a `budget` decision, refused for an unavailable pool or a cap that recorded
    usage and held reservations would exceed;
  - usage counted once (by source and request id, and a transcript never doubling a result),
    validated, and totalled.

  It also exports `FakeResources`, which passes it, over the pools in `POOLS`.
