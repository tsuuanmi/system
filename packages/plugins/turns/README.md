# @tsuuanmi/system-turns

**`ctx.turns`**: the website turn runtime, MVP slice 1 `ask`
([provider turns](../../../docs/design/provider-turns.md#runtime-mvp-slice-1)).

- **Durable from acceptance.** `ask` writes the turn (`queued`) and returns at
  once. The prompt is stored locally, and is never returned by views or MCP.
  `clientRequestId` makes retries idempotent; the same key with another prompt is
  refused.
- **Egress (INV-12):** before routing or sending, `ctx.egress` checks the prompt
  against the caller's `classification` (default `operator-shared`) for the
  `website` Worker class, and scans it for credentials. A denial fails the turn
  as `egress_denied` with the decision id, and nothing is sent.
- **Routing:** a persistent session stays on its account. Otherwise the turn goes
  to the first `ready` account in catalog order that has a driver. Each choice
  is a `route` decision artifact that lists why every other account was skipped.
  If no account is ready, the turn fails with `reauth_required` (`USER_ACTION`)
  and nothing is sent.
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
  - `tier` (or `defaultTier`) maps through the account's catalog `tiers` to the
    driver's mode preset, and a `tier` decision records the preset;
  - the receipt records the model and effort that were read back.
- **Deep research:** `research` starts in a new (or the given) persistent
  session and returns at once (`researchTimeoutMs`, `researchStallTimeoutMs`).
- **Sessions:**
  - a persistent session exists from acceptance and is bound to the first
    account that runs it;
  - turns of one session run in acceptance order.
- **Sign-out:** a driver `reauth_required` (it saw the login surface) marks the
  account `reauth-required`, so new turns route elsewhere.
- **MCP:** contributes `research`, `ask` (it waits up to `waitSeconds`, default 45 s, max
  55 s, then returns the `turnId`) and `result` (long-polls a `turnId`). These
  replace the built-in placeholders.
- **Injects:** `store`, `artifacts`, `leases`, `turnReceipts`, `accounts`, `browser`,
  `providers`; `mcp` is optional.
- **Not yet:**
  - one-node DAG execution on the workflow engine.
