# @tsuuanmi/system-mcp-server

An MCP Streamable HTTP endpoint inside the `system` profile, on DSH
`ctx.webServer`, for Claude Code and Codex
([ADR-0011](../../../docs/decisions/adr/0011-mvp-integration-via-mcp.md)).

- **Security:**
  - Host allow-list: `421` otherwise, which blocks DNS rebinding.
  - No browser origins: `403`, and no CORS.
  - Bearer token compared in constant time over SHA-256 digests: `401` otherwise.
  - 1 MB body limit.
- **Discovery:** writes `{url, tokenFile, pid}` to a `0600` file (default
  `<DSH_HOME>/system/mcp.json`) and removes it on unload. This pattern comes from
  dsh-codex-bridge.
- **Tools (slice 1 surface):**
  - `status` works today.
  - `ask`, `research`, and `result` return an explicit "not installed" error
    until the provider runtime lands (M1.5). They never pretend to work.
- **Injects:** `webServer`. It uses `ctx.get('artifacts')` and `ctx.get('store')`
  optionally.
