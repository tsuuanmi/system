# @tsuuanmi/system-mcp-server

An MCP Streamable HTTP endpoint inside the `system` profile, on DSH
`ctx.webServer`, published as **`ctx.mcp`**. It serves Claude Code, Codex, and
the `system` CLI
([ADR-0011](../../../docs/decisions/adr/0011-mvp-integration-via-mcp.md)).

- **Security:** the request guard every client endpoint shares
  ([`gateway-core`](../../gateway-core/README.md#the-request-guard)):
  - Host allow-list: `421` otherwise, which blocks DNS rebinding.
  - No browser origins: `403`, and no CORS.
  - Bearer token compared in constant time over SHA-256 digests: `401` otherwise.
  - Plain HTTP on a non-loopback host is refused (`assertSafeBind`).
  - 1 MiB body limit (`maxBodyBytes`).
- **Discovery:** writes `{url, tokenFile, pid}` to a `0600` file (default
  `<DSH_HOME>/system/mcp.json`) and removes it on unload. This pattern comes from
  dsh-codex-bridge.
- **Tools contributed by plugins:** `ctx.mcp.tool(name, { description,
  inputSchema }, handler)` registers a tool for the calling plugin's lifetime, so
  unloading the plugin removes it. A name is unique, except that a built-in
  placeholder may be replaced. For example, `login` contributes `account_list`
  and `account_save`.
- **Built-in tools (slice 1 surface):**
  - `status` reports the stage, store, artifacts, kernel seams, and registered
    providers.
  - `ask`, `research`, and `result` are placeholders. When `ctx.workflow` is
    mounted (it is in the `system` bundle), the engine's tools replace them.
    Otherwise they return an explicit "not installed" error and never pretend to
    work.
- **Injects:** `webServer`. It uses `ctx.get('artifacts')`, `ctx.get('store')`,
  and `ctx.get('providers')` optionally.
