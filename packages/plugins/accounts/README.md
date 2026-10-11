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
- **`refreshState(id, state, expectedRevision)`:** the turn runtime's write-back.
  It applies only to a `ready` account and keeps the identity and verification.
- **Rules:**
  - `markSignedOut` needs positive evidence (`login-url` / `login-surface`).
  - `markChallenge` keeps the state.
  - `duplicateIdentities` flags accounts that share an identity (REQ-TEAM-4).
- **Known limitation:** every read decrypts the whole vault, including every
  account's portable state. That is fine for a few accounts; caching by file
  change, or one record per file, is the next step if the catalog grows.
- **Injects:** `credentials`.
