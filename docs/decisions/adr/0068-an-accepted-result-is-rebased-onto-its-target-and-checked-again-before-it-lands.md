# ADR-0068: An accepted result is rebased onto its target and checked again before it lands

- **Status:** Proposed (2026-10-26, T216), built on the operator's decision D82 #1 (2026-10-26). It
  amends [ADR-0060](0060-an-accepted-result-lands-on-the-operators-merge-approval.md)'s decision 4
  ("a moved base asks again") and adds to the `board` and `workers` seams, each by an optional member.
- **Date:** 2026-10-26
- **Related:** [ADR-0060](0060-an-accepted-result-lands-on-the-operators-merge-approval.md),
  [ADR-0063](0063-a-runs-required-checks-run-on-its-exact-result.md),
  [ADR-0061](0061-a-tasks-next-attempt-starts-from-the-work-its-previous-attempt-left.md),
  [ADR-0036](0036-guarantee-core-and-capability-plugins.md), T166 (generated files), T210 (number
  collisions), [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-4](../../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay),
  [INV-5](../../architecture/invariants.md#inv-5-exact-subject-binding),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact),
  [INV-15](../../architecture/invariants.md#inv-15-one-writer-per-subject)

## Context

Seen all night on 2026-10-25/26 on the `system` repository: almost every board task's result was
cut from an older `dev`, because other tasks landed while it ran. ADR-0060 lands a result by merging
its branch into the base as it is when the operator approves; a base that moved after the request
was asked is asked again, and a merge that conflicts is refused. So about twelve results conflicted
(in code, in docs, and in the numbers of ADRs, migrations, and schemas that T210's check caught), and
the lead merged each by hand. Even a merge that did not conflict merged a tree no check had run on:
ADR-0063 checks the result's own tree, not what the merge makes of it with the newer base.

What constrains a fix:

- **Exact** (INV-5): what the operator approves must be the tree that is merged, and what was checked.
- **One writer** (INV-15): the run's worktree is written only while no agent run of it can write.
- **The board's states**: `done` is terminal at contract 1.3; a landing happens after `done`, so a
  result found not to hold on the newer base has no way back to the board.
- **Attempts are the task's budget of tries**: a base that only moved is not the result's fault.
- **T166** already makes a repository's declared generated files again on a merge that conflicts
  only in them; the same commands apply to a rebase.

## Options

1. **Keep ADR-0060: refuse a conflict, the operator merges.** What failed twelve times a night.
2. **Merge the base into the run's branch** (a sync merge) instead of rebasing: history with a merge
   per moved base, and the same conflicts to resolve; no gain over a rebase, and a branch whose
   change against the base is harder to read.
3. **Rebase before acceptance**, inside the run: the run's review would be of another tree than the
   accepted one, and a result held for the operator's review (hours) is rebased onto a base that
   moves again before the landing anyway.
4. **Rebase at landing, before the merge request, then check again; a failure goes back to the
   board.** Chosen.

## Decision

1. **When.** The landing's commit step (ADR-0060) also reports where the committed head forked from
   the base (`Landed.committed.fork`, their merge base). When that is not the base's head, the base
   moved since the result's work started, and the landing rebases the result before it asks for the
   merge. A base that moves after the request was asked is found so at the merge, as before; the
   commit then reports the new fork, and the result is rebased again. At most 3 rebases per landing
   (INV-9); past them, refused for the operator.
2. **How: by the source that holds the worktree.** `LandStep` gains `rebase` (phases `start`,
   `resolved`, `abandon`) on the `workers` seam's existing optional `land`. In the run's worktree,
   which stays on its branch, only while it is intact and free of agent runs: the head is kept under
   `refs/system/rebase/<runId>/<head>`, the branch moved to the base (only from the head), the
   result's change (fork to head) replayed there (a squash merge); a conflict only in declared
   generated files takes a side; the generated files are made again by the repository's commands
   (T166's confinement and policy checks), which may change nothing else; then one commit by the
   system, the head's message, a line saying what moved, and `System-Rebased-From` and
   `System-Rebased-Onto` trailers. A conflict in any other file leaves the replay uncommitted and the
   files marked (`conflicted`, with the base's commits since the fork). `resolved` commits a
   resolution only when no changed file holds a conflict marker; `abandon` moves the branch back to
   the head. Never a push; the head stays reachable.
3. **A conflict is its author's to resolve.** The engine starts one writing step on the Worker of
   the run's writing step that wrote the result (one that needs `develop`: the template's writing
   step, or the last fix a review grew from it; never a later step that only ran in the worktree,
   such as a validation on a writing sandbox; the result's own author: for the `system` repository, a
   Claude Code Worker), routed to that Worker only, in the run's worktree, started once by a key of
   the run, the head, and the base, on a board task's brief recorded once when the conflict is found:
   it names the task, its project, and its attempt as every step of the task's run does, so what the
   execution reserves and draws is the task's and the project's, within their caps, and states the
   task's budget left. Its instructions say what moved on the base (the commits since the
   fork), which files conflict, that the base's behaviour is kept and the result's change carried
   over it, that a number both sides took goes to the result as the next free one, and not to commit
   or run git. Once it ends, the source commits its resolution, or refuses when a marker is left.
4. **Checked again.** The command checks the run's own acceptance decision required or asked of the
   exact result (ADR-0063; kept on the run's row, so an operator's acceptance on the board, which
   reports none, does not skip them), with any the board's final acceptance names, run again, by
   `ctx.workers.check`, on the rebased tree's exact subject: those it reported (`checks`), and those
   its check run asked (`checkRun.asked`) that stayed pending, left out of `checks` because they timed
   out, were stopped, or were not let run. A pending check is required on the rebased tree all the
   same: an operator who accepted a result whose check did not run accepted no pass of the rebased
   tree. Left out are only checks the repository has no command for (its `check-run` evidence names no
   `argv` for them, or none ran at all), which cannot run on any tree; a check run refused or not run
   leaves every check it asked required. All passed: the merge is asked on the rebased head, its
   consequences saying it was rebased, by whom its conflicts were resolved, and that its checks passed
   again. A check that did not run to an exit code: refused for the operator, nothing merged (INV-2).
   A result of which no check the repository can run was asked (no checks configured) runs none
   again; the request says so.
5. **What cannot land goes back.** A conflict the Worker leaves (markers), a resolving step that
   failed, a Worker not admitted within 6 hours, or a check that fails on the rebased tree: the
   branch put back at the head (for a conflict), and the done task sent back as another attempt with
   the reason. The board gains, at contract 1.4, the optional `reopen(taskId, { runId, acceptance,
   decision, reason })`: only a task `done` on exactly that run's accepted result; the move a
   rejected attempt makes (through the gate again, or a wait for input with no attempt left), its
   `board` decision naming the landing's. No attempt is counted for it: the run that made the result
   was. A board without `reopen` leaves the landing refused and the task done.
6. **A target that only moved spends nothing.** A rebase with no conflict and checks that pass
   again goes straight to the merge request; the task stays done on its attempt; no Worker runs.
7. **Recorded** (INV-13). Each move is a `gate` decision of rule `workflow.landing`: `rebase` (the
   fork, the old and new heads, the base, the generated files made again, who resolved what),
   `resolve` (the files, the Worker), `recheck`, `return`, or `hold` (the checks and their evidence).
   The landing's states gain `rebase`, `resolving`, `returning`, `recheck`, and `returned`, each
   change a `workflow.task.landing` event; the task's view keeps the rebase (`TaskLanding.rebase`).
8. **Restart** (INV-4). The landing's state is on the run's row; each phase is found from what git
   or the row keeps, never from the worktree's files alone. The source finds a rebase begun (the
   branch at the base, the head kept as `refs/system/rebase/<run>/<head>`), replayed (also
   `refs/system/rebase-replayed/<run>/<head>` at the base, set only once the worktree holds the whole
   replay), or done (its commit's trailers). A rebase begun and not replayed may have stopped between
   moving the branch and making the worktree the base's, its files still the head's: it is made the
   base's again and replayed again, never committed as it is (that would revert what the base gained);
   a `resolved` step for it is refused. The landing's commit step finds a rebased head its own; the
   resolving step is found by its key; a check is answered from its stored outcome. A rebase given up
   is `returning`, with why, before its branch is put back; then the `return` decision is saved before
   the board is asked to reopen the task; so a restart between those puts the branch back again (the
   source finds it back) and sends the result back, instead of reading the head it put back as a moved
   one and refusing the landing; a task already sent back is found so.

## Consequences

- An accepted result reaches the base on one approval even when the base moved, conflicts and all,
  with no hand merge; and the tree the operator approves is the one merged and the one checked.
- The run's branch is rewritten by a rebase (its own branch only, never the base): the pre-rebase
  head is kept under `refs/system/rebase/<runId>/<head>`, and the rebase commit names it.
- The review of the result was of the tree before the rebase; the rebased tree is checked again, not
  reviewed again. A conflict's resolution is the author's, recorded, and the merge request says so.
- A rebase costs one more check run per moved base, and, on a conflict, one writing step on the
  author's account.
- A result that cannot land goes back to the board after it was `done`: dependents that became ready
  on it stay as they are (they already did before ADR-0060's merge, too).
- The retention never commits a worktree whose rebase conflicts are not resolved; such a worktree
  stays for its landing or the operator.
- The board's contract is 1.4; `FakeBoard` and the store board both have `reopen`; the conformance
  suite adds `board.reopen-sends-back`.

## Rejected alternatives

The options above; also: letting a Worker run `git rebase` itself (a gate that allows git in the
worktree, and a history the source cannot check), and resolving conflicts by taking one side (it
drops one side's behaviour silently).
