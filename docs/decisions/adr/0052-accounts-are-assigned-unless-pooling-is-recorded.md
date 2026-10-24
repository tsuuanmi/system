# ADR-0052: Accounts are assigned unless the operator records that a provider's terms allow pooling

- **Status:** Proposed (written on the operator's acceptance of PROP-0012, D23, and answer D24);
  supersedes [ADR-0034](0034-unsent-failover-to-a-sibling-account.md) in part, for assigned providers;
  superseded in part by [ADR-0055](0055-personal-accounts-may-be-pooled-on-the-operators-recorded-acceptance.md)
  (accepted 2026-10-24, D38; D33: `pooled` is the operator's recorded decision, and a personal subscription
  qualifies when the operator records that they accept the risk under its terms)
- **Date:** 2026-10-24
- **Related:** [PROP-0012](../../proposals/0012-agent-accounts.md),
  [PROP-0007](../../proposals/0007-account-pools.md),
  [PROP-0008](../../proposals/0008-studio-operating-model.md),
  [ADR-0033](0033-least-busy-routing.md), [ADR-0034](0034-unsent-failover-to-a-sibling-account.md),
  [ADR-0035](0035-one-family-teams-keep-distinct-accounts.md),
  [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0051](0051-agent-accounts-are-enrolled-slots-identified-by-their-login.md),
  REQ-ACC-10, REQ-WRK-8,
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-4](../../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-11](../../architecture/invariants.md#inv-11-no-tool-lock-in),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

All eight of the operator's agent subscriptions, and the website accounts, are personal paid
plans (D24, 2026-10-23). Rotating personal accounts to get around usage limits is restricted or
prohibited by the providers' terms (PROP-0012 research H4), and unresolved terms are not
permission. ADR-0034 moves an unsent attempt that hit an account's limit, challenge, sign-out, or
site error to a sibling account of the same provider, and its cooldowns steer new work to the
least busy sibling: exactly such a rotation once a provider has two accounts. The operator's
answer: accounts are assigned, not pooled; when one hits its limit its work waits for its reset and
never moves to another account of that provider; the website accounts get the same setting,
assigned by default.

## Options

1. **Keep ADR-0034 and add a flag to turn rotation off.** Pooling stays the default; unresolved
   terms would be treated as permission.
2. **Strict fixed scopes**: each role and project has exactly one account per provider. It forbids
   the parallel use the operator kept (D24: accounts still serve parallel roles and team
   independence).
3. **A per-provider setting `accounts: assigned | pooled`, `assigned` by default; under `assigned`
   a limit makes the account's work wait and never moves it inside the provider group; `pooled`
   only on the operator's recorded confirmation of that provider's terms.**

## Decision

Option 3. The rules apply only to Workers whose descriptor declares an `account`; a Worker with
none (a model Worker) is routed exactly as before. Routing, teams, and workflows compare the
account's `id` and `group` for equality only and never name a provider (INV-11).

- **The setting** is per provider: on each website provider of the `accounts` row, and on each
  agent provider of the `agent-workers` row. `pooled` is refused at load unless the provider's
  settings carry `pooledTerms` (who confirmed, when, which terms they read); the source records it
  at each start as a `gate` decision. Personal subscriptions never qualify (D24).
- **The `workers` seam** (a guarantee seam, changed only additively, ADR-0036):
  - the descriptor's optional `account: { id, group, mode, limitUntil? }` (`capability-descriptor@1.5`);
  - the admission check `assignment`: when, under `assigned`, a Worker is refused only for its
    limit (state `quota-exhausted`, or the `cooldown` check) and would otherwise be admitted, every
    Worker of another account of the same group is refused that work, saying until when;
  - `AdmissionFailure.limitUntil`: when every Worker refused only for its limit is on an assigned
    account, the earliest reset among their known limits (absent when none is known);
  - `RouteOptions.assignment: { group, account, reason }`: no other account of that group may take
    the work (check `assignment`), set by the engine after an unsent failure on an assigned account.
- **The `workflow` seam** (contract 1.5):
  - **wait.** A node refused only for limits of assigned accounts is not failed: the `recovery`
    decision chooses the new outcome `wait` (`decision@1.8`), and the node stays `READY` with
    `not_before` the reset, persisted on its row, so a restart keeps waiting (INV-4). A wait spends
    no attempt and sends nothing. It is bounded: a node waits at most `maxLimitWaitHours` (default
    24) in all, counted from its first wait; past that, or with no known reset, it fails
    `quota_exhausted` as before and the operator decides (INV-9).
  - **No failover inside the group.** After an unsent `quota_exhausted`, `challenge`, or
    `reauth_required` on an assigned account, the next attempt prefers a Worker outside the failed
    account (as ADR-0034), and no other account of its group may take it (`RouteOptions.assignment`,
    stored on the node row). With no Worker of another group, it routes back to its own account: a
    limit then waits for its reset, and a challenge or sign-out fails for the operator
    (`USER_ACTION`) as before ADR-0034. An unsent `overloaded` is retried with back-off, never as a
    failover, under the same rule.
- **What changes for ADR-0034, under `assigned` only:**

  | ADR-0034 | Under `assigned` |
  |---|---|
  | an unsent `quota_exhausted` fails over to a sibling account | it may move to another group; otherwise it waits for that account's reset (`wait`), bounded |
  | an unsent `challenge` or `reauth_required` fails over to a sibling account | it fails over only outside the group; with none, it fails (`USER_ACTION`) |
  | an unsent `overloaded` fails over to a sibling account | it is retried with back-off, never on another account of the group |
  | a limit's cooldown steers new work to the least busy sibling | the cooldown stands; work the limited account could take waits (`assignment`) |

  Under `pooled`, ADR-0034 stands as accepted. Cooldowns, their sources, and how they clear are
  unchanged in both modes; so are least-busy routing (ADR-0033) and one-family teams (ADR-0035).
- **Parallel use stays** (PROP-0012 open question 5, as proposed): accounts of one provider may
  serve the same role at once; the `assignment` check, not fixed scopes, stops the rotation.
- **Pool templates** (`resources`): a template names a pool's kind, windows, and the provider
  group it applies to; the `agents` source declares its ready accounts (`declare`), and the ledger
  makes one pool per template and account, so a limit on one account never closes another's. It
  is an optional method on the resource ledger, added with PROP-0012 phase F, when an agent
  provider first has several accounts.

## Consequences

- With one account per provider, as on the live host, routing chooses exactly as before: the
  `assignment` check refuses nothing without a second account in the group. What changes there is
  that a node refused for its assigned account's known limit waits for the reset, bounded, instead
  of failing at once.
- Website providers with two or more accounts become `assigned` on upgrade: PROP-0007's limit
  failover stops for them until the operator records `pooledTerms`.
- A waiting node holds its run open (it counts toward `maxActiveRuns`, and a drain waits for it)
  until its reset or the bound.
- New values only (`account`, `assignment`, `limitUntil`, `wait`, the node's `assignment` and
  `limit_wait_since`), so old runs still explain.
- Revisit when a provider's terms are confirmed to allow pooling (then `pooledTerms`, nothing
  else), or if the operator wants a waited node to hold longer than a day for a weekly limit
  (PROP-0012 open question 6).
