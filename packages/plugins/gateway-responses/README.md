# @tsuuanmi/system-gateway-responses

The **OpenAI Responses gateway**, on the DSH webserver under `/openai` (loopback
only). Codex selects a custom model provider whose base URL is here, and uses
website Workers as its model ([gateways](../../../docs/design/gateways.md),
[ADR-0022](../../../docs/decisions/adr/0022-text-protocol-tool-calls-for-website-models.md)).

## Use

`system codex-env` prints the command:

```sh
SYSTEM_MCP_TOKEN="$(… mcp-token)" codex -c model_provider=system \
  -c 'model_providers.system={name="system",base_url="http://127.0.0.1:<port>/openai/v1",env_key="SYSTEM_MCP_TOKEN",wire_api="responses",request_max_retries=0,stream_max_retries=0,stream_idle_timeout_ms=900000}' \
  -m system-standard
```

- The token reaches Codex only through `env_key`, set in a subshell, so it is
  never printed.
- Codex's retries are off: a retried request would send a website turn again.

## What it owns

- **Routes:**
  - `POST /v1/responses`, as JSON or SSE;
  - `GET /v1/models`, which lists `system-<tier>`;
  - `GET /v1/responses`, which answers 426, so Codex uses SSE rather than
    WebSocket;
  - `GET /healthz`.
- **Mapping:** Responses input maps to the neutral turns of
  [`gateway-turns`](../../gateway-turns/README.md).
  - Instructions, and developer messages before the first user message, become
    the agent's instructions.
  - `function_call`, `custom_tool_call`, and their outputs are replayed.
  - Reasoning and hosted-tool items are not.
- **Tools:**
  - function tools are offered as is;
  - freeform `custom` tools (apply_patch) take one `input` string and come back
    as `custom_tool_call`;
  - hosted tools (`web_search`) and namespaces are not offered.
- **Binding:** Codex's `prompt_cache_key` (its thread id) binds a conversation.
  Without one, the stable prefix does.
- **Events:**
  - The stream starts with `response.created`. While the turn runs,
    `response.in_progress` is the keepalive.
  - Each item is opened and closed (`output_item.added` … `.done`).
  - The stream ends with exactly one terminal event: `response.completed`
    (numeric usage) or `response.failed`.
  - `sequence_number` counts up from 0.

## Security

- **Guard:** the request guard every client endpoint shares
  ([`gateway-core`](../../gateway-core/README.md#the-request-guard), through
  [`gateway-turns`](../../gateway-turns/README.md)): a loopback `Host`, no
  browser `Origin`, and the MCP token as a bearer token, compared in constant
  time.
- **Bind:** on plain HTTP on a non-loopback host, the route is not registered
  (`assertSafeBind`).
- **Body:** at most 16 MiB of JSON.

## Compaction

Codex compacts locally for a custom provider. Its summary request continues the
bound conversation. The compacted history has no assistant turn, so it opens a
new provider conversation. There is no `/v1/responses/compact` route.

## Not yet

- Namespace tools (multi-agent).
- Reasoning summaries, and drain/admin routes.
