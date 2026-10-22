---
"@tsuuanmi/system-board": minor
"@tsuuanmi/system-board-core": minor
"@tsuuanmi/system-approvals-core": minor
"@tsuuanmi/system-approvals": patch
"@tsuuanmi/system-web-ui": minor
---

A review only the operator may accept is the operator's, not a lease's:
- When an acceptance that is not the operator's comes with the class's required checks not passed (under the default policy, a workspace write whose run reports no tests or lint), the board holds the review for the operator: the reviewer's lease is released, and the task waits (`operator-review`, with the checks still pending) for the policy's wait for the class, a day by default. After that it ends `review-expired`. Before, it ended `review-expired` once the run's lease lapsed, about ten minutes later, so no such task could reach done.
- `/ui` lists the tasks in review, with their project, exact subject, result artifacts, pending checks, and run, and takes the operator's Accept or Reject, recorded as the operator's acceptance decision on that exact result.
