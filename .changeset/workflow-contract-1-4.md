---
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-web-ui": patch
"@tsuuanmi/system-mcp-server": patch
"@tsuuanmi/system-gateway-anthropic": patch
"@tsuuanmi/system-gateway-responses": patch
"@tsuuanmi/system-profile-software-development": patch
"@tsuuanmi/system-profile-scientific-research": patch
---

The `workflow` contract is at 1.4 (ADR-0053, accepted 2026-10-24; T52): its conformance suite now states a board task's budget (refused before the task is taken when the ledger cannot hold it, reserved before each step, a spent line stopping the run and blocking the task with a funding request, none asked on its last attempt), a run's question, and `TASKS.md` in a run's own worktree. The engine is unchanged. `system plugins` shows the workflow plugin providing 1.4.0, and its consumers' manifests take `^1.4.0`.
