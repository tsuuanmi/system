# Routing

> Target state. Boundary: [routing](../architecture/components.md#routing).
> Purpose: [P1–P4](../requirements/purpose.md). Requirements: REQ-WRK-1..10, REQ-WRK-12.
>
> Implemented in [`workers`](../../packages/plugins/workers/README.md) (admission, order,
> decisions, acceptance) and [`workflow`](../../packages/plugins/workflow/README.md) (tier
> escalation); differs from target: `connector:<name>` is not proven by any Worker; usage is
> reported per run step, not estimated per account; there is no resume conformance test behind
> `persistent-conversation`, and no egress exception naming exact artifacts.

Routing turns a **work requirement**
([`work-requirement.v1.json`](../../schemas/work-requirement.v1.json)) into exactly
one admitted Worker, or into a typed admission failure. Every admission, route,
tier, escalation, egress, and acceptance outcome is recorded as a decision
artifact listing every candidate and the reason it was rejected
([artifacts](artifacts.md#decision-artifacts)). It is deterministic: the same configuration, the same
Worker states, and the same requirement always give the same result
([INV-2](../architecture/invariants.md#inv-2-fail-closed)).

## Work requirement

```ts
WorkRequirement {                    // work-requirement@1.2
  objective: string;
  capabilities: Capability[];        // all must be proven
  scope?: "review-member";           // the kind of work, for offers scoped to it (below)
  kind?: WorkKind;                   // the operator's kind of work, e.g. "code" (work kinds, below)
  data: { classification: "public" | "operator-shared" | "local-private";
          refs: ArtifactRef[] };      // what the work must read
  egressPolicy: string;              // policy id from a trusted envelope (INV-6, INV-12)
  boundaries?: string[];             // what the Worker must not do or touch
  effort?: { maxToolCalls?, maxSubWorkers?, maxMinutes? };
  writes?: { type, ref, version? };  // the subject the work writes, if any
  tier: { min: Tier; max?: Tier;     // "economy" | "standard" | "frontier"   (P4)
          source: "profile" | "caller" | "decision" | "default"; decision?: ArtifactRef };
  budget?: { maxTokens?, preferQuota?: QuotaClass[] };
  acceptance: { contract: string; resultSchema?: string; maxEscalations?: number };
}
```

## Capability vocabulary

Capabilities are named semantics. They are never tool names
([INV-11](../architecture/invariants.md#inv-11-no-tool-lock-in)). A Worker proves
each one with evidence from the sources shown below.

| Capability | Meaning | Typical evidence |
|---|---|---|
| `reason` | general reasoning and synthesis | provider driver conformance (website Workers); a route probe (model Workers, [models](models.md)); for a review member's steps only, a read-only agent Worker under the enforced review-member profile ([scoped offers](#scoped-offers)) |
| `web-search` | search the live web with citations | feature probe on the account |
| `deep-research` | provider-native multi-step research report | plan + feature probe (P2) |
| `connector:<name>` | a website connector or app enabled on the account, e.g. `connector:github` | connector probe on the account (P2) |
| `persistent-conversation` | resumable multi-turn identity | driver conformance (website Workers); the runtime probe's `resume` flag (agent Workers); the source's own replay (model Workers; for a review member's steps only, an agent Worker under the review-member profile whose runtime cannot resume: an exact, recorded replay); target for agent Workers: a resume conformance test |
| `local-data` | can read local files and datasets in place | runs on this machine; sandbox policy allows the paths |
| `develop`, `validate` | edit code, run tests in a workspace | agent-runtime probe + writable sandbox; `validate` also needs `executes` |
| `review` | assess a provided subject against criteria | a read-only agent Worker (runtime probe + read-only sandbox) |

Profiles express each node as capabilities, not Worker kinds. A research node
requires `deep-research` or `web-search` together with `reason`. An agent review
node requires `review` and `local-data`. Only agent Workers prove `local-data`,
`develop`, `validate`, and `review`. The Claude Code rows are on in the default composition,
with no Worker until the operator names a repository
([agent Workers](../operations/runbooks.md#agent-workers)).

### Scoped offers

A Worker may offer a capability for one kind of work only
([ADR-0049](../decisions/adr/0049-read-only-agent-workers-as-review-members.md)). A capability
offer carries `scope` (`capability-descriptor@1.4`), and a work requirement names the kind of work
it is (`scope`, `work-requirement@1.1`). The only scope is `review-member`: a step of a review
team's member, which the workflow engine names on every member step of a `review` team (proposal,
ballot, debate) from the admitted spec, never from a template or model text (INV-6).

- A scoped offer proves its capability only for a requirement that names its scope; an unscoped
  offer proves it for every requirement. Routing compares the two for equality, and nothing else.
- A Worker refused for it says so: `does not prove reason (it proves reason only for review-member
  work)`. With no Worker left, admission fails closed and names the capability no Worker proves for
  that work.
- A descriptor below `@1.4`, or a requirement below `@1.1`, that carries a scope is refused, so no
  reader takes a scoped offer for a plain one.
- One source scopes offers: an agent Worker under the enforced review-member profile
  offers `reason`, granted by the profile while it is enforced, and, when its runtime cannot
  resume, `persistent-conversation` (kept by an exact, recorded replay), for a review member's
  steps only ([agent runtimes](agent-runtimes.md#review-members)).
- A caller that reads descriptors itself (a board task deciding whether to resume a session)
  counts unscoped offers only.

### Work kinds

> Decision: [ADR-0057](../decisions/adr/0057-route-work-by-kind.md) (accepted 2026-10-24, D47), from the
> operator's D35. Requirement: REQ-WRK-11.

Capabilities say what work needs, never what it is about: a source-code change and a docs change
both need `develop`. The operator routes them apart by **kind**, an opaque label
(`^[a-z][a-z0-9-]{0,31}$`, such as `code`, `docs`, `tests`):

- **A step names its kind.** A template step may set `kind`, and a variant may change it
  ([templates](../reference/workflow-templates.md)); the engine puts it in the step's requirement
  (`work-requirement@1.2` `kind`) from the admitted spec, never from model text (INV-6). A
  planner's step has none; a remediation fix has the kind of the step whose change it fixes.
- **The operator gives Workers kinds.** A descriptor may list `kinds` (`capability-descriptor@1.6`),
  which its source takes from the operator's configuration (an agent Worker's `kinds`, or its
  role's, [agent runtimes](agent-runtimes.md#workers--account--role)).
- **The rule** (`takesKind`, part of the `capability` check). A Worker given kinds takes only
  work that names one of them: never another kind, never work that names none (`takes code work
  only; this work is docs work`). A Worker given none takes any work. A kind proves no capability.
  With no Worker left, admission fails closed: `no Worker that proves develop takes docs work`.
- **Equality only.** Kinds are never ordered or preferred; among the Workers that take a kind,
  the order below decides as before. No routing, workflow, or profile code names a tool, model,
  or family for a kind (INV-11): which runtime or account takes a kind is the Worker
  configuration's and the assignments', where vendors are already named.
- **Nothing changes without kinds.** With no Worker given kinds, every Worker takes every step,
  whatever kinds the templates name. Once the operator gives a writer kinds, a step that names
  none (a planner's step, `agent-review`) needs a Worker given none
  ([route work by kind](../operations/runbooks.md#route-work-by-kind)).

## Algorithm

```mermaid
flowchart TD
  A[every Worker every source describes now] --> B{inside the caller's restriction?}
  B -->|yes| X{"of no excluded provider family, when the caller excludes some?"}
  X -->|yes| C{proves every required capability, and takes the work's kind?}
  C -->|yes| L{"takes the input's length, when it declares a bound?"}
  L -->|yes| D{local, when the data is local-private?}
  D -->|yes| E{state ready or busy?}
  E -->|yes| F{tier within min and max?}
  F -->|yes| G[admitted]
  B -->|no| R[rejected, with the failed check]
  X -->|no| R
  C -->|no| R
  L -->|no| R
  D -->|no| R
  E -->|no| R
  F -->|no| R
  G --> H["order: over its reserve last while another has headroom, lowest tier, budget.preferQuota, quotaPreference, quota headroom, least load, priority list, id"]
  H --> I[first candidate: tier and route decisions, counted pending on it until started]
  R --> J[none admitted: an admission decision and AdmissionFailure with every rejection]
```

The checks, in order, are `restricted`, `excluded` (the Workers an earlier attempt failed on
unsent, [ADR-0034](../decisions/adr/0034-unsent-failover-to-a-sibling-account.md)),
`diversity`, `capability` (with the work's kind, [above](#work-kinds)), `cooldown` (a usage limit
on a capability the work needs),
`assignment` (another account of an assigned group holds the work, [below](#assigned-accounts)),
`input`, `locality`, `state`, and `tier`; a rejected Worker carries each check it failed, with its
reason.

**Input length** ([ADR-0032](../decisions/adr/0032-admission-refuses-input-longer-than-a-worker-takes.md)).
A descriptor may declare `maxInputChars` (`capability-descriptor@1.2`): the longest input the
Worker takes, in characters of what it is sent. The caller passes `input: { chars }` in the route
options, measured on what it rendered; the workflow engine measures a node's prompt, a review's
shown source included. A longer input fails the `input` check. A source that replays history
bounds it itself. With no Worker left for its length, a node fails unsent as `invalid_input`, and
the engine names the bound that sized it (a review's `repositories.maxSourceChars`).

**Load** ([ADR-0033](../decisions/adr/0033-least-busy-routing.md)). A descriptor may carry
`load` (`capability-descriptor@1.3`): the turns `running` in its runtime's `slots`, `queued`, and
routed to it but not started (`pending`). The Workers of one account report the same numbers,
since they share its scheduler. Among Workers equal in tier, quota class, and quota headroom ([quota in every route](#quota-in-every-route)), the least loaded
comes first (running, queued, and pending together); then the `priority` list and the id decide
as before, and a source that reports no load reads 0. A Worker at its limit reads `busy`, which
stays admissible: it only orders it later.

- **Pending.** The router asks the chosen Worker's source to `reserve` it, so the admission
  counts in that Worker's `pending` until the caller calls `release()` on what `route` returned:
  once the work is started, or on any path that will not start it. The workflow engine releases it
  with its routing turn, on every path. Starting is synchronous, so the work is queued by then. A
  restart drops pending counts; the schedulers hold the real load.
- **One route at a time.** `route` runs under one lock across every caller, so two routes never
  read the same counts: two nodes of a run, or two runs started together, land on two accounts.
- **Recorded.** The route decision gives the chosen Worker's load ("load 1 of 2, 1 queued, 1
  pending"), and an admitted Worker that lost on load says so ("w:b is less busy (load 0 of 2;
  this one load 2 of 2)"). The load read is part of the decision's input (REQ-WRK-2).

### Sources that do not answer

`describe` runs on every route, inside the routing lock
([ADR-0033](../decisions/adr/0033-least-busy-routing.md#amendment-2026-10-19-where-pending-admissions-are-counted)).

- **Silent.** Each source gets 5 s. A source silent that long counts as describing no Workers for
  that read, and the route or admission decision names it as a candidate it could not offer
  (`source agents`: `did not describe its Workers within 5 s`), so one stuck source never holds
  every route. A step routed then sees none of its Workers.
- **Failed.** A source whose `describe` throws fails the read with its error: no route is taken
  until it answers.
- **Its last read.** The router keeps how each source answered its last read, by a route or a
  listing (`sources()`: `described`, `silent`, or `failed`, when the read started, and why); a
  source's read goes with the source. Health reads it after listing the Workers, names every
  source silent or failed in it, and is degraded while one is, down when no Worker answered or the
  read failed ([runbook](../operations/runbooks.md#a-worker-source-does-not-answer)).
- **Describing.** A silent read of a source none of whose describes has landed since it registered
  says so (`describing`, an optional field of the read): its first describe is still running (the
  `agents` source's first probe of its runtimes, right after a start), so its Workers are not
  known yet, never known to be none. A describe that lands past the bound still lands: the
  source's later silent reads are plain `silent`. Health and the roster read the same reads after
  the same listing, and both say the source is describing and that the Workers they count are so
  far, never a count that reads as every Worker (T99 D8: the roster listed 7 Workers right after a
  restart while a later health read counted 13).
- **A source keeps its own describe fast.** The `agents` source refreshes its runtimes' probes in
  the background and, once a runtime's first probe has finished, never waits for one in a
  describe ([admission evidence](agent-runtimes.md#admission-evidence)).

### Assigned accounts

> Decision: [ADR-0052](../decisions/adr/0052-accounts-are-assigned-unless-pooling-is-recorded.md)
> (proposed), from [PROP-0012](../proposals/0012-agent-accounts.md) and the operator's answer D24.

A descriptor may carry the account its Worker runs on (`capability-descriptor@1.5`):
`account: { id, group, mode, limitUntil? }`. Every Worker of one account (the tiers of a website
account, the roles of an agent account) carries the same `id`; `group` is what accounts are compared with (a website's provider,
an agent runtime); `mode` is that group's setting, `assigned` by default or `pooled`
([configuration](../reference/configuration.md)). The router compares `id` and `group` for
equality only and never names one ([INV-11](../architecture/invariants.md#inv-11-no-tool-lock-in)).
A Worker with no `account` is routed as before.

- **The `assignment` check.** A Worker is *at its limit* when every check it fails is a `cooldown`
  on a capability the work needs, or its state `quota-exhausted`: it would take the work but for
  the limit. While a Worker of an `assigned` account is at its limit, every Worker of another
  account of the same group is refused that work: "w:a is at its limit until 18:40; assigned
  accounts do not take another account's work at its limit". Workers of other groups, and the
  other Workers of the limited account itself, are admitted as before. Work the limited account
  could not take anyway (another capability, a tier it does not have) is not held. Under `pooled`
  nothing is held, as in [ADR-0034](../decisions/adr/0034-unsent-failover-to-a-sibling-account.md).
- **When it is back.** Each Worker at its limit is back once every limit it fails lapses: its
  latest cooldown on what the work needs, and its account's `limitUntil` when its state is the
  limit; unknown when either is not known. When nothing is admitted and every Worker at its limit
  is on an assigned account, the `AdmissionFailure` carries `limitUntil`, the earliest known
  reset, and the admission decision says so; a caller may then wait for it instead of failing (the
  workflow engine's [`wait`](workflow-engine.md#waiting-for-an-accounts-limit)). It carries none
  when a limited Worker has no assigned account, or no reset is known.
- **Staying on an account.** A caller may pass `assignment: { group, account, reason }`: no Worker
  of another account of that group takes the work (check `assignment`, the caller's reason). The
  engine passes it after an unsent failure on an assigned account, so the next attempt never moves
  inside the provider.
- **One account per group**: nothing is held, so every Worker is chosen exactly as
  before, with the same decisions; a refusal for that account's known limit carries `limitUntil`.

Quota and health are inputs **before** admission. Once a turn starts on a Worker,
it is never moved to another one. Running out of quota mid-turn is a classified
failure (`USER_ACTION` or `BACKOFF`), not a silent switch to a different provider.

### Candidates without a reservation

> Decision: [ADR-0064](../decisions/adr/0064-system-starts-ready-work-under-the-dispatch-action-class.md)
> (accepted 2026-10-25, D61). Requirement: REQ-WRK-12.

The optional `candidates(requirement, options)` tells a caller what admission says of every Worker
before it starts anything: the checks `route` runs, in the same order and under the same lock, the
`assignment` hold included, each Worker with the checks it fails (empty when admitted), the sources
that did not answer, the stored requirement, and the router's own order after tier (its quota
classes for the requirement, its priority list). It reserves nothing (no `load.pending` moves) and
records no decision: the caller that acts on it records its own, listing every Worker with these
checks (INV-13). The workflow engine's dispatch pass is its one caller
([dispatch](workflow-engine.md#dispatch-starting-ready-work-by-itself)).

**The quota score** (`quotaScoreOf`, `quota-score@2`, pure, in [`libs`](../../packages/libs/README.md))
orders the Workers `candidates` admits for a dispatched task's writing step, by the headroom order
[below](#quota-in-every-route) around tier and quota class (metered last). The chosen Worker is the
first **free** one: every pool available, every window known with headroom above the reserve, not
metered, and what the caller adds (idle enough, within its bounds). Every candidate carries its
reasons: why it won, why it lost to the chosen one (the first key that differs), why it is not free,
or why routing refused it. Among assigned accounts this chooses by headroom for new work only;
`assignment` still holds a limited account's work (D24, D66).

### Quota in every route

> Decision: [ADR-0066](../decisions/adr/0066-every-route-orders-workers-by-their-accounts-quota-headroom.md),
> increment D3 of [PROP-0014](../proposals/0014-dispatch-by-quota.md#increments) (T185).
> Requirements: REQ-WRK-8, REQ-WRK-12.

Every route, for every step of every run (dispatched or started by the lead or the operator), orders
the admitted Workers by their accounts' quota. There is **one** implementation of a pool's headroom
and its order, in `libs` (`accountQuotaOf`, `headroomOrderOf`): the quota score, routing, and the
roster's [capacity now](roster.md#capacity-now) all call it, and none computes headroom itself.
The router reads the ledger's `pools()` and the operator's quota settings (`quota()`,
[resources](resources.md#quota-settings)) once per route, inside the routing lock:

| A window is | When |
|---|---|
| known | its latest reading is at most `staleReadingSeconds` old, reads `ok`, gives a used share, and its reset (when it names one) is still ahead |
| its headroom | `100 − used − reservePercent` (the reserve: 20 % of each window by default, D63) |
| its reset | the later of `resetsAt` and `cooldownUntil` |
| over the reserve | read now as `limited`, or known with no headroom: used above `100 − reservePercent` % |

An unread window (no reading, stale, `unknown`, no used share, or from before its reset) never
counts as headroom ([INV-2](../architecture/invariants.md#inv-2-fail-closed)). Which windows an
account has is the operator's pool configuration: its **canonical gauge** is the windows its pool
lists. A Claude Code plan's pool lists only its five-hour window (operator D70); a Codex plan's lists
the windows it reports. A Worker that offers several tiers names the pools a run at each tier draws
on (its account's, and its model's own, [quota per model](agent-runtimes.md#tiers-per-role)): it is
read, ranked, and scored at the tier it would serve by those pools only, never another model's.

The order, each key compared only when every key before it is equal:

1. **Over the reserve, last.** A Worker whose account is over its reserve ranks after every other
   admitted Worker while another admitted Worker's account is free (every window known with
   headroom). So it gets no new step, writing or not, while one has headroom. When none has, this
   key ties, and it ranks by its readings like any other.
2. **Tier**, lowest admissible first.
3. **Quota class**, `budget.preferQuota`, then `quotaPreference`.
4. **Known** before configured-available (`unknown: available`) before unknown or stale: an
   unknown reading is never preferred to a known one.
5. **Use it or lose it**: a window resetting within `useSoonMinutes` with at least
   `minHeadroomPercent` headroom in the binding window (the one with the least headroom) first, the
   earlier reset first.
6. **Headroom** in the binding window, most first, in `headroomBucketPercent`-point buckets.
7. **Load**, then the priority list, then **id**.

- **Recorded.** The route decision (`workers.route.deterministic` version 2; version 3 serves a Worker
  that offers several tiers at one of them, ADR-0073) lists every admitted
  Worker's score in one line, `quota (quota-score@2): known, 5 h: used 10 %, resets in 3 h 59 min,
  headroom 70`. An admitted Worker that lost on a quota key says which one: "w:b's account has
  headroom; this one's 5 h window is used 85 %, above 80 % (the 20 % reserve), so it ranks last
  while another has headroom". The readings the order read are the ledger's own records.
- **No ledger.** With no resource ledger mounted, every quota key ties, so the order is routing's
  own as before and the decision carries no quota line. A ledger that cannot be read leaves every
  account's quota unknown, never headroom; settings it cannot tell are the defaults.
- **Never a refusal.** The order only ranks: a Worker over its reserve is still admitted and runs
  when it is the only one. A turn in flight is never moved ([assigned accounts](#assigned-accounts)).

## Provider diversity

A step can be required to run on a different provider from other steps of its run, such as
`research`'s second literature review
([templates](../reference/workflow-templates.md#research)) or each later member of a
[team](teams.md#membership-model-a). [ADR-0027](../decisions/adr/0027-provider-diversity-in-routing.md) decides how,
without naming a provider ([INV-11](../architecture/invariants.md#inv-11-no-tool-lock-in)).

- **Provider family.** A capability descriptor may carry `family`
  (`capability-descriptor@1.1`): an opaque string for who ultimately serves the work, set by
  the Worker source. A website Worker's family is its account's provider, an agent Worker's is
  its configuration's `family`, by default its runtime (a review member must name it,
  [ADR-0049](../decisions/adr/0049-read-only-agent-workers-as-review-members.md)), and a model
  Worker's is its catalog entry's `family`, by default its route
  ([models](models.md#the-catalog-and-the-routes)). Admission checks it apart from capabilities: a
  Worker that proves every capability the work needs is still refused for `diversity`.
- **Exclusion.** A caller passes `exclude: { families, reason }` in the route options. The
  `diversity` check then rejects a Worker of an excluded family (`same provider family
  (<reason>)`), and a Worker that declares no family, which cannot be shown to differ
  (`declares no provider family, so it cannot differ (<reason>)`). With no Worker left, the
  admission fails closed ([INV-2](../architecture/invariants.md#inv-2-fail-closed)).
- **Inequality only.** Routing compares families only for inequality. It never names, ranks,
  or prefers one, and the `reason` names the steps to differ from (`differs from node
  literature:1`), never a family, so route and admission decisions carry no family value. An
  architecture test refuses a family literal in routing, workflow, profile, and models code.
- The workflow engine builds the exclusion from a node's `differentFrom`
  ([workflow engine](workflow-engine.md#different-provider-families)). Routing itself never
  lifts it; an operator opt-in lets the engine route again without it, recorded
  ([ADR-0029](../decisions/adr/0029-opt-in-same-family-fallback.md)).

## Data locality policy

- Work whose `data.classification` is `local-private` is admitted only to Workers
  that run locally, unless the egress policy names the exact artifacts that may
  be sent, and to which Worker classes.
- Before content reaches a remote Worker, the egress check runs on the **actual
  payload**: the rendered prompt plus its attachments. Each artifact ref is
  checked against the policy. A payload that is not permitted fails closed
  ([INV-12](../architecture/invariants.md#inv-12-data-egress-is-explicit)).
  The check runs inside the Worker source, after `workers.route`, before
  anything is sent.
- An **agent Worker** runs locally, so routing admits `local-private` work to it,
  but its model is remote. Its source therefore checks egress too, for the Worker
  class `agent`, which by default receives `public` and `operator-shared` only.
  An operator whose agent model runs on this machine widens that class.
- A **model Worker** ([models](models.md)) checks egress for the Worker class `model` (an API
  model: `public` and `operator-shared` by default) or `model-local` (a model on this machine,
  which may also receive `local-private`). Its catalog entry's `locality` decides both the
  class and the locality routing sees.
- **Phase separation.** A Worker that browses the web or calls remote connectors
  never holds local-private content in the same execution. Untrusted web content
  can carry prompt-injection payloads. Research and private-data processing are
  separate nodes, joined only through artifacts.
- What goes back the other way is not restricted. Results from website Workers
  flow freely to local Workers as cited artifacts.

## Intelligence tiers

- Each Worker *configuration* declares its tier. A tier belongs to a Worker plus
  its mode, so the same website account can provide an `economy` Worker (instant
  mode) and a `frontier` Worker (highest effort or Deep Research). The provider
  driver verifies the mode before every send (REQ-PRV-3), so a declared tier is
  always the tier that actually runs.
- **One Worker, several tiers** ([ADR-0073](../decisions/adr/0073-agent-workers-offer-tiers-per-role-with-quota-per-model.md)).
  An agent Worker whose role declares a model per tier offers them all (`capability-descriptor@1.10`
  `tiers`, its lowest as its `tier`; [tiers per role](agent-runtimes.md#tiers-per-role)). Capability
  comes first: every check but `tier` reads the Worker as before. Then routing serves it at the
  **lowest offered tier within the requirement's bounds whose model's pool is open** (`servedTier` in
  `workers-core`): a Worker none of whose tiers is within the bounds fails `tier` ("none of its tiers
  economy, frontier is from standard to standard"); one whose tiers within them are all closed by
  their models' limits fails `cooldown` ("tier frontier limit until …"), so an assigned account's
  limit holds the work and the caller may wait for its reset ([assigned accounts](#assigned-accounts)).
  The order's tier key, the quota keys (the served tier's pools only), the `tier` decision, and the
  route decision's reasons ("serves tier frontier of the tiers it offers (economy, standard,
  frontier)", then whether that tier "draws on its model's own window beside its account's" or "has
  no window of its model's own: its tiers share its account's windows", as on a provider that
  reports no window per model, such as Codex) are the served tier's; `AdmittedWorker.tier` and each admitted candidate's `tier` carry
  it, and the caller passes it to the start (`WorkerStart.tier`), so the run runs that tier's model.
  The route decision is `workers.route.deterministic` version 3. A Worker that offers one tier is
  routed as before.
- Profiles declare each node's minimum tier, for example triage → `economy`,
  research → `frontier`, compacting a handoff → `economy`.
- **Escalation:** if acceptance rejects a result, the workflow engine opens a
  *new* execution of the node at the next tier above the one that served it, at
  most `maxEscalations` times (per node, default 1, at most 3). The rejected
  result stays as evidence. The choice is an `escalation` decision either way
  (`workflow.escalation` version 2), and it is never applied to a running turn.
  A node its session holds to its Workers (a team member, which keeps one logical
  Worker, REQ-TEAM-2) escalates only when one of them, as listed now, serves the
  next tier or above: routing would refuse every other Worker, so the decision is
  `fail`, and the node fails as `acceptance_rejected` with the contract's reasons
  and why it was not escalated, never as an admission failure. Those Workers are
  listed only once the result is rejected. When the listing fails (a Worker source
  that cannot describe itself), no Worker can be shown to take the next tier: the
  decision is `fail` ("held Workers unknown", with the listing's error), and the
  step never fails for the listing itself. A rejected answer
  its Worker cut at its output bound (`model-answer` `finish: max-tokens`) says so
  among the reasons, since a higher tier is not what a cut answer lacked.
  Escalation is only ever for a rejected result: a Worker refused at admission
  (its input bound, say) never raises the tier; routing takes the lowest
  admissible tier at or above the node's own. A held Worker that offers several
  tiers serves the next one when any of its tiers is at or above it.
- **Tier by risk** ([ADR-0073](../decisions/adr/0073-agent-workers-offer-tiers-per-role-with-quota-per-model.md)).
  A board task's step may take its minimum tier from its task's risk tier
  ([ADR-0071](../decisions/adr/0071-a-changes-risk-tier-comes-from-the-policys-path-map.md)):
  the autonomy policy's `tierByRisk` (`autonomy-policy@1.2`, versioned) maps, under
  `light`, `normal`, or `heavy`, a step's capability or kind of work to a tier, such as
  `heavy: { develop: frontier, review: frontier }` and `light: { validate: economy, docs: economy }`.
  Before the step is routed, the engine reads the task's latest risk-tier decision (its run's, else
  an earlier attempt's) and, when an entry names the step (the highest of several, across the
  studio's and the project's policies), records a `tier` decision of policy `workflow.tier-by-risk`
  version 1, its input the risk decision, its detail the maps' versions and the entries that matched,
  raised, lowered, or kept; the step's requirement names it as its tier's source. A step an
  escalation set is never lowered, and its maximum bounds it. Dispatch scores a task's writing step at
  the same tier. With no map, steps keep their templates' tiers. When the policy or the board task
  cannot be read, the step's tier is unknown, and it is not routed at its template's tier (INV-2): it
  fails unsent and is retried with back-off, failing once its attempts are spent; dispatch does not
  start or score the task meanwhile.
- Planning may use a higher tier than the steps it coordinates,
  in line with "spend intelligence where intelligence matters".

Inferring the tier for work that does not declare one, using a decision model, is
under consideration in
[PROP-0002](../proposals/0002-decision-assisted-routing.md). It is not current
design.

## Quota and cost policy

- Each account and runtime declares a **quota class**: `subscription-chat` for
  website accounts, `agent-plan` for Claude Code and Codex plans, `metered` for
  API models, and `local` for models on this machine. The order is configuration
  (`quotaPreference`, REQ-WRK-8). The default composition prefers
  `subscription-chat`, then `local`, `agent-plan`, and `metered`. Agent Workers never
  offer plain `reason`, so `agent-plan` quota is spent only on capabilities only
  they prove, such as `develop`, `review`, and `local-data` (P1), and on the review member steps
  of the agent Workers the operator names review members, which offer `reason` for that work only
  ([scoped offers](#scoped-offers)); the quota order still puts a website Worker first there. Tier comes before
  quota, so a model Worker the operator declares at a lower tier than every website
  Worker serves the `economy` work (P4).
- The `api-first` preset ([ADR-0025](../decisions/adr/0025-api-first-composition.md)) orders
  `local`, `metered`, `agent-plan`, `subscription-chat`, and mounts no website Worker. Work that
  needs a capability only website Workers prove (`web-search`, `deep-research`) then fails
  admission: the failure names each required capability no Worker proves.
- Usage is recorded per account from observable signals (turn counts and
  estimated tokens) and treated as an estimate (CON-4). A site's own usage-limit
  text, recognized by a UI-map error rule, puts a **cooldown** on the account's
  Workers ([ADR-0034](../decisions/adr/0034-unsent-failover-to-a-sibling-account.md)):
  - on one feature (the rule's `feature`): the Workers list it in `cooldowns`
    (`capability-descriptor@1.3`), and work that needs it fails the `cooldown` check there
    ("deep-research limit until …"), while other work is admitted as before;
  - on the whole account (no feature): its Workers read `quota-exhausted`;
  - for `featureLimitCooldownMs` (6 h) or `accountLimitCooldownMs` (1 h). It ends when its time
    passes, when a turn that used the feature succeeds, or by the operator
    (`system account clear-cooldown`); a feature probe never ends it. A cooldown is Worker state,
    never the account's status: the account stays `ready`, keeps its checks, and health does not
    ask the operator to act. A node refused only for it fails `quota_exhausted`, unless the
    account is [assigned](#assigned-accounts): it then waits for the reset, bounded.
- **Accounts are assigned by default** (D24: personal subscriptions): a limit on one account
  never moves its work to another account of that provider, for website and agent accounts alike
  ([assigned accounts](#assigned-accounts)). A provider is `pooled` only on the operator's
  recorded decision (`pooledTerms`: who, when, which terms on what basis), which for a personal
  subscription records that the operator accepts the risk under its terms
  ([ADR-0055](../decisions/adr/0055-personal-accounts-may-be-pooled-on-the-operators-recorded-acceptance.md)).
- **Context economy.** Handoffs carry the synthesized, hash-bound result, not the
  research transcript. Retained conversations receive only new suffixes. Node
  results are reused by input hash.
