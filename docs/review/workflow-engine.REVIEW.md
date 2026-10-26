---
paths:
  - packages/plugins/workflow/
  - packages/plugins/profile-software-development/
  - packages/plugins/profile-scientific-research/
  - docs/design/workflow-engine.md
  - docs/reference/workflow-templates.md
owner: lead
version: 1
---
# Review guide: the workflow engine and its templates

## What failure looks like here
- A step that waits on a dependency that can never finish: a node whose `dependsOn` (or `differentFrom`) names a node that is retired, failed, or waits for it back. The run hangs with no error; today's dependency hang was one of these. Check every added edge for a cycle and for a state it can never leave.
- A decision the engine took that is not recorded as an artifact (INV-13), or a refusal that sends nothing but leaves no `gate` decision saying why.
- An unreadable or missing input treated as "none" instead of "heavy" or "refused" (INV-2): a path map that cannot be read, a Worker whose family is unknown, a change that cannot be captured.
- A review that does not count as independent but is counted as one (a self-review in `approvals`, a same-family second review), or the reverse.
- A restart that replays instead of reconciling (INV-4): an execution started twice, a decision written twice, a commit made twice.
- A template change with no new tests for the graph it builds, and docs and README that still describe the old graph.

## What to check first
1. The node graph the change produces: list its nodes, `dependsOn`, and which one is final (exactly one). Does anything wait for a node that may be skipped, retired, or failed?
2. Every place the change reads a node's `spec`: is a new field handled where the old ones are (`approvals`, `lastReview`, `checksOf`, remediation, landing provenance)?
3. Store changes: a migration with a test, never an edit of an applied one.
4. The tests name the property, never sleep a fixed time then assert (lesson L6).

## Paths to skip
- `packages/plugins/workflow/tests/` fixtures and golden files unless a test's meaning changed.
- Generated reference tables in `docs/reference/` (the `check:reference` freshness check covers them).

## Nit cap
At most 3 nits (style, naming, wording) in all; say "and N more nits" and stop. A nit is never `important`.

## Evidence rule
Every finding names a file and a line (`packages/plugins/workflow/src/risk.ts:142`) and says what happens, in one sentence, with the input that triggers it. A finding without a file and line is a `nit` at most.

## Summary rule
Open the summary with the count: "2 important, 3 nits, 1 pre-existing". Then one line per important finding. Do not repeat what the change does.
