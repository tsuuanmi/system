---
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-cli": minor
---

You can see the run worktrees and remove the finished ones yourself (T99 D12):
- `system worktrees` (MCP `agent_worktrees`, operator scope, `mcp-agent-runs@1.1`) lists every workflow run's worktree not removed yet, oldest first: its state (`in-use`, `held`, `finished`), what it holds (`clean`, `uncommitted`, `gone`, `not-intact`), its path and branch, and when the retention removes it.
- `system worktrees remove [--run <runId>] [--commit-changes] [note]` (MCP `agent_worktrees_remove`) removes the finished ones now, every one or one run's, at most 50 a call, recorded first as your `retention` decision. A worktree is removed only while no agent run of its run is unfinished or held, and only when it holds nothing uncommitted, or with `--commit-changes` once its changes are committed on its branch: nothing is discarded, and the branch stays. Its output is checked on the plan before anything is decided.
- The retention itself is unchanged: it removes a worktree `worktreeRetentionHours` after its run's last agent run ended, whether the attempt failed or its result was accepted or rejected (now tested end to end on the pilot). A new runbook section says who removes what, and how to delete the merged `system/run/*` branches yourself.
