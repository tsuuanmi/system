---
"@tsuuanmi/system-board": minor
"@tsuuanmi/system-workflow": minor
---

System accepts a listed branch's result on its review and its checks (D80, ADR-0067):
- The board takes `autoAccept: { projects, branches }` (off by default; validated at start: project ids and plain branch names, at most 64 each, no repeats). For a listed project's result on a git working tree, the run owner's accepting decision applies only when the run's last review approved the exact tree with no blocking finding left, the `check-run@1.0` record shows each command check it reports passed on that tree, and the result lands on a listed branch. The task is then done on a `board` decision of rule `board.auto-accept` naming the acceptance, the review, the check-run record, and the autonomy decision; the merge still asks the operator. Otherwise the review is held for the operator as before, and the hold's decision lists every condition that failed.
- The workflow engine's task acceptance (`workflow.task-acceptance`, version 3) names the run's last review (its assessment among the inputs) and the landing target (the base branch of the result's worktree, from `ctx.workers.changes`). A report the board applied on that rule is reconciled after a restart, never applied twice.
