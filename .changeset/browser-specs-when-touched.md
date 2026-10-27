---
"@tsuuanmi/system-libs": patch
"@tsuuanmi/system-agent-workers": patch
---

Browser tests run only when the change touches what they exercise (T305): `pnpm test:related`, `pnpm test:affected`, and the landing's whole suite leave out every test gated on a browser (`describe.runIf(canRunBrowser)`, `headlessIt`, `browserUnavailable`), one test at a time, unless the change is in the browser stack, edits the spec, or edits a helper beside it (`--all-browser` runs them). They set `SYSTEM_SKIP_BROWSER_TESTS=1`, which closes those gates; the plain tests that share a file with browser ones still run, and a test left out is never counted as a browser test that could not run. The landing's check is now told the commit its run's worktree was cut at (`SYSTEM_CHECK_BASE`), as the acceptance's is.
