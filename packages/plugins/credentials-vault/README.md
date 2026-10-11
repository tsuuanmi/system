# @tsuuanmi/system-credentials-vault

A **`ctx.credentials` provider that encrypts at rest**. It implements DSH's
`dsh-credentials` seam (refs plus records), so any DSH consumer works unchanged.
It replaces `dsh-credentials-local`, which stores plain YAML
([review](../../../docs/research/dsh-community-plugins-review.md),
[ADR-0017](../../../docs/decisions/adr/0017-credential-login-and-linux-remote-browser.md)).

- **Format:** the whole document is sealed with AES-256-GCM (fresh 96-bit nonce,
  AAD `system-vault:v1`). Any tampering or a wrong key fails authentication.
  Writes are atomic: a `0600` temp file, fsync, then rename.
- **Concurrency:** an in-process queue plus an `O_EXCL` lock file.
  `modifyRecord` re-checks under the lock, so concurrent writers lose no update.
- **Precedence:** the launch environment shadows the vault (read-only). A write
  that would be shadowed is refused.
- **Key:** a 32-byte `0600` file, created on first use (default
  `<DSH_HOME>/system/vault.key`). **Limitation:** a key stored next to the vault
  protects against copied files, backups, and log leaks, but not against an
  attacker who can read the whole account. To separate them, point `keyFile` at a
  systemd credential (`$CREDENTIALS_DIRECTORY/<name>`) or at another disk.
- **Account credentials** (email, password, TOTP secret) are stored as a
  `grant` record under `system-accounts/<accountId>`.
