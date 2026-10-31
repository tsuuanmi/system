---
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-report": minor
"@tsuuanmi/system-libs": minor
---

The System no longer fills its host's disk (T345):
- A landing that ends merged, or with nothing to land, on a done task has the source that holds the run's worktree remove it at once (new landing step `release`): only when it is clean and no agent run holds it, its branch kept, recorded as a `retention` decision. A commit step asked again afterwards finds its commit on the branch. A worktree of a task that may be retried is kept for the retention, which stays `worktreeRetentionHours` (the live patch sets 6).
- A disk floor: `diskFloorGb` (default 10) and the `disk-floor` enforce mechanism (`enforce.diskFloor`, starts `warn`). On, no new worktree is cut while the worktrees' filesystem has less free: dispatch's pass says why; a run that would cut one fails `overloaded` with nothing sent (never counted as the task's attempt), and a carried retry waits with its carry due (a new carry refusal `no-room`), so a full disk never spends an attempt. The wait is bounded by `maxLimitWaitHours` from its first wait (kept on the carry, whatever the retention), and ends sooner once the retention retires the earlier attempt's worktree or the operator removes it: then the retry starts fresh from HEAD (recorded, with why), the earlier work kept on its branch. In warn the refusal is recorded only.
- `lead_health` gains a `Disk` row (free space of the worktrees' and the store's filesystems; degraded under 20 %, failed under the floor; `mcp-report@1.8` adds the state `failed`) and counts every worktree, past 100.
