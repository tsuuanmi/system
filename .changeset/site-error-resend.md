---
"@tsuuanmi/system-provider-core": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-turns": patch
"@tsuuanmi/system-provider-gemini-web": patch
"@tsuuanmi/system-artifacts": patch
---

A team member's first step that the site answered with its own error after the send is resent once, in a new conversation (operator decision D60, ADR-0062):
- `ProviderError` gains the optional `siteError`; the Gemini driver sets it on "Sorry, something went wrong" (and its other recognised errors) read in place of an answer. The turn runtime keeps it on a turn's error only when the turn's receipt was written, and its Worker execution carries it (`WorkerExecution.error.siteError`, optional). Neither ever resends.
- The workflow engine (contract 1.8) resends a team member's `propose` step once on such an error, in a new conversation of the member's session (`ctx.workers.reset`), on the same Worker, as its next attempt after the back-off: never a ballot or debate, never a step that proves `develop` or grows a plan, never twice. The `recovery` decision `resend` (`decision@1.9`) names the failed execution and the new attempt's key, recorded in the transaction that resets the session; the event is `workflow.node.resent`. A site's error that is not resent fails as before, its decision saying why not.
- ADR-0061 (a task's next attempt carries the previous attempt's work) is accepted (D59).
