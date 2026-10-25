---
"@tsuuanmi/system-provider-core": patch
"@tsuuanmi/system-workers-core": patch
"@tsuuanmi/system-workflow": patch
"@tsuuanmi/system-turns": patch
"@tsuuanmi/system-artifacts": minor
"@tsuuanmi/system-web-ui": patch
---

Review fixes to the resend after a site's own error (ADR-0062, T144):
- The resend fences the run's lease before it resets the member's session, so an engine that lost the run records, resets, and readies nothing, and the engine that takes the run back resends once; the turn runtime closes a reset or released session's kept tab only once the caller's store transaction commits, so a rolled-back resend leaves no tab closed.
- `ProviderError.siteError` is optional (`siteError?: true`), set only when true (ADR-0036).
- A recovery decision that weighs a resend (`resend`, or `fail` with a `resend` candidate) is decided under rule `workflow.recovery` version 2; one with no site error stays version 1 (INV-13).
- A resend also needs the error's disposition to be retryable; a site error of another disposition fails as before (conformance scenario `workflow.site-error-not-retryable`).
- "Never twice" asks for the node's `resend` decision directly: `ctx.artifacts.list` takes an optional `outcome` (artifacts contract 1.2, additive).
- The web UI names the `workflow.node.resent` event; the workflow README lists it.
