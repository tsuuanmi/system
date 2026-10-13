# @tsuuanmi/system-agent-runtimes

**`ctx.agentRuntimes`**: the agent runtime provider registry. Definition:
[`@tsuuanmi/system-agent-runtime-core`](../../agent-runtime-core/README.md).

- Providers register for their plugin's lifetime, and kinds are unique.
  Workers name a runtime by kind in configuration; nothing branches on a kind
  (INV-11).
- **Read confinement** ([ADR-0024](../../../docs/decisions/adr/0024-agent-workers-confined-for-reads.md)):
  `confinement({ readOnly, writable })` is what every agent child runs under. It
  always hides, when present, the DSH home, `$XDG_RUNTIME_DIR` (or
  `/run/user/<uid>`), `$TMPDIR`, `/tmp`, `/var/tmp`, `/dev/shm`,
  `$CREDENTIALS_DIRECTORY`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.codex`,
  `~/.Xauthority`, `~/.config/gh`, `~/.docker/config.json`, and every
  registered secret path (`secretPaths()`), plus the configured `hide` paths
  (kept as given, so a typo shows in the probe). `readOnly` (default
  `$DSH_HOME/system/tools`) and the caller's binds (its home, its workspace)
  come back. `$DSH_HOME` expands in both lists.
- **Config:** `bwrap` (default: found on PATH once, a root-owned one first),
  `hide`, `readOnly`.
- **Dependencies:** `system-libs` (`dshHome`, `secretPaths`).
- **Injects:** nothing.
