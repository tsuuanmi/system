# ADR-0069: An attempt is not spent on an infrastructure failure

- **Status:** Accepted (2026-10-26, by the operator, D82 #3; built in T218)
- **Date:** 2026-10-26
- **Related:** T218, T213, T215, D82, [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0064](0064-system-starts-ready-work-under-the-dispatch-action-class.md), REQ-WF-6,
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-4](../../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

A board task makes at most `attempts.max` attempts. The board counts one when it records a run
(`start`), and a failed run's report (`reconcileRun`, failed) keeps it counted. T213 lost its
attempts to a live update's restart, which stopped its run, and to a dispatch bug (T215) whose
refusal failed a run before anything was sent. Neither said anything about the work; the task
still ended waiting for input (`retries-spent`), and the operator had to propose it again.

The operator decided (D82 #3, 2026-10-26): an attempt is not spent on an infrastructure failure. A
run stopped by the host's drain or restart, a run that failed before anything was sent (admission
or routing refusals, nothing submitted), and a run that failed only because a Worker became
unavailable mid-run do not count. The decision and its reason are recorded, and such free retries
are bounded (configured, validated, INV-9) so a persistent infrastructure failure still ends in
waiting for input, with the reason.

What constrains a fix:

- **The board counts attempts** and is a guarantee seam: its contract changes only by an ADR
  (ADR-0036), and it fails closed (INV-2).
- **The engine owns the run** and is the only one that knows how it failed (INV-4: its own records,
  never a guess).
- **Bounded** (INV-9): no failure may loop for ever, whatever its cause.
- **Recorded** (INV-13): not counting is a decision with a reason.

## Options

1. **Raise `attempts.max`.** Every attempt still spends one; a restart still costs the work.
2. **Have the engine retry such a run itself, under the same attempt.** A run that served an attempt
   is that attempt (the board decides the next); the engine would start work the board did not
   record (run first, then work), and the bound would sit outside the seam that counts.
3. **Have the run's owner say a failed run failed only on the infrastructure, and the board give
   the attempt back, within a bound per task it keeps and configures.** Chosen.

## Decision

- **Contract 1.5 of `ctx.board`** (a minor): a failed `RunOutcome` may carry `infrastructure`,
  `{ kind, reason }`: `host-stopped`, `unsent`, or `worker-unavailable`, and a reason of 1 to 500
  characters, nothing else (`infrastructureProblem`; malformed: `invalid`, and nothing moves).
- **The board's move.** While the task has free retries left, `reconcileRun` does not count the run:
  `attempts.count` goes back by one, and the task goes back for the same attempt through the gate
  (ready, or `approval-needed` on that attempt's subject). Its `board` decision says why, with the
  kind, the reason, and the free retries used and allowed (`outcome.detail.infrastructure`,
  `outcome.detail.freeRetry`). Past the bound the run counts like any failed run, and its decision
  says so, with the reason: a persistent one ends the task waiting for input (`retries-spent`).
- **The bound.** `board.maxFreeRetries`, default 3 (`FREE_RETRIES_DEFAULT`), a whole number from 0
  to 10 (`FREE_RETRIES_MAX`), validated when the board loads (`freeRetriesOf`; the row is refused
  otherwise). The store-backed board keeps the count beside the task's record
  (`board_tasks.free_retries`, migration 3), so the bound holds across restarts and over the task's
  whole life; the record's schema is unchanged.
- **How the engine tells** (`workflow`, `infrastructure.ts`), from its own records only:
  - `host-stopped`: a step whose execution its Worker source ended marked `host-stopped` (its
    holder stopped with it in flight, and that alone ended it: agent Workers mark a run reconciled
    after its holder stopped, website turns a turn reconciled after its owner stopped); or a run
    whose board holder lapsed while the host was down, found at its first renewal after the start;
  - `worker-unavailable`: a step that failed, nothing of it sent, because routing refused it with an
    otherwise fitting Worker `unavailable`, its Worker source is no longer loaded, or its execution
    ended unsubmitted while its Worker reads `unavailable`; or one its source ended marked
    `worker-unavailable`, sent or not (its Worker went away mid-run, and that alone ended it);
  - `unsent`: every execution the run started is one its source reports never submitted (one its
    source no longer knows counts as sent), and every step that failed failed on a Worker's own
    failure before the send (`network`, `overloaded`, `provider_stalled`, `session_broken`, `quota_exhausted`, `reauth_required`, `challenge`: its network,
    overload, stalled or broken session, its account's usage limit, sign-out, or challenge).
  - Always the attempt's, fail closed, even with nothing sent: a run the operator stopped; a run
    that failed for its own reason rather than a failed step's (its task's budget spent,
    `budget_spent`, or not reservable on the ledger, a result off its subject, no step able to run);
    and a step that failed for the task's own input, policy, configuration, or code (any other kind:
    `invalid_input`, `egress_denied`, `config_error`, `internal`, a timeout, a rejection). Only a
    kind named above, or a mark the engine or a source set, is the infrastructure's.
- **The source's word** (`ctx.workers`, a compatible addition): a failed `WorkerExecution`'s error
  may carry `infrastructure`, `host-stopped` or `worker-unavailable` (`ExecutionInfrastructure`),
  set only by a source that knows the infrastructure alone ended it. A failure of the execution's
  own (a sandbox or `.git` violation, a result whose subject was not captured) never carries it,
  whatever its kind, and whether or not the host restarted while it ran.
  A failed step is marked on its row (`workflow_nodes.infrastructure`, migration 22), and any
  other failure clears the mark. The run's failure is the infrastructure's when it is a failed
  step's and every failed step is marked, or when nothing of it was sent and every failed step
  failed on one of the Worker failures `unsent` names. The report's `reconciliation` decision
  (`workflow.task-report`, version 2) names it, or says why the attempt counts.

## Consequences

- A live update's restart, a dispatch refusal, or a Worker that goes away mid-run no longer costs a
  task an attempt, up to three times per task by default; the fourth counts.
- A refusal by the task's own budget, policy, input, or configuration that sends nothing (a spent
  budget on the last attempt, a template's placeholder left unfilled, a requirement no Worker
  meets) counts at once: a free retry would only meet it again until the bound ran out.
- The next run serves the same attempt number, and an approval of that attempt's subject still
  covers it: the attempt was never made.
- Anything not shown to be the infrastructure's (a sent step's own failure, an operator's stop, a
  rejection, a question, a spent budget) counts as before. The engine needs a board at 1.5 to
  report it; the store-backed board and the fake are.
- A decision's reason is clamped to 300 characters: the board's and the engine's decisions say the
  outcome first and the owner's reason last, and their detail keeps the reason whole.
- `maxFreeRetries: 0` restores the old behaviour.

## Rejected alternatives

The options above; also: a field on the task's record (a schema change for a count the board alone
needs); deciding by error kinds alone (agent Workers end a sandbox or `.git` violation
`reconciliation_failed` too); and taking a step in flight across a restart that then ended
`reconciliation_failed` or `aborted` as the host's (it may have outlived the restart and failed for
its own reason: only its source knows, so only its source's mark says so).
