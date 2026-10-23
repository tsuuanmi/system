# @tsuuanmi/system-accounts

**`ctx.accounts`**: a provider-agnostic, multi-account vault
([browser runtime](../../../docs/design/browser-runtime.md)).

- **Catalog:** configuration. Any number of accounts per provider, each with an id,
  provider, quota class, and a tier → mode map (P4). Each mapped tier is one
  website Worker for routing; a tier left unmapped is never served by the account.
- **Storage:** each account's `account@1.0` record, including its portable browser
  state, and its login credentials are separate **encrypted** grant records in
  `ctx.credentials` (`system-accounts/<id>`, `system-credentials/<id>`). Writes are
  guarded by revision.
- **Views:** `list`/`get` return secret-free views (INV-8). `portableState` and
  `credentials` are for the provider runtime only.
- **`setFeatures(id, names)`:** records which website features a probe proved on
  the account, and when (`account@1.1` `features`, REQ-PRV-7). The view carries
  them, and routing uses only these.
- **`saveState(id, input, expectedRevision?, { sameIdentity? })`:** stores a
  verified sign-in; the account becomes `ready`. With `sameIdentity` (an
  unattended credential relogin), a sign-in as a different account than the one
  saved is refused with `reauth_required` and nothing is stored: stored
  credentials may have been changed by a client, and only a manual Save at the
  remote login may switch accounts.
- **`refreshState(id, state, expectedRevision)`:** the turn runtime's write-back.
  It applies only to a `ready` account and keeps the identity and verification.
  At any other revision it is refused, so a Save or relogin made while a turn
  ran is never overwritten by that turn's older state.
- **Rules:**
  - `markSignedOut` needs positive evidence (`login-url` / `login-surface`).
  - `reverify` undoes a false signed-out mark: a reauth-required account whose
    saved state signs in again as the same identity is ready, verified now,
    with its state unchanged.
  - `markChallenge` keeps the state.
  - `duplicateIdentities` flags accounts that share an identity (REQ-TEAM-4).
- **How a provider's accounts are used** (`providers`, ADR-0052): each website
  provider is `assigned` (the default, and the only one for personal
  subscriptions: a limit on one account never moves its work to another account
  of that provider; the work waits) or `pooled`, which is refused at load unless
  its `pooledTerms` record who confirmed the provider's terms allow it, when,
  and which terms. `setting(provider)` gives a provider's setting (assigned when
  not listed), `pooled()` the pooled providers with their terms; the `website`
  source puts the setting on each Worker's `account` and records each pooled
  provider's terms as a `gate` decision at start
  ([assigned accounts](../../../docs/design/routing.md#assigned-accounts)).
- **Known limitation:** every read decrypts the whole vault, including every
  account's portable state. That is fine for a few accounts; caching by file
  change, or one record per file, is the next step if the catalog grows.
- **Injects:** `credentials`.
