---
"@tsuuanmi/system-provider-core": minor
"@tsuuanmi/system-browser-patchright": minor
"@tsuuanmi/system-turns": minor
"@tsuuanmi/system-provider-gemini-web": minor
"@tsuuanmi/system-provider-chatgpt-web": minor
"@tsuuanmi/system-mcp-server": patch
---

Kept tabs (ADR-0030 amendment): a session-bound account's persistent session keeps its page between turns, so a session's follow-up turns load no page. A kept page is checked again on hand-back, kept only when idle and clean, at most 4 per account, and closed with its session or context.
