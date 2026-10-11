# ADR-0011: The MVP integrates with Claude Code and Codex through MCP first

- **Status:** Accepted
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
