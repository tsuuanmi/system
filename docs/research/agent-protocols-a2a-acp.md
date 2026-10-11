# A2A vs ACP for direct Worker communication and long-running work

Non-normative. Researched 2026-10-11. Supports
[ADR-0015](../decisions/adr/0015-worker-sessions-and-peer-messaging.md).

## The requirement

This comes from AgentOS's original idea. Workers can talk **directly** to each
other, each has its **own session id**, and the purpose is **long-running tasks**.
AgentOS met this with DSH `ctx.agentTeams`: a persistent teammate session, a
durable mailbox, direct member-to-member messaging, and wake-up. The lead records
but does not relay content. AgentOS deferred A2A behind a five-condition gate
([AgentOS analysis](agentos-analysis.md)). `system` is a standalone host, so it
does not inherit `ctx.agentTeams`. It must either provide that mechanism itself
or adopt a protocol.

## Two different "ACP"s

| Name | Owner | Status | Purpose |
|---|---|---|---|
| **Agent Communication Protocol** | IBM / BeeAI | **merged into A2A** under the Linux Foundation (Aug 2025); repository archived | agent ↔ agent (REST) |
| **Agent Client Protocol** | Zed + community | active; v1 stable, v2 in progress | client (editor or app) ↔ agent subprocess |

When this repository says "ACP", it means the **Agent Client Protocol**.

## A2A (Agent2Agent) 1.0

