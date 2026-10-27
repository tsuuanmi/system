---
"@tsuuanmi/system-board-core": minor
"@tsuuanmi/system-board": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-web-ui": minor
---

A writing task's result is its git tree, its checks bind before any acceptance, and it is done only once it landed (T293, T283, T311):
- A board task's run with no write subject whose writing step changed its worktree binds its result to that tree, whatever the last step's answer is (a review, a validation), even when no check ran. Changed is against the commit the worktree forked from, so a change left in a commit counts too. A step whose answer names no worktree (a review member's) no longer keeps the run's checks from running on the tree.
- The board takes the command checks the run's own acceptance recorded on a writing result's exact tree, never a lead's or the operator's own claims. It refuses their acceptance over a check the run recorded failed, and while a required check is pending, naming the checks and since when. The workflow's landing watch runs a held result's pending checks on its tree once per subject and applies the run owner's acceptance again with them: passed, accepted (or held again with its checks bound); failed, another attempt. Only the operator accepts past a check that did not run, naming it with a note (`outcome.detail.checksNotRun`), on a board decision that says "accepted with check <name> not run: <note>": on `/ui`, the review card asks why under each check not run, and `POST reviews/<taskId>/decide` takes `checksNotRun` from the operator only. The pilot test fixtures bind their acceptances to checks a scripted check source runs and records, the policy unchanged.
- A review held again after a lapse or a re-opening counts the checks the run recorded, so a check it passed is no longer shown pending, and its decision names the run's acceptance.
- Done means landed (`board-task@1.3`): an accepted writing result waits in review for its landing (`waiting.reason` `landing`, 14 days) and is done only once its merge request is merged, or its landing finds nothing to land (`Board.landed`, a `board.landed` decision). A landing that does not land leaves it waiting; unlanded at the wait's end, it waits for input (`review-expired`).
