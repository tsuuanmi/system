# @tsuuanmi/system-worker-sessions

**`ctx.workerSessions`**: durable Worker sessions with direct peer messaging
([design](../../../docs/design/sessions-and-messaging.md),
[ADR-0015](../../../docs/decisions/adr/0015-worker-sessions-and-peer-messaging.md)).

- **Groups and sessions.**
  - `group(id, { barrier })` creates a group.
  - `join(group, member)` forms a member's session once its Worker is chosen
    (Model A: by its first admission, for the session's lifetime). The
    `worker-session@1.0` record is bound to that Worker, runtime, and
    formation decision. A rejoin with another Worker is refused.
- **Messages.**
  - `send(message)` is checked against the policy first:
    - the sender is a member, or the operator;
    - the target is in its `mayMessage` (the group id allows the group and
      every member);
    - its message budget has room.
  - A refusal is a `gate` decision. An accepted message is a `message@1.0`
    artifact, appended to each target's mailbox with a sequence number. A
    repeated sender message id is delivered once.
- **Barriers are mailbox gates.** While a group's barrier is closed, messages
  are stored but `inbox` delivers nothing; `openBarrier` releases them
  (independent-first).
- **Mailbox.** `inbox(session)` returns unread messages in order. `ack(session,
  seq)` moves the session's `mailboxSeq`, so a redelivery after a crash resumes
  after it.
- **It records, never relays or rewrites.** The workflow engine posts a panel
  member's accepted answer as that member's message. A `To m<k>: …` line in an
  answer is a direct message to that member only.
- **MCP:**
  - `session_send` (as the operator, to a session or a group);
  - `session_inbox` (a session's record and unread messages, not acknowledged).
- **Not yet:**
  - wake-on-message for idle sessions outside a workflow round;
  - checkpoints and compaction for long-running sessions;
  - budgets beyond messages.
- **Injects:** `store`, `artifacts`; `mcp` is optional.
