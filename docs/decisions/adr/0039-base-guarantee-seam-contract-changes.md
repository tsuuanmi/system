# ADR-0039: Base B3 to B5 extend the workers, workflow, board, and approvals contracts

- **Status:** Accepted; amended 2026-10-23 (the board puts a wait to the policy again when a policy change withdrew its request)
- **Date:** 2026-10-23 (accepted 2026-10-23, by the operator)
- **Related:** [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0037](0037-schema-and-protocol-first.md), [PROP-0010](../../proposals/0010-base-version.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-4](../../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay),
  [INV-5](../../architecture/invariants.md#inv-5-exact-subject-binding),
  [INV-15](../../architecture/invariants.md#inv-15-one-writer-per-subject)

## Context

ADR-0036 makes a change to a guarantee seam's contract need an ADR. Milestones B3 to B5 of
PROP-0010 changed four guarantee seams to do what the proposal asks: a worktree per writing run,
board tasks served by workflow runs, and the autonomy policy enforced on every action. Two of the
seams (`workers`, `workflow`) were already on `main`. The other two (`board`, `approvals`) were
defined in the same unmerged stack (B1) and amended before any release. Every change is additive
for existing callers or makes a seam stricter (fail closed). None of them widens what a provider
may do.

## Options

1. **Accept the changes as one record**, listing each seam's change and the conformance version
   that tests it.
2. **One ADR per seam.** This gives the same content in four records that would have to be read
   together, because the changes depend on each other (a board task's run needs the run id on
   every execution).
3. **Revert to the contracts on `main`** and keep B3 to B5 out of the core. This leaves the board
   unable to finish work and the policy unenforced inside a Worker, which PROP-0010 requires.

## Decision

Option 1. The contracts change as follows.

**`workers` (core: gate).** `WorkerStart` gains an optional `runId`, naming the workflow run an
execution belongs to. Callers that omit it see no change. A Worker source may use it to keep a run's
executions in one workspace (agent Workers' `worktreePerRun`).

**`workflow` (core: work state machine, runner).** The conformance contract moves from 1.0 to 1.2:
- 1.1: the engine names its run on every execution it starts (`workflow.run-id`).
- 1.2: a run may serve one attempt of a board task (`task: { taskId, holder?, generation? }` on
  start and on the `run` tool). The engine adopts a live claim or claims the task itself. It records
  the run on the board before any node runs (`board.start`). It renews the board lease while the
  run lives, and reports the outcome through the board only: `submit` and `accept`, with an
  acceptance bound to the task, the result's exact subject, and every result artifact, or
  `reconcileRun` after a failure or a lost holder. A run without a task behaves as before. Without
  a board, a run for a task is refused. Scenarios: `task-run`, `task-claim`, `task-failure`.

**`board` (core: work state machine), amended in place at contract 1.0 (unreleased).**
- A move is committed before its approval request is withdrawn.
- Waits expire on their own when the queue has no verdict.
- From `running`, the policy alone never readies or cancels a task.
- An acceptance binds to the exact result.
- Every attempt goes through the gate again.
- A task with no attempts left is never ready.
- An acceptance that is not the operator's, with required checks still pending, holds the review
  for the operator (`waiting.reason: operator-review`, bounded by the policy's expiry). Only the
  operator's acceptance accepts it.
- `board_complete` is removed: the engine is the one writer of an attempt (INV-15).

**`approvals` (core: gate), amended in place at contract 1.0 (unreleased).**
- `request` judges the action again under the current policy, and refuses a cited decision for
  another class, project, policy version, or policy hash.
- A policy change withdraws open requests it no longer asks for.
- Listed commands match the whole argv exactly. An argv word with a shell metacharacter is
  forbidden.
- `remediation` joins the classes that always ask (a load-time rule, since `autonomy-policy@1.0`
  predates it).
- A rule's required checks bind when a result is accepted, not at a step of the work: a gate on the
  work records them as pending.

The tool gate on the `agentRuntimes` capability seam (`RunSpec.toolGate`, `gatesToolCalls`)
needs no ADR under ADR-0036. It is listed here because the gate component above relies on it: a
runtime that cannot ask the gate before each tool call refuses a gated run, so its Workers are not
admitted.

## Consequences

- Each seam's conformance suite tests its new behaviour, and each fake follows it
  ([plugin model](../../architecture/plugin-model.md#seam-catalog)).
- Callers of `workers` and `workflow` on `main` keep working unchanged.
- The Codex and ACP runtime rows stay off until their runtimes can ask the gate before each tool
  call.
- Open, and not decided here:
  - Required checks bind at acceptance only for a run that serves a board task.
  - Nothing carries a run's project to the Worker's tool gate, so tool calls are judged under the
    studio policy. Carrying it would change `WorkerStart` again.
- Revisit if a later milestone needs a waiting status in the `workers` seam: a run deferred on an
  approval now ends as a failure that names the request.

## Amendment (2026-10-23): a wait whose request a policy change withdrew

The `approvals` change above withdraws an open request the new policies no longer ask for. The
board took every withdrawn request for its own, so such a wait stayed until it expired, even when
the new policy would let the work run. `board` is amended in place at contract 1.0 (still
unreleased): a request withdrawn by the queue's policy rule (decider rule `approvals.policy`) gets
no verdict, so the sweep runs the wait's gate again under the current policy, as a fresh gate, and
records a `board` decision. A request the board withdrew itself still changes nothing. The suite
adds `board.policy-change-asks-again`, and its `boot` gains `changePolicies`
([board](../../design/board.md#where-the-tables-leave-room)).
