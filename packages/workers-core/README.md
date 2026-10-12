# @tsuuanmi/system-workers-core

Routing **seam definition**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[routing](../../docs/design/routing.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.workers` | abstract `Workers` with `register(source)`, `list()`, `route(requirement, options)`, `contract(id, check)`, `contracts()`, `accept(result, contract, { resultSchema })` (the result's JSON checked against the schema first, REQ-ART-5); `source(name)`, `affinity(sessionId)`, `handle(sessionId)`, `reset(sessionId)`; `WorkerSource` (describe, start, get, wait, affinity, handle, reset, cancel), `WorkerStart`, `WorkerExecution`, `CapabilityDescriptor`, `WorkRequirement`, `AdmittedWorker`, `AdmissionFailure`, `AcceptanceContract` | `@tsuuanmi/system-workers` |

- The types mirror `capability-descriptor@1.0` and `work-requirement@1.0`. The
  schemas in `schemas/` are canonical.
- Worker sources (website Workers from `turns`, agent Workers from
  `agent-workers`) and callers depend on this package only. It depends on
  nothing but Cordis.
- Tier escalation after a rejected result is the workflow engine's, not the
  router's: it routes a new execution with `tier.source: decision`.
- The conformance suite is [`conformance/workers.ts`](conformance/workers.ts):
  - source lifetime and duplicate names;
  - capability admission, data locality, state, and tier bounds;
  - the order: lowest tier, then quota class, then id;
  - restriction, determinism, and the decision artifacts;
  - acceptance contracts and the `acceptance` decision.
