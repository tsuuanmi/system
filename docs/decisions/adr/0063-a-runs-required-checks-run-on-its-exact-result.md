# ADR-0063: A run's required checks run on its exact result

- **Status:** Proposed (2026-10-25, T151; built on the operator's go-ahead for T151). It changes what
  the core accepts only for a repository whose checks the operator configures: with none
  configured, every result is accepted as before.
- **Date:** 2026-10-25
- **Related:** T151, [PROP-0013](../../proposals/0013-feedback-from-work.md) (C3, open question 9),
  [PROP-0010](../../proposals/0010-base-version.md) (B5, B8),
  [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0038](0038-confined-commands-for-claude-code-workers.md),
  [ADR-0058](0058-a-run-worktree-is-set-up-offline-before-its-agent-starts.md), REQ-WF-15,
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-4](../../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay),
  [INV-5](../../architecture/invariants.md#inv-5-exact-subject-binding),
  [INV-6](../../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

Seen on 2026-10-25 on every development run of the `system` repository (`system explain
run_b64941feb244c936`, `run_950605f52dfc5698`): the studio policy's `workspace-write` rule
requires `tests` and `lint`; the run's acceptance says "it ran none of the checks a policy can
require; the board binds those", and the task waits for the operator with "checks pending: tests,
lint". The template's `validate:1` step is told to run `corepack pnpm lint` and `corepack pnpm
test:affected`, and the policy lets it run them unasked, but what it reports is a model's account
of a command: evidence, never a check ([B8](../../proposals/roadmap.md);
[PROP-0013](../../proposals/0013-feedback-from-work.md#2-a-completion-gate-at-the-workers-stop-boundary),
alternative 4). So under the studio policy the operator accepts every result by hand, after running
the checks themselves ([runbook](../../operations/runbooks.md#accept-or-reject-a-review)).

What constrains a fix:

- **Checks are commands with exit codes** (PROP-0013): a model's report of a command is not a
  check, and a check binds to the exact subject it ran on (INV-5).
- **Required checks bind at acceptance** ([board](../../design/board.md#required-checks-bind-at-acceptance)):
  the board already takes `tests`, `typecheck`, and `lint` in an acceptance decision's
  `outcome.detail.checks`, holds a result whose required check did not pass for the operator, and
  sends a failed one back as another attempt. Nothing about the board needs to change.
- **Commands run in a proven confinement**, from the operator's configuration, each allowed by the
  policy by its exact argv (ADR-0038, ADR-0058; INV-6). The `agents` source already runs a
  repository's setup commands in a run's worktree that way.
- **The `workers` seam is a guarantee seam** (ADR-0036): it changes by an additive, optional
  member only. No `exec` seam is planned (PROP-0013, alternative 6).
- PROP-0013 planned the checks at the Worker's stop boundary (C2, a `Stop` hook proven live first,
  C1) and their report at acceptance (C3, this decision's kind); C1 has not run. Its open question 9
  asked whether `validate:1`'s commands should produce check evidence.

## Options

1. **Trust `validate:1`'s report.** A model's account of a command. Rejected (PROP-0013,
   alternative 4).
2. **Have the validation Worker's tool gate record its `Bash` calls' exit codes.** The gate sees a
   call before it runs, never its exit code, and a Worker may run the command on another tree than
   the result's (before a later edit). Rejected.
3. **The completion gate at the stop boundary (PROP-0013 C2).** Needs the supervised `Stop` hook
   check first (C1), a hook per runtime, and rounds fed back into the session. It stays the plan for
   checks *before* a step stops; it is not needed for checks at acceptance.
4. **The run itself runs each required check, on the exact tree its result is on, before its
   acceptance, through the source that holds the tree.** The engine asks the policy which checks it
   requires of the result, and asks `ctx.workers.check` (optional, additive) to run them; the
   source runs each check's operator-configured command in the confinement its setup uses, judged by
   the policy, and records what ran. Chosen.

## Decision

- **When.** Once every step of a run that wrote has completed (in `algorithm-development`, after
  `validate:1`), before its acceptance is decided: a board task's run whose task writes a `git-head`
  subject, and a plain run with a completed `develop` step, whose result is an agent's on a git
  working tree. Not when a check the run judged itself failed (the acceptance rejects anyway).
- **Which checks.** The engine asks `ctx.approvals.check` on the class the acceptance is judged
  under (the task's action class and project; `workspace-write` for a plain run) with the checks
  the run judged itself; under `auto` or `notify`, the required checks still failed that are
  commands (`tests`, `typecheck`, `lint`) are asked for. None, or another mode: nothing runs.
- **Where.** `ctx.workers.check(step, signal)`, optional on the `workers` seam: the source that
  holds the worktree as the run's own runs the checks, only while it is intact, no agent run of the
  workflow run can still write it (INV-15), and it is exactly the result's subject (else `refused`:
  `moved`, `gone`, `busy`, `failed`). A source that throws is `failed`, never a check passed.
- **How** (the `agents` source). Each check's command is the operator's, per repository, beside its
  setup (`worktreeSetup[].checks`); it runs only on a worktree set up under the setup loaded now,
  in that setup's confinement and views (the host read-only but the worktree, no network), within
  `checkTimeoutSeconds`, and only when the policy lets its exact argv run unasked (`auto` or
  `notify`: a line on the studio commands list). An `ask` opens no request: a check is not a step
  that waits.
- **What counts.** Exit 0 is `passed` and any other code `failed`, only while the tree is still the
  subject after the command; anything else (no command configured, not allowed, not set up, a
  confinement not proven, a command that cannot start, a timeout, a signal, a tree the check
  changed) is `error`, neither passed nor failed: the check stays pending (INV-2). A check that
  changed the tree ends the run of the rest.
- **What is recorded.** The source records one `check-run@1.0` `evidence` artifact (per check: the
  argv, the `autonomy` decision on it, exit code, duration, and the end of its output with the
  length and SHA-256 of all of it) at the run's classification. The engine's `acceptance` decision
  (`workflow.task-acceptance` and `workflow.run-acceptance`, both now version 2) names it among its
  inputs, reports each `passed` or `failed` check in `outcome.detail.checks` beside `schema` and
  `review`, gives each `error` as a reason, and keeps what was asked in `outcome.detail.checkRun`.
- **What the board does with it** is unchanged: no check failed and none pending, the result is
  accepted without the operator; a failed one is another attempt; a pending one holds the review for
  the operator. A plain run records them and is never blocked.
- **Restart** (INV-4): running a check changes nothing it checks (a check that does is an
  `error`), so it is safe to repeat: a run stopped before its acceptance runs them again.

## Consequences

- Under the studio policy, a development run whose tests and lint pass on its exact result, and
  whose review approved it, is accepted by the engine's own decision, and its landing asks the
  operator to merge it ([landing](../../design/workflow-engine.md#landing-an-accepted-result)).
  That is what the policy's `auto` with `requires` always meant; the operator's acceptance on `/ui`
  is no longer the only way for such a result.
- It takes effect per repository, by the operator's configuration: a repository with no `checks`
  runs none, and every result is held for the operator as before. Removing the checks reverses it.
- A check's command runs once more per attempt, after the validation step: the run takes that much
  longer before it reports (bounded per check, at most 3600 s).
- The checks run after the steps, never inside them: a failure is found at acceptance and costs the
  attempt. Catching it before the step stops, in the same session, is still PROP-0013's C2.
- `validate:1` stays: it measures what the task's criteria name, and its report stays evidence.
- Only the `agents` source answers `check`; a result on a tree another source holds keeps its
  checks pending.

## Rejected alternatives

The options above; also: running the checks inside the engine (it would need a confinement of its
own and the repository's setup, a parallel path to the source's), and a new `exec` seam (not
planned in the seam catalog: the source's confinement is the one proven).
