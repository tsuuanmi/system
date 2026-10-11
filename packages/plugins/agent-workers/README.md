# @tsuuanmi/system-agent-workers

The **`agents` Worker source**: agent runtimes as Workers
([design](../../../docs/design/agent-runtimes.md)).

- **Workers come from configuration only** (INV-6). Each entry is `agent:<id>`
  with a `runtime` kind, an absolute `workspace`, a `sandbox` (`read-only` or
  `workspace-write`), and optional `tools` (omitted or empty: the runtime's
  minimal set), `model`, and `maxTurns`. It also
  has a `tier`, and a `quotaClass` (default `agent-plan`). The Worker is local.
- **Capabilities are what `probe()` proves now** (cached for `probeTtlMs`):
  - `review` and `local-data`;
  - `develop` and `validate` for a writable sandbox;
  - `persistent-conversation` when the runtime can resume.

  A Worker never offers plain `reason`, so ordinary asks never spend agent-plan
  quota (P1). If the runtime is missing, or cannot enforce the configured
  sandbox, the Worker is `unavailable`: its policy is never loosened.
- **Runs** (`start`, `get`, `wait`):
  - durable at once, and idempotent by key;
  - one at a time per Worker (one writer per workspace, INV-15);
  - under a lease;
  - each result is a `report` artifact (`agent-result@1.0`) with the requirement's
    classification.
- **Deadline:** a run longer than `runTimeoutMs` (15 min) is stopped and fails
  as `timeout`. The run was submitted, so it is not retried automatically.
- **Restart:** a queued run starts. A run that had started is never run again:
  the agent may already have acted. It fails as `reconciliation_failed`
  (`USER_ACTION`) and names its native session.
- **Sessions:** a session id is bound to its Worker (`affinity`). Later runs
  resume the agent's native session.
- **Injects:** `store`, `artifacts`, `leases`, `workers`, `agentRuntimes`.
