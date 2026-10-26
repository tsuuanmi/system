---
---

A workflow eval tells whether a change to System's own process holds up (T231). Past board tasks whose accepted results are known form a golden set (`docs/validation/experiments/records/workflow-golden-set.v1.json`, three tasks to start: T184, T187, T188). Each task is pinned to its base commit, with its goal, its criteria, and a grader: paths the change must touch, patterns a file must match or lack, the task's commands, and optionally the landed commit's tests. A new helper, `scripts/experiments/workflow-eval.ts`, does the rest:

- `calibrate` proves a grader fails on the base and passes on the accepted change.
- `plan` replays a chosen subset under named process variants (`current` now; `fix-in-author-session` and `no-validate-step` named, not yet ready), at least twice each, in variant blocks ordered by a seed, under a budget cap of the eval's own.
- `next` prepares one trial at a time on an eval clone and an eval board project, never live work's, and refuses past the cap.
- `export` and `grade` read a run's records and grade its exact result in a worktree of the eval's own.
- `report` gives per task and in total: passed, passed first time, review cycles, lead and operator touches, tokens, quota points, and wall-clock, plus the tasks that flipped between variants.

The docs are `docs/validation/experiments/workflow-eval.md` (with how to add a task) and the runbook's "Replay the golden set".
