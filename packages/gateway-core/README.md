# @tsuuanmi/system-gateway-core

Gateway **seam definitions**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.mcp` | abstract `McpTools` with `tool(name, spec, handler)`, plus `ToolSpec` and `ToolHandler` | `@tsuuanmi/system-mcp-server` |

Plugins that contribute tools (`login`, `turns`) depend on this package only, so
the provider-runtime layer never imports the gateway's implementation. The
conformance suite is [`conformance/mcp-tools.ts`](conformance/mcp-tools.ts).
