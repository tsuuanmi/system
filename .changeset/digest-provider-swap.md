---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-digest-core": minor
"@tsuuanmi/system-digest-extractive": minor
"@tsuuanmi/system-bundle": minor
"@tsuuanmi/system-digest": patch
"@tsuuanmi/system-report": patch
---

A second digest provider, swapped in by configuration alone (Base exit criterion 6, T44):
- `digest-extractive` provides `ctx.digests` extractive-first: before its Worker writes, code selects at most `maxExtracts` (default 40) verbatim lines of the sources, recorded as a `digest-extract@1.0` artifact; the Worker reads only those and cites each claim by a line's id, and the quote is filled from that line. Its bundle row is off; the runbook "Swap the digest provider" turns `digest` off and it on in one patch. Its request ids start with `dgx-`.
- The `digests_request` and `digests_get` MCP tools now belong to the seam definition (`digest-core`), so whichever provider runs serves them, unchanged. With both rows on, the second does not start and health `plugins` is down, naming it.
- The report says when a digest attached in the period, or one of a project's digest requests, is unknown to the provider loaded (another settled it before a swap), instead of counting it as having no claims.
