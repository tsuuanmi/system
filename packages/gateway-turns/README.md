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
  - Each exchange is an `ask` run on the workflow engine, plus at most one
    nudge when the model claims it cannot reach the user's files.
- **The guard** (`guard.ts`), with the MCP endpoint's rules:
  - a loopback `Host`;
  - no browser `Origin`;
  - the MCP bearer token (or `x-api-key`), compared in constant time.

## Dependency direction

Depends on `system-libs`, `system-store`, and the workflow engine's types. Only
gateway plugins depend on it. It is a library, not a seam: the shared turn
broker for MCP tool inversion stays the target.
