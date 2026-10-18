# @tsuuanmi/system-workers

**`ctx.workers`**: the Worker registry, fail-closed admission, and the deterministic
router ([routing](../../../docs/design/routing.md#algorithm)). Definition:
[`@tsuuanmi/system-workers-core`](../../workers-core/README.md).

- **Sources.** A plugin registers a `WorkerSource` for its own lifetime. A
  source describes its Workers, runs work on them (`start`, `get`, `wait`), and
  may name the Workers a session must stay on (`affinity`). The router
  returns the admitted Worker with its source's name; `source(name)` finds the
  source. Three sources register today: website Workers (`ctx.turns`, one Worker
  per account and mapped tier), agent Workers
  ([`agent-workers`](../agent-workers/README.md)), and model Workers
  ([`models`](../models/README.md)).
  `describe()` runs on every route, so admission sees current states. Each
  descriptor is validated against `capability-descriptor@1.0`, `@1.1` (with
  `family`), or `@1.2` (with `maxInputChars`). A Worker id that
  two sources describe is refused.
- **Admission (REQ-WRK-1, -7, -9).** A Worker passes only if all of these hold:
  - it is inside the caller's restriction, if one is given;
  - it is of none of the provider families the caller excludes, if any
    (`diversity`); a Worker that declares no family cannot differ, so it fails
    too ([provider diversity](../../../docs/design/routing.md#provider-diversity));
  - it proves every required capability;
  - it takes the input's length, when the caller gives one and the Worker
    declares a bound (`input`, [ADR-0032](../../../docs/decisions/adr/0032-admission-refuses-input-longer-than-a-worker-takes.md));
  - it is local when the data is `local-private`;
  - it is `ready`;
  - its tier is within `[min, max]`.

  Every failed check is kept with its reason.
- **Order (REQ-WRK-2, -8).** Lowest tier first, then the requirement's
  `budget.preferQuota`, then `quotaPreference` (default `subscription-chat`,
  `local`, `agent-plan`, `metered`; the `api-first` preset sets `local`, `metered`,
  `agent-plan`, `subscription-chat`), then `priority` (Worker ids), then the id in
  code-point order. The result does not depend on the locale or on source order.
- **Decisions (INV-13).** The requirement is stored as an `objective` artifact
  (`work-requirement@1.0`).
  - **Success:** a `tier` decision, and a `route` decision whose candidates are
    every Worker. A rejected Worker carries its failed checks. An admitted Worker
    that was not chosen says what put the winner first.
  - **Failure:** an `admission` decision with outcome `none`, and
    `AdmissionFailure` carrying every rejection, including each Worker's state.
    A required capability that no Worker proves is named first
    (`no Worker proves web-search`), as under the `api-first` preset.
- **Acceptance (REQ-WRK-3).** `contract(id, check)` registers a deterministic
  contract for the plugin's lifetime. `accept(result, contract)` checks a stored
  result and records an `acceptance` decision. `contracts()` lists the
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
