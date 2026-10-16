# ADR-0011: The MVP integrates with Claude Code and Codex through MCP first

- **Status:** Accepted; amended 2026-10-16 (any MCP client)
- **Date:** 2026-10-11
- **Related:** ADR-0008, ADR-0009, [release scope](../../requirements/release-scope.md)

## Context

[ADR-0009](0009-claude-and-codex-first-class.md) requires both Claude Code and
Codex to be able to use `system`. There are two ways to do that:

- **MCP tools:** `system` appears as a set of tools (`ask`, `research`,
  `status`) inside the agent.
- **Model gateways:** `system` appears as a *model* in the agent's model picker,
  through Responses or Anthropic Messages emulation, as codex-chatgpt-web does
  for Codex.

## Options

1. MCP first. The gateways come in production-ready (v1.0).
2. The Responses gateway first, for Codex only, with Messages later.
3. Both gateways in the MVP.

## Decision

Option 1. The maintainer confirmed it on 2026-10-11.

## Consequences

- One integration reaches both agents, which satisfies ADR-0008 and ADR-0009 at
  the lowest cost. The agent stays the local Worker for code and data, so purpose
  P3 holds without extra mechanism.
- The MVP does not offer "pick a (Web) model in the agent's picker". Users call
  `system` tools explicitly, or let the agent call them.
- Gateway mechanics (turn broker, tool inversion, completion fence) remain
  designed in [gateways](../../design/gateways.md) and are delivered in v1.0.

## Amendment (2026-10-16): MCP is the client interface for any local agent

The decision stands, and its scope is stated more precisely:

- **Primary interface.** MCP over Streamable HTTP, on loopback with scoped tokens
  ([ADR-0023](0023-scoped-control-credentials.md)), is how a local agent uses
  `system`. Claude Code and Codex are the first two clients. Any MCP-capable agent
  uses the same tools, with the same contracts and scopes.
  - Tool names, descriptions, inputs, and results never name a client.
  - Per-client code is limited to helpers that print configuration
    (`system mcp-config`, `mcp-headers`, `mcp-stdio`).
- **No second client protocol.** A2A and ACP are not part of the client path in
  the MVP. Where they appear, ACP drives an agent *as a Worker*
  ([ADR-0009](0009-claude-and-codex-first-class.md)), and A2A is deferred for
  cross-runtime peers ([ADR-0006](0006-protocol-introduction-gates.md)).
- **Advice, not authority.** The calling agent is the Lead. What `system` returns
  is advice to it ([ADR-0028](0028-local-lead-final-authority.md)).
- **Gateways stay optional.** The model gateways are built, but off in the default
  composition. Turning them on is an operator choice.
