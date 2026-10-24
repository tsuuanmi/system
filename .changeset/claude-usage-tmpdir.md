---
"@tsuuanmi/system-runtime-claude-agent-sdk": patch
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-gateway-core": minor
"@tsuuanmi/system-agent-runtime-core": minor
---

Claude Code quota reads again; a run's commands get a temporary directory of their own (T111, T113):
- Claude Code's usage report tells a window by its shape. The live answer's new entries that are not windows (`limits`, `spend`, `member_dashboard_available`, null ones such as `pace`) are skipped, so every account's windows read again instead of "no reading yet". A window with a field of the wrong type still makes the whole report unreadable.
- A report that cannot be read now says why where the operator looks: `system roster` and the `/ui` Workers tab show `used unknown (no reading yet: its account's usage report could not be read at <time>: <why>)` until a report of that account is read (`AgentAccounts.unreadReport`, optional). A client's roster does not show it.
- Every confined command (an agent, a probe, a worktree's setup) gets a fresh private `/tmp` as `TMPDIR`, `TMP`, and `TEMP`, whatever the daemon's own are. A bind or view of the host's `/tmp` is refused. Claude Code's and Codex's command sandboxes still refuse unix sockets (`listen EPERM`, the `tsx` CLI's IPC pipe), and nothing loosens them (runbook).
