---
"@tsuuanmi/system-runtime-codex-sdk": minor
---

Codex runs report their token counts (T208, from the efficiency audit T203). The Codex provider sums the `usage` of each `turn.completed` into the run's `usage`: `input_tokens` as `inputTokens` (its parts `cached_input_tokens` and `cache_write_input_tokens` as `cacheReadInputTokens` and `cacheCreationInputTokens`), `output_tokens` as `outputTokens` (its part `reasoning_output_tokens` is not added again). A run that ends early reports the tokens of the turns it completed, marked `partial` as a lower bound. A turn whose counts cannot be read leaves the run with no token counts. No cost is reported: Codex names no charge, and a Codex subscription stays judged by its windows.
