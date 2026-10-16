# ADR-0009: Claude Code and Codex are first-class, as clients and as Workers

- **Status:** Accepted; amended 2026-10-16 (further agents)
- **Date:** 2026-10-11
- **Related:** ADR-0006, ADR-0008, REQ-GW-1, REQ-GW-5, REQ-WRK-5..6

## Context

The maintainer requires that both Claude (Claude Code) and Codex can use
`system`. Each can relate to `system` in two directions:

- **as a client:** the agent's own user interface and loop drive `system` Workers,
  as codex-chatgpt-web does for Codex;
- **as a Worker:** `system` drives the agent to do work. DSH has one-shot
  `claude-code` and `codex` subagent bridges, which "do not gain multiple turns".

## Options

1. Support Codex only as a client, as codex-chatgpt-web does.
2. Support both agents in both directions, through public protocols and official
   SDKs.

## Decision

Option 2, symmetric for both agents:

| Direction | Codex | Claude Code |
|---|---|---|
| client: model protocol | Responses gateway (custom model provider pointing at the gateway) | Anthropic Messages gateway (base URL pointing at the gateway) |
| client: tools and capabilities | MCP server | MCP server |
| Worker | `runtime-codex-sdk` | `runtime-claude-agent-sdk` |

- Both client gateways share one turn broker (planned; until then they share the
  `gateway-turns` library and the text protocol of
  [ADR-0022](0022-text-protocol-tool-calls-for-website-models.md)). Remote tool
  requests become the client's native tool-call items (`function_call` for
  Responses, `tool_use` for Messages) and are executed by the client under its own
  sandbox and approvals ([gateways](../../design/gateways.md)).
- Worker runtimes use the official TypeScript SDKs. A runtime is admitted as a
  continuable Team member only if its resume conformance test passes (planned;
  today admission rests on the runtime probe's `resume` flag)
  ([agent runtimes](../../design/agent-runtimes.md)).
- Any other ACP-speaking agent is reachable through `runtime-acp`.

## Consequences

- One `system` installation serves both ecosystems, and a workflow can mix
  Workers: for example, a ChatGPT Web thinker, a Claude Code implementer, and a
  Codex reviewer.
- Two client-protocol adapters must be maintained. Their shared broker and
  smoke tests against both real clients keep them aligned
  ([testing](../../engineering/testing.md)).
- Client configuration edits (the Codex `config.toml` and Claude Code settings)
  are journaled and reversible (REQ-HOST-3; planned: today `system codex-env` and
  `system claude-env` print a command and edit nothing).
- Supersedes nothing. It extends the protocol table in
  [ADR-0006](0006-protocol-introduction-gates.md), which was updated in the same
  change.

## Amendment (2026-10-16): how a further agent is integrated

The decision for Claude Code and Codex stands. For any other coding agent, the
cheapest path that keeps every invariant comes first:

1. **As a client: configuration only.** An MCP-capable agent uses the MCP server
   as it is ([ADR-0011](0011-mvp-integration-via-mcp.md)). It gets no runtime, plugin,
   or vendor-specific code of its own.
2. **As a Worker: the generic ACP runtime.** An ACP-speaking agent becomes a Worker
   through `runtime-acp`. It is admitted only for the capabilities its runtime
   evidence proves.
   - It must prove the confinement it runs under: write and read confinement
     ([ADR-0024](0024-agent-workers-confined-for-reads.md)), egress, and resume.
   - A capability it cannot prove is one the agent does not offer (INV-2).
3. **As a Worker: a native SDK adapter, only on evidence.** Write one only when ACP
   cannot carry a required capability or security guarantee, and record the gap in
   the [dependency register](../../engineering/dependencies.md).

An agent that can connect to MCP gets no runtime of its own for that reason alone.
