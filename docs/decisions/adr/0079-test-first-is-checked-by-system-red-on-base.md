# ADR-0079: Test-first is checked by System: the result's new tests fail on its base

- **Status:** Proposed
- **Date:** 2026-10-28
- **Related:** T306c (a rerun of T306 and T306b), T267, T284, T299, T293b, T322, D108,
  [ADR-0063](0063-a-runs-required-checks-run-on-its-exact-result.md),
  [ADR-0071](0071-a-changes-risk-tier-comes-from-the-policys-path-map.md),
  [ADR-0078](0078-a-plugin-or-a-mechanism-is-turned-off-at-runtime.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-5](../../architecture/invariants.md#inv-5-exact-subject-binding),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact),
  [INV-14](../../architecture/invariants.md#inv-14-every-record-has-a-versioned-schema)

## Context

The operator, 2026-10-27: "should System move towards test-driven development?". Every task's goal
already names "tests that must fail without the change", but nothing checks that they do: a test that
passes on the tree the change started from proves nothing of the change, and the lead proved it by
hand, in salvages. The author's own evidence cannot be that proof (T267: the System's checks are
never taken from an agent's account of a command), and the acceptance's `tests` check runs the
result's tests on the result only, where a vacuous test passes.

## Options

1. **Ask only.** The brief asks test-first; nothing checks. It is what the goal sentence is today.
2. **A check of the acceptance, run by the source on a base tree** (chosen): the new tests are run on
   the commit the run's worktree was cut at, with the result's tests copied over, and must fail there.
3. **The author runs its tests on the base and shows them.** An account of a command, never a check.
4. **A policy field per tier** (`requiresByTier`). Reads the tier where the engine already has it
   (ADR-0071) without a new field: the check is asked of the tiers that have code to be red on.

## Decision

Option 2, in three parts.

- **The brief.** The writing step of the code work (`develop:1`, not its `docs` and `tests` variants)
  asks test-first: write the tests that encode the criteria, run them and see them fail (a missing
  module counts), then implement, and show both runs in the evidence. A task whose criteria say
  `refactor: no behaviour change` is asked to change no existing test.
- **The check `red-on-base`.** A new command check (`RunCheck`, `Check`; `check-run@1.1`,
  `autonomy-policy@1.5`, `board-task@1.4`, `agent-tool-event@1.3` add the name, each an enum value). The
  repository's command (`pnpm check:red-on-base`, `scripts/red-on-base.ts`) is the operator's, judged
  and confined as the others are. The source tells it the commit the worktree was cut at and whether
  the task is a refactor. The script reads the test files the result adds or changes since that
  commit, makes the base tree (`git archive` into a temporary directory, `node_modules` linked with
  the workspace packages pointing at the base's own sources, so nothing the result added is seen),
  copies the result's tests over it, and runs them on the base and on the result: each file must fail
  on the base (one that cannot load counts) and pass on the result; a file passing on the base is
  named with its tests. A result that changes code and no test fails; documents or tests alone have
  nothing for the base to lack and pass. A **refactor** instead fails when it edits or deletes an
  existing test, and no test runs on the base; the `tests` check runs the related suite as always.
  The result and its output are in the dossier as any check's (`check-run`, the failing lines).
  The landing does not run it again: the rebased tree has no such base.
- **By tier and behind a switch.** A policy rule may require `red-on-base` as it requires `tests` and
  `lint`; the engine asks it of a change of the normal or heavy tier (and of one with no tier
  recorded, INV-2), and reports it met, saying so, for a light change. It has an enforce switch
  (ADR-0078, workflow row `enforce.redOnBase`): `on` sends a failing result back, `warn` (the start
  value) runs it, records a `gate` decision (`workflow.red-on-base`) and judges the result as if it
  passed, `off` does not ask it. It goes `on` only after the test profile's canary and days clean
  (D108, the 7-day rule). The board's auto-accept rule does not read its pass in the check-run
  record: the switch may be warn or off, and the run owner judged it.

## Consequences

- A result whose new test passes on its base fails the check, naming the test; one whose new test
  fails on its base and passes on the result passes; a refactor that edits an existing test fails.
- The check costs one more run of the new test files, and a `git archive` of the repository, per
  acceptance. A test that needs a built package or a file the archive does not hold (untracked,
  ignored) is red on the base for that reason too, a false green of the check: warn shows how often.
- A tests-only result passes by design, as does a documents-only one; a behaviour change that adds no
  test fails. In warn each is recorded, never refused.
- **Measure** on the next ten tasks after it lands: how many results had a test that passed on its
  base (the warn decisions), and what their reviews said of those tests. The lead reads them from the
  `workflow.red-on-base` decisions and the dossiers; the switch moves to `on` only after that and
  the days clean.
- Revisit if the base tree's setup proves too unlike the result's (a changed dependency), or when the
  policy gains a per-tier `requires` field of its own.
