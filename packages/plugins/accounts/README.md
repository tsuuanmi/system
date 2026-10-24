# @tsuuanmi/system-accounts

**`ctx.accounts`**: a provider-agnostic, multi-account vault
([browser runtime](../../../docs/design/browser-runtime.md)).

- **Catalog:** configuration. Any number of accounts per provider, each with an id,
  provider, quota class, and a tier → mode map (P4). Each mapped tier is one
  website Worker for routing; a tier left unmapped is never served by the account.
  An optional `description` (plain text, one line, at most 200 characters) says what its Workers
  are for; each tier's Worker shows it with its tier on the roster (`capability-descriptor@1.6`).
- **Storage:** each account's record (`account@1.1`, written on every change; one
  stored earlier reads as `account@1.0`), including its portable browser
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
- **`setCredentials(id, { email, password, totpSecret? })`:** stores the login
  credentials in their own encrypted record and switches the account to
  credential login (code providers `totp-local` and `manual` with a TOTP secret,
  else `manual`).
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
  - `duplicateIdentities` lists the groups of accounts that share an identity
    (REQ-ACC-7, REQ-TEAM-4). The website runtime takes every Worker of such an
    account out of work, and health names them
    ([turns](../turns/README.md)).
- **How a provider's accounts are used** (`providers`, ADR-0052, ADR-0055):
  each website provider is `assigned` (the default: a limit on one account never
  moves its work to another account of that provider; the work waits) or
  `pooled`, which is refused at load unless its `pooledTerms` record the
  operator's decision: who decided, when, and which terms on what basis (that
  they allow it, or, for a personal subscription, that the operator accepts the
  risk). `setting(provider)` gives a provider's setting (assigned when
  not listed), `pooled()` the pooled providers with their terms; the `website`
  source puts the setting on each Worker's `account` and records each pooled
  provider's terms as a `gate` decision at start
  ([assigned accounts](../../../docs/design/routing.md#assigned-accounts)).
- **Known limitation:** every read decrypts the whole vault, including every
  account's portable state. That is fine for a few accounts; caching by file
  change, or one record per file, is the next step if the catalog grows.
- **Injects:** `credentials`.
