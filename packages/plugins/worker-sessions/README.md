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
