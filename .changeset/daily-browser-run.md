---
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-workers": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-web-ui": minor
"@tsuuanmi/system-report": minor
---

A daily run of every browser spec on dev's tip, inside System, whose failure files a board task (T305b, D104):
- **`workflow.dailyCheck`**, off by default (`enabled`, `projectId`, `repository`, `ref` default `dev`, `hourUtc` default 4, `timeoutMinutes`, `actionClass`, `taskTemplate`): once a day from its hour, the whole suite with every browser test runs on the ref's tip. A failure proposes one board task with the failing tests' names and assertions, the commit, and the last green commit, and none while an earlier one is open; a pass is recorded; a run that did not run to an exit code, or exited 0 without running its browser tests, is an `error`, files nothing, and is never the last green commit. `dailyCheckTick`, `dailyCheckNow`, and `dailyCheckReport` are the seams; store migration 27 keeps the runs, and a run a restart cut resumes its own stored check.
- **A check on a tip.** `WorkerSource.checkTip` and `ctx.workers.checkTip` (optional): agent Workers cut a worktree at the commit, set it up, and run the `tests` check, bound to exactly that commit with nothing on top of it (a setup that changed the tree is refused), at the new scope `daily` (`SYSTEM_CHECK_SCOPE=daily`: `pnpm test:affected` runs the whole suite, no browser test left out), confined and read-only, in the host's queue of checks. Its worktree is held while the check uses it (setup, queue, command): neither the retention nor the operator's removal retires it then, it lists as in use, and its retention counts from the check's end (store migration 23 of agent-workers, `agent_worktrees.used_at`).
- **A check's environment is its source's own.** A check's command is told `SYSTEM_CHECK_ALONE=0` unless it is the re-run alone after timeouts, and no `SYSTEM_CHECK_BASE` its worktree did not record: a check started inside another check (this repository's suite, run as a check alone) no longer inherits its parent's, which made the timeout re-run's tests fail at a landing.
- **Shown.** `/ui` Home has a "Daily run" panel (`GET /ui/api/daily-check`), and `system metrics` notes the last daily run and the last green commit.
