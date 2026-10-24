---
"@tsuuanmi/system-artifacts": minor
"@tsuuanmi/system-workers-core": patch
"@tsuuanmi/system-agent-workers": patch
"@tsuuanmi/system-web-ui": patch
---

A review reads a run's change within its bounds, and never as "no change" when it was not read (T128a):
- `ctx.artifacts.list` takes an optional `newest` (contract 1.1): the newest first within the limit.
- The agents source reads a run's change as git gives it, keeping only what `CHANGE_BOUNDS` shows: thousands of untracked files are counted, and read only while the bounds leave room, asynchronously; a patch of any size reads as cut, never as unreadable. An untracked file is opened one directory at a time from the worktree's own descriptor, never through a link. Each diff is paired with its file by its own `diff --git` line.
- A landed run still shows its change: once its branch is in the base, the change is read against the commit its worktree was cut at, now recorded (agent-workers migration 16). A worktree made before that, already merged, says its change cannot be told.
- `GET /ui/api/runs/<runId>/review`: the change is `{unknown}` when no source read one while the run's result names the workspace an agent worked in; the verdicts are the newest 20, with `more` (and `moreAtLeast`).
- The page keeps a review read that failed, as it keeps one that succeeded: the 5-second refresh does not read it again, and **Read it again** does. Past the newest 20 verdicts it says how many older ones are not shown.
