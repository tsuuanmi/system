# ADR-0073: An agent Worker offers a tier per model its role declares, with quota per model, and a task's risk may set a step's tier

- **Status:** Accepted (2026-10-27; built in T261, `a89c5bd4`; a risk's tier on a first review in T288, `d81d8def`)
- **Date:** 2026-10-26
- **Related:** T261, the operator's request of 2026-10-26 ("when a Worker is chosen, choose its tier
  (mapping to the provider's frontier, standard and economy models) and its capability (develop,
  review, research, ...)"), [ADR-0051](0051-agent-accounts-are-enrolled-slots-identified-by-their-login.md),
  [ADR-0052](0052-accounts-are-assigned-unless-pooling-is-recorded.md),
  [ADR-0057](0057-route-work-by-kind.md),
  [ADR-0059](0059-quota-readings-from-each-accounts-own-usage-report.md),
  [ADR-0066](0066-every-route-orders-workers-by-their-accounts-quota-headroom.md),
  [ADR-0071](0071-a-changes-risk-tier-comes-from-the-policys-path-map.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-6](../../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes),
  [INV-11](../../architecture/invariants.md#inv-11-no-tool-lock-in),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

An agent role gives its Workers one tier (`tier`) and, per runtime, one model
(`runtimes.<runtime>.model`). A vendor's plan serves several models, from an economy one to a
frontier one, and so does each account enrolled on it: to give an account's work the model a step
needs, the operator had to define one role per tier, each deriving a Worker of its own per account,
and the roster, the load, and the assignments multiplied with them. Routing already takes "the
lowest admissible tier at or above a step's minimum" ([routing](../../design/routing.md#intelligence-tiers));
what it lacked was one Worker that can serve several tiers.

The quota does not fit either. A vendor reports a weekly window per model beside the account's own
(the Claude usage report's per-model list, skipped as `model_scoped` until now): when the frontier
model's week is used up, the account still serves its other models, but an account has one pool, so
any limit closed the whole account.

And the risk tier of a board task (ADR-0071) says what process its change needs, but not what
intelligence: the operator wants a heavy change developed and reviewed at the frontier, and a light
one's validation and documentation at the economy tier.

What constrains it:

- **Capability first, then tier.** What a Worker may do (its sandbox, its kinds of work, a review
  member's profile) stays the role's: a tier never widens it.
- **Models are configuration** (INV-6, INV-11): no model is named in code, docs, tests, or examples;
  routing never reads one.
- **One rule for headroom** (ADR-0066): a tier's quota is read by the same `quota-score@2`.
- **Fail closed** (INV-2): a model's window that cannot be read closes its tier, never opens it.
- **A one-tier role works as today.**

## Options

1. **One role per tier, as today.** Three Workers per account, three roster rows, three entries in
   every assignment, and still one pool per account. Rejected.
2. **One Worker per account and role per tier, derived (`…/<role>/<tier>`).** Keeps routing as it is,
   but multiplies Workers and siblings the same way, and a session would have to move between Workers
   to escalate. Rejected.
3. **One Worker that offers every tier its role declares, served at one of them per step; a pool per
   model per account; a policy map from risk tier to step tier.** Chosen.

## Decision

- **Tiers per role, per runtime.** `runtimes.<runtime>.tiers: { economy?, standard?, frontier? }`,
  each `{ model, tools?, maxTurns? }` (the options that differ at that tier; the runtime's otherwise).
  It replaces the role's one `tier` on that runtime; a role may leave `tier` out when every runtime it
  is assigned on declares tiers, and one assigned on a runtime with neither is refused at load.
  Malformed tiers (an unknown tier, no model, a model that is not one word, another option) are refused.
- **One Worker offers them all.** The Worker `agent:<accountId>/<role>` describes `tiers`
  (`capability-descriptor@1.10`): each tier it offers, the ledger pools a run at it draws on, and
  whether its model's pool is closed now (with when it is back). Its `tier` is the lowest.
- **Routing serves it at one tier** (`workers.route.deterministic` version 3): the lowest offered tier
  within the requirement's bounds whose model's pool is open (`servedTier`). A Worker none of whose
  tiers is within the bounds fails the `tier` check; one whose tiers within them are all closed fails
  the `cooldown` check (`tier frontier limit until …`), so an assigned account's limit holds the work
  and the caller may wait for its reset (ADR-0052). The tier order key, the quota keys, the `tier`
  decision's outcome, and the route decision's reasons are the served tier's.
  `AdmittedWorker.tier` and `Candidates.workers[].tier` carry it.
- **The run runs that tier's model.** The engine passes the routed tier on `WorkerStart.tier`; the
  `agents` source records it on the run (store migration `agent-workers` 20, `agent_runs.tier` and `configured_model`) and
  gives the runtime that tier's model, tools, and turn limit. A tier the Worker does not offer refuses
  the start. A run whose Worker, when the run comes up, no longer offers its tier (its tiers removed,
  or a one-tier Worker's tier another), or whose tier now runs another model than the one it was
  started for (`agent_runs.configured_model`), fails unsent as `worker_changed` (a new failure kind,
  disposition `IMMEDIATE`), naming both tiers: the engine routes the work again, and no run takes
  another model in silence. With no tier given, the lowest offered at or above the requirement's
  minimum.
- **Recorded and shown.** The result is `agent-result@1.4` with `tier` and `configuredModel`; the brief
  carries `tier` (`brief@1.4`) and `model` (`brief@1.5`) when the Worker offers tiers, the model from its source
  (`WorkerSource.model`, optional); the workflow node keeps its served tier;
  `system explain`, the usage report, and the run's page on `/ui` show the tier and the model.
- **Quota per model.** A provider entry's `modelPools: [{ model, pool, windows }]` gives a model one
  more pool per account (`<pool>/<accountId>`, a template of the runtime's group, which the ledger
  makes for each declared account as it does the account's own). A run on that model reserves on both
  pools; an observation a model pool's `windows` maps (a run's or the usage report's) is a reading of
  that pool alone, never of the account's; a limit the account's pool cannot place still closes it
  whole, and only a limit recorded on a pool the run drew on stands for the run's own limit. So a
  frontier model's limit closes only the tiers that run that model. On a provider with model pools, a
  one-tier role's Worker names its one tier's pools too, so another model's pool never counts as its quota. A tier's headroom in
  `quota-score@2` (routing's order and dispatch's score) reads its pools only, never another model's.
  The resources seam is unchanged.
- **Claude's per-model windows are read.** The Claude Code usage report's `model_scoped` list is read
  as one window per entry, `model_scoped:<display name>` (lower-cased); a list in another shape gives
  no per-model reading and leaves the account's windows read (INV-2).
- **Tier by risk.** `autonomy-policy@1.2` adds `tierByRisk: { version, light?, normal?, heavy? }`:
  under a risk tier, a step's capability (`develop`, `review`, `validate`) or kind of work (`docs`)
  mapped to the tier that becomes its minimum, such as `heavy: { develop: frontier, review: frontier }`
  and `light: { validate: economy, docs: economy }`. Before a board task's step is routed, the engine
  reads the task's risk tier (its latest `workflow.risk-tier` decision, this run's or an earlier
  attempt's) and, when an entry names the step, records a `tier` decision of policy
  `workflow.tier-by-risk` version 1 (its input the risk decision, its detail the maps' versions and
  entries), which the step's requirement names as its tier's source. Several entries: the highest. A
  step an escalation set is never lowered, and a step's maximum bounds it. Dispatch looks at the same
  tier when it scores a task's writing step. A policy or board task that cannot be read leaves the
  tier unknown, which never routes the step at its template's tier (INV-2): it fails unsent, retried
  with back-off, and dispatch passes the task over. With no map, steps keep their templates' tiers; the
  repository's own policy sets none (the operator does, once a frontier Worker exists).
- **Model names are configuration only.** The repository's docs write placeholders (`<frontier
  model>`), its tests and examples fake names; the Anthropic gateway's default model-name pattern map
  is empty.

## Consequences

- One role with three tiers gives each assigned account one Worker offering three: one roster row,
  one load, one session that can escalate on the same Worker to a higher tier's model.
- A one-tier role is unchanged: its descriptor, its run, and its result are as before, unless its one
  model has a pool of its own, which then joins its quota (`tiers` with that one tier).
- Every pool is fail closed: a model pool with no reading yet closes its tier, and the account's pool
  with none closes them all, as before.
- **Known limits.** A model's window reaches its pool only when the operator maps its name
  (`modelPools[].windows`); Codex reports no per-model window, so a Codex role's tiers share the
  account's windows, and the route decision says so. A run that hits a limit its runtime does
  not name still closes the account's pool whole. The risk tier of a task is known once a review
  approved its change, so a first attempt's develop step is raised only from an earlier attempt's tier.
- Schema minors: `capability-descriptor@1.10`, `agent-result@1.4`, `brief@1.4` and `brief@1.5`,
  `autonomy-policy@1.2`; one store migration; the route decision's version 3. ADR-0072 designs its
  own `brief@1.4` (`handbook`), not built yet: whichever lands second takes the next minors.

## Rejected alternatives

The options above; also: a tier per assignment (the account would decide the tier, and one account
could not serve two); a closed tier as a Worker state (it would close every tier, and the
assigned-account hold reads limits, not states); and lowering a step at the light tier only when a
Worker of the lower tier is free (routing would then depend on load for what the policy decides).
