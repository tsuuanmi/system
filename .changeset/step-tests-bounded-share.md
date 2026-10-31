---
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-agent-runtime-core": minor
"@tsuuanmi/system-runtime-claude-agent-sdk": patch
"@tsuuanmi/system-runtime-codex-sdk": patch
---

A run's own tests use a bounded share of the host (T348; T336's three attempts failed only on browser and Xvfb specs that timed out at a load of about 2,260 on 256 shared cores):
- A writing step's commands get `SYSTEM_TEST_MAX_WORKERS` (`RunSpec.testWorkers`, `withTestWorkers`): `stepTests.coreBudget` (default half the host's cores) shared among `stepTests.runs` (default 6; set it to the dispatch's `maxRunning`), 1 to 32. The repository's `vitest.config.ts` reads it as `maxWorkers`, with `SYSTEM_CHECK_MAX_WORKERS` (the smaller of both). `system account migrate` leaves `stepTests` out of the row it prints when it sets nothing.
- The browser and real-Xvfb specs (browser-patchright, display-virtual, the display, browser, and deletion conformance suites) scale their waits for the browser stack (timeouts, Xvfb start-up bounds) by `SYSTEM_TEST_TIME_FACTOR` (1 to 20, default 1); an assertion is never loosened.
