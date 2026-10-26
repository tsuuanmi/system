---
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-agent-runtime-core": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-runtime-claude-agent-sdk": minor
---

A board task keeps a dossier: the one record its Workers coordinate through when they share no session (T233, ADR-0070):
- Entries are append-only and carried across the task's attempts: `plan` (approach, files, risks), `progress` (what was done, commits, what remains, small decisions and why), `review` (a reviewer's verdict and findings, bound to the subject it reviewed, its result linked, not copied), `response` (per finding: fixed in which commit, or not and why), and `evidence` (System's: the acceptance and its checks, the report to the board, the landing). Each is a content-hashed `task-dossier-entry@1.0` artifact naming the one before it; none is ever changed.
- A Worker appends its own for the step it runs, by its role, through `dossier_append` (bounded text; never `evidence`), a tool its run holds: its source binds it to the step and the execution it runs, so the entry is that step's Worker's and no caller names the step. An agent Worker on Claude Code gets `dossier_read` and `dossier_append` as host tools (`mcp__system__…`, an in-process MCP server; new in the agent-runtime seam: `HostTool`, `RunSpec.hostTools`, `RuntimeEvidence.hostTools`), each call through its tool gate. System's own MCP surface has `dossier_read` only. For a step that wrote none, System appends it: a website or model Worker's answer as it is, an agent's answer linked (on a runtime without host tools), a review's findings from its assessment.
- Every step's brief of a task's run points at a slice of the dossier within 6,000 characters (a summary and the latest entries, `task-dossier@1.0`), and a run's worktree holds the whole of it as `.system/DOSSIER.md`. A fix on another Worker, a moved step, a new attempt, and a reviewer start from it; a reviewer never reads the author's conversation.
