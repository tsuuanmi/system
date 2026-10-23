# @tsuuanmi/system-workers-core

Routing **seam definition**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[routing](../../docs/design/routing.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.workers` | abstract `Workers` with `register(source)`, `list()`, `route(requirement, options)`, `contract(id, check)`, `contracts()`, `accept(result, contract, { resultSchema })` (the result's JSON checked against the schema first, REQ-ART-5); `source(name)`, `affinity(sessionId)`, `siblings(worker)`, `handle(sessionId)`, `reset(sessionId)`, `release(sessionIds, reason)`; `WorkerSource` (describe, start, reserve, get, wait, sandbox, affinity, siblings, handle, reset, release, cancel), `WorkerStart` (with the optional `runId` of the workflow run an execution belongs to, and its rendered `prompt` or the `brief` the source renders, exactly one), `WorkerSandbox`, `WorkerExecution`, `CapabilityDescriptor` (with `load`, ADR-0033; `account`, ADR-0052), `WorkerAccount`, `AccountMode`, `CapabilityOffer` (with `scope`, ADR-0049), `WorkRequirement` (with `scope`), `WorkScope`, `provesFor(offer, requirement)`, `AdmittedWorker` (with `release()`), `AdmissionFailure` (with `limitUntil`, ADR-0052), `AdmissionCheck`, `ADMISSION_CHECKS`, `AcceptanceContract` | `@tsuuanmi/system-workers` |

- The types mirror `capability-descriptor@1.5` (its optional `family`, an opaque
  provider family; `maxInputChars`, the longest input the Worker takes; `load` and `cooldowns`;
  a capability offer's `scope`; and the `account` it runs on, `{ id, group, mode, limitUntil? }`)
  and `work-requirement@1.1` (its optional `scope`). A scoped
  offer proves its capability only for work whose requirement names that scope (`provesFor`,
  [scoped offers](../../docs/design/routing.md#scoped-offers),
  [ADR-0049](../../docs/decisions/adr/0049-read-only-agent-workers-as-review-members.md)). The
  schemas in `schemas/` are canonical. `RouteOptions`
  takes `restrict`, `exclude` (provider families no Worker may be of,
  [provider diversity](../../docs/design/routing.md#provider-diversity)), and
  `input` (the input's length as it will be sent,
  [ADR-0032](../../docs/decisions/adr/0032-admission-refuses-input-longer-than-a-worker-takes.md)),
  `excludeWorkers`, and `assignment` (the work stays on one account of a group).
- **Assigned accounts** ([ADR-0052](../../docs/decisions/adr/0052-accounts-are-assigned-unless-pooling-is-recorded.md),
  [routing](../../docs/design/routing.md#assigned-accounts)): the admission check `assignment`
  refuses another account of an assigned group the work its limited account could take, and an
  `AdmissionFailure` whose limited Workers are all on assigned accounts carries `limitUntil`, the
  earliest known reset. All of it is optional: a Worker with no `account` routes as before.
- **Briefs** ([workflow engine](../../docs/design/workflow-engine.md#briefs)): a caller that
  composes a `brief@1.x` records it as an `objective` artifact and starts the execution with its
  id; the source renders its own prompt from it at start (`startPrompt` and `renderBrief` in
  `@tsuuanmi/system-libs` are the default text rendering), resolving pointers through
  `ctx.artifacts`, and checks egress on what it rendered at the requirement's classification, as
  for any prompt (INV-12). A source declares its Workers' confinement for the brief
  with `sandbox(worker, runId)`; one that declares none runs nothing on this machine.
- Worker sources (website Workers from `turns`, agent Workers from
  `agent-workers`, model Workers from `models`) and callers depend on this
  package only. It depends on nothing but Cordis.
- Tier escalation after a rejected result is the workflow engine's, not the
  router's: it routes a new execution with `tier.source: decision`.
- The conformance suite is [`conformance/workers.ts`](conformance/workers.ts):
  - source lifetime and duplicate names;
  - capability admission, data locality, state, and tier bounds; a failure names
    each required capability no Worker proves;
  - scoped offers: an offer scoped to a kind of work proves its capability for that work only,
    and a refusal says it is scoped;
  - the order: lowest tier, then quota class, then id;
  - restriction, determinism, and the decision artifacts;
  - provider-family exclusion: only another family is admitted, a Worker with no
    family is rejected, and the reasons name no family;
  - input length: a Worker that takes less than the input is refused, saying so,
    and one that takes exactly as much, or declares no bound, is admitted;
  - load and pending admissions, usage-limit cooldowns, a source that does not answer in time;
  - assigned accounts: a limited account holds its work off its group's other accounts while
    other groups take it; the failure's `limitUntil` is the earliest known reset, absent when
    none is known or a limited Worker is not assigned; `pooled` holds nothing; `assignment` keeps
    work on one account; with one account per group the choice and decisions are exactly as
    before; an `account` below `@1.5` is refused;
  - acceptance contracts and the `acceptance` decision.
