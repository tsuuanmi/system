# @tsuuanmi/system-notify

**Out-of-band notifications** (PROP-0010 B5): an approval request expires denied, so a request
the operator never saw is lost work. This surface plugin tells the operator, outside `/ui` and
the CLI, what needs them, from **recorded events only**, and with the exact command to act
([design](../../../docs/design/notifications.md)). It reads the core, decides nothing, and fails
open: a notice that cannot be sent is recorded and shown in health, and nothing else changes.

- **What it tells** (`notification@1.0` `kind`), from the event log:

  | Kind | From the event | Subject |
  |---|---|---|
  | `approval.opened` | `approvals.requested` | the request |
  | `approval.expiring` | an open request `expiryLeadMinutes` before its `expiresAt` (none once `approvals.resolved` names it, or when it expires within the lead time from its making) | the request |
  | `run.user-action` | `workflow.node.failed` or `workflow.run.failed` with `disposition: USER_ACTION` | the run |
  | `run.escalated` | `workflow.node.escalated` | the run |
  | `run.waiting` | `workflow.node.waiting` (ADR-0052 `wait`) | the run |
  | `pool.limited` | `resources.pool.limited` | the pool |
  | `worker.quarantined` | `agent-workers.account.quarantined` (PROP-0012 E) | the account (`<provider>:slot-<n>` with no id yet) |

- **Content:** what happened, which request, run, pool, or account, and the commands to act
  (`system ui`, `system explain <runId>`, `system continue <runId> <nodeId>`, `system account
  verify …`, MCP `approvals_decide`), and the `/ui` link without its token. Ids, classes, kinds,
  and times only: never a secret, a prompt, an answer, or a request's summary or command
  (egress classification `operator-shared`). Every value it quotes is checked as an id or a word,
  cut, and the notice validated against [`notification@1.0`](../../../schemas/notification.v1.json).
- **Never blocks or alters a producer:** it reads the log after its own cursor on its own clock;
  a committed event (`system/event`) only wakes it. A pass moves the cursor, the reminders, and each
  notice's claim in one store transaction, and queues the notices after it commits.
- **Deduplicated:** at most one notice per subject and kind per `dedupMinutes` (10), counted in the
  store, so a restart neither repeats nor loses a window.
- **Bounded (INV-9):** at most `maxQueue` (50) notices wait; one more is dropped and recorded. A pass
  reads at most 10 000 entries (a longer backlog is read by the next passes, at once); at most
  10 000 reminders. An event older than `maxAgeMinutes` (60) when read makes no notice (a host or
  row that was off), though an open request's reminder is still kept.
- **Sinks**, each sent once (no retry), bounded by `timeoutSeconds` (10):
  - **desktop** (`desktop`, default on): `notify-send` from libnotify, found on `PATH` at start,
    given only the environment it needs to reach the session bus, `--` before the title and body.
    Without it, a no-op: recorded `unavailable` at start, and each notice `failed`.
  - **webhook** (`webhook.enabled`, default off): a JSON `POST` of the notice, no redirect followed.
    Only after `ctx.egress` lets the exact body leave for the `webhook` class (INV-12): the egress
    row's default lets nothing leave for it, so the operator declares `webhook: [operator-shared]`
    there; with no egress gate loaded, nothing is sent. The URL is kept in `ctx.credentials`
    under `webhook.credential` (`SYSTEM_NOTIFY_WEBHOOK_URL`), never in configuration, and never
    logged or recorded: MCP `notify_webhook` (operator) or `system notify webhook < file` stores
    it; it must be https, or http to this machine, with no user or password.
- **Health:** each outcome is a `notify.delivery` event (`sent`, `failed`, `dropped`,
  `unavailable`, with the sink, kind, subject, notice id, and why); MCP `status` health reads them
  (`notifications`, [mcp-server](../mcp-server/README.md)): degraded while a sink's latest outcome
  recently failed, or a notice was dropped recently.
- **Config:** `kinds`, `expiryLeadMinutes`, `dedupMinutes`, `maxQueue`, `pollSeconds`,
  `timeoutSeconds`, `maxAgeMinutes`, `link`, `desktop`, `webhook` ([configuration](../../../docs/reference/configuration.md#notify)).
  A `link` with a fragment, user, or password, a `webhook.credential` that is not a credential
  reference, or no `kinds` refuses the plugin at start.
- **Injects:** `store`, `eventLog`; reads `egress` and `credentials` when it sends to the webhook,
  and registers `notify_webhook` on `mcp` with `credentials`. It cooperates with the producers by
  events only and imports none of them.
- **Bundle:** its row, `notify`, is off; the operator turns it on
  ([runbook](../../../docs/operations/runbooks.md#get-notified)). Off, nothing else changes.
- **Tests:** [`tests/notify.spec.ts`](tests/notify.spec.ts): each kind read into its notice, the
  reminder, deduplication, the bounded queue, stale events, the configured kinds, a failing sink,
  the cursor across a restart, a long backlog, a request from the real approval queue, the desktop
  sink through a stand-in `notify-send`, and the webhook refused while egress is not declared or no
  gate is loaded, sent once it is, its URL in no event.
