---
"@tsuuanmi/system-board-core": minor
"@tsuuanmi/system-board": minor
"@tsuuanmi/system-workflow": minor
---

Approving the funding of a board task whose budget is spent now raises its budget, so its next attempt can run:
- When the resource ledger refuses a task's run because a budget line is reached, the workflow engine asks for exact lines to add. It takes them from the ledger's own count: for each spent line, what the task overdrew plus one attempt's share of the line. The run's view shows the ask (`task.budget.funding`), and the run's error message names it.
- The approval queue shows the lines in the `funding` request's summary, and its consequences give the budget they make. The request's subject binds those exact lines (`budget-spent:<hash of the lines>`), and the task keeps them in `waiting.funding`.
- When the operator approves, the board adds exactly those lines to the task's `budget`, records the raise in the task's `funding` with the approval, and then puts the next attempt to the autonomy policy. When the operator denies the request, or it expires, nothing is raised and the task waits for input, as before.
- The board's new `fundingMaxPercent` (default 100) bounds what all of a task's raises may add to one of its lines, as a share of what the task declared. An ask past it opens no request, and the task waits for input.
- The board's contract is now 1.2, and `board-task` records with funding are `board-task@1.1`. Both are minors: a `budget-spent` block without lines asks only to go on, as before.
