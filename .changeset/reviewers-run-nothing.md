---
"@tsuuanmi/system-workflow": patch
"@tsuuanmi/system-profile-software-development": patch
---

A review reads and judges the change, and never runs the project's tests or builds; an environment limit is at most an `info` finding:
- The exact-subject block the engine appends to every bound review (and to a remediation cycle's re-review) now says so: the validation and the run's required checks at acceptance (ADR-0063) run the tests and builds, a command the reviewer could not run is no finding about the change, and an environment limit (a read-only sandbox, a denied or failing command) is at most `info`, never `blocking`. Before, a read-only reviewer that tried `pnpm test:affected`, failed to write its temporary directory, and reported "required affected tests did not pass" as blocking sent good work into remediation cycles no fix could satisfy.
- `algorithm-development`'s review prompt says the same, so its re-review, given the review's instructions, does too. The exact-subject rules are unchanged.