Linux Foundation, Apache-2.0. Version 1.0.0 is the first stable specification
(2026). Earlier versions are 0.3, 0.2.6, and 0.1. Facts from the
[specification](https://a2a-protocol.org/latest/specification/):

- **Objects:**
  - `AgentCard`: identity, skills, endpoint, security schemes.
  - `Task`: `id`, `contextId`, `status`, `artifacts`, `history`.
  - `Message`: `messageId`, `contextId`, `taskId`, `role`, `parts`,
    `referenceTaskIds`.
  - `Part` and `Artifact`.
- **Task states:** `SUBMITTED`, `WORKING`, `INPUT_REQUIRED` and `AUTH_REQUIRED`
  (interrupted), and the terminal states `COMPLETED`, `FAILED`, `CANCELED`, and
  `REJECTED`.
- **Operations:** `SendMessage`, `SendStreamingMessage`, Get, List and Cancel
  Task, `SubscribeToTask`, push-notification configuration CRUD, and an extended
  agent card.
- **Bindings:** JSON-RPC, gRPC, and HTTP+JSON.
- **Long-running work:** a non-blocking send (`returnImmediately`), polling,
  SSE streaming, re-subscribing by opening a new stream, and **push
  notifications** to a webhook. The specification notes that push "messages are
  not a reliable delivery mechanism".
- **Multi-turn:** `contextId` groups the tasks and messages of one conversation
  or session. `INPUT_REQUIRED` continues on the same `taskId` and `contextId`.
- **Idempotency:** a send "MAY be idempotent", and agents may use `messageId` to
  detect duplicates. Cancel is idempotent.

**Fit for `system`:**

- **Strong fit as the *external* peer boundary.** It suits a peer Worker that
  runs in another runtime, on another machine, or under another vendor, and that
  `system` does not drive itself. It also suits exposing `system` sessions to
  outside agents. The task lifecycle, `contextId`, `INPUT_REQUIRED`, and push
  notifications match long-running cross-runtime work.
- **Poor fit as the *internal* transport** between Workers that `system` already
  drives (ChatGPT Web, Claude Code, Codex). It would add HTTP servers, agent
  cards, and authentication between in-process components. It would turn A2A
  objects into a universal internal model, which INV-7 forbids. It would still
  need our own durable mailbox, because push delivery is not reliable and
  idempotency is optional.

## Agent Client Protocol (ACP)

Facts from the [protocol overview](https://agentclientprotocol.com/protocol/v2/overview):

- JSON-RPC 2.0 between a **client** (editor or app) and an **agent**, usually a
  subprocess.
- **Lifecycle:** `initialize`, then `auth/login` (v2) or `authenticate` (v1), then
  `session/new` or `session/resume`. In v1, `session/load` resumes a session when
  the agent advertises `loadSession`.
- **Turns:** `session/prompt`, with streamed `session/update` notifications
  (messages, tool calls, plans, compaction). `session/cancel`.
  `session/request_permission` goes from agent to client. v2 adds
  `session/list` and `session/close`.
- Method names differ between v1 and v2 drafts (`session/load` vs
  `session/resume`, `authenticate` vs `auth/login`), so pin a version.
- **Out of scope: agent ↔ agent peer messaging.** Every flow is client ↔ agent.

**Fit for `system`:**

- **Strong fit for *driving* an agent Worker** with a persistent, resumable
  session. This is our `runtime-acp` provider. The `sessionId`, resume,
  streaming updates, permission requests, and cancel cover long-running agent
  sessions.
- **Possible future client gateway:** `system` exposed *as* an ACP agent to
  editors such as Zed or JetBrains. This needs its own requirement.
- **No fit for peer messaging.**

## Comparison

| Need | A2A 1.0 | ACP (Agent Client Protocol) | `system` native mailbox |
|---|---|---|---|
| Own session id per Worker | `contextId` (+ `taskId`) | `sessionId` | `SessionId` bound to native handles |
| Peer ↔ peer messages | **yes** | no | **yes** |
| Long-running: resume after restart | task persists server-side; re-subscribe | `session/resume` / `session/load` | durable sessions + receipts + cold resume |
| Async notification | push webhooks (unreliable) | streamed updates | wake-on-message from a durable mailbox |
| Human / peer input mid-task | `INPUT_REQUIRED` | `request_permission`, elicitation | `input-required` session state |
| Works for website Workers (ChatGPT Web) | no (needs a server per Worker) | no | **yes** (messages injected as turns) |
| Cross-runtime / cross-vendor | **yes** | n/a | no (local only) |
| Adds infrastructure | HTTP server, cards, auth | subprocess per agent | none beyond the store |

## Recommendation

1. **Internal direct communication: a `system`-native durable mailbox** in a new
   `ctx.sessions` seam. It replaces what DSH `ctx.agentTeams` gave AgentOS. Every
   continuable Worker participation gets a `SessionId`. Peers address each other
   by `SessionId`. Messages are artifacts. Delivery is durable, at least once,
   and idempotent by `messageId`. Idle sessions are woken by incoming messages.
2. **Design the session and message model to map 1:1 onto A2A**: `SessionId ↔
   contextId`, execution ↔ `taskId`, `messageId`, `referenceTaskIds`,
   `INPUT_REQUIRED`, and artifacts. A later A2A adapter then translates
   *behavior* and needs no mirror types.
3. **A2A: planned, for cross-runtime peers.** Add `gateway-a2a` (expose `system`
   sessions) and `runtime-a2a` (use a remote A2A agent as a Worker) when the
   first peer appears that `system` does not drive. That is AgentOS's gate, now
   met by a concrete scenario class.
4. **ACP (Agent Client Protocol): keep it as a Worker-runtime provider**, and use
   its session resume for long-running agent sessions. Treat an ACP *client*
   gateway as a later candidate.
5. **Do not use IBM's Agent Communication Protocol.** It has been merged into
   A2A.

## Sources

- [A2A specification (latest, 1.0.0)](https://a2a-protocol.org/latest/specification/)
- [A2A key concepts](https://a2a-protocol.org/latest/topics/key-concepts/)
- [Linux Foundation: A2A marks one year (AIwire)](https://www.hpcwire.com/aiwire/2026/04/09/linux-foundation-a2a-protocol-marks-one-year-with-broad-enterprise-and-cloud-adoption/)
- [Agent Client Protocol: communication model (v2)](https://agentclientprotocol.com/protocol/v2/overview)
- [ACP TypeScript SDK protocol overview](https://mintlify.com/agentclientprotocol/typescript-sdk/concepts/protocol-overview)
- [IBM: What is Agent Communication Protocol (merged into A2A)](https://www.ibm.com/think/topics/agent-communication-protocol)
- [A2A vs ACP vs MCP compared](https://codex.danielvaughan.com/2026/05/29/agent-to-agent-communication-protocols-a2a-vs-acp-vs-mcp-compared/)
