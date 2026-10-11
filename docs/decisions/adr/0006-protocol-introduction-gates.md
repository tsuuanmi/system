# ADR-0006: Protocol introduction gates

- **Status:** Accepted (2026-10-11, with PROP-0001)
- **Date:** 2026-10-11
- **Related:** PROP-0001, INV-7, REQ-GW-*, ADR-0015

## Context

AgentOS went through several protocol placements, from A2A peers to ACP website
agents to native host seams. Its documents still contradict each other because of
this. It concluded that a protocol should be added only when a real boundary
needs it, and that native protocol objects should cross boundaries unchanged.
codex-chatgpt-web shows the value of one well-implemented standard surface, the
Responses API, combined with MCP.

## Options

1. Support every agent protocol (MCP, ACP, A2A, Responses) from the start, with a
   universal internal message model.
2. Introduce protocols only through explicit gates, and keep native objects with
   no universal mirror.

## Decision

Option 2.

| Protocol | Status | Role |
|---|---|---|
| OpenAI Responses (HTTP + SSE) | **now** | client gateway for Codex and Responses clients |
| Anthropic Messages (HTTP + SSE) | **now** | client gateway for Claude Code and Messages clients ([ADR-0009](0009-claude-and-codex-first-class.md)) |
| MCP | **now** | capability exposure and the per-turn tool bridge |
| ACP | **now**, as a Worker runtime provider | generic driver for ACP-speaking agents (`runtime-acp`). Claude Code and Codex use their official SDKs instead |
| A2A 1.0 | **planned** (post-MVP) | cross-runtime peers only: `gateway-a2a` exposes `system` sessions, and `runtime-a2a` uses remote A2A agents as Workers. Introduced with the first peer `system` does not drive. Internal peer messaging uses the native mailbox ([ADR-0015](0015-worker-sessions-and-peer-messaging.md)) |
| IBM Agent Communication Protocol | rejected | merged into A2A (2025); not to be confused with the Agent Client Protocol (ACP) above |

A new protocol is admitted only when all of these hold:

1. A concrete requirement names the boundary.
2. No existing gateway can serve it without losing an invariant.
3. An official SDK or specification exists.
4. Native objects can cross the boundary without a mirror type.
5. A conformance test against a real counterpart is planned.

## Consequences

- The internal model stays small. Adapters translate behavior, not data.
- Some interoperability is postponed on purpose, and the gate tells future
  contributors exactly what evidence brings it forward.
