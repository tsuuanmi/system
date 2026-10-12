# @tsuuanmi/system-agent-runtimes

**`ctx.agentRuntimes`**: the agent runtime provider registry. Definition:
[`@tsuuanmi/system-agent-runtime-core`](../../agent-runtime-core/README.md).

- Providers register for their plugin's lifetime, and kinds are unique.
  Workers name a runtime by kind in configuration; nothing branches on a kind
  (INV-11).
- **Injects:** nothing.
