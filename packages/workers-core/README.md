# @tsuuanmi/system-workers-core

Routing **seam definition**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[routing](../../docs/design/routing.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.workers` | abstract `Workers` with `register(source)`, `list()`, optional `sources()` (how each source answered its last read, `WorkerSourceRead`), `route(requirement, options)`, `contract(id, check)`, `contracts()`, `accept(result, contract, { resultSchema })` (the result's JSON checked against the schema first, REQ-ART-5); `source(name)`, `affinity(sessionId)`, `siblings(worker)`, `handle(sessionId)`, `reset(sessionId)`, optional `held(sessionId)` (why a session takes no input now, from its source; PROP-0013, ADR-0056), optional `liveness(query)` (the runs whose liveness needs the operator's look, from every source that tells it, and each source that could not tell; PROP-0013), optional `land(step)` (one step of landing an accepted result, `commit` or `merge`, by the source that holds its worktree, with its name; a source that throws is a `failed` refusal; ADR-0060), optional `changes(runId)` (a workflow run's change in each worktree a source holds, read only, with its source's name, and each source that could not read its own; T122), optional `carry(step)` (a workflow run's worktree started from an earlier run's tree, by the source that holds that tree, with its name; a source that throws is a `failed` refusal; ADR-0061), `release(sessionIds, reason)`; `WorkerSource` (describe, start, reserve, get, wait, sandbox, affinity, siblings, handle, reset, held, liveness, land, changes, carry, release, cancel), `LandStep`, `Landed`, `LandRefusal`, `WorkChange`, `ChangedFile`, `CHANGE_BOUNDS`, `CarryStep`, `Carried`, `CarryRefusal`, `RunLiveness`, `LivenessReport`, `LivenessQuery`, `LivenessState`, `MAX_LIVENESS_RUNS`, `WorkerStart` (with the optional `runId` of the workflow run an execution belongs to, and its rendered `prompt` or the `brief` the source renders, exactly one), `WorkerSandbox`, `WorkerExecution` (its error's optional `siteError`: the input was sent and the site answered it with its own error, ADR-0062), `CapabilityDescriptor` (with `load`, ADR-0033; `account`, ADR-0052; `kinds`, ADR-0057), `WorkerAccount`, `AccountMode`, `CapabilityOffer` (with `scope`, ADR-0049), `WorkRequirement` (with `scope`; `kind`, ADR-0057), `WorkScope`, `provesFor(offer, requirement)`, `WORK_KIND`, `takesKind(worker, requirement)`, `AdmittedWorker` (with `release()`), `AdmissionFailure` (with `limitUntil`, ADR-0052), `AdmissionCheck`, `ADMISSION_CHECKS`, `AcceptanceContract` | `@tsuuanmi/system-workers` |

- The types mirror `capability-descriptor@1.8` (its optional `family`, an opaque
  provider family; `maxInputChars`, the longest input the Worker takes; `load` and `cooldowns`;
  a capability offer's `scope`; the `account` it runs on, `{ id, group, mode, limitUntil? }`;
  the `kinds` of work the operator gives it; the operator's `description` and its `title` (a
  website provider's own, a model's from the operator's catalog), both for people only, never a
  routing input) and `work-requirement@1.2` (its optional `scope` and `kind`). A scoped
  offer proves its capability only for work whose requirement names that scope (`provesFor`,
  [scoped offers](../../docs/design/routing.md#scoped-offers),
  [ADR-0049](../../docs/decisions/adr/0049-read-only-agent-workers-as-review-members.md)). A
  Worker given kinds takes only work that names one of them; one given none takes any work
  (`takesKind`, [work kinds](../../docs/design/routing.md#work-kinds),
  [ADR-0057](../../docs/decisions/adr/0057-route-work-by-kind.md)). The
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
- **A source's last read** (`sources()`, optional): for each registered source, how it answered
  the last read of its Workers, by a route or `list`: `described` (how many), `silent` (it did not
  answer within the router's bound, so that read counted none of its Workers), or `failed` (its
  `describe` threw), when that read started, and why; on a silent read, optionally, `describing`
  while none of the source's describes has landed since it registered (its first is still
  running), so its Workers are not known yet, never none. A provider that keeps none leaves a
  caller unable to tell a silent source from one with no Workers; health and the roster read it
  ([routing](../../docs/design/routing.md#sources-that-do-not-answer)).
- The conformance suite is [`conformance/workers.ts`](conformance/workers.ts); the seam is at
  contract 1.0:
  - source lifetime and duplicate names;
  - a session's affinity, handle, reset, and release asked of the source that owns it;
  - Workers an earlier attempt failed on before sending left out, saying why;
  - capability admission, data locality, state, and tier bounds; a failure names
    each required capability no Worker proves;
  - scoped offers: an offer scoped to a kind of work proves its capability for that work only,
    and a refusal says it is scoped; a scope below the schema version that carries it is refused;
  - work kinds: a Worker given kinds takes only work of those kinds, never work that names none,
    one given none takes any, a kind proves no capability, a failure says no Worker takes the
    kind, and kinds below `capability-descriptor@1.6` or `work-requirement@1.2` are refused;
  - the order: lowest tier, then quota class, then id;
  - restriction, determinism, and the decision artifacts;
  - a source that does not describe its Workers in time: routed past and named in the decision;
    with `sources()`, kept `silent` in its last read, a source whose describe fails kept `failed`,
    and a source's read gone with the source; a provider that says `describing` says it of a
    source that never answered, and no longer once one of its describes landed, even late;
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
  - acceptance contracts and the `acceptance` decision; a structured result checked against its
    schema before the contract;
  - a malformed work requirement refused;
  - where a provider offers the optional seams: `held`, `liveness`, `land` and `carry` (the
    source that holds the worktree answers, with its name; none holding it is undefined; a source
    that throws is a `failed` refusal), and `changes` (each source that holds a worktree of the run
    answers, with its name; one that throws is named in `unread`, never read as no change).
