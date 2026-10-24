# @tsuuanmi/system-credentials-vault

A **`ctx.credentials` provider that encrypts at rest**. It implements DSH's
`dsh-credentials` seam (refs plus records), so any DSH consumer works unchanged.
It replaces `dsh-credentials-local`, which stores plain YAML
([review](../../../docs/research/dsh-community-plugins-review.md),
[ADR-0017](../../../docs/decisions/adr/0017-credential-login-and-linux-remote-browser.md)).

- **Format:** the whole document is sealed with AES-256-GCM (fresh 96-bit nonce,
  AAD `system-vault:v1`). Any tampering or a wrong key fails authentication.
  Writes are atomic: a `0600` temp file, fsync, then rename.
- **Concurrency:** an in-process queue plus DSH `withFileLock`, held across the
  whole read-modify-write, including the async `mutate` (seam contract: a
  rotating refresh token is never spent twice).
- **Disposal:** waits for in-flight mutations before wiping the key in memory,
  and refuses any write afterwards, so a write can never seal the vault under a
  wiped key.
- **Precedence:** the launch environment shadows the vault (read-only). A write
  that would be shadowed is refused.
- **Key:** a 32-byte owner-only file (`0600`, or `0400` such as a systemd
  credential), created atomically on first use (default
  `<DSH_HOME>/system/vault.key`). **Limitation:** a key stored next to the vault
  protects against copied files, backups, and log leaks, but not against an
  attacker who can read the whole account. To separate them, point `keyFile` at a
  systemd credential (`$CREDENTIALS_DIRECTORY/<name>`) or at another disk
  ([key custody](../../../docs/operations/runbooks.md#key-custody)).
- **Custody:** `custody()` reports whether the key is kept apart from the
  vault, which `status` health shows as advice.
- **Hidden from agents:** the vault file and its key are registered secret
  paths while the plugin runs, wherever they are kept ([ADR-0024](../../../docs/decisions/adr/0024-agent-workers-confined-for-reads.md)).
- **Website accounts** ([`accounts`](../accounts/README.md)) keep two `grant`
  records each: the account record, with its portable browser state, under
  `system-accounts/<accountId>`, and its login credentials (email, password,
  TOTP secret) under `system-credentials/<accountId>`.
- **Config:** `path` (default `<DSH_HOME>/system/vault.enc`), `keyFile` (default
  `<DSH_HOME>/system/vault.key`), `lockWaitMs` (the cross-process lock wait,
  default 30 s).
