---
"@tsuuanmi/system-provider-core": minor
"@tsuuanmi/system-provider-gemini-web": minor
---

Gemini: a prompt over `maxPromptChars` (default 30,000 characters, the observed site limit) is refused before anything is sent; a prompt the site silently drops is `input_dropped`; a bound conversation the site no longer has is `conversation_lost` and is not retried, so a team member whose chat is gone fails at once with a clear error. A page that shows neither signed in nor signed out is outlined as drift evidence.
