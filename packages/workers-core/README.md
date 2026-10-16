# @tsuuanmi/system-workers-core

Routing **seam definition**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[routing](../../docs/design/routing.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.workers` | abstract `Workers` with `register(source)`, `list()`, `route(requirement, options)`, `contract(id, check)`, `contracts()`, `accept(result, contract, { resultSchema })` (the result's JSON checked against the schema first, REQ-ART-5); `source(name)`, `affinity(sessionId)`, `handle(sessionId)`, `reset(sessionId)`, `release(sessionIds, reason)`; `WorkerSource` (describe, start, get, wait, affinity, handle, reset, release, cancel), `WorkerStart`, `WorkerExecution`, `CapabilityDescriptor`, `WorkRequirement`, `AdmittedWorker`, `AdmissionFailure`, `AcceptanceContract` | `@tsuuanmi/system-workers` |

- The types mirror `capability-descriptor@1.1` (its optional `family`, an opaque
  provider family) and `work-requirement@1.0`. The schemas in `schemas/` are
  canonical. `RouteOptions` takes `restrict` and `exclude` (provider families no
  Worker may be of, [provider diversity](../../docs/design/routing.md#provider-diversity)).
- Worker sources (website Workers from `turns`, agent Workers from
  `agent-workers`, model Workers from `models`) and callers depend on this
  package only. It depends on nothing but Cordis.
- Tier escalation after a rejected result is the workflow engine's, not the
  router's: it routes a new execution with `tier.source: decision`.
- The conformance suite is [`conformance/workers.ts`](conformance/workers.ts):
  - source lifetime and duplicate names;
  - capability admission, data locality, state, and tier bounds; a failure names
    each required capability no Worker proves;
  - the order: lowest tier, then quota class, then id;
  - restriction, determinism, and the decision artifacts;
  - provider-family exclusion: only another family is admitted, a Worker with no
    family is rejected, and the reasons name no family;
  - acceptance contracts and the `acceptance` decision.
