# @tsuuanmi/system-mcp-server

An MCP Streamable HTTP endpoint inside the `system` profile, on DSH
`ctx.webServer`, published as **`ctx.mcp`**. It serves Claude Code, Codex, and
the `system` CLI
([ADR-0011](../../../docs/decisions/adr/0011-mvp-integration-via-mcp.md)).

- **Security:** the request guard every client endpoint shares
  ([`gateway-core`](../../gateway-core/README.md#the-request-guard)):
  - Host allow-list: `421` otherwise, which blocks DNS rebinding.
  - No browser origins: `403`, and no CORS.
  - The operator or client token compared in constant time over SHA-256
    digests: `401` otherwise, the model token included
    ([scopes](#scopes)).
  - Plain HTTP on a non-loopback host is refused (`assertSafeBind`).
  - 1 MiB body limit (`maxBodyBytes`).
- **Discovery:** writes `{url, tokenFiles: {operator, client, model}, pid}` to a
  `0600` file (default `<DSH_HOME>/system/mcp.json`) and removes it on unload.
  This pattern comes from dsh-codex-bridge.
- **Tools contributed by plugins:** `ctx.mcp.tool(name, { description,
  inputSchema, scope }, handler)` registers a tool for the calling plugin's
  lifetime, so unloading the plugin removes it. A name is unique, except that a
  built-in placeholder may be replaced. For example, `login` contributes
  `account_list` and `account_save`.
- **Built-in tools (slice 1 surface), all `client` scope:**
  - `status` reports the stage, store, artifacts, kernel seams, and registered
    providers.
  - `ask`, `research`, and `result` are placeholders. When `ctx.workflow` is
    mounted (it is in the `system` bundle), the engine's tools replace them.
    Otherwise they return an explicit "not installed" error and never pretend to
    work.
- **Injects:** `webServer`. It uses `ctx.get('artifacts')`, `ctx.get('store')`,
  and `ctx.get('providers')` optionally.

## Scopes

Every client endpoint authorizes by the token it is shown
([ADR-0023](../../../docs/decisions/adr/0023-scoped-control-credentials.md)).
Each scope has an owner-only token file under `tokenDir` (default
`<DSH_HOME>/system`) holding 32 random bytes, used as base64url
(`scopeTokens` and `tokenFile` in
[`gateway-core`](../../gateway-core/README.md#the-request-guard)). This
endpoint creates all three at start, so the CLI and its helpers find them, and
it refuses to start if two files hold the same token (a copied file would hand
one scope another's rights).

| Scope | Token file | Reaches | Handed out by |
|---|---|---|---|
| `operator` | `operator.token` | every MCP tool, and `/ui` | the `system` CLI's own tool calls, `system ui` |
| `client` | `client.token` | the client tools on `/mcp`: `ask`, `research`, `run`, `result`, `status`, `explain`, `usage`, `session_send`, `session_inbox` | `system mcp-headers` (Claude Code), `system mcp-stdio` (Codex) |
| `model` | `model.token` | `/anthropic` and `/openai` only; `/mcp` and `/ui` answer `401` | `system claude-env`, `system codex-env`, `system mcp-token --scope model` (a Codex Worker on the Responses gateway) |

- **Tool scope:** a tool declares `scope: 'client' | 'operator'` in its
  `ToolSpec`. A tool that declares none is the operator's (fail closed), so
  `approve`, `stop`, `continue`, `delete`, `supersede`, `drain`, `resume`, and
  every `account_*` tool, `account_probe` included, are operator-only.
- **Listing:** `tools/list` returns only the tools the caller's scope may use,
  each with `_meta: { "system/scope": … }`. The operator sees every tool.
- **Handlers** are told the caller's scope (`ToolContext`), so what a tool
  records can name who acted.
- **Calls:** a `tools/call` of a registered tool outside the caller's scope,
  also inside a JSON-RPC batch, is refused before the MCP server runs: `403`,
  `WWW-Authenticate: Bearer error="insufficient_scope", scope="operator"`, and
  the JSON body `{ "error": "insufficient_scope", "error_description": … }`.
- **Rotation:** delete the scope's token file and restart
  ([runbook](../../../docs/operations/runbooks.md#rotate-a-control-token)).
