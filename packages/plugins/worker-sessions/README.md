# @tsuuanmi/system-worker-sessions

**`ctx.workerSessions`**: durable Worker sessions with direct peer messaging
([design](../../../docs/design/sessions-and-messaging.md),
[ADR-0015](../../../docs/decisions/adr/0015-worker-sessions-and-peer-messaging.md)).

- **Groups and sessions.**
  - `group(id, { barrier })` creates a group.
  - `join(group, member)` forms a member's session once its Worker is chosen
    (Model A: by its first admission, for the session's lifetime). The
    `worker-session@1.x` record is bound to that Worker, runtime, and
    formation decision (`@1.1` for the `antigravity-cli` runtime, which
    `@1.0` does not name; `@1.0` otherwise). A rejoin with another Worker is
    refused.
- **Messages.**
  - `send(message)` is checked against the policy first:
    - the sender is a member, or a sender that is not a session (`EXTERNAL_SENDERS`:
      `operator`, or `client` for an MCP client holding the client scope);
    - the target is in its `mayMessage` (the group id allows the group and
      every member);
    - its message budget has room.
  - A refusal is a `gate` decision. An accepted message is a `message@1.0`
    artifact, appended to each target's mailbox with a sequence number. A
    repeated sender message id is delivered once.
- **Barriers are mailbox gates.** While a group's barrier is closed, messages
  are stored but `inbox` delivers nothing; `openBarrier` releases them. The
  workflow engine's teams open their groups without one: their members never
  message each other.
- **Mailbox.** `inbox(session)` returns unread messages in order. `ack(session,
  seq)` moves the session's `mailboxSeq`, so a redelivery after a crash resumes
  after it.
- **It records, never relays or rewrites.** A message is stored as its sender
  wrote it.
- **MCP:**
  - `session_send` (to a session or a group, client scope). It records the caller
    as the sender: `operator` for the operator token, `client` (producer
    `system`/`mcp-client`) for a client token, so the audit trail never credits
    the operator with what a client wrote;
  - `session_inbox` (a session's record and unread messages, not acknowledged).
- **Activation (wake-on-message).**
  - A delivery whose intent asks for a reply (any but `answer` and `close`)
    announces `worker-sessions/delivered`, and the workflow engine wakes the
    idle targets.
  - `activate(session, nativeHandle)` makes an idle session ACTIVE, records
    its native conversation handle, and counts its turn against `maxTurns`. A
    refusal is a `gate` decision. `settle` makes it idle again.
  - `pending()` lists sessions with unread mail, and `ofRun(runId)` lists a
    run's members.
- **Budgets (REQ-SES-7).**
  - Config `maxTurns`, `maxLifetimeMinutes`, `maxIdleMinutes`, and
    `maxMessages` are recorded on each session.
  - `activate` refuses a spent turn, lifetime, or idle budget: the session
    becomes FAILED, with a `gate` decision naming the budget.
  - `settle` takes the turn's estimated tokens and native handle. With
    `inputRequired`, the session waits in INPUT_REQUIRED, and any message then
    wakes it.
  - `rebind` advances the binding generation after a compaction.
  - Config `checkpointEveryTurns` and `compactAtTokens` drive the engine's
    checkpoints and compaction.
- **Injects:** `store`, `artifacts`; `mcp` is optional.
- The conformance suite is [`conformance/worker-sessions.ts`](conformance/worker-sessions.ts),
  run through the [conformance runner](../../libs/conformance/runner.ts) at contract 1.1
  against this plugin with `SESSIONS_CONFIG` (1.1 adds the binding runtime `antigravity-cli`,
  recorded in a `worker-session@1.1`; [ADR-0015](../../../docs/decisions/adr/0015-worker-sessions-and-peer-messaging.md#amendment-2026-10-23-contract-11-names-the-antigravity-cli-runtime)):
  - a SessionId bound once to its Worker, unchanged across activations and compaction;
  - a binding generation that advances on every activation, which `settle` presents, so a
    stale activation's write is refused;
  - an ordered mailbox; redelivery from `mailboxSeq + 1`; deduplication on
    `(from, messageId)`;
  - policy refusals (sender, target, budget) as `gate` decisions; barriers hold messages;
  - a body is data, never authority (INV-6);
  - a message at least as strict as its `refs`, so the receiver's turn carries their
    classification to its egress check (write authority over a subject is the board's);
  - activation needs a conversation and fits the turn and lifetime budgets;
  - the binding records the runtime a member joins with, an Antigravity CLI member's as
    `antigravity-cli` (contract 1.1).
