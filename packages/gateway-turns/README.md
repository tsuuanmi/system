# @tsuuanmi/system-gateway-turns

What the client-protocol gateways share
([gateways](../../docs/design/gateways.md),
[ADR-0022](../../docs/decisions/adr/0022-text-protocol-tool-calls-for-website-models.md)).
Each gateway (`gateway-anthropic`, `gateway-responses`) maps its wire format to
the neutral turns here and owns nothing else.

## What it owns

- **The text tool protocol** (`protocol.ts`, pure). It:
  - lists a client's tools compactly;
  - renders the opening turn (protocol, tools, the agent's instructions, the
    history, and a closing that quotes the user's request) and later suffixes;
  - parses `<call tool="…">{json}</call>` tags. A tag counts only when it names
    an offered tool and its arguments are a JSON object.
- **Threads** (`threads.ts`). A thread binds a client conversation to one
  persistent provider conversation, in table `gateway_threads` (scope, key).
  - A later request sends only what follows the last assistant turn, because
    the provider conversation already holds its own replies.
  - **A thread resumes only its own conversation.** The binding stores a
    fingerprint of what the provider conversation saw: user text, tool
    results, and the assistant's text and call ids (call ids are random per
    reply, so two clients never share one). A request resumes only when its
    history up to the last assistant turn matches that fingerprint exactly.
    Otherwise (another client with the same opening, or a rewound or edited
    history) a fresh conversation opens with the whole history. The
    fingerprint is column `history` (store migration 2).
  - Each exchange is an `ask` run on the workflow engine, plus at most one
    nudge when the model claims it cannot reach the user's files.
- **The guard factory** (`guard.ts`): `guard()` reads the MCP token file and
  applies the request guard every client endpoint shares (`guardRequest` from
  [`gateway-core`](../gateway-core/README.md#the-request-guard)), with
  `x-api-key` also accepted (`apiKeyHeader`). `MAX_REQUEST_BYTES` (16 MiB) bounds
  a gateway's request body.

## Dependency direction

Depends on `system-gateway-core`, `system-libs`, `system-store`, and the
workflow engine's types. Only
gateway plugins depend on it. It is a library, not a seam: the shared turn
broker for MCP tool inversion stays the target.
