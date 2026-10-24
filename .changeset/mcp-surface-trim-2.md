---
"@tsuuanmi/system-mcp-server": patch
"@tsuuanmi/system-workflow": patch
"@tsuuanmi/system-board": patch
"@tsuuanmi/system-approvals": patch
"@tsuuanmi/system-agent-workers": patch
"@tsuuanmi/system-digest-core": patch
"@tsuuanmi/system-report": patch
"@tsuuanmi/system-resources": patch
"@tsuuanmi/system-turns": patch
"@tsuuanmi/system-login": patch
"@tsuuanmi/system-models": patch
"@tsuuanmi/system-notify": patch
---

The MCP surface has headroom again (T108, QA-12), and every call is validated as before:
- `tools/list` as the operator is 44,521 bytes (was 46,975) and as the lead 26,352 (was 28,013). The client ceiling is 29,000 (was 29,100) and the largest tool's 4,500 (was 4,600); the operator's stays 47,200, since its new size plus 10 % would be over it.
- The listing leaves out the safe-integer bounds zod gives an integer that sets none of its own (`maximum: 9007199254740991`); the server still refuses an unsafe integer.
- Tool descriptions say each fact once: what a parameter's description says is not repeated in the tool's (`board_update`'s answer shape is said on `answers` only), no "Operator tool:" or "Operator only:" word (the listing's `_meta` is the scope), and no reference a sentence already states. The `resources_*` ids list no `maxLength` beside the id pattern, which bounds them.
- `status` sums up the plugins for the operator as `N plugins, M need a look`.
