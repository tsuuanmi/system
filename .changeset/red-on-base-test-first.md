---
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-approvals-core": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-board": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-profile-software-development": minor
---

Test-first is checked by System (ADR-0079, T306c): a new acceptance check `red-on-base` runs the test files a result adds or changes on the commit its run started from, with the result's tests copied over, and they must fail there and pass on the result.
- The brief of a writing step of a behaviour change (the code work, not the `docs` and `tests` variants) asks the author to write the tests that encode the criteria first, run them and see them fail, then implement, and show both runs in its evidence. A task whose criteria say `refactor: no behaviour change` is asked to change no existing test.
- The check is the repository's `corepack pnpm check:red-on-base` (`scripts/red-on-base.ts`), which you configure as the `red-on-base` check of the repository's `worktreeSetup` like `tests` and `lint`. A test that passes on the base tree fails it, naming the test; a missing module counts as failing; a refactor that edits or deletes an existing test fails it; documents or tests alone have nothing for the base to lack and pass. It is not run again at the landing.
- A policy rule can require it (`requires: [..., "red-on-base"]`, `autonomy-policy@1.5`, `check-run@1.1`); it is asked of a change of the normal or heavy risk tier, and reported met for a light one.
- It has an enforce switch, `red-on-base` (`off`, `warn`, `on`; the workflow row's `enforce.redOnBase`, default `warn`): in warn it runs, records a `gate` decision of rule `workflow.red-on-base` and says in the acceptance what it would have refused, and the result is judged as if it passed; `on` sends a failing result back; `off` does not ask it. Move it to `on` after the test profile's canary and days clean.
