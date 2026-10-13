# @tsuuanmi/system-agent-runtimes

**`ctx.agentRuntimes`**: the agent runtime provider registry. Definition:
[`@tsuuanmi/system-agent-runtime-core`](../../agent-runtime-core/README.md).

- Providers register for their plugin's lifetime, and kinds are unique.
  Workers name a runtime by kind in configuration; nothing branches on a kind
  (INV-11).
- **Read confinement** ([ADR-0024](../../../docs/decisions/adr/0024-agent-workers-confined-for-reads.md)):
  `confinement(writable)` is what every agent child runs under. It always hides
  the DSH home and `$CREDENTIALS_DIRECTORY`, plus the configured `hide` paths;
  `readOnly` (default `$DSH_HOME/system/tools`) and the caller's `writable` (its
  own home) come back. `$DSH_HOME` expands in both lists.
- **Config:** `bwrap` (default `bwrap`), `hide`, `readOnly`.
- **Dependencies:** `system-libs` (`dshHome`).
- **Injects:** nothing.
