# @tsuuanmi/system-gateway-anthropic

The **Anthropic Messages gateway**, on the DSH webserver under `/anthropic`
(loopback only). Claude Code points its base URL here and uses website Workers
as its model ([gateways](../../../docs/design/gateways.md),
[ADR-0022](../../../docs/decisions/adr/0022-text-protocol-tool-calls-for-website-models.md)).

## Use

`system claude-env` prints the command:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/anthropic claude --settings '{"apiKeyHelper":"… mcp-token --scope model"}'
```

The `apiKeyHelper` reads the model token for each connection, so the token is
never printed, exported, or written to Claude Code's settings.

## What it owns

- **Routes:**
  - `POST /v1/messages`, as JSON or SSE;
  - `POST /v1/messages/count_tokens`, an estimate;
  - `GET /v1/models`, which lists `system-economy`, `system-standard`, and
    `system-frontier`.
- **Tiers:** a model name maps to a tier.
  - `system-<tier>` names the tier directly.
  - Otherwise the `models` patterns apply (default: `haiku` → `economy`).
  - Anything else gets `standard`.
- **Runs:** each request is an `ask` run on the workflow engine. It is routed,
  egress-checked at the configured `classification`, receipted, and
  explainable.
- **Mapping:** Messages maps to the neutral turns of
  [`gateway-turns`](../../gateway-turns/README.md), which owns the
  conversation binding, the text tool protocol, and the one nudge.
  - A conversation is keyed by a hash of its tier, system prompt, and first
    message. Two clients with the same opening share a key, but each resumes
    only the conversation its own history came from.
  - A `tool_use` id (`toolu_…`) labels its `tool_result` in the next turn.

It does not own the tools: the client runs every call under its own sandbox
and approvals (INV-6).

## Security

- **Guard:** the request guard every client endpoint shares
  ([`gateway-core`](../../gateway-core/README.md#the-request-guard), through
  [`gateway-turns`](../../gateway-turns/README.md)): a loopback `Host`, no
  browser `Origin`, and the model token (`model.token` under `tokenDir`) as a
  bearer token or `x-api-key`, compared in constant time. An operator or client
  token gets `401` ([scopes](../mcp-server/README.md#scopes)).
- **Bind:** on plain HTTP on a non-loopback host, the route is not registered
  (`assertSafeBind`).
- **Body:** at most 16 MiB of JSON.

## Not yet

- A shared turn broker with MCP tool inversion.
- `thinking` blocks, and drain/admin routes.
