# @tsuuanmi/system-turns

**`ctx.turns`**: the website turn runtime, MVP slice 1 `ask`
([provider turns](../../../docs/design/provider-turns.md#runtime-mvp-slice-1)).

- **Durable from acceptance.** `ask` writes the turn (`queued`) and returns at
  once. The prompt is stored locally, and is never returned by views or MCP.
  `clientRequestId` makes retries idempotent; the same key with another prompt is
  refused.
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
- **Completion:**
  - one transaction binds the conversation and completes the receipt;
  - the answer becomes a `report` artifact (`provider-answer@1.0`,
    `local-private`) linked to the route decision.
- **Restart:**
  - `queued` turns run again;
  - a `running` turn with no receipt was never sent, so it runs again;
  - a `running` turn **with** a receipt is not resent. It fails with
    `reconciliation_failed`, because recovering it needs a conversation
    snapshot and a temporary conversation cannot be reopened.
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
- **Injects:** `store`, `artifacts`, `turnReceipts`, `accounts`, `browser`,
  `providers`; `mcp` is optional.
- **Not yet:**
  - recovering a submitted persistent turn from its conversation;
  - state write-back after a turn;
  - one-node DAG execution on the workflow engine.
