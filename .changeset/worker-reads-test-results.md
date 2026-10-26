---
"@tsuuanmi/system-agent-runtime-core": minor
"@tsuuanmi/system-runtime-claude-agent-sdk": minor
"@tsuuanmi/system-runtime-codex-sdk": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-workflow": minor
---

A Worker can read its own test results (T270):
- A run's private shell home now holds its tool-state directories (`~/.local/share`, `~/.local/state`, `~/.cache`, `~/.config`), bound back writable over the read-only home, with fish's startup directories in them read-only again (`agentHome().writable` and `.startup`, `HOME_STATE_DIRECTORIES`, `HOME_STARTUP_DIRECTORIES`). Tools that create them on their first run write quietly instead of printing `mkdir .local` errors on every test file. No startup file can be planted, the home is removed with the run, and the real `HOME` stays unmounted. Claude Code's command sandbox allows those directories (`withHomeState`) and denies its home and fish's directories, no longer the shells' home whole; Codex's gets them among its `sandbox_workspace_write.writable_roots`.
- A failed check's result carries its failing tests' names and assertion lines (`CheckResult.failures`, at most 200 lines of 240 characters), and the task's dossier gets an `evidence` entry with them after the acceptance's, so the next attempt's Worker sees what failed without opening the `check-run` artifact.
- The tool gate admits exactly `corepack pnpm vitest run <test file>` inside the run's worktree, as a write of the workspace, and refuses it on a path outside it.
