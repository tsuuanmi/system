# @tsuuanmi/system-resources-core

Resource ledger **seam definition**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[resources](../../docs/design/resources.md)). A guarantee seam: its contract changes only by an
ADR ([ADR-0036](../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.resources` | abstract `Resources` with `pools(filter?, at?)`, `observe(reading)`, `reserve(request, at?)`, `release(reservationId)`, `record(usage)`, `usage(filter?)`, the optional `declare(source, accounts)` (contract 1.1, ADR-0052), and the optional `quota()` (contract 1.2, ADR-0064: the operator's `QuotaSettings`, validated when the provider loaded); `PoolConfig`, `PoolTemplate`, `DeclaredAccount`, `templatePool`, `PoolState`, `LimitState`, `UsageRecord`, `TokenUsage`, `BudgetLine`, `ReservationRequest`, `Reservation`, `UsageTotal`, `QuotaSettings`, `ResourcesError`; `RESOURCES_CONTRACT` (1.2) | [`resources`](../plugins/resources/README.md) (on `ctx.store`); the fake `FakeResources` |

- The types mirror `usage-record@1.0` and `limit-state@1.0`; the schemas in `schemas/` are
  canonical. Pools are configuration (`PoolConfig`), never a plan named in code
  ([INV-11](../../docs/architecture/invariants.md#inv-11-no-tool-lock-in)). It depends on nothing
  but Cordis.
- The conformance suite is [`conformance/resources.ts`](conformance/resources.ts), run through
  the [conformance runner](../libs/conformance/runner.ts) at contract 1.2:
  - pools from configuration; a limited window cools a pool down until its reset; readings with
    missing fields, the latest one kept; a window with no reading, or an `unknown` one, fails the
    pool closed unless its configuration makes unknown available;
  - unknown pools refused, and a reading from the future refused;
  - reservations with a `budget` decision, refused for an unavailable pool or a cap that recorded
    usage and held reservations would exceed; every hold expires;
  - usage counted once (by source and request id, and a transcript never doubling a result),
    against the scope its run was reserved for, validated, and totalled.

  - (1.1) pool templates: one pool per template and declared account, `<template>/<account>`, a
    limit on one account never closing another's, a declaration replacing the source's last, and
    one that would take a configured or another source's pool refused.
  - (1.2) where a provider gives `quota()`: the settings each in its range, the defaults (a 20 %
    reserve of every window, D63) when none is configured, and a copy no caller can change.

  It also exports `FakeResources`, which passes it, over the pools in `POOLS` and the templates in
  `TEMPLATES`, its `quota` the defaults under a configured one.
