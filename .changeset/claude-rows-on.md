---
"@tsuuanmi/system-bundle": minor
---

The Claude Code agent rows are on by default (B3): `agent-runtimes`, `runtime-claude-agent-sdk`, and `agent-workers` mount in the default composition, with no Worker, since a Worker's workspace is a repository the operator names (the runbook shows a read-only reviewer and a writer with a worktree per run). A host without Claude Code, bubblewrap, or a sign-in still boots; its Workers are unavailable and the probe says why. The Codex, ACP, and software-development rows stay off; the `api-first` preset still turns them on.
