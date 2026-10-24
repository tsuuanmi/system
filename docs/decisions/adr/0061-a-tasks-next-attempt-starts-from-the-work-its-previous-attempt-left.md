# ADR-0061: A board task's next attempt starts from the work its previous attempt left

- **Status:** Proposed. The carry is on by default in the code, pending the operator's acceptance
  (D59); until then its decisions are recorded as for any other.
- **Date:** 2026-10-25
- **Related:** T112 (from T110a), [PROP-0010](../../proposals/0010-base-version.md) (B4, B8),
  [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0058](0058-a-run-worktree-is-set-up-offline-before-its-agent-starts.md),
  [ADR-0060](0060-an-accepted-result-lands-on-the-operators-merge-approval.md), REQ-WF-14,
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-4](../../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay),
  [INV-5](../../architecture/invariants.md#inv-5-exact-subject-binding),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact),
  [INV-15](../../architecture/invariants.md#inv-15-one-writer-per-subject)

## Context

On the live host on 2026-10-24 (T110a), attempt 2 of a board task ran `algorithm-development`:
its `develop:1` step completed a correct 17-file change in the run's worktree, then its `review:1`
step failed as `session_broken` ("Reached maximum number of turns (4)"). The board counted the
attempt, and attempt 3 started from HEAD in a fresh worktree, redoing 7 minutes of work. The
earlier change was not lost (the retention commits it on its run's branch later), but nothing
reused it. `system continue` refuses a run that served an attempt, by design: the board decides
the next attempt, which is a new run ([board tasks](../../design/workflow-engine.md#board-tasks)).

What constrains reuse:

- **One attempt, one run, one worktree.** A workflow run works in its own worktree on
  `system/run/<runId>`; the retention, liveness, the operator's removal, and landing are kept per
  workflow run ([workspaces](../../design/agent-runtimes.md#workspaces), ADR-0060).
- **Exact subjects** (INV-5). A task that `writes` a `git-head` subject takes a result only on that
  commit; a review binds to `git:<HEAD>:<hash of every change on top>` and is shown the change
  relative to HEAD ([exact-subject gates](../../design/workflow-engine.md#exact-subject-gates)).
- **Judged work is not reused unseen.** A change a review asked to change, or a result the board
  (a person) rejected, is the reason for the next attempt, not a start for it.
- **One writer per subject** (INV-15): nothing may still write the earlier tree.
- **The `workers` seam is a guarantee seam** (ADR-0036): its contract changes by an additive,
  optional field only, with an ADR.

## Options

1. **Let `continue` run the failed step of a board task's run again.** The run's attempt was
   reported and counted; a second outcome for it would bypass the board, which decides attempts.
   Rejected.
2. **Give the next run the earlier run's worktree.** Two workflow runs in one worktree and one
   branch would break the per-run retention, liveness, removal, and landing. Rejected.
3. **Skip the next attempt's writing step, completing it with the earlier step's result.** The
   earlier result names the earlier worktree, so the review would bind to a tree the run does not
   work in; the engine would make up a node's completion from another run's execution; and the
   writer would never see its work again. Rejected.
4. **Cut the next worktree at a commit of the earlier tree.** The change would then be HEAD: the
   review's diff, relative to HEAD, would be empty, and the result would no longer be on the commit
   the task writes (`stale_subject`). Rejected.
5. **Commit the earlier tree on its own branch, as the retention would; cut the next run's worktree
   at the same base, holding that tree as its change, staged; and run the writing step again, told
   its worktree already holds the change.** The review reviews the whole change on the subject the
   task writes, a landing commits one change on the base, and no node completes without its own
   execution. Chosen: the smallest honest one.

When the work is reused:

6. **By the failure's kind alone.** A review can ask for changes, and the run then fail for a reason
   that says nothing about it (the fix's session breaks). Rejected as the only test.
7. **By what happened to the change, then by why the run ended.** Chosen.

## Decision

Options 5 and 7.

1. **Bounded, decided at admission** (INV-13), from the engine's own records, before the task is
   taken. When the task's immediately previous attempt left a writing step's result (a step that
   proves `develop`, completed, with an agent's result naming a git working tree and its subject),
   an `admission` decision (rule `workflow.task-worktree`) chooses `carry` only when all of these
   hold, and `fresh` with why otherwise:
   - that run served the attempt just before this one (`attempts.count`); only that attempt's
     work is ever carried, so a chain carries from the one before, never further back;
   - it failed (a completed run's result went to the board, which judged it), and it and each of its
     failed steps failed as a later step fails: `session_broken`, `provider_stalled`, `timeout`,
     `network`, `overloaded`, `quota_exhausted`, `reauth_required`, `challenge`,
     `reconciliation_failed`, `config_error`, `internal`, `budget_spent`, or `holder_lost`. A
     review's or a person's verdict (`plan_rejected`, `gate_timeout`, `call_rejected`,
     `call_expired`, `stopped`, `aborted`), a moved subject (`stale_subject`), a question, a denied
     egress, or anything not listed is not;
   - nothing in it was grown (no remediation cycle, no plan), and no review of it judged the change
     other than `approve`; no step of it asked questions;
   - the task writes a `git-head` subject, the run was admitted to write that same subject, and the
     tree is on its commit. A task that writes nothing never carries: no earlier tree is held as its
     own (INV-15).
2. **Carried by the source that holds the tree, before the run's first step.** At the run's first
   turn, after the board recorded it, the engine asks `ctx.workers.carry({ runId, from: { runId,
   workspace, subject }, message })`. The `agents` source commits the earlier worktree on its own
   branch, as the system, with the engine's message and `System-Subject` and `System-Carried-To`
   trailers, only while no agent run of its workflow run is unfinished or not known to be gone, the
   worktree is intact and on its branch, the repository's HEAD is still the commit the tree is on
   (where a fresh worktree is cut from: the carry never moves a run onto another base), and the
   worktree is still exactly the subject its writing step left. It then adds the new run's worktree
   on `system/run/<runId>` at that commit, without a checkout, and reads the committed tree into it
   (index and files), so its HEAD is the base and the earlier change is its own, staged.
3. **Told, then reviewed.** A `gate` decision of the same rule records what the source did, naming
   the earlier run, the commit, its branch, the base, and the new worktree, or why the run starts
   from HEAD instead. Every brief of a carried run points first at that decision (role `prior`),
   its note saying the worktree already holds the change and to build on it. The writing step runs
   as in any attempt; the review then binds to the whole change on the subject the task writes;
   the result and its landing are as for any attempt.
4. **Fails closed** (INV-2): anything that does not hold, a refusal (`moved`, `gone`, `busy`,
   `base-moved`, `exists`, `empty`, `failed`), no source holding the tree, a source that cannot
   answer, a lost holder, or a `ctx.workers` without `carry`, and the run's worktree is cut from
   HEAD as before, recorded with why. A refusal before the commit leaves the earlier tree as it was.
5. **Restart is reconciliation** (INV-4). The carry's state is on the run's `workflow_tasks` row
   (`due` until settled); the source finds a commit and a worktree it made and says so; a worktree
   cut and not yet given the tree is never run in, and is given it when asked again, or put back to
   its base, a fresh worktree, when the tree can no longer be given. What such a worktree holds is
   no run's work (its index empty, every file of its base staged as deleted), so the retention and
   the operator's removal put it back to its base before they retire it and never commit it; one
   that cannot be put back to exactly its base stays, marked, for the operator. A run's branch
   whose tip is a retention's commit of such a tree, made before this rule (T127 review item 2), is
   never added again as a worktree.
6. **Seams.** `workers` gains the optional `carry(step)` and `WorkerSource.carry` (additive,
   ADR-0036; its conformance suite gains the case). Nothing else changes: the `workflow` contract
   (1.6) and the board's are as they were, as for landing (ADR-0060), since a `ctx.workers`
   without `carry`, or a source that holds no tree, leaves every attempt as before; no schema
   changes (`admission` and `gate` decisions, a brief pointer with role `prior`).

## Consequences

- T110a's case costs one writing step that finds its work done, instead of the whole change again.
- The earlier run's branch keeps the system's carry commit, which is never merged: the next run's
  branch starts at the base, and its landing commits the whole change there. Branches are never
  deleted, as before.
- The new worktree's setup (ADR-0058) runs on the carried tree, which an earlier agent run wrote:
  ADR-0058's "at the HEAD the worktree was cut from" does not hold for a carried worktree. The
  repository's install scripts as that agent left them run in the setup, under the setup's
  confinement (the host read-only but the worktree, no network, a deadline). The agent could run
  its own commands under the same bounds, and a listed validation command runs the code it wrote
  already; what the setup adds is reading the package store's files its views show read-only.
  Revisit if a setup is ever given more than a Worker's own confinement.
- One more decision for every next attempt after a writing step (`fresh` or `carry`), and one more
  when it is carried.
- An earlier attempt's work is never carried onto a moved HEAD; rebasing it is the operator's.
- The carried worktree is on the repository of the earlier tree. A writing step routed to a Worker
  on another repository works there as before (routing does not know a task's repository), and
  its brief would still say the run's worktree holds the change: a task's writers are on one
  repository.
- A crash between the new worktree's `git worktree add` and its row leaves a path the source does
  not know, as a crash in the same place of a fresh worktree's creation does: the carry is refused
  (`exists`), the attempt's first agent run refuses the path, and the operator removes it.
- Revisit when the board or a lead may choose the start of an attempt itself, or when a carried
  tree should go to a review before its writing step runs.
