# ADR-0067: System accepts a listed branch's result on its review and its checks

- **Status:** Accepted (2026-10-26, by the operator, D80; built in T217). It amends
  [ADR-0063](0063-a-runs-required-checks-run-on-its-exact-result.md) where that says "what the board
  does with it is unchanged", and the board's review hold
  ([required checks bind at acceptance](../../design/board.md#required-checks-bind-at-acceptance)),
  only for the projects and branches the operator lists: with the setting off (the default), nothing
  changes.
- **Date:** 2026-10-26
- **Related:** T217, D80, [ADR-0060](0060-an-accepted-result-lands-on-the-operators-merge-approval.md),
  [ADR-0063](0063-a-runs-required-checks-run-on-its-exact-result.md), REQ-WF-5, REQ-WF-15,
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-5](../../architecture/invariants.md#inv-5-exact-subject-binding),
  [INV-6](../../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

On the `system` project every board review was held for the operator (`board.review.held`), and the
lead accepted each on the operator's delegation after running the checks again by hand. The operator
decided (D80, 2026-10-26): board tasks on `dev` are accepted by System when their final review
approves and every required check passed.

What the board had: an accepting decision that is not the operator's applies when the policy, given
the checks it reports, leaves none of the class's required checks failed; otherwise the review is
held for the operator. It did not ask whether the run's last review approved (only whether the
review of the result's exact tree, when there was one, did: a failed `review` check is a reject),
nor where the result would land, and it took the checks the decision reported without reading the
`check-run` record behind them.

What constrains a fix:

- **Exact subject** (INV-5): the review and the checks count only on the result's exact tree.
- **Records, not accounts** (INV-6, INV-13): what decides is read from the records the decision
  names (the `assessment@1.0`, the `check-run@1.0`), in envelopes the system produced; the
  acceptance names them.
- **A merge always asks** (D56, ADR-0060): accepting a result never merges it.
- **Fail closed** (INV-2): a condition not known is a condition not met.

## Options

1. **Have the lead keep accepting by hand.** What D80 ends.
2. **Lower the policy's requirements for the class.** It would accept results with no review, or
   checks not run, on every branch. Rejected.
3. **A board setting, per project and landing branch, under which the run owner's acceptance applies
   only when the run's last review approved, every required check passed on the exact result as its
   `check-run` record shows, and the result lands on a listed branch; held for the operator,
   with the reasons, otherwise.** Chosen.

## Decision

- **The setting.** `board.autoAccept: { projects, branches }`: project ids, and branch names (plain
  git branch names, never patterns), at most 64 each, each list without repeats; malformed, the
  board does not start. Off unless both lists name one; off by default.
- **Where it applies.** An accepting `acceptance` decision that is not the operator's, for a task of
  a listed project whose result is on a git working tree (`git-head`), and that the policy lets
  apply as before (no required check failed, the class not forbidden). A rejection, the operator's
  own decision, a result on no working tree, another project's task: as before.
- **When it accepts.** Every condition holds, each read from a record:
  - the decision is the run owner's: a rule's decision in an envelope the system produced;
  - **review**: it names the run's last review (`outcome.detail.review.assessment`, among its
    inputs): an `assessment@1.0` of the result's exact tree whose verdict is `approve` and that
    lists no blocking finding;
  - **checks**: each command check it reports passed (`tests`, `typecheck`, `lint`; this covers
    every one the policy requires, since the policy saw none failed) is `passed` in the
    `check-run@1.0` record it names (`outcome.detail.checkRun.evidence`, among its inputs), of the
    result's exact tree;
  - **landing**: `outcome.detail.landing.branch`, the repository's checked-out branch the run's
    worktree was cut from, which a landing merges into, is listed.
- **What it records.** The task is `done` on a `board` decision of rule `board.auto-accept` that
  names the acceptance, the review, the check-run record, and the autonomy decision, and says why
  each condition held (INV-13); `result.acceptance` stays the run owner's acceptance. The landing
  then goes as before: a commit on the run's branch and a `merge` request the operator answers.
- **When it holds.** Any condition not met holds the review for the operator, as before, for the
  policy's wait for the class: the `board` decision (`operator-review`) says the rule does not apply
  and lists every condition that failed (`outcome.detail.autoAccept`); a review left with a blocking
  finding at the cycle bound says so. Only the operator's acceptance accepts it then; another of the
  run owner's that the rule does not apply to is refused.
- **What the engine names.** The workflow engine's task acceptance (`workflow.task-acceptance`,
  version 3) adds `review` (the run's last step whose exact-subject gate passed with an assessment:
  its step, gate decision, assessment, verdict, blocking findings, remediation cycle and bound, and
  the tree it reviewed; the assessment among its inputs) and `landing` (the repository and the base
  branch of the worktree the result is on, as the source that holds it tells it through
  `ctx.workers.changes`, read before the decision; none when no source tells).

## Consequences

- With `autoAccept: { projects: [system], branches: [dev] }`, a `system` task's result whose last
  review approved it and whose `tests` and `lint` passed on its exact tree, landing on `dev`, is done
  without the operator, and its merge into `dev` is asked as before. Removing the setting reverses
  it.
- On a listed project the rule is stricter than the policy alone: a result on a working tree with no
  review, a review of another tree, a passed check without its record, or an unknown landing target
  is held even where the policy would have let it apply.
- A check that did not run to an exit code is still pending, and the policy's own hold stands: the
  rule never accepts what the policy holds.
- A check that passed but reported tests it did not run (its browser tests, T247; the acceptance's
  `outcome.detail.checkRun.results[].notRun`) is a condition not met: the rule holds the result, the
  reason naming the check and what did not run, and /ui says "checks passed, browser tests not run"
  (T255). Read from the run owner's own decision, it can only hold, never accept.
- A review of the exact result that requested changes is the run's own failed `review` check: the
  engine rejects it and the work goes back as another attempt, as before. The rule holds the cases the
  engine accepts though the run's last review did not approve (a review of another tree, an approval
  that still lists a blocking finding).
