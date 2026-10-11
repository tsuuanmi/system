# ADR-0001: `system` is a standalone host

- **Status:** Accepted
- **Date:** 2026-10-11
- **Related:** PROP-0001, CON-1, ADR-0007

## Context

AgentOS and internet are both plugins of DeepSeek Harness (DSH) on Cordis. That
gave them a lot of infrastructure for free, including subagents, agent teams,
storage, and a UI. It also tied their core semantics to experimental host APIs.
For example, AgentOS team membership depends on `prepareContinuable`, which only
in-process providers pass. Their lifecycle follows the host's release cadence.
codex-chatgpt-web is standalone, and it integrates with Codex purely through a
standard protocol, the Responses API.

## Options

1. Remain a DSH/Cordis plugin.
2. Build a standalone host, and integrate DSH, Codex, Claude Code, and MCP agents as
   clients or adapters.
3. Build on a general agent framework (Mastra, LangGraph, and similar) as the host.

## Decision

Option 2. `system` owns its process, composition root, durable store, and
lifecycle. Every harness reaches it through a gateway: Responses, MCP, the CLI, or
a thin DSH adapter.

## Consequences

- Core semantics no longer depend on experimental third-party APIs, and any
  protocol-speaking client can use `system`.
- `system` must provide what DSH used to provide: storage, scheduling, an operator
  UI, and approvals. The reuse ladder still applies inside the host: a standard
  protocol or library before custom code.
- Option 3 was rejected because AgentOS's research found that a second full
  framework duplicates orchestration and hides durability semantics. Frameworks
  remain references only.
- Revisit if a host appears that provides the required durability and
  reconciliation semantics through a stable public contract.

## Follow-up (2026-10-11)

[ADR-0007](0007-everything-is-a-plugin.md) builds the standalone host on Cordis,
the plugin runtime that DSH also uses. `system` stays standalone, but its plugins
can be mounted by a DSH profile as a bundle. That replaces the "thin DSH adapter"
mentioned in the decision above.
