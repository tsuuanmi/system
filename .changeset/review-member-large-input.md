---
"@tsuuanmi/system-workflow": patch
"@tsuuanmi/system-provider-gemini-web": patch
"@tsuuanmi/system-turns": patch
---

A review team member kept off a website by its input bound, or slow on Gemini, now fails only for its real cause, and says it (the live two-member review of 2026-10-23):
- A text review shows its text once: the request is the source step's numbered file `material`, so a text that fits `repositories.maxSourceChars` fits a 30,000-character member input again (it was sent twice: 17,000 characters of text made a 36,064-character input, over the Gemini site's bound).
- A rejected answer escalates only onto a Worker the member's session can take (`workflow.escalation` version 2): with none at the next tier, the step fails as `acceptance_rejected` with the contract's reasons and why it was not escalated, instead of an admission failure; an answer cut at its Worker's output bound says so.
- A member's admission failure says the team is short of provider families only when it is.
- Gemini: what the whole answer shows, its thinking included, counts as progress, so a long think is not a stall; the input bound is counted in characters (code points), as admission counts it.
- A stalled website turn names the bound that ended it, where the page is outlined, and what to change.
