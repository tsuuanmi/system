---
"@tsuuanmi/system-board": patch
"@tsuuanmi/system-approvals": patch
"@tsuuanmi/system-digest-core": minor
"@tsuuanmi/system-digest": minor
"@tsuuanmi/system-digest-extractive": minor
---

Every MCP tool of the board, the approval queue, and the digests that changes something checks its output before the change commits (T103's pattern, T102c):
- `board_charter`, `board_propose`, `board_claim`, `board_update`, `board_cancel`, `board_pause`, `board_resume`, and `board_close` check the output they would give inside the move's store transaction. An output its schema refuses (a defect) is refused with `… would make an output its schema refuses (a defect), so nothing changed`: nothing moves, no decision is recorded, nothing is withdrawn, and a request the move opened is withdrawn. Before, the move committed and the call said it was recorded anyway.
- `approvals_decide` applies a call's verdicts in one transaction and checks its output before it commits, so a defect applies none of them; `approvals_policy_propose` stores no change on a defect.
- `digests` contract 1.2: a request's optional `check` sees the request as it would be returned, inside the transaction that records it; one that throws records nothing, takes no key, and asks no Worker. `digests_request` checks its output through it. Both providers and the fake honour it, and the conformance suite's new scenario `digests.checks-before-recording` says so.
