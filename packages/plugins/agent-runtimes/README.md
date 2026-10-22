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
  `$CREDENTIALS_DIRECTORY`, the credential stores in the home directory
  (`CREDENTIAL_STORES`: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`,
  `~/.Xauthority`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`,
  `~/.config/gh`, `~/.config/gcloud`, `~/.docker/config.json`,
  `~/.cargo/credentials.toml`) and every coding agent's own login (`~/.claude`,
  `~/.claude.json`, `~/.codex`, `~/.gemini`, `~/.cursor`, `~/.config/github-copilot`,
  `~/.config/opencode`, `~/.local/share/opencode`): an agent runs in a home of its
  own, so it never reads another agent's credentials or the operator's; and every
  registered secret path (`secretPaths()`), plus the configured `hide` paths
  (kept as given, so a typo shows in the probe). `readOnly` (default
  `$DSH_HOME/system/tools`) and the caller's binds (its home, its workspace)
  come back. `$DSH_HOME` expands in both lists.
- **Config:** `bwrap` (default: found on PATH once, a root-owned one first),
  `hide`, `readOnly`.
- **Dependencies:** `system-libs` (`dshHome`, `secretPaths`).
- **Injects:** nothing.
