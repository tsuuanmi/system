---
"@tsuuanmi/system-agent-workers": minor
---

Acceptance checks run under a bounded load (T292; seen on the night of 2026-10-26, when up to 9 runs' full `test:affected` suites ran at once and tests with a 5 s timeout failed that pass alone):
- A host-wide queue: at most `checks.maxConcurrent` (default 2, 1 to 32) check commands run at once across every workflow run, first come first served. A check that waits is told (`agent-workers.check.queue`, `queued`) and records its wait; its deadline starts with its command, so it never fails for the wait.
- Each check command gets `SYSTEM_CHECK_MAX_WORKERS`, the host's cores less one shared among `maxConcurrent` (at least 1, at most 32; `checks.maxWorkers` overrides), which the repository's `vitest.config.ts` reads as `maxWorkers`.
- A check that failed only on tests that timed out is run once more alone (`SYSTEM_CHECK_ALONE=1`, nothing else running). Its whole output is read as printed, in vitest 4's report format, and the summary's failure count must match the timeouts read. A `gate` decision (rule `agent-workers.check-timeout-rerun`) naming the first run is recorded before the re-run, and the check-run evidence names it. The second result counts, and its reason says it was a re-run; a stop while it waits stores the first result.
- `system account migrate` leaves `checks` out of the row it prints when its bounds are at their defaults.
