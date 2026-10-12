# @tsuuanmi/system-gateway-core

Gateway **seam definitions**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2),
and the **request guard** every client endpoint shares.

| Seam | Definition | Provider |
|---|---|---|
| `ctx.mcp` | abstract `McpTools` with `tool(name, spec, handler)`, plus `ToolSpec` and `ToolHandler` | `@tsuuanmi/system-mcp-server` |

Plugins that contribute tools depend on this package only, so the
provider-runtime layer never imports the gateway's implementation:

| Contributor | Tools |
|---|---|
| `login` | `account_list`, `account_login`, `account_set_credentials`, `account_relogin`, `account_code`, `account_save` |
| `turns` | `account_probe` |
| `workflow` | `ask`, `research`, `run`, `approve`, `stop`, `drain`, `resume`, `continue`, `delete`, `supersede`, `result`, `usage`, `explain` |
| `worker-sessions` | `session_send`, `session_inbox` |
| `mcp-server` itself | `status` |

The exact contracts are in [MCP tools](../../docs/reference/mcp-tools.md). The client-protocol
gateways are plain plugins and use no seam; they share the
[`gateway-turns`](../gateway-turns/README.md) library. The
conformance suite is [`conformance/mcp-tools.ts`](conformance/mcp-tools.ts).

## The request guard

`guard.ts` holds the one set of transport checks for every client endpoint: the
MCP endpoint, both protocol gateways (through
[`gateway-turns`](../gateway-turns/README.md)), and the web UI
([threat model](../../docs/security/threat-model.md)).

- **`guardRequest(req, options)`**, in order:
  - a `Host` on the allow-list (default `LOOPBACK_HOSTS`: `127.0.0.1`,
    `localhost`, `[::1]`), or `421`, against DNS rebinding;
  - no browser `Origin`, or `403`, so no CORS. Only `sameOrigin` (the web UI,
    which serves its own page) accepts the endpoint's own origin;
  - the bearer token compared in constant time over SHA-256 digests, or `401`.
    `x-api-key` is accepted only with `apiKeyHeader` (Anthropic clients). An
    empty token never matches.
- **`assertSafeBind(bound)`** throws on plain HTTP on a non-loopback host, so
  the token never travels in clear text over a network. Every endpoint calls it
  before it registers its route.
- **`endpointUrl(bound, path)`** builds the URL from the bound protocol, host
  (IPv6 bracketed), and port.
- **`readJsonBody(req, maxBytes)`** reads a bounded JSON body: empty is
  `undefined`, invalid is `400`, too large is `413`.

Tests: `tests/guard.spec.ts`.
