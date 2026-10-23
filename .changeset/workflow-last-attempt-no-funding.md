---
"@tsuuanmi/system-workflow": patch
---

A board task whose budget is spent on its last attempt no longer asks the operator for funding that could not be used:
- Before, the run blocked the task (`budget-spent`) and opened a `funding` request even when no attempt was left, and an approval then raised nothing and started nothing.
- Now the run fails as `budget_spent` with nothing of it run, and its error message says it was the task's last attempt. The engine records why as a `gate` decision (`workflow.task-funding`), which the run's view shows as `task.budget.lastAttempt`. The run's report leaves the task waiting for input (`retries-spent`), as a failed last attempt does; to go on, propose the work again.
- Nothing is put to the approval queue for it.
