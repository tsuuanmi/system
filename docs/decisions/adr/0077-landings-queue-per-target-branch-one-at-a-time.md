# ADR-0077: Landings queue per target branch, one at a time

- **Status:** Accepted (2026-10-27; built in T318b), on PROP-0016 I3 ("integration queue"). It amends the
  consequences of [ADR-0068](0068-an-accepted-result-is-rebased-onto-its-target-and-checked-again-before-it-lands.md)
  (the bound of 3 rebases) and adds one optional member to the `workers` seam's `rebase` step.
- **Date:** 2026-10-27
- **Related:** [ADR-0060](0060-an-accepted-result-lands-on-the-operators-merge-approval.md),
  [ADR-0063](0063-a-runs-required-checks-run-on-its-exact-result.md), T216, T292, T299,
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-4](../../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay),
  [INV-5](../../architecture/invariants.md#inv-5-exact-subject-binding),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-15](../../architecture/invariants.md#inv-15-one-writer-per-subject)

## Context

With dispatch auto and up to 12 runs, results reach landing together. Each landing rebases onto the
target and runs the full suite there (minutes under load, T299) while the others move the target. T298
and T299 ended with "dev moved again after 3 rebase(s) of this result: a target that keeps moving is
not followed further", and the lead merged both by hand. The bound of ADR-0068 was right for a target
that moves now and then; it is wrong when System itself moves the target under its own landings.

## Decision

1. **One queue per repository and target branch**, kept on the landings' own rows
   (`workflow_tasks.landing.queue`: key `<repository>#<branch>`, a `seq`, and the `turn`), so it is
   durable and a restart reads it (INV-4). A result enters it when its commit has read the target, in
   the order it was committed.
2. **One landing at a time.** Only the landing that holds the turn rebases, checks, asks, and merges.
   The others wait in state `queued`; when the holder reaches an end (merged, returned, refused,
   rejected), the first waiting one is promoted and reads the target again through the commit step. A
   later result never moves the target under an earlier one's landing.
3. **Between queued results, "moved again after N rebases" cannot happen.** The target moves under a
   queued landing only by a push the queue did not make. Those moves are still bounded (INV-9): a
   landing follows at most 8 (`MAX_OUTSIDE_MOVES`), then is refused for the operator to merge by hand,
   its reason saying the target was moved from outside. A result whose rebase conflicts goes to its
   author's Worker, and back to the board when unresolved, as in ADR-0068.
4. **An optional batch** (`landingBatch`, default 1: none; at most 8): when the queue holds several
   results, the head takes the next N as a stack (state `stacked`). Each is rebased onto the one before
   it (the source's `rebase` step takes `stacked`: its base is that result's rebased head, which holds
   the target's tip), the tip's full suite runs once, and one merge request lands the stack; the ones
   under the tip are then merged with it. A stack whose checks fail is bisected over the results' own
   trees: the first result that fails on top of the ones before it goes back alone (`bisect` decision),
   the ones before it land as a smaller stack, the ones after it return to the queue, their branches put
   back. The size is on the queue record and on the `queue` decision.
5. **A salvage's wait is advisory; System does not enforce it.** A lead's or operator's push to the
   target is a `git push` outside System, which has no hook on it, so no code can make it wait or take
   the turn. The playbook (LD14) tells the lead to push only when `system explain` shows no landing
   holding the turn, or to let the queue land the change as a result; its check is **none**. What System
   does enforce is that a push which lands anyway never makes a landing merge a tree that was not
   checked: the holder's rebase or merge is refused as a moved base and read again (INV-5), at most 8
   times (decision 3). An enforced fence (a queue entry a salvage takes through a System command) is
   left for a later change.
6. **Shown**: `system explain` and `/ui` say a result's place, who holds the turn, and its stack.

## Consequences

- A landing is never starved or refused for a target that other landings moved; the cost is that
  landings are serial, each waiting for the operator's merge approval before the next starts. The batch
  trades that wait for one approval per stack.
- A queued result that waits long was committed on an older target: it is committed again when promoted.
- The head's approval is the queue's throughput: an unanswered merge request holds the turn until it is
  answered or expires.
- The source's `rebase` step gains `stacked`; a source that ignores it refuses a stacked rebase as a
  moved base, so a batch needs the `agents` source of this version.
