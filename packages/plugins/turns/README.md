# @tsuuanmi/system-turns

**`ctx.turns`**: the website turn runtime: the website Worker's owning runtime,
invoked by the [workflow engine](../workflow/README.md)
([provider turns](../../../docs/design/provider-turns.md#runtime-mvp-slice-1)).

- **The `website` Worker source.**
  - **Describe:** one Worker `worker:<account>/<tier>` per account and per tier
    its catalog maps to a mode preset. It proves what the account's driver
    declares, in a state taken from the account's status. A tier mapped to a
    preset the driver does not have (the driver's `modes`) is `unavailable`, and so
    is every Worker of an account signed in as the same person as another catalog
    entry (`ctx.accounts.duplicateIdentities()`, REQ-ACC-7): both entries, since
    neither is a distinct account; a turn routed before that fails
    `reauth_required` before anything is sent, and health names them. Its
    provider family (`capability-descriptor@1.1`) is the account's provider. Its
    `load` (`@1.3`, ADR-0033) is the account's turns running and queued, its
    routes not started yet (`reserve`), and `maxConcurrentTurnsPerAccount` as its
    slots; a ready account with every slot running reads `busy`.
  - **Cooldowns (ADR-0034).** A turn that fails `quota_exhausted` (a site's usage
    limit, recognized by a UI-map error rule) cools its account in table
    `turn_cooldowns`: the rule's `feature` for `featureLimitCooldownMs`, else the
    whole account (`*`) for `accountLimitCooldownMs`. A cooled feature is listed in
    the Workers' `cooldowns`; a cooled account reads `quota-exhausted`. A completed
    turn ends its feature's cooldown, and the operator ends one with
    `account_clear_cooldown` (`account_cooldowns` lists them). Events
    `account.cooldown`, `account.cooldown-cleared`. The account's status is never
    touched.
  - **Run:** `start`, `get`, and `wait` run turns. The engine routes; a turn
    never routes itself.
  - **Affinity:** a session stays on the account it is bound to, once a turn of
    it was sent, is under way, or it has a conversation. A session whose turns
    all failed before sending holds no account: its next turn may run on another
    (unsent failover, ADR-0034), and the tab the first account kept for it closes.
- **Durable from acceptance.** `ask(WorkerStart)` writes the turn (`queued`) on
  the admitted Worker and returns at once.
  - The turn takes its feature from the requirement's capabilities
    (`deep-research`), its tier from the Worker, and the route and tier
    decisions from the caller.
  - A session id is opened on first use and bound to the Worker's account.
  - The request `key` makes it idempotent; the same key with another prompt is
    refused.
  - The prompt is stored locally, and is never returned by views or MCP.
- **Briefs:** a start that names a `brief@1.x` is rendered here, at start, with the default
  text rendering, each pointer replaced by its artifact's text
  ([briefs](../../../docs/design/workflow-engine.md#briefs)); a brief that cannot be rendered
  refuses the turn as `invalid_input`, nothing sent. The rendered prompt is the turn's prompt.
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
- **Where an operation runs:** every page the runtime opens goes through one helper.
  That covers turns, reconciliation, verify, probe, the sign-in check, and
  conversation inspection and deletion. For a session-bound driver
  ([ADR-0030](../../../docs/decisions/adr/0030-session-bound-accounts-use-their-login-profile.md)),
  the page is in the account's login profile (`ctx.login.profileDir`), spaced by
  the driver's `pageGapMs`, and across all accounts of its provider by
  `providerPageGapMs` (default 3 s, PROP-0007: they share the host's address),
  with nothing written back. For any other driver, it
  is a fresh context from the portable state.
- **Kept tabs** ([ADR-0030](../../../docs/decisions/adr/0030-session-bound-accounts-use-their-login-profile.md)'s
  amendment): a session-bound account's persistent session keeps its page between turns.
  - Once the answer is in, the page is kept if the driver reports it idle and clean
    (`pageIdle`), otherwise discarded. This happens before the turn completes, so the session's
    next turn finds it. A commit that fails takes it back.
  - The page follows the turn's abort only until the answer is in.
  - A failed turn discards its page.
  - Releasing or resetting a session closes its tab.
- **Write-back:** before completing, the turn captures the browser state for the
  driver's origins and stores it with `accounts.refreshState`. A session-bound
  account has no copy to refresh. This happens only
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
  - `checkSignIn(account)` checks a ready account's sign-in on its scheduler,
    with its saved state, sending nothing. Positive signed-out evidence marks
    it reauth-required (event `account.signed-out`), so health shows it before
    a turn finds it. Signed in, the state the site refreshed is written back as
    after a turn (revision and scheduler slot current), so an idle account's
    session does not age out; unknown changes nothing. It runs in the background
    every `authCheckMs` (default 6 h; 0: never) for ready accounts whose feature
    probe is still fresh. The first one comes within one interval after start, at
    an offset derived from the account id, so the accounts' checks spread over the
    interval (PROP-0007). Background probes and checks run one at a time.
  - `verify(account)` re-verifies a reauth-required account on its scheduler:
    it opens the site with the saved state, sends nothing, runs `checkAuth`
    and `identity`, and if the state signs in as the saved account,
    `accounts.reverify` marks it ready (event `account.re-verified`). Nothing
    is saved or written back (MCP `account_verify`, `system account verify`).
  - A requirement with `web-search` runs with Web search turned on.
- **Deep research:** a requirement with `deep-research` runs as Deep research in
  its persistent session (`researchTimeoutMs`, `researchStallTimeoutMs`).
- **Conversation ledger (REQ-PRV-8, [design](../../../docs/design/provider-turns.md#conversation-ledger)):**
  - `bind` records every conversation in `turn_conversations`, in the turn's
    fenced transaction ([`ledger.ts`](src/ledger.ts)); a temporary chat is
    `kept`.
  - The source's `release(sessions, reason)` makes their live conversations
    `due`, as one `retention` decision (rule `turns.conversation-retention`),
    clears the sessions' bindings, and starts a deletion pass. A released
    session's next turn fails as `conversation_lost`, unsent. Passes also run at start and hourly, one at a
    time.
  - A pass deletes each due conversation under the lease
    `conversation:<account>:<binding>`, on the account's scheduler with
    `runExclusive`, through the driver's `deleteConversation`. A driver without
    it, a feature outside its `deletes`, or a removed account keeps the
    conversation, with why. A signed-out account leaves it due. Three failed
    attempts make it `failed` (health `conversations`). Events:
    `conversation.released`, `.deleted`, `.delete-retried`, `.delete-failed`.
  - `inspectConversation(account, binding)` stores the driver's read-only
    outlines of a recorded conversation as local-private evidence (event
    `conversation.inspected`).
- **Sessions:**
  - the caller issues session ids; a session is bound to the account of its
    first turn;
  - turns of one session run in acceptance order, **decided by the store**, not
    by this process's memory: a later turn waits (looked at again every second)
    while an earlier turn of its session is `queued` or `running`, including one
    whose lease a crashed process still holds. So it never answers into a
    conversation that is not reconciled yet; otherwise, after a quick restart,
    a turn could be recorded with the next turn's answer.
- **A failure on a signed-out page:** a turn that fails after its page opened, as
  `provider_stalled`, `timeout`, `session_broken`, or `ui_drift`, has its page checked as it
  stands (`checkAuth`, at most 15 s, never loaded again). Positive sign-out evidence turns the
  failure into `reauth_required`, which marks the account signed out (below); a challenge, into
  `challenge`. An unclear page keeps the original failure.
- **Challenge:** a driver `challenge` (a CAPTCHA, an unusual-traffic check, a terms notice) from
  a turn, a sign-in check, or a feature probe marks the account `challenge`
  (event `account.challenged`): its Workers are unavailable, so nothing loads the
  site again until the operator passes the check in the login profile and saves
  the account. A background feature probe or sign-in check that waited for the
  account's slot checks again once it has it, so one queued behind the turn that
  found the check loads nothing.
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
  generating is not taken. The cancel is recorded first (`cancel_requested_at`),
  so a turn this process does not hold now, held by another owner or caught by a
  restart before the abort landed, fails as `aborted` when it next starts. It is
  never reconciled or resent.
- **Stop:** a stopped runtime starts nothing. A turn caught before scheduling
  stays queued for the next start.
- **Injects:** `store`, `artifacts`, `leases`, `egress`, `turnReceipts`, `accounts`,
  `browser`, `providers`, `workers`. `mcp` and `login` are optional. `login` is used for
  credential relogin, and a session-bound account needs it for its profile path.
- **MCP:** `account_verify`, `account_probe`, `conversation_list`, and
  `conversation_inspect` (operator); the workflow engine serves `ask`,
  `research`, and `result` as runs.
