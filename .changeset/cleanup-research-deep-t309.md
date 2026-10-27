---
"@tsuuanmi/system-profile-scientific-research": patch
---

Clean-up (T309, PROP-0018 T3, L3): the `research-deep` stub is gone. The typed-result listener now handles only `research` runs and always parses a step's result with the profile's current schema (`hypothesis-set@1.0`, `evidence-table@1.1`). It no longer keeps a pre-PROP-0004 step on the schema version that step asked for. The store holds no `research-deep` run (the lead checked on 2026-10-27).

Measured lines removed (net), against the row's target of about 11 source and 36 test lines: 6 source (`src/index.ts`), 14 tests (`tests/profile.spec.ts`), and 2 README lines. Less is removed, file by file, for these reasons:

- `profile-scientific-research/tests/profile.spec.ts`: the old-run test was 14 lines, not the proposal's estimated ~30.
- `workflow/src/spec.ts` (`LEGACY_SEVERITY` and its lookup, ~5 lines), `workflow/src/review.ts` (a 1-line comment), `workflow/tests/review-severity.spec.ts` (the legacy finding cases): L1 is kept on purpose. Removing it changes what `parseAssessment` returns for the fixed sample in `scripts/experiments/reviewer-eval.ts:358` (`blocking`, `info`). That changes the reviewer's recorded fingerprint, so `check:reviewer-eval` (in `pnpm check`) and `scripts/experiments/reviewer-eval.spec.ts` fail until a measured `reviewer-eval.ts run --record` with live reviewers records a new gate (attempt 2 of T309 measured this: check exit 1). That run cannot happen in a run's sandbox. Editing the sample or the record without a run would weaken the gate. L1 goes in a follow-up task that records the reviewer eval in the same change. No `@tsuuanmi/system-workflow` changeset, since that package is unchanged.
