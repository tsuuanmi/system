# ADR-0022: Website models reach a client's tools through a text protocol in the turn

- **Status:** Accepted
- **Date:** 2026-10-12
- **Related:** [ADR-0009](0009-claude-and-codex-first-class.md),
  [gateways](../../design/gateways.md#mcp-tool-inversion),
  [INV-6](../../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes)

## Context

The gateways let Claude Code and Codex use a website model *as their model*.
The model must therefore be able to call the client's tools (REQ-GW-2).

The [gateway design](../../design/gateways.md#mcp-tool-inversion) plans **MCP
tool inversion**. The web model calls tools through a website connector that
reaches the local MCP server. A turn broker turns those calls into the client's
native tool calls, and returns the results inside the same remote turn.

That path needs two things that cannot be built or verified on the development
host:

- an account feature (custom connectors);
- an endpoint the provider can reach.

A web model *can* follow instructions in its turn, and its answer is read back
as text.

## Options

1. Wait for connector-based MCP inversion before shipping a gateway.
2. **A text protocol in the turn.** The turn lists the client's tools. The model
   answers with `<call tool="…">{<arguments>}</call>` tags. The gateway turns
   them into native tool calls (`tool_use` for Messages, `function_call` for
   Responses). The client's results go back as the next turn of the same
   provider conversation.
3. Answer text only, with no tools.

## Decision

Option 2 now. MCP tool inversion remains the target, for accounts and hosts that
can support it.

- **Authority does not move.** The model text only *proposes* a call. The client
  runs every tool under its own sandbox and approvals (INV-6). A call is passed
  on only when it names a tool the current client request offered, and its
  input is a JSON object.
- **One conversation per client conversation.** It is bound by a hash of the
  client conversation's stable prefix. Later requests send only the new suffix:
  tool results and new user turns.
- **The protocol is plain lines,** not fenced blocks. A web model's answer is
  read from its rendered page, and rendering changes fences (labels, copy
  buttons). The line must not look like the provider's own function-call
  envelope. ChatGPT dropped the JSON from `TOOL_CALL {...}` lines, and from
  `CALL Read {…}` lines in a full agent turn (observed live): a reply that ends
  in a tool name and JSON is taken as a native call and hidden. A closed tag
  keeps the call in the visible text.
- **One nudge, no more.** A web model sometimes answers that it cannot reach
  the user's files. When a tooled answer has no call and says so, the gateway
  sends one fixed reminder into the same conversation and uses that answer.
  The reminder is its own run.
- **Every gateway request is a workflow run.** It is routed, egress-checked,
  receipted, and explainable like any other run.

## Consequences

- Claude Code (and later Codex) can run on a website model's subscription quota
  (P1), with no connector setup.
- A model can ignore or garble the protocol. A malformed call is not executed:
  the answer is returned as text. A turn costs browser latency (seconds), not
  API latency.
- Large tool catalogs are compressed in the turn (name, first sentence, and
  parameters), so the model sees less detail than an API model would.
- Moving to MCP inversion later changes only the gateway's tool path. The
  client-facing wire format stays the same.
