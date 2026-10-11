# @tsuuanmi/system-turns

**`ctx.turns`**: the website turn runtime: the website Worker's owning runtime,
invoked by the [workflow engine](../workflow/README.md)
([provider turns](../../../docs/design/provider-turns.md#runtime-mvp-slice-1)).

- **Durable from acceptance.** `ask` writes the turn (`queued`) and returns at
  once. The prompt is stored locally, and is never returned by views or MCP.
  `clientRequestId` makes retries idempotent; the same key with another prompt is
  refused.
- **Egress (INV-12):** before routing or sending, `ctx.egress` checks the prompt
  against the caller's `classification` (default `operator-shared`) for the
  `website` Worker class, and scans it for credentials. A denial fails the turn
  as `egress_denied` with the decision id, and nothing is sent.
- **Routing through `ctx.workers`:**
  - this runtime registers the `website` Worker source: one Worker
    `worker:<account>/<tier>` per account and tier its catalog maps to a mode
    preset, proving what the account's driver declares, in a state taken from the
    account's status;
  - each turn becomes a `work-requirement@1.0`: `reason`, plus
    `persistent-conversation` for a session and `deep-research` for research;
    the caller's classification; and the minimum tier;
  - a persistent session is restricted to its account's Workers;
  - the router records `tier` and `route` decisions. When nothing is admissible
    it records an `admission` decision, and the turn fails with nothing sent:
    `reauth_required` when there is no Worker at all or a Worker was kept out
    only by its account's state, `config_error` when no Worker serves the
    capabilities or tier.
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
- **Completion:**
  - one transaction binds the conversation and completes the receipt;
  - the answer becomes a `report` artifact (`provider-answer@1.0`,
    `local-private`) linked to the route decision.
- **Bounds (INV-9):** at most `maxPendingTurns` (default 32) accepted but
  unfinished turns; more are refused with `overloaded` (BACKOFF). Finished turns,
  their prompts, and sessions with no turns left are deleted after `retainDays`
  (default 30). Answers stay as artifacts, which hold the prompt by hash only.
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
  - A stop leaves turns as they are for the next start.
- **Tiers and modes:**
  - `tier` (or `defaultTier`) is the **minimum**: the router picks the lowest
    admitted tier at or above it, and the chosen Worker's tier maps through the
    account's catalog `tiers` to the driver's mode preset;
  - the receipt records the model and effort that were read back.
- **Deep research:** `research` starts in a new (or the given) persistent
  session and returns at once (`researchTimeoutMs`, `researchStallTimeoutMs`).
- **Sessions:**
  - a persistent session exists from acceptance and is bound to the first
    account that runs it;
  - turns of one session run in acceptance order.
- **Sign-out:** a driver `reauth_required` (it saw the login surface) marks the
  account `reauth-required`, so new turns route elsewhere.
- **For the engine:** `requirement(input)` returns the `work-requirement@1.0` an
  ask is routed with; the engine records it on its node. `openSession()` opens
  an empty persistent session, so a run can return its id at once. An ask names
  its `acceptance` contract (default `acceptance.answer`), which is recorded in
  the requirement.
- **Stop:** a stopped runtime starts nothing. A turn caught mid-route stays
  queued for the next start.
- **Injects:** `store`, `artifacts`, `leases`, `egress`, `turnReceipts`, `accounts`,
  `browser`, `providers`, `workers`; `mcp` is optional.
- **MCP:** none of its own; the workflow engine serves `ask`, `research`, and
  `result` as runs.
