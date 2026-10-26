---
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-board": patch
"@tsuuanmi/system-web-ui": patch
"@tsuuanmi/system-cli": patch
"@tsuuanmi/system-profile-software-development": patch
---

A review that converges (T266, ADR-0075): verified findings, severity, and diff-only re-review.

- Every review finding is `important`, `nit`, or `pre-existing`, with its file, line, evidence (what fails), and optionally its class. An important or pre-existing finding without a file, a line, and evidence is read as a nit. The old severities are read as the new ones (`blocking` as important, `warning` and `info` as nits).
- `assessment@1.1` (additive) gives each finding an id, its evidence, its class, and a second reviewer's vote. Its `summary` opens with the count ("2 important, 3 nits", or "no issues"). Its verdict is `changes-requested` only while a confirmed important finding stands; the reviewer's own verdict is kept as `said`.
- A review with an important finding grows `<review>:verify`: a second reviewer (another provider family where one is free, else a fresh session) votes `confirm` or `reject` with a reason on each, against the exact tree. It is recorded as a `workflow.verification` decision. Only a confirmed important finding blocks and grows the fix round; rejected and unverified ones are recorded and shown, never sent as work.
- Nits never start a fix round and never hold auto-accept. They reach the author once, as optional notes of a fix that runs anyway, else as a dossier entry. The fix's prompt names each confirmed finding's class, so the author fixes every instance.
- A pre-existing finding proposes a follow-up board task, linked from the dossier and never blocking (`workflow.follow-up`).
- A re-review reads only the change since the last reviewed tree, plus the open findings and the answered ones. The whole change is shown only when no commit holds the last subject. A finding that repeats an answered one is marked `repeated` and never counted. From cycle 3 on, the reviewer says whether the approach should change (`approach`).
- The dossier's review entry, `explain` (each review step's `review`), the CLI, and `/ui` show the findings by severity with their votes. The board's auto-accept counts only a confirmed important finding (or an `assessment@1.0` blocking one) as blocking.
