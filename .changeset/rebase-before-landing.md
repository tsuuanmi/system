---
"@tsuuanmi/system-board-core": minor
"@tsuuanmi/system-board": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-web-ui": patch
---

An accepted result is rebased onto its landing target and checked again before it lands (D82 #1, T216, ADR-0068, amending ADR-0060's decision 4).

- Why: nearly every board task's result was cut from an older `dev`, and its merge conflicted (code, docs, ADR, migration, and schema numbers), so the lead merged about twelve results by hand in one night; and a merge that did not conflict merged a tree no check had run on.
- `workers` seam (additive): `LandStep` gains `rebase` (phases `start`, `resolved`, `abandon`); `Landed` gains `rebased`, `conflicted`, and `abandoned`, and `committed` an optional `fork` (where the head forked from the base).
- The `agents` source rebases in the run's worktree, which stays on its branch: the head kept under `refs/system/rebase/<runId>/<head>`, the change replayed on the base, the declared generated files made again by the repository's commands (T166's confinement and checks); a conflict elsewhere left marked for a writing step, its resolution committed only with no conflict marker left; a rebase found done after a restart is taken only on a clean worktree, its subject the committed tree that lands; `abandon` puts the branch back. Each phase finds its own work done after a restart, from git's refs (`refs/system/rebase-replayed/<runId>/<head>` marks a replay whole), so a crash between moving the branch and the replay replays again instead of committing the head's tree on the base. Its landing commit recognises a rebased head; its retention never commits a worktree with a rebase left unresolved.
- The workflow engine's landing: when the commit's `fork` is not the base's head, `rebase`, then (on a conflict) `resolving` by a writing step on the result's own author's Worker (the run's writing step that wrote it, never a validation that only ran in its worktree), on the task's brief (the task, its project, and its attempt, so its reservations and usage are within their caps), told what moved and that the base's behaviour is kept, then `recheck` (the checks the run's own acceptance required or asked of its result, pending ones included (a check that timed out or was not let run; only one the repository has no command for is left out), run again on the rebased tree, also when the operator accepted it on the board), then the merge request on the rebased head; a conflict left unresolved, a failed resolving step, or a check that fails there sends the result back as another attempt (`returning`, kept before the branch is put back, then `returned`). Each move a `gate` decision (`rebase`, `resolve`, `recheck`, `return`, `hold`) of `workflow.landing`; at most 3 rebases per landing. A target that only moved spends no attempt.
- `board` contract 1.4: the optional `reopen(taskId, { runId, acceptance, decision, reason })` sends a done task back as another attempt, through the gate again, naming the landing's decision; the conformance suite adds `board.reopen-sends-back`, which the store board and `FakeBoard` pass.
- `/ui`: the Board's task card says when a result is being rebased, resolved, checked again, or was sent back, and why.
