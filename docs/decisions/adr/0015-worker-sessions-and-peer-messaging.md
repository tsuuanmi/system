# ADR-0015: Durable Worker sessions with direct peer messaging

- **Status:** Accepted
- **Date:** 2026-10-11
- **Related:** ADR-0006, ADR-0012, INV-7, INV-15,
  [sessions and messaging](../../design/sessions-and-messaging.md),
  [A2A vs ACP research](../../research/agent-protocols-a2a-acp.md)

## Context

AgentOS's core idea is that Workers can talk **directly** to each other, each
with its **own session id**, to carry **long-running tasks**. AgentOS got this
from DSH `ctx.agentTeams`. `system` is standalone
([ADR-0001](0001-standalone-host.md)), so it needs its own mechanism or a
protocol. Two protocols were evaluated:

- **A2A 1.0**, which is agent ↔ agent and cross-runtime;
- **ACP**, the Agent Client Protocol, which is client ↔ agent.

IBM's Agent Communication Protocol was merged into A2A.

## Options

1. All Worker ↔ Worker communication over A2A, including internally.
2. Only engine-mediated exchange: peers see each other's outputs in DAG rounds,
   with no direct messages.
3. **A `system`-native durable session and mailbox seam (`ctx.workerSessions`; renamed from `ctx.sessions` by ADR-0018 because DSH owns that key)**
   modelled to map 1:1 onto A2A, with A2A as an adapter for cross-runtime peers
   and ACP kept for driving agent runtimes.

## Decision

Option 3.

- **Sessions.** Every continuable Worker participation has a system-owned
  `SessionId`. It is bound to the Worker's native handle (a ChatGPT conversation,
  a Claude Agent SDK session, a Codex thread, an ACP `sessionId`, or an A2A
  `contextId`) through an execution binding with a generation fence. Activations,
  meaning live processes or browser contexts, can be disposed and cold-resumed
  without changing the session.
- **Direct messaging.** A session addresses peers by `SessionId`. Messages are
  `message` artifacts in a durable mailbox. Delivery is at least once and
  idempotent by `messageId`, and an incoming message wakes the target. The
  engine records messages but never relays or rewrites their content.
- **Policy.** The team or profile declares who may message whom, the barriers,
  and the bounds (messages, turns, lifetime, budget). Violations are rejected
  with a decision artifact.
- **DAG relationship.** A session group runs **inside** one DAG node (executor
  `team` or `session`). The DAG stays the durable macro structure
  ([ADR-0012](0012-dag-execution-model.md)), and sessions give long-running,
  conversational work inside a node.
- **Single writer still holds.** Peer messages exchange intelligence. Write
  authority over a subject stays with one session
  ([INV-15](../../architecture/invariants.md#inv-15-one-writer-per-subject)).
- **Protocols.**
  - **A2A** becomes *planned* for cross-runtime peers (`gateway-a2a`,
    `runtime-a2a`), introduced when the first peer appears that `system` does
    not drive.
  - **ACP** remains the generic Worker-runtime protocol, and its session resume
    serves long-running agent sessions.
  - Both are recorded in [ADR-0006](0006-protocol-introduction-gates.md).

## Consequences

- AgentOS's direct-collaboration model is restored without depending on DSH,
  and it also works for website Workers, which cannot host an A2A server.
- Long-running work gets first-class mechanics: durable sessions, wake-on-message,
  checkpoints, engine-owned compaction summaries, an `input-required` state, and
  bounded lifetimes.
- [INV-7](../../architecture/invariants.md#inv-7-no-mirrored-protocol-objects) is
  clarified. A `SessionId` is a system-owned identity for a collaboration
  session, not a universal Worker id or a protocol mirror. Native handles stay
  native.
- Because the model is A2A-shaped, a later A2A adapter translates behavior only.
