# ADR-0054: A funding request names the holds the ledger did not release

- **Status:** Proposed (it implements the operator's decision D31 (c) of 2026-10-24)
- **Date:** 2026-10-24
- **Related:** [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0044](0044-funding-raises-a-spent-task-budget.md),
  [ADR-0047](0047-a-run-stops-at-a-boundary-once-its-task-budget-is-spent.md),
  [ADR-0053](0053-workflow-contract-states-task-budget-question-and-tasks-file.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

Before each step of a board task's run, the workflow engine reserves the task's lines on the
resource ledger (ADR-0047, step 1). A step's hold is released once the step settles. When the
ledger does not release it (its store did not answer, say), the hold stays on the run's row and
keeps counting against the task's caps until it expires (`holdSeconds`, 4 hours by default).

Such a hold can refuse the next step on its own. The engine then blocks the task (`budget-spent`)
with a funding ask computed from recorded usage only (ADR-0044). Recorded usage reaches no line, so
the ask is empty, and the operator gets a request that names nothing and asks only to go on.

The operator decided (D31 (c), 2026-10-24) that failing closed stays: the hold still counts. But
the funding request names the hold, its step and its expiry, instead of asking with nothing named.
The board writes the request, and `board` is a guarantee seam, so its contract changes only through
an ADR (ADR-0036).

## Options

1. **Board contract 1.3, a minor.** `block` takes an optional `unreleased` list for `budget-spent`.
   The board names each hold in the request it opens.
2. **Release or ignore the hold in the engine.** This would draw past a cap the ledger still
   enforces, against INV-2 and the operator's decision.
3. **Name the holds only in the run's failure message.** The operator decides on the request, in
   the queue, so the reason would not be where the decision is made.

## Decision

Option 1.

- **The seam.** `block(taskId, generation, { reason: 'budget-spent', funding?, unreleased? })`.
  `unreleased` holds 1 to 8 entries `{ runId, step, expiresAt? }`: a run id and a step of 1 to 200
  characters (`run` for an earlier engine's one reservation per run), and an ISO date when known.
  A malformed list, or one on another wait, is refused as `invalid`, and nothing changes. On an
  `ask` verdict, the request's consequences name each hold and say that the next attempt may be
  refused again until they expire. Its summary counts them.
- **What does not change.** The request's subject, which binds a funding ask's lines (INV-5). The
  wait and the `board-task` record. Nothing is released, raised, or skipped because of the holds.
  A request asked again after a policy change does not name them, since the wait does not keep
  them. They are reported, not stored state.
- **The engine.** When a spent run blocks its task, it first asks the ledger once more to release
  the holds that no running step owns: the spent run's own, and those an earlier, finished run of
  the task left. It names the ones the ledger still holds and that have not expired, at most 8,
  those that count longest first. It fixes them on the run's row with the funding ask, before the
  block, so a block asked again after a crash names the same ones. Each step's hold now records its
  expiry when the ledger gives one. The run's failure message names them too.
- **Why a minor.** The field is optional, and a block without it behaves as at 1.2. A consumer's
  `^1.2` range accepts a 1.3 provider. The new scenario covers only blocks that name the field.
  This follows ADR-0044 (board 1.1 to 1.2).

## Consequences

- `BOARD_CONTRACT` is 1.3. The conformance suite adds `board.budget-spent-names-unreleased` since
  1.3, run against the fake and the store-backed provider. The manifests take the new contract.
- `unreleasedProblem` and `unreleasedText` in `board-core` are the one check and the one wording,
  so the providers name holds alike.
- No schema changes: the request's consequences are text, and the run's view keeps the list in
  `task.budget.unreleased`.
- With the holds named, the operator can wait for their expiry before approving. An approval given
  sooner lets the next attempt go on, and the ledger may refuse its first step again, which fails
  closed as before.
