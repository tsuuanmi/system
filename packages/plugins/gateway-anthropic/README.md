# @tsuuanmi/system-gateway-anthropic

The **Anthropic Messages gateway**, on the DSH webserver under `/anthropic`
(loopback only). Claude Code points its base URL here and uses website Workers
as its model ([gateways](../../../docs/design/gateways.md),
[ADR-0022](../../../docs/decisions/adr/0022-text-protocol-tool-calls-for-website-models.md)).

## Use

`system claude-env` prints the command:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/anthropic claude --settings '{"apiKeyHelper":"… mcp-token"}'
```

The `apiKeyHelper` reads the token for each connection, so the token is never
printed, exported, or written to Claude Code's settings.

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
- **Conversations:** a client conversation is bound to one persistent provider
  conversation by a hash of its tier, system prompt, and first message. A later
  request sends only the new suffix: tool results and new user turns.
- **Tools (text protocol):**
  - The opening turn lists the client's tools and asks for
    `<call tool="…">{arguments}</call>` tags.
  - A tag becomes a `tool_use` block only when it names a tool the request
    offered and its arguments are a JSON object. Anything else stays as text.
  - When a tooled answer has no call but claims it cannot reach the user's
    files, the gateway sends **one** nudge into the same conversation.

It does not own the tools: the client runs every call under its own sandbox
and approvals (INV-6).

## Security

The guard matches the MCP endpoint's:

- a loopback `Host`;
- no browser `Origin`;
- the MCP bearer token (as `Authorization: Bearer` or `x-api-key`), compared
  in constant time.

## Not yet

- The Responses gateway (Codex).
- A shared turn broker with MCP tool inversion.
- `thinking` blocks, and drain/admin routes.
