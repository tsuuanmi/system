# @tsuuanmi/system-turns

**`ctx.turns`**: the website turn runtime: the website Worker's owning runtime,
invoked by the [workflow engine](../workflow/README.md)
([provider turns](../../../docs/design/provider-turns.md#runtime-mvp-slice-1)).

- **The `website` Worker source.**
  - **Describe:** one Worker `worker:<account>/<tier>` per account and per tier
    its catalog maps to a mode preset. It proves what the account's driver
    declares, in a state taken from the account's status. A tier mapped to a
    preset the driver does not have (the driver's `modes`) is `unavailable`. Its
    provider family (`capability-descriptor@1.1`) is the account's provider.
  - **Run:** `start`, `get`, and `wait` run turns. The engine routes; a turn
    never routes itself.
  - **Affinity:** a session stays on the account it is bound to.
- **Durable from acceptance.** `ask(WorkerStart)` writes the turn (`queued`) on
  the admitted Worker and returns at once.
  - The turn takes its feature from the requirement's capabilities
    (`deep-research`), its tier from the Worker, and the route and tier
    decisions from the caller.
  - A session id is opened on first use and bound to the Worker's account.
  - The request `key` makes it idempotent; the same key with another prompt is
    refused.
  - The prompt is stored locally, and is never returned by views or MCP.
- **Egress (INV-12):** before sending, `ctx.egress` checks the prompt against
  the requirement's classification for the `website` Worker class, and scans it
  for credentials. A denial fails the turn as `egress_denied` with the decision
  id, and nothing is sent. Routing already keeps `local-private` work off remote
  Workers; this check holds even if a caller skipped routing.
- **Execution:**
  - each account has its own `ProviderScheduler` (capacity
    `maxConcurrentTurnsPerAccount`; one session runs in order);
  - every turn runs in a fresh `ctx.browser` context from the account's saved
    state;
  - the driver call uses the conversation mode (temporary by default;
    `persist` / `sessionId` for a persistent `/c/<id>` binding);
  - the receipt is written in the driver's `beforeSend` hook.
- **Write-back:** before completing, the turn captures the browser state for the
  driver's origins and stores it with `accounts.refreshState`. This happens only
  if the turn still holds its lease and the account is still at the revision the
  turn started from. A failure is logged (`account.write-back-skipped`) and never
  fails an answered turn.
  - **Concurrent sign-in:** a Save or relogin while a turn runs writes a newer
    revision, so the turn's write-back is skipped and the newer sign-in wins
    (tested). Login therefore does not take `ProviderScheduler.runExclusive`:
    wrapping the in-turn relogin in it would deadlock.
- **Completion:**
  - one transaction binds the conversation and completes the receipt;
  - the answer becomes a `report` artifact (`provider-answer@1.0`,
    `local-private`) linked to the route decision.
- **Bounds (INV-9):** at most `maxPendingTurns` (default 32) accepted but
  unfinished turns; more are refused with `overloaded` (BACKOFF). Finished turns,
  their prompts, their receipts (`turnReceipts.delete`), and sessions with no
  turns left are deleted after `retainDays` (default 30), in one transaction.
  Answers stay as artifacts, which hold the prompt by hash only.
- **Ownership:**
  - every turn runs under a `turn:<id>` lease from `ctx.leases` (60 s, renewed
    every 20 s);
  - the receipt, routing, status, and completion writes are fenced inside their
    transactions;
  - a turn that another live process holds is re-checked when its lease would
    expire, so two processes sharing one home never run a turn twice;
  - a stop waits for in-flight runs, so their leases are released.
- **Restart:**
  - `queued` turns run again;
  - a `running` turn with no receipt was never sent, so it runs again;
  - a `running` turn **with** a submitted receipt is reconciled under its lease.
    A persistent conversation (bound as soon as its URL shows the id) is reopened
    and snapshotted. A temporary or never-bound conversation cannot be observed,
    so it is AMBIGUOUS. The `reconciliation` decision is recorded first (INV-13).
    Then the turn waits (WAIT), adopts the answer without resending (RECOVER),
    resends within the bound (RESUBMIT), or fails closed with
    `reconciliation_failed` (AMBIGUOUS).
  - **WAIT** looks again every 5 s with an abortable sleep, so an operator
    cancel or a runtime stop ends the wait at once. Consecutive WAITs are one
    decision (`turnReceipts.reconcile`).
  - A stop leaves turns as they are for the next start.
- **Tiers and modes:**
  - the Worker's tier maps through the account's catalog `tiers` to the
    driver's mode preset. The router chose that tier as the lowest admitted one
    at or above the requirement's minimum;
  - the receipt records the model and effort that were read back.
- **Account features (REQ-PRV-7):**
  - A Worker proves its driver's conformance capabilities (`reason`,
    `persistent-conversation`). It also proves each website feature that a
    probe found on its account (`deep-research`, `web-search`,
    `image-generation`), with `probe` evidence.
  - `probe(account)` runs the driver's `probeFeatures` on the account's
    scheduler. It reads the tools popover, sends nothing, and records the
    result on the account (MCP `account_probe`, `system account probe <id>`).
  - Ready accounts whose probe is missing or older than `probeTtlMs`
    (default 24 h) are probed in the background, at start and hourly.
  - A requirement with `web-search` runs with Web search turned on.
- **Deep research:** a requirement with `deep-research` runs as Deep research in
  its persistent session (`researchTimeoutMs`, `researchStallTimeoutMs`).
- **Sessions:**
  - the caller issues session ids; a session is bound to the account of its
    first turn;
  - turns of one session run in acceptance order, **decided by the store**, not
    by this process's memory: a later turn waits (looked at again every second)
    while an earlier turn of its session is `queued` or `running`, including one
    whose lease a crashed process still holds. So it never answers into a
    conversation that is not reconciled yet; otherwise, after a quick restart,
    a turn could be recorded with the next turn's answer.
- **Sign-out:** a driver `reauth_required` (it saw the login surface) marks the
  account `reauth-required`, so new turns route elsewhere. A credentials-mode
  account signs in again once (`login.relogin`, ADR-0017) and the turn runs
  again, but only while the turn has no receipt. A `reauth_required` after the
  receipt exists means the prompt may have been sent, so the turn fails instead
  (INV-4).
- **Submitted:** a view's `submitted` flag says whether the prompt reached the
  provider. It is set in the same transaction as the receipt, so a caller never
  resends.
- **Fail closed on drift:** a turn routed before a restart whose tier the
  operator has since unmapped fails with `config_error`. It is never served by
  another mode.
- **Lost lease:** the turn is looked at again once its lease can be taken, so it
  is never stranded until the next start.
- **Cancel (REQ-WRK-4):** `cancel(turnId)` aborts a running turn, or fails a
  queued one before it starts, as `aborted`. An answer the provider was already
  generating is not taken.
- **Stop:** a stopped runtime starts nothing. A turn caught before scheduling
  stays queued for the next start.
- **Injects:** `store`, `artifacts`, `leases`, `egress`, `turnReceipts`, `accounts`,
  `browser`, `providers`, `workers`; `mcp` is optional.
- **MCP:** none of its own; the workflow engine serves `ask`, `research`, and
  `result` as runs.
