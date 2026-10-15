# Gateway compatibility

> Current state, verified against Claude Code and Codex CLI 0.162.1 on 2026-10-12.
> Design: [gateways](../design/gateways.md). Decision: [ADR-0022](../decisions/adr/0022-text-protocol-tool-calls-for-website-models.md).
> Both gateway rows are off in the default composition; this applies once one is
> [turned on](../operations/runbooks.md#turn-an-off-row-back-on).

## Anthropic Messages (`/anthropic`, Claude Code)

| Client sends | Gateway |
|---|---|
| `POST /v1/messages` with `stream: true` | SSE: `message_start`, `content_block_*` (`text_delta`, `input_json_delta`), `message_delta`, `message_stop`; `ping` while the turn runs |
| `POST /v1/messages` without `stream` | one JSON message |
| `POST /v1/messages/count_tokens` | an estimate (characters / 4) |
| `GET /v1/models` | `system-economy`, `system-standard`, `system-frontier` |
| `HEAD /` | 200 (connectivity check) |
| `system` with an `x-anthropic-billing-header` block | the block is dropped |
| a `system`-role message after the user's turn (environment, skills) | rendered as a `[system]` turn |
| `tools` | listed compactly; calls come back as `tool_use` |
| `tool_result` blocks | `TOOL_RESULT <tool> (<id>)` lines in the next turn of the same provider conversation |
| model names | `system-<tier>`, else `models` patterns (default `haiku` → economy), else standard |
| thinking requests | not answered with `thinking` blocks |

## OpenAI Responses (`/openai/v1`, Codex)

| Client sends | Gateway |
|---|---|
| `POST /v1/responses` with `stream: true` | SSE: `response.created`, `response.in_progress` (keepalive), items opened and closed, exactly one `response.completed` or `response.failed`, numbered `sequence_number` |
| `GET /v1/responses` (WebSocket) | 426, so the client uses SSE |
| `instructions` and leading `developer` messages | the agent's instructions |
| `function` tools | offered as they are; calls come back as `function_call` (arguments never `""`) |
| `custom` (freeform) tools, such as apply_patch | offered with one `input` string; calls come back as `custom_tool_call` |
| `web_search`, `image_generation`, namespaces | not offered |
| `reasoning` items, `include: reasoning.encrypted_content` | ignored |
| `prompt_cache_key` | binds the provider conversation |
| local compaction (a summary request, then a compacted history) | continues, then opens a new provider conversation |
| `/v1/responses/compact` | not served (Codex does not call it for a custom provider) |

Codex runs with `request_max_retries=0` and `stream_max_retries=0`
(`system codex-env`), because a retried request would send a website turn again.
