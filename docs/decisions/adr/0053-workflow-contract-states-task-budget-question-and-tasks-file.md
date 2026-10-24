# ADR-0053: Workflow contract 1.4 states a board task's budget, a run's question, and TASKS.md in a run's workspace

- **Status:** Accepted
- **Date:** 2026-10-24 (accepted 2026-10-24, by the operator)
- **Related:** [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0039](0039-base-guarantee-seam-contract-changes.md),
  [ADR-0040](0040-briefs-on-the-workers-and-workflow-seams.md),
  [ADR-0044](0044-funding-raises-a-spent-task-budget.md),
  [ADR-0047](0047-a-run-stops-at-a-boundary-once-its-task-budget-is-spent.md),
  [PROP-0010](../../proposals/0010-base-version.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-5](../../architecture/invariants.md#inv-5-exact-subject-binding),
  [INV-6](../../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

B4 of PROP-0010 built three behaviours of a board task's run in the workflow engine:

- **A task's budget.** The engine refuses a task whose budget the ledger cannot hold, before the
  task is taken. It reserves the task's lines before each step of the run (ADR-0047, step 1). Once
  a step spent a line, it starts no further step. It then blocks the task with a funding request
  on lines it computes from the ledger's count (ADR-0044), or asks for none on the task's last
  attempt (ADR-0044's amendment)
  ([a task's budget](../../design/workflow-engine.md#a-tasks-budget)).
- **A question from a run.** A step may answer with only a questions object, as every brief of the
  run offers (`brief@1.2` `ask`). The step then fails as `question`, the holder raises the board's
  question wait, and the answers brief the next attempt
  ([a question from a run](../../design/workflow-engine.md#a-question-from-a-run)).
- **`TASKS.md` in a run's workspace.** Every brief of the run names the board's projection as a
  file under `.system/` (`brief@1.2` `files`). A Worker source with a worktree of the run's own
  writes it there, git-ignored. It is never part of the work and never read back
  ([TASKS.md in a run's workspace](../../design/workflow-engine.md#tasksmd-in-a-runs-workspace)).

The plugin's own tests cover all three. The `workflow` conformance contract (1.3) says nothing
about them. So another engine behind `ctx.workflow` could pass its suite and still break the
guarantees they hold:

- it could run a budgeted task with no ledger, or run past a spent line (INV-2, INV-9);
- it could take a step's questions as the task's result (INV-6);
- it could bind a result to a subject that changes when an agent edits the board's file (INV-5).

ADR-0047 left this to revisit, and the roadmap's B4 lists it as open. `workflow` is a guarantee
seam (work state machine, runner). Under ADR-0036, adding scenarios to its contract needs an ADR.

## Options

1. **Contract 1.4, a minor.** Add four scenarios, each since 1.4. From 1.4 on, the suite's `boot`
   also provides a resource ledger.
2. **Contract 2.0, a major.** Treat the new requirements as breaking, because within their cases
   they are strict: where 1.3 let an engine admit or go on, 1.4 makes it refuse, stop, or block.
   This would split the consumers' ranges for no change in anything 1.3 requires.
3. **Keep plugin tests only.** The guarantees then belong to one provider, not to the seam, and a
   second engine is held to none of them.

## Decision

Option 1. The `workflow` conformance contract moves from 1.3 to 1.4 with these scenarios:

- **`workflow.task-budget`.**
  - A task with a budget on a pool the ledger does not configure is refused before the task is
    taken (`config_error`). So is one on a pool the ledger has no reading of (`overloaded`).
    Each refusal is an `admission` decision, and nothing is claimed or sent.
  - Before each step starts, the ledger's `budget` decision reserves the least of each line, with
    the task's lines as caps.
  - Once a step's recorded usage reached a line, the next step is refused before it is routed.
    The steps in flight finish. The run fails as `budget_spent` (`USER_ACTION`).
  - The task is then blocked (`budget-spent`). Its funding request asks for what the task overdrew
    the line by, plus one attempt's share of the line.
  - Once the operator approves, the next attempt reserves within the raised lines. Its brief points
    at the steps the stopped attempt completed (`prior`).
- **`workflow.task-budget-last-attempt`.** On a task's last attempt, no funding is asked. A `gate`
  decision (`workflow.task-funding`, `end`) on the ledger's refusal ends the run with nothing
  started. Its report leaves the task waiting for input (`retries-spent`), and no request reaches
  the operator.
- **`workflow.task-question`.**
  - A step whose whole answer is a questions object fails as `question` with no result, on a `gate`
    decision (`workflow.task-question`). Nothing after it starts.
  - The holder raises the board's question wait, and the run's outcome is `blocked`.
  - Answered, the next attempt's brief points at the answers.
  - A run that serves no board task offers no way to ask, and the same answer is its result.
- **`workflow.task-tasks-file`.**
  - Every brief of the run names the board's projection of the task's project as
    `.system/TASKS.md`: a `board-projection@1.0` by content id, and an input of the brief's
    envelope.
  - A source with a worktree of the run's own writes the file there, git-ignored. The scripted
    source plays that part, as the `agents` source does.
  - The run's result is accepted on the worktree's exact subject. Neither the subject nor its diff
    includes the file, even after an agent edits it.
  - Nothing commits the file, and what the agent wrote into it changes nothing on the board.

From 1.4 on, the suite's context also provides `ctx.resources`, configured with the suite's
`POOLS` (one pool, `max.programmatic`) and holding no records. The engine's conformance run
composes the store-backed `resources` plugin. `ScriptedWorkers` gains an opt-in worktree per run
for the last scenario.

**Why a minor.** No scenario tightens what 1.3 requires:

- Every 1.3 scenario keeps its expected outcome.
- Each new scenario only covers a case that 1.3 left unspecified:
  - a task that declares a budget;
  - a step of a task's run whose whole answer is a questions object;
  - a brief's files and the working tree they are written into.
- Within those cases the requirements are strict and fail closed. At 1.3 an engine could admit a
  budgeted task with no ledger, run past a spent line, or take questions as a result. At 1.4 it
  must refuse, stop, or block.
- A plain run's answer that is a questions object stays a result, so nothing about plain runs
  changes.
- A provider pinned at 1.3 still passes its suite. A consumer's `^1.3` range accepts a 1.4
  provider, and every behaviour 1.3 states stays as it was.
- This follows ADR-0039 (workflow 1.0 to 1.2, stricter and fail-closed, as minors) and ADR-0044
  (board 1.1 to 1.2).
- The engine already behaved this way: the suite passes with no engine change.

**What stays the Worker source's.** The workflow seam guarantees what it names in the brief and
the subject its result binds to. The source owns the rest:

- writing the file read-only;
- the `.gitignore`;
- checking egress on the file with the prompt;
- refusing a repository that tracks `.system/`;
- removing `.system/` before the worktree's retention commit.

The `agents` source's tests cover these
([agent-workers](../../../packages/plugins/agent-workers/README.md)). The `workers` contract does
not state them.

## Consequences

- The workflow plugin's manifest provides `workflow` 1.4.0. The manifests of its consumers,
  generated from the workspace, take `^1.4.0`: `gateway-anthropic`, `gateway-responses`,
  `mcp-server`, `web-ui`, and both profiles.
- The open item in the roadmap's B4 ("no workflow conformance scenario covers the budget, question,
  or `TASKS.md` behaviour yet") is closed.
- `workflow` has one provider, the engine, and no fake. A second engine would have to pass these
  scenarios over a real ledger.
- Still open, and not decided here:
  - A Worker source's share of `TASKS.md` is not in the `workers` contract. Stating it there would
    change that guarantee seam's contract, by its own ADR.
  - Step 2 of ADR-0047 stays deferred. When it is built, the budget scenarios gain a stop at an
    agent run's boundary.
- Revisit if a second `ctx.workflow` provider appears, or if a Worker source other than `agents`
  gets a worktree per run.
