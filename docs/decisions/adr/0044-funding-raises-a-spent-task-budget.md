# ADR-0044: An approved funding request raises a spent task's budget by exactly the lines it names

- **Status:** Proposed
- **Date:** 2026-10-23
- **Related:** [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0039](0039-base-guarantee-seam-contract-changes.md),
  [ADR-0040](0040-briefs-on-the-workers-and-workflow-seams.md),
  [PROP-0010](../../proposals/0010-base-version.md),
  [INV-4](../../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay),
  [INV-5](../../architecture/invariants.md#inv-5-exact-subject-binding),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

A board task's `budget` lines are caps on what its attempts draw from the resource ledger,
counted for the task. When a line is reached, the ledger refuses the next run's reservation, and
the run's holder blocks the task (`budget-spent`): the board asks the operator about `funding`.
Until now no board move changed a task's budget, so an approval gave an attempt that the ledger
refused again, each such attempt counted, and the work had to be proposed again as a new task with
larger lines. The operator also approved without being shown how much more the task would draw.

The board is a guarantee seam (work state machine). ADR-0036 makes a change to its contract need an
ADR. The change must stay additive, so that a holder or a provider at 1.1 keeps working.

## Options

1. **The holder names the lines it asks for.** `block` gains an optional `funding` for
   `budget-spent`. The request binds to those lines, and the board applies exactly those lines
   once the operator approves. The holder computes them from the ledger's own count, which it
   already reads. The board bounds them by configuration.
2. **The board computes the lines.** The board has no ledger: it would need `ctx.resources` as a
   new dependency of a guarantee seam's provider, and would compute the ask outside the component
   that met the refusal.
3. **The lead proposes the lines** with a new `board_*` tool, within a configured cap. This adds a
   tool, a second request on the same wait, and a way for model-chosen numbers to reach the queue.
   The operator would still decide, but every spent budget would wait on the lead first.
4. **A new board method** to change a task's budget. This is not additive to the contract's
   fields, and it splits one decision (go on, with more) into two requests.

## Decision

Option 1. The board's contract moves from 1.1 to 1.2, and `board-task@1.0` to `@1.1`, as minors.

- **`block` (`budget-spent` only) takes an optional `funding`.** It names the lines to add, at most
  one per pool and unit of the task's budget, each above zero. Anything else is refused
  (`invalid`), and nothing changes.
- **The request binds the lines (INV-5).** The `funding` request's subject is
  `board-task:<id>:attempt:<n>` at version `budget-spent:<sha256 of the lines' canonical JSON>`. Its
  summary and consequences name the lines and the budget they make. The wait keeps them
  (`waiting.funding`). A request put to the policy again after a policy change asks for the same
  lines on the same subject.
- **Approved, exactly those lines are applied, before the gate (INV-13, INV-4).** In one
  transaction, the board adds the lines to the budget, appends the raise to `funding` (the
  lines, the operator's approval, and a `board` decision that names the approval), and then puts
  the next attempt to the policy, as for any approval to go on. A crash before that commit leaves
  the task waiting on the approved request, and the next sweep applies it once, adopting any
  request the dead move opened. With no attempt left, nothing is raised. A request whose subject
  does not bind the stored lines raises nothing, and the task waits for input (`rejected`).
- **Bounded per task (INV-9).** The board's `fundingMaxPercent` (default 100) bounds what all of a
  task's raises add to a line, as a share of the amount the task declared. An ask past the bound
  opens no request, and the task waits for input (`rejected`), as when the policy cannot ask. The
  bound is checked again when an approval is applied. Each raise follows a spent run, which is an
  attempt, so the number of raises is bounded by the task's attempts.
- **Rejected or expired, nothing changes:** the task waits for input (`rejected`), as at 1.1.
- **The workflow engine computes the ask** from the ledger's count of the task's usage, never from
  a model's report. For each line the recorded usage reached, it asks for the overdraft plus one
  attempt's share of the line (the line divided by the task's attempts). It records the ask on the
  run's row before the block, so a block asked again after a crash asks for the same lines.

A `budget-spent` block without `funding` behaves as at 1.1. The engine sends no lines when the
ledger cannot count the task's usage. Then the request asks only to go on.

## Consequences

- The suite adds `board.funding-raises-budget` (since 1.2), which the fake and the store-backed
  provider pass over both approval queues. A provider pinned at 1.1 still passes its suite.
- An approved funding request changes a task's `budget`. The ledger enforces the raised lines from
  the next reservation on, and the brief tells the next attempt what is left.
- The operator sees the lines in the queue, and the subject binds them. A request asked on other
  lines is a different request.
- Not decided here: a lead proposing its own lines; funding a milestone (`project@1.0`
  `milestones[].funding`); stopping a run that overdraws mid-run. A funding ask is still made when
  the spent run was the last attempt. Then an approval raises nothing.
- Revisit if raises should be bounded per project, or by absolute amounts per pool, rather than as
  a share of each task's own lines.
