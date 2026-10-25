# ADR-0065: A cap fails closed on usage the ledger could not count

- **Status:** Accepted (2026-10-25, by the lead on the operator's delegation for dev-branch work, answering T190's questions under INV-2)
- **Date:** 2026-10-25
- **Related:** [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0053](0053-workflow-contract-states-task-budget-question-and-tasks-file.md),
  [resources](../../design/resources.md#usage-the-ledger-cannot-count), D25,
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

The live `usage` health check was degraded by a run whose usage the ledger could not count
(`not-reported`). A run's numbers come from its runtime's final message (the Claude Agent SDK's
`result`, Codex's turn count); a run that ends by a stop, a timeout, a drain at the host's stop, or a
deferred call has none, and what the runtime reported while it ran was dropped. Under D25 every cap
counted such a run as 0, so a board task's budget lines could be spent past their amount unseen,
which INV-2 forbids: a degraded path is an explicit error, never a silent default. The resource
ledger is a guarantee seam: its cap semantics change by an ADR (ADR-0036).

## Options

1. **Keep counting as 0 (D25).** Visible, but a cap's amount is not a bound. Rejected.
2. **Fail closed for metered pools only** (D25's third option). A subscription pool's caps would
   still count unknown runs as 0. Rejected by the operator: INV-2 holds for every pool kind.
3. **Estimate the usage.** No objective source gives it; a model's own report is never one.
   Rejected.
4. **Record what the runtime did report, as a lower bound, and fail a cap closed while a run of its
   scope is not reconciled, for every pool kind.** Chosen.

## Decision

1. **A runtime reports a partial count.** `RunMetering` gains the optional `partial` (plain words,
   at most 300 characters): the run ended before the runtime's final count, and `usage` and `turns`
   are what the agent reported while it ran, a lower bound. A partial report names no `resultId`.
2. **The `agents` source records it.** A partial report with a number above 0 becomes the run's
   `usage-record` and a `not-reported` fact (`usage-unknown@1.1`) whose `partial` names that record;
   one with no number above 0 becomes no record. Every fact's `reason` says how the run ended.
3. **Reconciled** means the ledger counts a record of the run in its pool other than its own lower
   bound (`reconciledBy` in libs); health, the report, and the ledger use the one rule.
4. **The store-backed ledger refuses a reservation** whose caps have a scope (a task, else a
   project) while a run of that scope (by its fact, else by its reservation) has a fact in a capped
   pool and is not reconciled. The `budget` decision names each such run, its Worker, and why. It
   refuses too when no event log is loaded, when more than 10,000 `usage.unknown` entries are kept
   (INV-9), or when an entry is not a valid record: whether such a run exists is then unknown. A
   request without caps, or caps without a scope, is not concerned.
5. **Health names the runs**: the latest three per pool, each with its Worker, kind, whether a
   lower bound was counted, and its reason.

## Consequences

- Until transcript reconciliation exists, nothing reconciles such a run: a task whose budget caps
  its pool stays refused, and funding does not help. The way out is to cancel the task and file it
  again without that cap, or to wait until the run's usage is counted (runbook, "Usage the ledger
  could not count").
- The `resources` contract version is unchanged: a stricter refusal of `reserve`, which may always
  refuse. The seam's conformance suite gains the rule once its fake ledger can read the event log;
  until then the store-backed ledger's own tests hold it. Its tests load the event log, as the host does.
- A later `transcript` record of a run with a `runtime-result` lower bound is a duplicate under the
  ledger's dedupe rule; transcript reconciliation will have to replace the lower bound, not add one.
- A counted record without the figure of a cap's unit still counts 0 of that unit; that case is
  not changed here.
