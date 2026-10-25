# @tsuuanmi/system-workers

**`ctx.workers`**: the Worker registry, fail-closed admission, and the deterministic
router ([routing](../../../docs/design/routing.md#algorithm)). Definition:
[`@tsuuanmi/system-workers-core`](../../workers-core/README.md).

- **Sources.** A plugin registers a `WorkerSource` for its own lifetime. A
  source describes its Workers, runs work on them (`start`, `get`, `wait`), and
  may name the Workers a session must stay on (`affinity`), and why a session
  takes no input now (`held`, PROP-0013: asked of every source, the first
  reason given wins, and a source whose `held` throws cannot show the session
  free), and its runs whose liveness needs the operator's look (`liveness`,
  PROP-0013: every source that tells it is asked, the runs merged latest first,
  at most 64, the counts summed, and a source that throws named in `unread`,
  never read as having none), and lands an accepted result made in a worktree it
  holds (`land`, ADR-0060: asked of each source in turn, the first that holds the
  worktree answers, with its name; one that throws is a `failed` refusal, never
  read as not holding it), and reads a workflow run's change in its worktrees
  (`changes`, T122: every source that holds one answers, with its name; one that
  throws is named in `unread`, never read as no change), and starts a workflow
  run's worktree from an earlier run's tree it holds (`carry`, ADR-0061, accepted 2026-10-25, D59; asked as
  `land` is, by the earlier tree's worktree), and runs a workflow run's required
  checks on its result's worktree (`check`, T151: asked as `land` is; one that
  throws, unless the caller stopped it, is a `failed` refusal, never a check
  passed). The router
  returns the admitted Worker with its source's name; `source(name)` finds the
  source. Three sources register today: website Workers (`ctx.turns`, one Worker
  per account and mapped tier), agent Workers
  ([`agent-workers`](../agent-workers/README.md)), and model Workers
  ([`models`](../models/README.md)).
  `describe()` runs on every route, so admission sees current states. A source
  gets 5 s inside the routing lock: one silent that long counts as describing
  no Workers for that read, and the route or admission decision names it
  (`source <name>`: `did not describe its Workers within 5 s`); one whose
  `describe` throws fails the read with its error, as before. `sources()` gives
  how each source answered its last read, by a route or `list` (`described`,
  `silent`, or `failed`, when, and why); a source's read goes with the source.
  A silent read says `describing` while none of the source's describes has
  landed since it registered (one that lands past the bound still counts), so a
  first probe after a start reads as describing, not as no Workers.
  Health names every source silent or failed in it
  ([sources that do not answer](../../../docs/design/routing.md#sources-that-do-not-answer)). Each
  descriptor is validated against `capability-descriptor@1.0`, `@1.1` (with
  `family`), `@1.2` (with `maxInputChars`), `@1.3` (with `load` and `cooldowns`), `@1.4` (an
  offer's `scope`), `@1.5` (its `account`), `@1.6` (its `kinds`), or `@1.7` (its `description`). A Worker id that two sources
  describe is refused.
- **Admission (REQ-WRK-1, -7, -9).** A Worker passes only if all of these hold:
  - it is inside the caller's restriction, if one is given;
  - it is not one the caller leaves out (`excluded`: an earlier attempt failed on it before
    sending, ADR-0034);
  - it is of none of the provider families the caller excludes, if any
    (`diversity`); a Worker that declares no family cannot differ, so it fails
    too ([provider diversity](../../../docs/design/routing.md#provider-diversity));
  - it proves every required capability; an offer scoped to a kind of work
    (`scope`, [ADR-0049](../../../docs/decisions/adr/0049-read-only-agent-workers-as-review-members.md))
    counts only for a requirement that names that scope, and a refusal says so
    (`does not prove reason (it proves reason only for review-member work)`);
  - it takes the work's kind: a Worker the operator gives `kinds` takes only work whose
    requirement names one of them (`capability`, [work kinds](../../../docs/design/routing.md#work-kinds),
    [ADR-0057](../../../docs/decisions/adr/0057-route-work-by-kind.md)), and says so (`takes code
    work only; this work is docs work`); a Worker given none takes any work;
  - no usage limit is on a capability the work needs (`cooldown`, ADR-0034);
  - no other account of its group holds the work (`assignment`,
    [assigned accounts](../../../docs/design/routing.md#assigned-accounts)): while a Worker of an
    `assigned` account is refused only for its limit (its `cooldown`s, or `quota-exhausted`), a
    Worker of another account of the same group is refused the same work, and so is any Worker of
    another account when the caller keeps the work on one (`RouteOptions.assignment`);
  - it takes the input's length, when the caller gives one and the Worker
    declares a bound (`input`, [ADR-0032](../../../docs/decisions/adr/0032-admission-refuses-input-longer-than-a-worker-takes.md));
  - it is local when the data is `local-private`;
  - it is `ready` or `busy` (busy only orders it later);
  - its tier is within `[min, max]`.

  Every failed check is kept with its reason.
- **Order (REQ-WRK-2, -8).** Lowest tier first, then the requirement's
  `budget.preferQuota`, then `quotaPreference` (default `subscription-chat`,
  `local`, `agent-plan`, `metered`; the `api-first` preset sets `local`, `metered`,
  `agent-plan`, `subscription-chat`), then the least `load` (running, queued, and
  pending; a source that reports none reads 0), then `priority` (Worker ids), then the
  id in code-point order. The result does not depend on the locale or on source order.
- **Load (ADR-0033).** `route` runs under one lock across every caller. The chosen
  Worker's source `reserve`s it, so the admission counts as `pending` until the caller
  calls `release()` on the admitted Worker (idempotent), once the work is started or
  will not be.
- **Candidates (ADR-0064).** `candidates(requirement, options)` runs the same admission, under
  the same lock, the `assignment` hold applied, and returns every Worker with its source and the
  checks it fails, the sources that did not answer, the stored requirement, and the order after
  tier this requirement gets (`quotaPreference` after `budget.preferQuota`, and `priority`). It
  reserves nothing and records no decision: the workflow engine's dispatch pass, its caller,
  records its own `dispatch.choice` decision over these
  ([candidates](../../../docs/design/routing.md#candidates-without-a-reservation)).
- **Decisions (INV-13).** The requirement is stored as an `objective` artifact
  (`work-requirement@1.0`, `@1.1` with a `scope`, or `@1.2` with a `kind`).
  - **Success:** a `tier` decision, and a `route` decision whose candidates are
    every Worker. A rejected Worker carries its failed checks. An admitted Worker
    that was not chosen says what put the winner first.
  - **Failure:** an `admission` decision with outcome `none`, and
    `AdmissionFailure` carrying every rejection, including each Worker's state.
    A required capability that no Worker proves is named first
    (`no Worker proves web-search`), as under the `api-first` preset; then a kind no Worker
    that proves it all takes (`no Worker that proves develop takes code work`). When every
    Worker refused only for its limit is on an assigned account, the failure's
    `limitUntil` is the earliest known reset, and the decision says when the first is back.
- **Acceptance (REQ-WRK-3).** `contract(id, check)` registers a deterministic
  contract for the plugin's lifetime. `accept(result, contract)` checks a stored
  result and records an `acceptance` decision; with a `resultSchema`, the result's JSON must first
  be valid against that schema (REQ-ART-5). `contracts()` lists the
  registered ids, so a caller can refuse an unknown contract before any work
  runs. An unknown contract or result
  throws: it never accepts silently. Two contracts are built in:
  - `acceptance.answer`: the answer has text;
  - `acceptance.cited`: the answer also cites at least one http(s) source link.
- **Escalation** is not the router's: after a rejection, the workflow engine
  opens a new execution at the next tier and routes it again
  ([workflow](../workflow/README.md)).
- **Config:** `quotaPreference`, `priority`.
- **Injects:** `artifacts`.
