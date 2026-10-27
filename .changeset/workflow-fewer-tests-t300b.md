---
"@tsuuanmi/system-workflow": patch
---

Fewer boots in the workflow tests (T300b, D101): the three board tests that weigh a run by what was sent (a task's own refusal before any send, a failure after a send, a sign-out before any send) share one engine boot and assert each case in turn. No source changed; every assertion is kept. No REQ or INV citation moved except the board tests' line shift in `docs/validation/traceability.md`.

Before and after (tests and conformance, helpers included): tests about 429 to 427; lines 14087 to 14079; test time not re-measured (the merge saves one boot, about 1 s of `scripts/test-durations.json`'s per-file sum). The 20 % / 20 % / 15 % targets are not met. Where coverage stops further cuts, file by file:

- `team-exclusion.spec.ts`: 12 boots, each a distinct config (`excludeWorkers`, `allowSameFamily`, roster); its other tests are boot-free units of `leftOutOfTeams`, `restriction` and `checkConfig`, each on its own branch. T300 already merged what shared a setup.
- `team-families`, `team-accounts`, `team-routing`, `team-votes`, `team-ties`, `team-waits`, `team-reviews`, `team-resend`, `team-input`, `team-handoffs`, `team-sessions` (1 to 5 tests each, 30 to 70 s of file time apiece): each test boots a different browser stack (accounts, families, scripted answers). Sharing a boot would change what the test proves, so the time cost is the stack's, not the test count's.
- `board.spec.ts`: the remaining tests differ in restarts, a closed quota window (it fails later runs in the same boot), or the ledger and pool setup; only the three above shared a plain boot.
- `risk.spec.ts`: the light/normal tests could share a boot in principle, but the harness's `readyTask` names one task per boot and `workers.started` accumulates across runs, so a merge needs a harness change and a run to check it.
- `dispatch`, `checks`, `remediation`, `landing`, `scheduled-review`, `engine`, `spec`, `handbook`, `review-guides`, `advisor`, `carry`, `dossier`: each test cites its own REQ, INV or branch; a cut needs the per-test timings and the failing-test output of the workflow suite, which the run's tools could not read.
