---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-lead-inbox": minor
"@tsuuanmi/system-board": patch
"@tsuuanmi/system-approvals": patch
"@tsuuanmi/system-workflow": patch
"@tsuuanmi/system-web-ui": minor
"@tsuuanmi/system-cli": minor
"@tsuuanmi/system-bundle": minor
---

A lead inbox that pushes to the lead (D107, PROP-0016 I2 and I5): what needs a project's lead, and what finished, comes to it by itself instead of a lead's own polling script.
- New plugin `lead-inbox` makes `lead-notice@1.0` records per project, addressed to `lead:<project>`, from recorded events only: `result.held`, `merge.held`, `worker.question`, `task.retries-spent`, `task.landing-gave-up`, `request.outside-rights`, `request.stale`, `quota.idle`, `live-update.done`/`failed`, `task.landed` (pushed per landing, with its commit) and a `task.digest`. Deduplicated, bounded, ids and the command to act only; a decided request or a moved task closes its notice.
- MCP `lead_inbox` (a lead token reads its own project only; `ack` marks ids handled), `system lead wait|inbox|ack`, and a per-project Lead panel on the board page.
- Push delivery per project on the row: `command` (argv, no shell, JSON on stdin, bounded), `file` (a JSON line under the coordination directory), `wait`; each fails open and is recorded as `lead-inbox.delivery`.
- Metrics: the time notices wait until handled and the lead's touches per task, from the acks and the decisions that closed notices.
- The board records `board.waiting` and `board.waiting.ended`, the queue `approvals.lead-refused` and the task of a request, and a landing its branch, cause, and one-line change.
