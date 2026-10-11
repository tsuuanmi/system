# Gateways

> Target state. Boundary: [gateways](../architecture/components.md#gateways).
> Requirements: REQ-GW-1..4, REQ-HOST-1, REQ-HOST-3. Security: [threat model](../security/threat-model.md).

## Responses gateway

An OpenAI Responses-compatible HTTP endpoint on loopback.

- **Routes:** `GET /v1/models`, `POST /v1/responses` (SSE), `POST
  /v1/responses/compact`, `GET /healthz`, plus `/admin/*` (drain, resume,
  cancel, interrupt, shutdown).
- **Transport:** a WebSocket upgrade attempt on `/v1/responses` receives HTTP 426,
  which makes clients fall back to SSE. Any non-GET request with an `Origin` header
  is rejected, which closes the browser-to-loopback path.
- **Authentication:** every route except `/healthz` requires a bearer token from
  the host's credential file. This differs from codex-chatgpt-web, which left its
  Responses route open.
- **Model catalog:** `system` Workers appear as models with measured context
  windows and composer budgets. A request that exceeds the budget fails during
  preflight, before a provider turn opens.
- **State:** `previous_response_id` is served from a bounded local cache, bounded
  by entries, age, and bytes.
- **Event mapping:** provider status rows become reasoning summaries, prose becomes
  output text, and tool requests become `function_call` items. The final text must
  equal the streamed deltas.

## MCP tool inversion

A remote Worker, such as a web model, can use the *client's* tools, while the
client keeps its own sandbox and approvals (REQ-GW-2):

1. Each turn prompt embeds a random **turn token**. The MCP server accepts tool
   calls only with a live token, and only for tools the current client turn
   advertised.
2. The **turn broker** (a private Unix socket or named pipe between the MCP server
   process and the host) queues the call.
3. **Causal barrier:** before tools are emitted, the provider runtime checkpoints
   the response text produced so far.
4. The gateway ends the current client response with `function_call` items.
5. The client runs the tools and sends `function_call_output`. The gateway requires
   the result count to equal the outstanding count.
6. The broker completes the calls, and the MCP calls return inside the **same**
   remote turn. One remote turn can therefore span many client requests.
7. **Two-phase completion fence:** the turn completes only on a new, stable final
   answer produced after the last checkpoint, observed under a monotonic
   `activityRevision` that tool activity advances.

## Authority

Filesystem scope, working directory, and sandbox mode come only from the client's
native envelope or from operator configuration. Text such as
`<environment_context>` inside a prompt is data, never authority
([INV-6](../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes)).

## Client configuration edits

When the host configures a client, for example by pointing Codex's provider base
URL at the gateway, the edit is surgical and preserves formatting. It is journaled
with the previous bytes, and restored byte for byte on disconnect (REQ-HOST-3).

## Drain

`/admin/drain` stops admitting new work, then waits until both the in-flight HTTP
request count and the active provider-turn count reach zero, or until the drain
deadline expires. Stop and upgrade always drain first (REQ-HOST-1).

## MCP server (capabilities)

Separately from the per-turn bridge, the MCP server exposes `system` capabilities
(chat, research, team, workflow control) as native MCP tools to any MCP client.
