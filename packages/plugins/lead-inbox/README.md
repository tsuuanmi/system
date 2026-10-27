# @tsuuanmi/system-lead-inbox

**A project's lead inbox** (D107: "a real lead does not go asking and waiting; when work is done the
information should reach the lead"; PROP-0016 I2 and I5). What needs a project's lead, and what
finished, comes to it by itself, from **recorded events only** ([design](../../../docs/design/notifications.md#the-leads-inbox)).
It reads the core, decides nothing, and fails open: a notice that cannot be pushed is recorded, and
nothing else changes.

- **Notices** (`lead-notice@1.0`, [schema](../../../schemas/lead-notice.v1.json)), per project,
  addressed to `lead:<project>`:

  | Kind | From the event | Subject | Closed by itself when |
  |---|---|---|---|
  | `result.held` | `board.review.held` (heavy tier, or its checks unknown) | the task | `board.review.ended` |
  | `merge.held` | `workflow.task.landing` `asked` | the request | `approvals.resolved` |
  | `worker.question` | `workflow.task.question` | the task | `board.waiting.ended` |
  | `task.retries-spent` | `board.waiting` with reason `retries-spent` | the task | `board.waiting.ended` |
  | `task.landing-gave-up` | `workflow.task.landing` `refused` (also "dev moved again after N rebases") | the task | the task's next landing step |
  | `request.outside-rights` | `approvals.lead-refused` (a lead token refused a verdict) | the request | `approvals.resolved` |
  | `request.stale` | an open request of the project older than `staleMinutes` (10) | the request | `approvals.resolved` |
  | `quota.idle` | ready tasks waiting while a Worker that could take them is free, past `idleMinutes` (10) | the task | acked |
  | `live-update.done` / `live-update.failed` | `host.live-update`, recorded by `scripts/live-update.sh` through MCP `live_update_record` (operator scope) once the daemon runs again | the update | acked |
  | `task.landed` | `workflow.task.landing` `merged`: the task, the commit, what it changed in one line | the task | acked |
  | `task.digest` | the landings of each `digestMinutes` (60), batched | the interval | acked |

  Ids, kinds, counts, times, and the command to act only (egress classification `operator-shared`).
  Deduplicated per project, subject, and kind within `dedupMinutes` (10); bounded (INV-9): `maxNotices`
  per project, handled notices kept `retainDays`, `maxQueue` notices waiting to be pushed.
- **Read:** MCP `lead_inbox` (client scope; a project's lead token reads only its own project, the
  operator names `projectId`): the unread notices, `ack` to mark ids handled, `waitSeconds` (up to
  55) to block until one is unread; `stats` with the time notices waited until handled and the lead's
  touches per task. `system lead wait [--project <id>] [--timeout <s>]` is the loop a lead runs
  instead of polling.
- **Pushed**, per project on the row (`projects.<id>.sinks`), each sink sent once, failing open, its
  outcome the event `lead-inbox.delivery`, never blocking a producer (the inbox reads after the
  commit, on its own clock):
  - `command`: `argv` run with no shell, the notice as JSON on stdin, bounded in time
    (`timeoutSeconds`, 10) and output (64 KiB). System knows only the argv (INV-11).
  - `file`: the notice as one JSON line appended to `path` under `coordinationDir` (5 MiB at most).
  - `wait`: the long-poll above (the default).
- Tests: `tests/lead-inbox.spec.ts`.
