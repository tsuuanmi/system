# ADR-0047: A board task's run stops at its next boundary once the ledger's recorded usage passes the task's lines

- **Status:** Proposed
- **Date:** 2026-10-23
- **Related:** [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0044](0044-funding-raises-a-spent-task-budget.md),
  [PROP-0010](../../proposals/0010-base-version.md),
  [PROP-0008](../../proposals/0008-studio-operating-model.md#resource-management-and-token-optimization),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-4](../../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

A board task's `budget` lines cap what its attempts draw from the resource ledger, as the ledger
counts them for the task. The workflow engine reserves once per run, before the run starts work.
It reserves the least amount of each line, with the task's lines as caps. The ledger refuses that
reservation when recorded usage and live holds already reach a line
([a task's budget](../../design/workflow-engine.md#a-tasks-budget)). After that, nothing checks the
lines again. A run that starts with little left draws all it needs. The overdraw is recorded under
the task, so the next attempt is refused, and it asks for funding that covers the overdraw
(ADR-0044). The board's design lists this as a gap with its target ("a run can overdraw its last
lines"), and ADR-0044 left it open.

**Rule 4 is a guarantee.** The engine follows rule 4 of the resource ledger ("every cap is
enforced before the run, never after", [resources](../../design/resources.md#fail-closed-rules)).
That ledger is a guarantee seam (the core component *resource ledger and metering*), and so is the
engine (*work state machine*, *runner*). Changing when a cap applies changes a guarantee seam's
rules, so it needs an ADR (ADR-0036).

**The seams cannot stop a run partway today.**

1. **No usage is recorded while a run is in flight.** `RunMetering` covers a whole agent run and
   comes back with its result ([agent runtimes](../../design/agent-runtimes.md#metering)). The
   `agents` source records one `usage-record` per run, after the run (source `runtime-result`).
   Website and model sources record none yet. So the ledger's count for a task cannot change while
   the task's run is running, and "recorded usage passes the lines" can only be seen between Worker
   runs.
2. **No way to stop at a boundary.** `Workers.cancel` aborts an execution: it fails as `aborted`,
   and an agent subprocess that ignores the abort gets SIGTERM, then SIGKILL. That can cut a tool
   off mid-call. The runtime's tool gate is asked before every tool call, and its `defer` ends the
   run at that call. But a deferral names an approval request and means "a person decides this
   call" ([approvals](../../design/approvals.md)). It does not mean "the budget is spent".
3. **One check per run.** The engine reserves once per run, not before each Worker execution (its
   own "differs from target"), so the lines are not checked again even between the steps of a
   multi-step run.

## Options

1. **Keep rule 4 as it stands.** A run's own bounds limit the overdraw: a Worker's `maxTurns`, each
   step's timeout, the template's steps. The overdraw is recorded, and the task is then funded
   again or ended. This is simple, but one run can overdraw by any amount.
2. **Check before each step.** The engine reserves before every Worker execution of a task's run,
   with the task's lines as caps, as it now does once per run. If a spent line refuses that
   reservation, no new step starts. Steps already running finish, and their results are taken, as
   in a holder-lost wind-down. The run then blocks the task (`budget-spent`, with funding asked
   from the ledger's count), or on its last attempt it ends the task (`retries-spent`). No seam
   changes, and rule 4 holds as written, since each Worker run is still checked before it starts.
   An overdraw is limited to the steps in flight.
3. **Stop an agent run at its next turn or tool boundary.** This needs four changes:
   - `agentRuntimes` (a capability seam): `RunSpec` gains an optional progress callback. After each
     turn, the runtime gives it the run's cumulative `RunMetering`, read from its own messages. A
     runtime that cannot report progress reports none.
   - `resources` (a guarantee seam: contract 1.1, `usage-record@1.1`): interim usage of a run in
     flight is recorded under a new source, `runtime-progress`. A later reading replaces it, and the
     run's `runtime-result` supersedes it, so each unit is still counted once. Caps count it. Rule 4
     becomes: a cap binds before a run, and at each boundary of a run whose runtime reports
     progress; never inside a tool call.
   - The tool gate gains an outcome `stop`, with a reason. The runtime honors it by ending the run
     before that call. After a turn with no tool call, it does not start the next turn. A runtime
     that does not know `stop` treats it as a deny, which fails closed. The `agents` source answers
     `stop` when the ledger's count for the run's task, this run's progress included, passes a
     line of the caps the engine passes in at start (`WorkerStart.budget`: a minor of the workers
     contract, which is a guarantee seam).
   - The execution fails as `budget_spent` with its metering. The engine then blocks the task as it
     does for a refused reservation: it asks for funding from the ledger's count (ADR-0044), and
     asks for none on a last attempt.
4. **Estimate usage**, from the model's own report or by counting the prompt's tokens. Rejected:
   usage is never estimated from a model's report (resources rule 3, and the metering guarantee in
   ADR-0036).

## Decision (proposed)

Do option 2 first, then option 3 for runtimes that report progress. Each lands as its own change.

- **Option 2 changes only the engine.** Rule 4 is unchanged. Where each execution's reservation
  stands goes on the run's row. The ledger's `budget` decision is recorded before any effect
  (INV-13). Each reservation is released when its execution finishes, and a hold that a crash
  leaves behind expires (INV-9). A restart reserves again, never twice (INV-4), and the crash
  suite covers it. A brief still states what the task has left.
- **Option 3 follows** once an agent runtime reports progress. It goes through the seam changes
  listed above, each with its conformance scenarios and fakes, and rule 4 is amended in that change.
- **Both options** count recorded usage only, never an estimate. Neither stops a tool mid-call.
  Each records every stop as a decision before its effect.

## Consequences

- Until this is accepted and built, rule 4 stays "before, never after": a run can overdraw its
  task's last lines. The overdraw is recorded, and then it is either funded (ADR-0044) or the task
  ends.
- Option 2 limits an overdraw to the steps in flight. One long agent step can still overdraw, up to
  its own `maxTurns`.
- A run stopped between steps leaves the results of the steps it completed. The next attempt's
  brief points at them, as it does for any earlier attempt.
- Option 3 changes two guarantee seams (`resources`, `workers`) and one capability seam
  (`agentRuntimes`). A runtime without progress reports gets only option 2.
- Revisit this if the workflow contract should state its budget behaviour. That would add a
  conformance scenario, which changes the workflow contract and needs an ADR (roadmap B4).

## Implementation note (2026-10-23): option 2

Option 2 is built in the workflow engine alone, while this ADR is proposed; no seam changes, and
rule 4 is unchanged ([a task's budget](../../design/workflow-engine.md#a-tasks-budget)). Where the
decision left room, the engine:

- counts as a step each Worker execution of a run, so each attempt, retry, and escalation of a node
  reserves; a step that draws no Worker (a gate, a team's tally or decision, a review's source)
  reserves nothing;
- reserves after the step's brief is drafted and before it is routed, so a refused step records no
  route and sends nothing;
- keeps each hold on the run's row under its step (node, attempt, escalations), and releases it at
  the run's next turn once the step is no longer in flight. A hold whose step never started (a
  crash between the two) is released, and the step reserves again, so a restart never holds two;
- keeps the first refusal, and does not start a step whose reservation was granted beside a refused
  one;
- lets a step in flight that fails for good, or asks questions, decide the run as it would without
  the refusal; the next attempt's first step is then refused on the spent line;
- points the next attempt's brief at the results of the steps a stopped attempt completed (role
  `prior`). A failed attempt has no result on the board, so the engine reads them from the stopped
  run;
- still briefs each step with what the task had left when the run was admitted.
