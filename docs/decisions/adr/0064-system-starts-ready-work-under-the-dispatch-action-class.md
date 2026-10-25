# ADR-0064: System starts ready work under the dispatch action class, within recorded bounds

- **Status:** Accepted (2026-10-25, by the operator, D61)
- **Date:** 2026-10-25
- **Related:** [PROP-0014](../../proposals/0014-dispatch-by-quota.md) (increment D1; D61 to D66),
  [ADR-0033](0033-least-busy-routing.md), [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0041](0041-policy-changes-through-the-approval-queue.md),
  [ADR-0052](0052-accounts-are-assigned-unless-pooling-is-recorded.md),
  [ADR-0058](0058-a-run-worktree-is-set-up-offline-before-its-agent-starts.md),
  [ADR-0059](0059-quota-readings-from-each-accounts-own-usage-report.md),
  [ADR-0060](0060-an-accepted-result-lands-on-the-operators-merge-approval.md), REQ-WF-16,
  REQ-WRK-12, [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-4](../../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay),
  [INV-5](../../architecture/invariants.md#inv-5-exact-subject-binding),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact),
  [INV-15](../../architecture/invariants.md#inv-15-one-writer-per-subject)

## Context

On 2026-10-25 the operator saw 16 ready board tasks and 18 free Workers at once, both Codex accounts
at 0 % of their windows, while the lead was busy: nothing starts a ready task but the lead or the
operator, routing reads whether a pool is available but not how much of each window is left, and
nothing bounds what would start without a person. A plan window's unused share is lost at its reset.
PROP-0014 proposed that System starts ready work by itself, chosen by quota; the operator accepted it
and its first increment, D1 ("ask to start, chosen by quota"), with the answers D62 to D66.

What constrains it:

- **The engine owns a task's run** on the board ([board tasks](../../design/workflow-engine.md#board-tasks)):
  it claims, records the run, then schedules. A second component that starts runs would race it.
- **The workflow, workers, approvals, and resources seams are guarantee seams** (ADR-0036): their
  contracts change by an additive, optional field, with an ADR.
- **Readiness is the board's.** A task's own action class gates whether its attempt may run; that a
  person or the lead starts it is a separate fact no class expresses today.
- **Assigned accounts** (D24, ADR-0052): work never moves around a limit to a sibling account.
- **Readings** come from each account's own usage report (ADR-0059); a missing one is missing.

## Options

1. **The lead dispatches** in its prompt. A model would order and choose, and it stops when the lead
   is busy, which is the problem. Rejected.
2. **The board starts runs in its sweep.** Two components would start runs. Rejected.
3. **Reuse the task's own class** (`workspace-write: auto` means "start it too"). It mixes "may this
   attempt run" with "may System start it", and would move acceptance's required checks. Rejected.
4. **A pass of the engine, gated by a new action class, choosing the Worker by a pinned score over
   the ledger's readings, bounded by recorded counts.** Chosen.

## Decision

1. **The dispatch pass is the engine's.** Every `dispatch.sweepSeconds` and once at start, after the
   engine reconciled its runs, the engine reads the board, the Workers, the ledger, the queue, and its
   own records again; it keeps nothing in memory a restart would lose, so a restart is a pass, not a
   replay (INV-4). It takes the ready tasks of active projects that name a template it serves, oldest
   first (`createdAt`, then id; D1 orders by age, priority is D2), at most `dispatch.maxPerPass` a
   pass, and starts them through the engine's own start: claim as the run, run first, then work. A
   lead's or the operator's start of the same task races only at the board's fenced claim.
2. **The action class `dispatch`** (`common@1`'s `actionClass` gains it; the approvals contract
   stays 1.1, its vocabulary amended in place as for `promotion`): System starting a ready task's
   attempt with no person or lead asking for it, judged per project by the autonomy policy. It is
   not in `ALWAYS_ASK` (a run can be stopped, its worktree is its own, nothing lands without
   `merge`). A policy that names no rule for it takes its `default`, `ask` or `forbid`; the bundle's
   studio policy names none and asks. In D1, `ask` opens one request per chosen start, `forbid`
   dispatches nothing in that project, and `auto` or `notify` dispatch nothing either, the decision
   saying so: D1 starts only on the operator's word (D2 honours them).
3. **One request per chosen start**, on `{content, dispatch:<taskId>:attempt:<n>, <score version>:<sha256 of the Worker and the score's inputs>}`
   (`n` the attempts already made), requester `workflow` with the task and project, its summary the
   task, the Worker, and the quota it would draw on. The engine records the ask on a durable row
   before it asks and adopts an open request on that subject after a crash, so a pass repeated after
   a crash asks once. At most `dispatch.maxOpenAsks` are open. A request the operator denies, or
   lets expire, is not asked again for that attempt; one withdrawn on a policy change is put to the
   policy in force at the next pass; the engine withdraws its open requests when the task moves on
   or dispatch is paused.
4. **An approval binds the task, the attempt, and the Worker** (INV-5). Applied, the run starts only
   while the task is still `ready` at the attempt the subject names and the chosen Worker is still
   admitted and free, within `dispatch.approvedHoldMinutes` of the approval; otherwise it is used for
   nothing, recorded, and a new choice asks again. An approval never starts another Worker or
   attempt. **An attempt the operator already approved through the board's gate counts as its
   dispatch approval** (D62): the operator's `approval` of the board's own request on
   `board-task:<id>:attempt:<n>` for that attempt starts it without a second button, recorded as a
   `gate` decision naming that approval.
5. **The Worker is chosen by quota** among those routing admits for the run's writing step (its
   first step that proves `develop`, else its first Worker step), with the requirement the engine
   builds from the admitted spec (INV-6). `workers` gains the optional `candidates(requirement,
   options)`: the checks `route` runs, in its order and under its lock, the assigned-account hold
   included, with nothing reserved and no decision recorded. The order is the pure, versioned
   `quotaScoreOf` (`quota-score@1`, in `libs`): tier, quota class (metered last), known before
   unknown or stale, a window resetting within `quota.useSoonMinutes` with headroom first, headroom
   above the reserve in buckets, then load, the priority list, and id. A Worker is **free** only when
   routing admits it, it is `ready` with its account's load below `dispatch.maxRunningPerAccount` and
   no step of a run on it, its account's pools are available and every window is known with headroom
   above `quota.reservePercent`, it is not metered (D65: dispatch never starts work on a metered pool
   by itself), and its account and repository are within their bounds. An unknown, stale, or
   `unknown: available`-only window never counts as free (INV-2). Among assigned accounts this
   chooses by headroom for new work, which moves nothing around a limit: routing's `assignment` hold
   still applies (D66 keeps D24).
6. **The reserve** (D63) is `quota.reservePercent` of every window (default 20), kept for the
   operator's own use. It gates starts only: a run that crosses into it keeps going, and a run the
   lead or the operator starts is routed as before. The `resources` contract becomes 1.2: the
   optional `quota()` gives the operator's quota settings, validated when the row loads; a ledger
   without it keeps no reserve, so nothing is free.
7. **Bounds, counted from records** (INV-9): `dispatch.maxRunning` dispatched runs not finished,
   `maxRunningPerProject`, `maxRunningPerAccount`, `maxRunningPerRepository` (D64: tasks without a
   write subject on one repository run in parallel, at most 4, the repository being the chosen
   writing Worker's workspace), each counting open and approved asks too, so approvals never exceed
   them; `leaveRunsFree` of `maxActiveRuns` kept for the lead's and the operator's own starts; a task
   that writes a subject is not taken while another task holds that subject or has a live ask on it
   (board rule 6, INV-15). `dispatch.enabled: false` turns the pass off; the operator pauses and
   resumes it entirely (`dispatch_pause`, `dispatch_resume`), each a `gate` decision kept on a
   durable row.
8. **Every start choice is a decision** (INV-13): a pass that takes a task records an `admission`
   decision (rule `dispatch.select`) over the ready tasks it looked at, each with why, then a
   `route` decision (rule `dispatch.choice`, `quota-score@1`) over every Worker with its keys or its
   refusal, the `autonomy` decision for `dispatch`, and on D62 the `gate` decision (rule
   `dispatch.approval`); the run's `workflow.task-admission` decision names them, so `explain` on the
   run shows why it started and on what. A pass that takes nothing changes nothing and records no
   decision; its reason for each task is kept as the last pass, which `dispatch_status` shows.
9. **The run prefers the chosen Worker.** Its writing step's first route is restricted to that Worker;
   refused (its state changed), it routes again without the restriction, both decisions kept on the
   step. A refused preference spends no attempt.

## Consequences

- In the operator's case, Home lists up to `maxOpenAsks` starts, each on a free Worker chosen by
  quota with its window line, approved with one button; D62 tasks start without one.
- The `workflow` contract becomes 1.9 (the pass and its tools); the `workers` seam gains an optional
  method and the `resources` seam an optional one (contract 1.2); `common@1` gains an enum value.
  No invariant changes.
- A run the engine started for dispatch is a run like any other: its next steps route as today, a
  window or budget that closes mid-run stops it at its next step by the rules that exist, and the
  turn in flight is never moved.
- Quota readings are trusted as recorded; the research behind PROP-0014 found window-aware dispatch
  safe but its throughput gain unproven. D1 asks for every start, so the live day it runs on is the
  first evidence.
- Revisit for D2 (`notify` and `auto`, hourly bounds, per-project pause, priority) and D3 (the score
  in every route, its own ADR).
