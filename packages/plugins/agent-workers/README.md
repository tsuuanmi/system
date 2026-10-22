# @tsuuanmi/system-agent-workers

The **`agents` Worker source**: agent runtimes as Workers
([design](../../../docs/design/agent-runtimes.md)).

- **Off by default:** this row, the agent runtime rows, and the
  software-development profile, whose `agent-review` template only these
  Workers can run, are off in the default composition (PROP-0004)
  ([turn them on](../../../docs/operations/runbooks.md#turn-an-off-row-back-on)).

- **Workers come from configuration only** (INV-6). Each entry is `agent:<id>`
  with a `runtime` kind, an absolute `workspace`, a `sandbox` (`read-only` or
  `workspace-write`), and optional `tools` (omitted or empty: the runtime's
  minimal set), `model`, and `maxTurns`. It also
  has a `tier`, and a `quotaClass` (default `agent-plan`). The Worker is local.
  Its provider family (`capability-descriptor@1.1`) is its runtime. Optional,
  for metering: `pool` and `account` (set together: a pool id from the
  resources configuration and the account it belongs to), and `windows`, the
  runtime's limit window names mapped to the pool's window ids (for example
  `five_hour: five-hour`).
- **Capabilities are what `probe()` proves now** (cached for `probeTtlMs`):
  - `local-data`;
  - `review` only for a read-only sandbox: a review is independent of the
    change (INV-15);
  - `develop` for a writable sandbox, and `validate` only if the runtime can
    also run commands confined to the workspace (`executes`);
  - `persistent-conversation` when the runtime can resume.

  A Worker never offers plain `reason`, so ordinary asks never spend agent-plan
  quota (P1). If the runtime is missing, cannot enforce the configured sandbox,
  or does not prove `readsConfined` (ADR-0024), the Worker is `unavailable`:
  its policy is never loosened.
- **Runs** (`start`, `get`, `wait`):
  - durable at once, and idempotent by key;
  - one at a time per Worker (one writer per workspace, INV-15);
  - under a lease;
  - each result is a `report` artifact with the requirement's classification:
    `agent-result@1.2` (with `model`, `usage`, and `models`) when the runtime
    reported its token usage, `agent-result@1.1` otherwise. It carries the
    workspace and, when that is a git working tree, its exact subject after the
    run, which a review binds to.
- **Metering** ([resources](../../../docs/design/resources.md)), for a Worker
  with a `pool`, through `ctx.resources` (optional: read when present, never
  injected):
  - **admission:** `describe()` reports the Worker `quota-exhausted` while its
    pool is unavailable, so routing skips it (REQ-WRK-8). With no ledger
    loaded, a pool the ledger does not configure, or a ledger that cannot be
    read, it is `unavailable` (INV-2);
  - **reserve** before the run, after the egress check and before anything
    reaches the agent: one line, `runs` 1 on the pool. The `budget` decision
    joins the run's decisions. A refused reservation fails the run unsubmitted
    as `quota_exhausted` (`config_error` when the ledger does not configure the
    pool, or no ledger is loaded), and nothing runs;
  - **record** after the run, completed, failed, or aborted: one `usage-record`
    (source `runtime-result`; `requestId` `<runtime>:<the runtime's result
    id>`, or the run id when it gives none; `runId`, `account`, `pool`,
    `worker`, `sessionId`, `model` (request: the configured model; response:
    the runtime's main model), `usage`, `models`, `turns`, `durationMs` (from
    submission to the end), `cost` with basis `runtime-estimate`, and
    `outcome`). Numbers the runtime did not report stay missing; a run that
    reported neither tokens nor turns gets no record. A ledger refusal is
    logged and never changes the run's own outcome;
  - **observe** each rate-limit observation the runtime reported as a
    `limit-state` reading (source `runtime-result`) of the window `windows`
    maps it to: `limited` with `resetsAt` when `rejected`, `unknown` when
    `rejected` without a reset time (the pool stays closed until a reading
    says otherwise), `ok` otherwise. An unmapped window is logged and skipped;
  - **release** the reservation once the usage is recorded, or when the run
    fails before it starts.

  Without a `pool`, runs are not metered, whether a ledger is loaded or not.
- **Egress (INV-12):** the agent runs on this machine, but its model is remote.
  So before a run starts, its prompt is checked by `ctx.egress` with
  `workerClass: 'agent'`. The decision is part of the run's decision chain (as for website
  turns), so `system explain` shows it. A denial fails the run as `egress_denied`,
  never submitted. By default `local-private` work is refused here, although
  routing admits it (the Worker is local); see the egress plugin's
  `workerClasses`.
- **Cancel (REQ-WRK-4):** a running agent is stopped, and a queued run never
  starts. Both fail as `aborted`.
- **Deadline:** a run longer than `runTimeoutMs` (15 min) is stopped and fails
  as `timeout`. The run was submitted, so it is not retried automatically.
- **Restart:** a queued run starts. A run that had started is never run again:
  the agent may already have acted. It fails as `reconciliation_failed`
  (`USER_ACTION`) and names its native session. Its reservation is released,
  and its usage is not invented: no result message means no `runtime-result`
  record; its usage comes from transcript reconciliation (`source:
  transcript`), later (not built yet).
- **Never stranded:** a run whose `agent-run:<id>` lease another process holds
  is looked at again once that lease would expire (it finishes the run, or it
  crashed). A run whose lease was lost is looked at again after the lease
  period; a run already submitted then fails as `reconciliation_failed`, never
  run again (INV-4).
- **Sessions:** a session id is bound to its Worker (`affinity`). Later runs
  resume the agent's native session.
- **Injects:** `store`, `artifacts`, `leases`, `workers`, `agentRuntimes`, `egress`;
  reads `resources` when present.
