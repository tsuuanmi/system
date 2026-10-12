# Gateways

> Target state. Boundary: [gateways](../architecture/components.md#gateways).
> Requirements: REQ-GW-1..5, REQ-HOST-1, REQ-HOST-3. Security: [threat model](../security/threat-model.md).
> Decision: [ADR-0009](../decisions/adr/0009-claude-and-codex-first-class.md).

Gateways are consumer plugins at the edge. The two **client-protocol gateways**,
Responses for Codex and Anthropic Messages for Claude Code, are providers of one
seam, `ctx.clientProtocols`. They share the turn broker, the model catalog, the
authentication, the drain logic, and the tool-inversion mechanics described
below. Each one owns only its wire format.

## Responses gateway (Codex)

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

## Anthropic Messages gateway (Claude Code)

An Anthropic Messages-compatible HTTP endpoint on the same loopback listener.

- **Routes:** `POST /v1/messages` (SSE), `POST /v1/messages/count_tokens`, and
  `GET /v1/models`. The admin, authentication, and Origin rules are the same as
  for the Responses gateway.
- **Client setup:** Claude Code is pointed at the gateway by its base-URL and
  auth-token settings. The edit is journaled like every client configuration edit.
- **Event mapping:** provider status rows become `thinking` blocks when the client
  requested thinking (otherwise they are omitted), prose becomes `text` blocks,
  and tool requests become `tool_use` blocks. The final text must equal the
  streamed deltas.
- **Conversation state:** Messages is stateless, because the client resends
  history. The gateway binds a client conversation to a provider conversation by
  a hash of the stable history prefix. A retained provider chat receives only
  the new suffix, the same way a Responses `previous_response_id` chain does.

### Built so far (M5)

`@tsuuanmi/system-gateway-anthropic` serves the Messages routes under
`/anthropic`, and `@tsuuanmi/system-gateway-responses` serves the Responses
routes under `/openai` ([source READMEs](../../packages/plugins/gateway-responses/README.md)).
They share one implementation of everything except the wire format:
[`@tsuuanmi/system-gateway-turns`](../../packages/gateway-turns/README.md) holds
the text tool protocol, the threads bound to provider conversations, and the
guard.

They differ from the target in four ways:

- **Tools use a text protocol** ([ADR-0022](../decisions/adr/0022-text-protocol-tool-calls-for-website-models.md)),
  not MCP inversion.
- **The client setup is not journaled:** `system claude-env` and
  `system codex-env` print a command that reads the token through a helper or
  subshell.
- **Status rows are omitted,** rather than mapped to `thinking` blocks or
  reasoning summaries.
- **There is no remote compaction route.** Codex compacts locally for a custom
  provider (observed against a fake provider). Its summary request continues the
  bound conversation, and the compacted history, which has no assistant turn,
  opens a new one.
- **Drain is not an `/admin` route.** It is an engine operation that every entry
  point shares (see [Drain](#drain)).

Each request is an `ask` run, so it is routed, egress-checked, and explainable
like any other run.

Verified live on 2026-10-12, on ChatGPT (`standard`), with both Claude Code and
Codex: a read, edit, and answer loop that fixed a bug in a file, with its
indentation intact.

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
4. The gateway ends the current client response with the client's native
   tool-call items: `function_call` for Responses, or `tool_use` with
   `stop_reason: tool_use` for Messages.
5. The client runs the tools and sends the results (`function_call_output` or
   `tool_result`). The gateway requires the result count to equal the
   outstanding count.
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

When the host configures a client, for example by pointing Codex's model
provider or Claude Code's base URL at the gateway, the edit is surgical and preserves formatting. It is journaled
with the previous bytes, and restored byte for byte on disconnect (REQ-HOST-3).

## Drain

`/admin/drain` stops admitting new work, then waits until both the in-flight HTTP
request count and the active provider-turn count reach zero, or until the drain
deadline expires. Stop and upgrade always drain first (REQ-HOST-1).

**Built:** every entry point (gateways, MCP, CLI) admits work through
`workflow.start`, so drain lives in the engine.
- `drain()` admits no new run, which answers as `overloaded` (a gateway returns
  529 or `response.failed`), and reports the runs still executing. `resume()`
  undoes it.
- Both are MCP tools. `system drain` and `system shutdown` poll `drain` until
  nothing is executing or the deadline passes. `shutdown` then sends SIGTERM to
  the profile and waits for it to exit.
- A gateway request ends with its run, so the HTTP count follows the run count.
- Runs still executing at the deadline are durable, and resume on the next
  start (REQ-WF-4).

Verified live on 2026-10-12:
- a drain waited for a running `ask`;
- a new `ask` during the drain was refused;
- `resume` admitted runs again;
- `shutdown` stopped the profile.

## MCP server (capabilities)

Separately from the per-turn bridge, the MCP server exposes `system` capabilities
(chat, research, team, workflow control) as native MCP tools to any MCP client.
