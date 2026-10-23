# Worker sessions, direct messaging, and long-running work

> Target state. Seam: `ctx.workerSessions` ([plugin model](../architecture/plugin-model.md#seam-catalog)).
> Decision: [ADR-0015](../decisions/adr/0015-worker-sessions-and-peer-messaging.md).
> Requirements: REQ-SES-1..8. Shapes: [`worker-session.v1.json`](../../schemas/worker-session.v1.json),
> [`message.v1.json`](../../schemas/message.v1.json).
>
> Implemented in [`worker-sessions`](../../packages/plugins/worker-sessions/README.md) (sessions,
> groups, mailboxes, budgets) and [`workflow`](../../packages/plugins/workflow/README.md)
> (wake-on-message, checkpoints, compaction); differs from target: a Worker sends a message only
> as its reply to a wake, and `session_send` is the operator's or a client's;
> sessions start `IDLE` at their first admission (no `FORMING`) and are never `CLOSED`; a group
> lives for its run, not inside one `team` node; the A2A adapter is planned.

## Concepts

| Concept | Meaning | Lifetime |
|---|---|---|
| **Session** | one Worker's durable participation, with its own `SessionId`, role, and policy | from formation until it is closed; survives restarts |
| **Activation** | the live process, browser context, or SDK client currently serving a session | disposable, recreated on demand |
| **Execution binding** | `SessionId → { nativeHandle, generation }` | the generation advances on every activation, and the activation's settle presents it, so a stale activation is refused |
| **Session group** | sessions under one policy, such as a team's members | the lifetime of its DAG node |
| **Mailbox** | the durable, ordered inbox of a session | the lifetime of the session |

This is AgentOS's Model A, generalized beyond DSH. The session *is* the
collaboration identity, and it is chosen through admission once, at formation
([teams](teams.md#membership-model-a)).

## Native handle mapping

| Worker runtime | Native handle bound to `SessionId` | Resume mechanism |
|---|---|---|
| ChatGPT / Gemini Web | canonical conversation URL plus the last receipt | open the URL in a fresh context (a session-bound account: a page of its login profile); reconcile the receipt ([provider turns](provider-turns.md)) |
| Claude Agent SDK | SDK session id | SDK resume |
| Codex SDK | thread id | resume thread |
| ACP agent | ACP `sessionId` | `session/resume` (v2) or `session/load` (v1) |
| An agent runtime that cannot resume (the Antigravity CLI), as a review member only | none | a replay, not a resume: the `agents` source sends the session's earlier turns, exactly as recorded, before each new one, and records them with the answer ([review members](agent-runtimes.md#review-members)) |
| Model Worker | none | the `models` source replays the session's transcript ([ADR-0031](../decisions/adr/0031-model-worker-sessions-by-replay.md)) |
| A2A remote agent (planned) | `contextId` (+ current `taskId`) | `SubscribeToTask` / Get Task |

A Worker can serve a session only if it proves `persistent-conversation`
([routing](routing.md#capability-vocabulary)), for that work when its offer is scoped to one kind
of work ([scoped offers](routing.md#scoped-offers)).

## Session states

```mermaid
stateDiagram-v2
  [*] --> FORMING
  FORMING --> IDLE
  IDLE --> ACTIVE: a turn, or a message arrives (wake-on-message, cold resume if needed)
  ACTIVE --> IDLE: the turn settles
  ACTIVE --> INPUT_REQUIRED: the session asks a question
  INPUT_REQUIRED --> ACTIVE: operator or peer input
  ACTIVE --> FAILED: classified failure or a spent budget
  IDLE --> CLOSED
  CLOSED --> [*]
```

`INPUT_REQUIRED` maps to A2A's `TASK_STATE_INPUT_REQUIRED` and to a node in
`BLOCKED`/`USER_ACTION` when the input must come from the operator.

## Direct messaging

1. A session sends `message(to: SessionId | group, body, inReplyTo?, refs[])`.
   - Incoming messages are injected as the target's next turn. A team's
     members do not message each other: the engine composes their prompts from
     sealed records ([teams](teams.md#membership-model-a)).
   - The operator sends with the MCP tool `session_send` and reads with
     `session_inbox`.
2. **Policy check.** The group policy decides whether the sender may address the
   target, whether a barrier is open, whether the message and turn budgets have
   room. A rejection is recorded as a decision artifact. Egress is checked where content leaves
   for the receiver: a message artifact is at least as strict as its refs, and the receiver's
   turn carries the strictest classification of the messages it delivers, so the turn's egress
   check (the one authority, [routing](routing.md)) refuses local-private content to a remote
   Worker before anything is sent.
3. **Persist, then deliver.** The message is a `message` artifact, appended to
   the target mailbox with a sequence number. Delivery is at least once, and the
   receiver deduplicates by `messageId`.
4. **Wake.** An `IDLE` target is activated, cold-resumed if necessary, and
   receives its unread messages in order as one turn.
5. The engine **records** every message but **never relays or rewrites**
   content.

Barriers are mailbox gates. Messages to a member of a group with a closed
barrier are held until it opens.

## Long-running mechanics

| Concern | Mechanism |
|---|---|
| Survive restarts | session, bindings, mailbox, and receipts are durable; on start, sessions that were `ACTIVE` reconcile their last turn, then resume |
| No polling between peers | wake-on-message; the operator and clients subscribe to session events |
| Progress visibility | the session emits a `report` checkpoint artifact at least every `checkpointEvery` turns or minutes |
| Context growth | engine-owned compaction: at a token threshold, an economy-tier step writes a `handoff` summary artifact (decisions, open questions, state), and the session continues from the summary plus refs. Memory is never left to the model alone |
| Liveness | per-turn two-clock completion; a session heartbeat lease; a stale activation is fenced by generation |
| Bounds | `maxLifetime`, `maxTurns`, `maxMessages`, `maxIdle`, token and quota budget per session; exceeding one is a classified failure |
| Clients waiting on long work | MCP and CLI calls return a `SessionId` or run id at once. Clients poll `status` or stream events; they never block for the duration |
| Human in the loop | `INPUT_REQUIRED` with a question artifact; the answer is an `approval` or a message artifact |

## Relation to the DAG

A team's session group spans the steps its node is unrolled into: each
member's steps run in its own session, and the team's `team` steps tally the
ballots and decide ([teams](teams.md#procedure)). The decision step's output is
the team's result. The DAG gives the durable macro structure. Sessions give
long-running, conversational work inside it
([ADR-0012](../decisions/adr/0012-dag-execution-model.md)).

## A2A alignment (for the planned adapter)

| `system` | A2A 1.0 |
|---|---|
| `SessionId` | `contextId` |
| one activation turn or execution | `Task` (`id`) |
| `message` artifact (`messageId`, `inReplyTo`, `refs`) | `Message` (`messageId`, `referenceTaskIds`, `parts`) |
| domain artifacts | `Artifact` |
| `INPUT_REQUIRED`, `CLOSED`, `FAILED` | `TASK_STATE_INPUT_REQUIRED`, `COMPLETED`, `FAILED` / `CANCELED` |
| wake-on-message, session events | streaming, `SubscribeToTask`, push notifications |