- The landing target is the base branch when the acceptance is decided; a landing merges into the
  repository's checked-out branch when the operator approves. Those differ only if the checked-out
  branch changed in between, and the merge request names the branch it merges into.
- A restart after the rule accepted is reconciled by the engine as an applied acceptance
  (`result.acceptance`), never applied twice (INV-4).

## Amendment: the circuit breaker (T268, D93, 2026-10-26)

Auto-accept had no brake: it kept accepting however many of its accepted results turned out
defective. Anthropic's "Solving code review" says they still lack a circuit breaker that tightens
approval when escaped defects rise; this amends the rule with one. Nothing else in it changes.

- **An escape.** A defect found after an auto-accepted result landed, recorded by the operator or
  the lead against the task whose result held it (`recordEscape`; one per task, with a note and
  when it was found). Only a done task whose last decision is the rule's own (`board.auto-accept`,
  which names the branch it landed on) takes one: a result the operator accepted, or any other, is
  not what the line is about.
- **The line.** `board.autoAccept.breaker: { escapes, days }`, default 2 escapes in 7 days (1 to 100
  in 1 to 90), counted per project and landing branch over a rolling window. At that many, in the
  transaction that recorded the last, the breaker trips.
- **What a trip does.** Auto-accept for that project and branch turns off: every result that would
  be accepted by the rule is held for the operator, the reason naming the breaker, its decision, and
  the line. Other branches and projects are unaffected. It is recorded as a `board` decision of rule
  `board.auto-accept-breaker` (`auto-accept off`) whose inputs are the escaped tasks' accepting
  decisions and whose detail lists every escape it counted (INV-13). Home says *Auto-accept is off
  on <branch>* in the project's group, with the line and the tasks counted.
- **It does not reset by itself.** No sweep, no passing time, no later accepted result turns it on.
  Only the operator or the lead does (`resetBreaker`), and only once the line holds again: fewer
  escapes than the line within the window as of that moment. Until then even the operator's reset is
  refused, so the operator who wants the rule back sooner changes the line in the configuration, a
  decision of its own. A reset is a `board` decision (`auto-accept on`) naming the trip's.
- **State.** Escapes and breakers are board tables (store migration 4); at most one breaker per
  project and branch is open.
- **The metric.** `system metrics` reads the same recorded escapes: *Escaped defects per 100
  landed* is the escapes found in its window over the results merged in it, with the count as
  `figures.escapes`, a lower bound (only defects recorded against auto-accepted results count). The
  breaker counts the same table over its own window; a board that records no escapes leaves the
  metric not measurable.
- **The surface.** MCP `board_escape` records an escape, `board_breakers` lists the breakers
  tripped, and `board_breaker_reset` turns auto-accept on again (`mcp-board` 1.3). Each is the lead's
  or the operator's, and which one is the caller's token, never an argument (INV-6). Each output is
  checked against its schema before the move commits.

The reviewer is checked the same way: [a reviewer eval](../../validation/experiments/reviewer-eval.md)
runs System's own reviewer, as the board's `review:1` runs, on past escapes and clean changes.
`pnpm check` fails on any change to the reviewer's instructions, subject block, parser, steps, or
set until the eval has run on it and is recorded no worse than before
([runbook](../../operations/runbooks.md#run-the-reviewer-eval)).

## Rejected alternatives

The options above; also: deciding the rule in the engine (the board is what holds a review, and a
decision the engine made about itself would be its own account), and matching branches by pattern
(a listed name is exact, so a new branch is never accepted by accident).
