---
"@tsuuanmi/system-agent-workers": patch
---

`system worktrees remove` (MCP `agent_worktrees_remove`) no longer fails, removing nothing, when more than 31 finished worktrees are removable at once (T250): its `retention` decision kept one reason per worktree and broke decision@1.3's bound of 32 reasons. The decision now names each worktree and why while they fit, else counts the worktrees by why; every worktree is still named in its outcome's detail, and each reason is cut to the schema's 300 characters. A worktree git cannot look at while the removal is planned now stays, with why, instead of failing the whole call; one git cannot remove stays as before, and the others go on.
