---
"@tsuuanmi/system-notify": minor
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-approvals": minor
"@tsuuanmi/system-resources": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-egress": minor
"@tsuuanmi/system-mcp-server": minor
"@tsuuanmi/system-cli": minor
"@tsuuanmi/system-bundle": minor
---

Out-of-band notifications (B5), so an approval request you never saw is not lost to its expiry. The new `notify` row, off by default, tells you from recorded events only:
- an approval request opened, and one still open an hour (`expiryLeadMinutes`) before it expires and is denied; a run that failed for you (`USER_ACTION`) or was escalated; a step waiting for an account's limit; a pool closed at its limit; an agent account quarantined. Each notice (`notification@1.0`) says what, which request, run, pool, or account, and the command to act (`system ui`, `system explain`, `system continue`, `system account verify`), and never carries a secret, a prompt, an answer, or a request's summary.
- At most one per subject and kind in 10 minutes (`dedupMinutes`), through a bounded queue (`maxQueue`), never blocking or changing the producer of an event; nothing is retried.
- On the desktop through `notify-send` (a no-op health shows when it is missing), or to a webhook you turn on, only once the `egress` row declares `webhook: [operator-shared]` (its default now lets nothing leave for it) and with its URL in the vault (`system notify webhook < file`, MCP `notify_webhook`), never in configuration.
- `system health` shows `notifications` degraded while a sink's latest delivery failed or a notice was dropped; `system events --type notify.delivery` lists every outcome.

The producers record what it reads: `approvals.requested` and `approvals.resolved`, `resources.pool.limited`, `agent-workers.account.quarantined`, and a `disposition` on every `workflow.node.failed` (and a `kind` and `disposition` on `workflow.run.failed`).
