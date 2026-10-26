---
paths:
  - packages/board-core/
  - packages/plugins/board/
  - packages/landing-core/
  - packages/plugins/landing-local/
  - packages/plugins/workflow/src/dispatch.ts
  - packages/plugins/workflow/src/tasks.ts
  - packages/plugins/workflow/src/landings.ts
  - docs/design/board.md
owner: lead
version: 1
---
# Review guide: the board, dispatch, and landing

## What failure looks like here
- Two writers on one subject (INV-15): two runs holding a task, two landings on one branch, a lease that is not fenced.
- A result accepted or landed on a tree other than the one reviewed and checked (INV-5): the HEAD moved, the worktree is dirty, a fix was added after the review.
- A rebase or merge that conflicts in generated files and resolves them by hand or by taking one side. Today's regenerate guard exists because a generated file (traceability tables, references, manifests) was merged by hand and drifted; regeneration runs only for files the repository declares generated, and a conflict in anything else stops. The rebase traceability conflicts came from `docs/validation/traceability.md`: rerun `pnpm gen:traceability`, never edit the table.
- A task started outside an active project with an approved charter, or one that spends past its budget without stopping at a boundary (ADR-0047).
- A restart that counts an infrastructure failure as an attempt, or loses one.

## What to check first
1. The state machine: draw the transitions the change adds, and for each, what a crash in the middle leaves (INV-4).
2. Every path that applies a result: does it check the exact subject and the required checks on it (ADR-0063)?
3. A landing step repeated after a restart finds its work done and says so.
4. Tests for the failing branch, not only the happy one.

## Paths to skip
- `docs/validation/traceability.md` and other generated tables: check that the generator was run, not the table's text.
- Board fixtures and example records under `schemas/examples/`.

## Nit cap
At most 3 nits in all, then "and N more nits". A nit is never `important`.

## Evidence rule
Every finding names a file and a line, the state it starts from, and the event that breaks it ("`landings.ts:540`: after a crash between the merge and the record, the next pass merges again").

## Summary rule
Open with the count: "2 important, 0 nits, 1 pre-existing". Then name each state or transition the change adds.
