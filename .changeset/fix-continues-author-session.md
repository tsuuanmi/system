---
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-profile-software-development": patch
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-agent-workers": minor
---

One task, one author session: a review's findings now go as messages to the author's session (T232; seen on T207, T213, T216, where a fix ran on another account's Worker in a fresh context and lost the author's reasoning):

- A remediation fix now takes the session of the step that wrote the change. It routes to that session's Worker and resumes its native conversation. The findings, the subject the reviewer read, and what to change are its next message, so the author fixes its own work on top of what it did. A team member's session is never taken.
- When the author's Worker cannot take the fix now (out of quota, signed out, not listed), the fix waits for it. It sends nothing and spends no attempt, for at most `fixSessionWaitMinutes` (new configuration, default 60). Past the bound, it moves off the session through T230's handoff, carrying the session's earlier turns. A lost session (no Worker keeps it, or there is no native session to resume) is handed off into a new conversation of the same session, its brief carrying the earlier turns. Each path is a `route` decision by `workflow.fix-session` (`continue`, `wait`, `handoff`), or a `workflow.session-move` for a move. A fix no longer starts fresh in silence. A `workflow.session-move`'s `stay` reason now cuts a long refusal rather than the reason it is not waited on.
- The reviewer stays independent: every review and re-review runs in a session of its own, never the author's.
- Each fix is its own commit of the run's review history, the ref `refs/system/reviews/<runId>` of its repository. The tree the review read is kept before the fix runs, and the fix's result after it completes, through the worktree source's new `land` `record` step. Each commit, or why none was made, is a `gate` decision by `workflow.fix-commit`. The worktree's HEAD, branch, index, and files never move, so a board task still binds its result and the run's required checks to the commit it writes (`writes.ref`).
- `@tsuuanmi/system-workers-core` adds the `land` step `record`, its answer `recorded`, and `reviewRef(runId)`. `@tsuuanmi/system-agent-workers` makes that step: the tree, while still exactly the subject asked, is committed on the run's review history ref from an index of its own.
- A re-review is now shown the change since the subject the last review read, and the whole change since the first review's base. Before, it saw only the change against HEAD.
- `@tsuuanmi/system-libs` adds `changeSince(workspace, commit)`, a working tree's change against a commit shown as a subject's change is, `changeBetween(workspace, from, to)`, the change between two commits, and `CLEAN_VERSION`.
