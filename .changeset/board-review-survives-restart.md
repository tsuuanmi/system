---
"@tsuuanmi/system-board": minor
"@tsuuanmi/system-board-core": minor
"@tsuuanmi/system-notify": patch
"@tsuuanmi/system-report": patch
"@tsuuanmi/system-web-ui": patch
---

A result held in review survives a host restart, and an expired review can be re-opened (T286):
- A review whose holder's lease lapsed (its process gone, a host stop across it) is no longer expired `review-expired` by the sweep. The result is held for the operator on `operator-review`, with the class's required checks pending, for the policy's wait for the class, as a result reported after the restart is. Only that wait ends a review. On 2026-10-26 two approved results expired twenty minutes after a restart this way.
- `board_reopen_review` (`mcp-board` 1.4; the operator's token, else the lead's for its own project) brings a `review-expired` task back to review, held for the operator again, with a reason, while it still has its result and its run's worktree is recorded and on disk. Recorded as a `board` decision; no attempt is counted. The board's `reopenReview` (optional in the contract) does the move.
- The review notice, the report, and `/ui` no longer say nothing revives an expired review: they name the re-opening.
