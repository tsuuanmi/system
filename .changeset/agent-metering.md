---
"@tsuuanmi/system-agent-runtime-core": minor
"@tsuuanmi/system-runtime-claude-agent-sdk": minor
"@tsuuanmi/system-agent-workers": minor
---

Agent Workers report what they consume, from the runtime's own numbers (B2):
- A runtime's run result may carry its token usage (input including cached input), its usage per model with cost, its main model, and the rate-limit observations it saw; a failed run carries them on its error. The Claude Agent SDK runtime reads them from the result's `modelUsage` and from `rate_limit_event` messages, and fails a run that hit a usage limit as `quota_exhausted`.
- An agent result is `agent-result@1.2` (model, usage, models) when the runtime reported usage.
- An agent Worker configured with a resource `pool` and `account` reserves before each run (a refusal runs nothing), records one `usage-record` after it, and records the runtime's limit observations as readings of the windows `windows` maps them to. It is `quota-exhausted` while its pool is unavailable. Without a pool, nothing changes.
