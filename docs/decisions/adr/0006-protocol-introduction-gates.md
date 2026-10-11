# ADR-0006: Protocol introduction gates

- **Status:** Proposed
- **Date:** 2026-10-11
- **Related:** PROP-0001, INV-7, REQ-GW-*

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
| MCP | **now** | capability exposure and the per-turn tool bridge |
| ACP | optional | controlling an external Worker runtime, once one is needed |
| A2A | deferred | added only after a real cross-runtime direct-peer requirement |

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
