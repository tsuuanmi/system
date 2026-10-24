---
"@tsuuanmi/system-gateway-core": minor
"@tsuuanmi/system-mcp-server": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-cli": minor
"@tsuuanmi/system-digest-core": minor
"@tsuuanmi/system-board": minor
"@tsuuanmi/system-approvals": minor
"@tsuuanmi/system-resources": minor
"@tsuuanmi/system-worker-sessions": minor
"@tsuuanmi/system-login": minor
"@tsuuanmi/system-turns": minor
"@tsuuanmi/system-agent-workers": minor
---

The MCP surface costs a client fewer tokens (T76, QA-12), and nothing a client reads is lost:
- A tool answers once: the answer is the result's structured content, and its text block is a short summary (a completed run's text is still its answer), never the same JSON again. `reply` and `outline` in `gateway-core` make such a result.
- `tools/list` carries no `$schema` (the input schemas are JSON Schema 2020-12, MCP's default), no `execution: {taskSupport: "forbidden"}` (absent means the same), no zod `pattern` beside `format: "date-time"` (the server still checks it), and `_meta: {"system/scope": "operator"}` only on a tool the operator token alone may call. The server validates every call exactly as before.
- `status` lists for the operator only the plugins that need a look (a manifest check finding, a refused manifest, a lifecycle the composition does not give it) and counts the rest in `pluginsOmitted`; `status { plugins: true }` lists every one, as `system plugins` does. Health is unchanged.
- `usage` lists the 10 most recent runs unless `limit` asks for up to 500 (was 50), and each run without its answer, result and brief ids, spec hash, errors, wait, or task, which `result` gives; each step keeps its Worker, tiers, quota class, tokens, and `usageUnknown`.
