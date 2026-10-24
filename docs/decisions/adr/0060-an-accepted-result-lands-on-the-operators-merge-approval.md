# ADR-0060: An accepted result lands in its repository on the operator's merge approval

- **Status:** Proposed
- **Date:** 2026-10-24
- **Related:** [PROP-0013](../../proposals/0013-feedback-from-work.md#landing-merge-or-apply) (W5),
  [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0056](0056-a-failed-lease-renewal-is-not-a-lost-lease-and-death-needs-a-verdict.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-4](../../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay),
  [INV-5](../../architecture/invariants.md#inv-5-exact-subject-binding),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact),
  [INV-15](../../architecture/invariants.md#inv-15-one-writer-per-subject)

## Context

A writing run works in its own git worktree, on `system/run/<runId>`
([workspaces](../../design/agent-runtimes.md#workspaces)). Its change stays uncommitted there. On
2026-10-24 (T99) the operator accepted such a result on `/ui`: the board task was `done`, and the
change was still uncommitted in the worktree. Nothing offered it for merge, and the lead copied the
diff into the repository by hand. The retention would have committed it on the branch a week later,
with no word of the task or the acceptance, and merged nothing.

PROP-0013 W5 designs landing as a `merge` approval bound to the base and head SHAs, done by the
plugin that owns the worktrees, the engine asking and recording. It was deferred until the pilot
produced work to land, which it now has. This record takes the smallest part of it: `merge` only,
asked by the engine once the board has the task `done`. `apply`, MCP `land`, and the code-host
observer stay deferred.

## Decision

1. **The engine asks, the worktree's owner lands.** The `workers` seam gains an optional
   `land(step)` (and `WorkerSource.land`), routed to the source that holds the worktree; a source
   that holds none answers undefined, one that throws is a refusal. A caller that finds no `land`
   lands nothing. No other seam changes: `merge` is an action class, the landing version is a
   subject version, and the board reads nothing new.
2. **Commit on acceptance, exactly.** Once the board has the task `done` on the run's result, and a
   result artifact names a working tree a source holds as the run's worktree, the source commits the
   worktree's changes on its branch, as the system, with a message naming the task, the run, the
   reviews of that tree, and the acceptance decision, and a `System-Subject` trailer. Only while no
   agent run of the workflow run can still write it, and only while the tree is still the accepted
   subject; a tree that moved is refused, and nothing is committed.
3. **Merge on approval, exactly.** The engine puts `merge` to the autonomy policy: `ask` opens one
   request on `{ git-head, system/run/<runId>, landing:merge:<base>:<head> }`, the base being the
   repository's checked-out branch at its head then, its consequences the `git diff --stat`; `forbid`
   refuses; `auto` and `notify` merge without asking, as the policy says. On the approval, the source
   merges the branch into the repository's checkout as one merge commit, only while the branch is at
   `head`, the checked-out branch is the base at `base`, and its tracked files are clean. A conflict
   is aborted so the repository is as it was. Never a force, a reset, a deletion, or a push: pushing
   stays the operator's.
4. **A moved base asks again.** A base that moved, or a working tree that was not clean when the
   approval came, is refused with a decision and asked again on the base as it is then (the
   operator's next approval). A head that moved, a conflict, or any other failure ends the landing
   refused; the branch keeps its commit for the operator.
5. **Recorded.** The commit, the merge, and each refusal is a `gate` decision of rule
   `workflow.landing` under the run's final step; the request carries the policy's `autonomy`
   decision, and the operator's verdict its `approval` decision; each change of state is a
   `workflow.task.landing` event. The task's view names the landing (`TaskView.landing`), and the
   Board shows it on the task's card.
6. **Restart is reconciliation.** The landing's state is durable on the run's task row; a request
   asked before a crash is adopted; a commit already made (the system's commit with the accepted
   subject's trailer on top of its head) and a base that already holds the head are found done, not
   done twice.
7. **Only new work.** A run reported before this change lands nothing (its branch is merged by hand,
   as before).

## Consequences

- An accepted result reaches the repository the next tasks are cut from, on one approval, with its
  history: the system's commit on the branch, then a merge commit naming the approval.
- The repository's main working tree is now written, but only by a merge the operator approved (or
  the policy allowed), checked against the exact SHAs it was approved on. The rest of the
  "never written" rule for worktrees stands.
- Each accepted result costs the operator one more decision on the queue (counted as an
  interruption in the report). A policy may make `merge` `auto`; whether `merge` should be always
  asked (`ALWAYS_ASK`) is PROP-0013's open question 5, unchanged here.
- The engine holds no lease on the base branch: one change at a time per repository within the
  daemon, and the SHA checks, guard it; a second daemon on the same repository is not supported.
- An artifact-subject result lands only when one of its result artifacts names the tree (the
  algorithm-development template's validation report does); a template whose final step is a
  model's answer, with no `writes`, lands nothing.

## Alternatives

- **The agents source does it all**, reading the board for done tasks: a capability plugin would
  decide when a core work state is acted on. Rejected; the engine owns the task's run.
- **The board proposes the merge**: the board knows nothing of git or worktrees (ADR-0036).
- **Commit at acceptance but leave the merge to the operator**: the gap T99 found stays half open,
  and the operator still has no queue item to act on.
- **Bind the approval to the head only, merging onto whatever the base is then**: the operator would
  approve a diff stat against a base that is no longer the one merged into (INV-5).
