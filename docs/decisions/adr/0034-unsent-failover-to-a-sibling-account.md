# ADR-0034: An unsent attempt moves to a sibling account; usage limits set cooldowns

- **Status:** Accepted
- **Date:** 2026-10-19 (accepted 2026-10-19, by the operator, with [PROP-0007](../../proposals/0007-account-pools.md))
- **Related:** REQ-WRK-8, [INV-4](../../architecture/invariants.md),
  [ADR-0021](0021-ui-operations-as-data.md), [ADR-0033](0033-least-busy-routing.md)

## Context

- `quota_exhausted`, `challenge`, and `reauth_required` are `USER_ACTION`. A node that hits one of
  them fails, even when nothing was sent and a sibling account of the same provider is ready.
- An unsent `overloaded` is retried, but the retry may route to the same account.
- No UI map recognizes a site's usage-limit message, and nothing sets an account
  `quota-exhausted`. So REQ-WRK-8's "accounts whose quota is exhausted are excluded before
  admission" is not met.
- A started turn must never be moved (INV-4, [routing](../../design/routing.md)).

## Options

1. **Keep failing.** The operator moves work by hand.
2. **Retry any failure on a sibling.** This would duplicate a sent turn (INV-4).
3. **Retry only an unsent attempt, with the failed account excluded. Record usage limits as
   cooldowns that admission respects.**

## Decision

Option 3.

- **Failover is a recovery outcome.** When a workflow node fails with `quota_exhausted`,
  `challenge`, `reauth_required`, or `overloaded` and its receipt proves **nothing was sent**,
  recovery chooses `failover` within the node's `maxAttempts`. The `recovery` decision names the
  failed Worker, the kind, and the unsent proof.
  - The exclusion is stored on the node row beside `not_before`, so a restart keeps it.
  - The router takes `excludeWorkers` and records it as a rejection reason.
  - A sent or possibly sent turn never moves; reconciliation applies as before.
  - A node bound to a session's Worker never moves.
  - A bare `ask` has no recovery and fails as before.
- **Usage limits.** A site shows a limit in one of two places:
  - **Before sending** (a banner, or a tool marked as limited): a UI-map error rule of kind
    `quota_exhausted`, with an optional `feature`. The turn fails unsent and may fail over.
  - **As the reply after sending**: a map element for the limit answer classifies the sent turn
    `quota_exhausted` with its feature. Its node fails and does not fail over.
- **Cooldowns.** Either case sets a cooldown on the account's Workers, `{ feature | "*", until,
  source }`, for the configured `featureLimitCooldownMs` (default 6 h) or `accountLimitCooldownMs`
  (default 1 h).
  - A cooldown clears when its time passes, when a turn that used the feature succeeds, or by the
    operator (`system account clear-cooldown`). A feature probe never clears it.
  - A Worker in cooldown for everything it proves reads `quota-exhausted`. Work that needs a cooled
    feature does not admit that account.
  - A cooldown is never the account's `status`. The account stays `ready`, its sign-in checks and
    probes keep running, and health does not ask the operator to act.
- **No guessing.** Repeated `overloaded` is never taken as a limit, and reset times are not parsed
  until a live limit text shows their format.

## Consequences

- REQ-WRK-8's exclusion before admission becomes true. [Routing](../../design/routing.md) loses its
  "nothing sets a Worker `quota-exhausted`" gap.
- Limit rules ship empty until a site's limit text is seen live. Until then a limit still looks like
  a site error or a stall, and the operator overlay can add a rule without a release (ADR-0021).
- An unsent `challenge` or sign-out on one account no longer stops a run when a sibling is ready.
  The account still needs the operator, and health says so.
- New values only (`failover`, the node's exclusion, the error rule's `feature`, the cooldowns), so
  old runs still explain.
