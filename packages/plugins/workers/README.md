# @tsuuanmi/system-workers

**`ctx.workers`**: the Worker registry, fail-closed admission, and the deterministic
router ([routing](../../../docs/design/routing.md#algorithm)). Definition:
[`@tsuuanmi/system-workers-core`](../../workers-core/README.md).

- **Sources.** A plugin registers a `WorkerSource` for its own lifetime.
  `describe()` runs on every route, so admission sees current states. Each
  descriptor is validated against `capability-descriptor@1.0`. A Worker id that
  two sources describe is refused.
- **Admission (REQ-WRK-1, -7, -9).** A Worker passes only if all of these hold:
  - it is inside the caller's restriction, if one is given;
  - it proves every required capability;
  - it is local when the data is `local-private`;
  - it is `ready`;
  - its tier is within `[min, max]`.

  Every failed check is kept with its reason.
- **Order (REQ-WRK-2, -8).** Lowest tier first, then the requirement's
  `budget.preferQuota`, then `quotaPreference` (default `subscription-chat`,
  `local`, `agent-plan`, `metered`), then `priority` (Worker ids), then the id in
  code-point order. The result does not depend on the locale or on source order.
- **Decisions (INV-13).** The requirement is stored as an `objective` artifact
  (`work-requirement@1.0`).
  - **Success:** a `tier` decision, and a `route` decision whose candidates are
    every Worker. A rejected Worker carries its failed checks. An admitted Worker
    that was not chosen says what put the winner first.
  - **Failure:** an `admission` decision with outcome `none`, and
    `AdmissionFailure` carrying every rejection, including each Worker's state.
- **Not yet:** acceptance and tier escalation arrive with the workflow engine
  (M3). See
  [known gaps](../../../docs/architecture/plugin-model.md#known-gaps-tracked).
- **Config:** `quotaPreference`, `priority`.
- **Injects:** `artifacts`.
