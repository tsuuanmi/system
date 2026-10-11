# ADR-0008: Tool-agnostic boundaries

- **Status:** Accepted
- **Date:** 2026-10-11
- **Related:** ADR-0006, ADR-0007, ADR-0009, INV-11

## Context

The maintainer requires that `system` not be locked into any single tool. The
reference systems each lock in somewhere:

- internet is tied to DSH and to the ChatGPT and Gemini websites;
- codex-chatgpt-web is tied to Codex's private formats and to ChatGPT;
- AgentOS is tied to DSH's experimental team API.

The AI tool ecosystem changes faster than any design built around one tool.

## Options

1. Pick a primary tool per concern and optimize for it.
2. Make every external tool reachable only through a seam or a standard protocol,
   and keep tool names out of the semantic layers.

## Decision

Option 2, stated as [INV-11](../../architecture/invariants.md#inv-11-no-tool-lock-in):

- **Models and providers:** web providers, API providers, and agent runtimes are
  all providers behind seams.
- **Clients:** any Responses client, any Anthropic Messages client, any MCP
  client, and the CLI. No client gets a private integration that the others
  cannot use.
- **Infrastructure:** the browser engine, store, display, and executor are seams.
- **Semantics:** routing, teams, workflows, and profiles depend only on
  capabilities and never name a tool, model, or vendor.
- **Exit test:** for every seam, a second provider must be plausible without
  changing consumers. Its conformance suite has to be runnable against a fake.

## Consequences

- Adding a tool means adding a provider plugin and passing a conformance suite.
- Some tool-specific features are reachable only when a capability models them.
  This is intentional: a capability is added when a requirement needs it.
- Gateways must follow public protocol contracts and must not depend on a client's
  private internals. This drops codex-chatgpt-web's reliance on Codex-internal
  formats.
