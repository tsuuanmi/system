---
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-workers": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-web-ui": minor
---

The operator decides a review seeing what it changed (T122):
- `ctx.workers.changes(runId)` is new and optional, as is `WorkerSource.changes`. It reads a workflow run's change in each worktree a source holds, read only and bounded (`CHANGE_BOUNDS`). The agents source reads its worktree against the commit it forked from on the repository's checked-out branch, untracked files included, never through a link; a retired worktree is read from its branch. A source that cannot read its own is named, never read as no change.
- `GET /ui/api/runs/<runId>/review` gives the run's change, its reviewers' verdicts (`assessment`), its report (the run's answer), and its landing.
- A review card, and a run's page, show what changed (the stat, then each file folded, a long one with "Show all"), what the reviewers said, and what the checks measured. The checks not run are shown in warning colour: "Accepting counts them as passed — run them first."
- After **Accept**, the result stays under "Accepted, on their way in" with where it stands (committed on its branch, its merge request linked) until it is merged or refused. `GET reviews` adds `accepted`.
