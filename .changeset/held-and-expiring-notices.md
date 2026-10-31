---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-lead-inbox": minor
"@tsuuanmi/system-notify": minor
"@tsuuanmi/system-report": minor
---

Nobody's finished work expires unseen (T357): a result held for the operator is told, and told again before its review expires.
- The lead inbox makes `review.held` (as the hold starts: task, why held, expiry, the /ui link) and `review.expiring` (`expiringHours` before the hold expires, default 4, once per hold) as `lead-notice@1.1`; both on by default, pushed to no sink beyond the project's own; a decided hold closes them.
- The notify row has a new key `holds: off | on` (default off), with `holdsLeadHours` (4) and `holdsPerHour` (4): on, one batched message per sweep lists every new hold and every expiring one, as `notification@1.3` kind `review.held` (or `review.expiring`), and the per-task review reminder is not sent twice. No sink is configured by this change.
- Both reconcile the holds they keep with the board's on each sweep, so a hold held before the upgrade (or, for notify, while `holds` was off) is told, and one the board no longer holds is forgotten. A batched message names each hold whole within its text bound; the ones that do not fit are counted and named in the next message.
- `lead_digest`'s "Waits on the operator" shows each hold's hours to expiry and flags those under the lead inbox's `expiringHours` (4 without the row).
