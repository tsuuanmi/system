---
"@tsuuanmi/system-libs": patch
"@tsuuanmi/system-board": patch
"@tsuuanmi/system-resources": patch
"@tsuuanmi/system-approvals": patch
"@tsuuanmi/system-web-ui": patch
"@tsuuanmi/system-agent-workers": patch
"@tsuuanmi/system-runtime-antigravity-cli": patch
"@tsuuanmi/system-runtime-claude-agent-sdk": patch
"@tsuuanmi/system-runtime-codex-sdk": patch
"@tsuuanmi/system-digest-core": patch
"@tsuuanmi/system-digest": patch
"@tsuuanmi/system-digest-extractive": patch
"@tsuuanmi/system-workflow": patch
"@tsuuanmi/system-experiments-core": patch
"@tsuuanmi/system-models": patch
"@tsuuanmi/system-provider-core": patch
"@tsuuanmi/system-ui-ops": patch
"@tsuuanmi/system-leases": patch
"@tsuuanmi/system-accounts": patch
"@tsuuanmi/system-turns": patch
"@tsuuanmi/system-mcp-server": patch
---

Clean-up (PROP-0018 T2), no behaviour change: libs gains `isRecord`, `clampText`, `sleep` (with an abort signal) and `unique`; the copies of them in the packages above are replaced by these.
