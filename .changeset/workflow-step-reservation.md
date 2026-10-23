---
"@tsuuanmi/system-workflow": minor
---

A board task's budget is now reserved before each step of its run, not once per run (ADR-0047, step 1):
- Before, the run reserved the task's lines once, before its first step, and then ran every step even after its earlier steps had spent the lines.
- Now each Worker execution of the run reserves before it is routed, its hold is kept on the run's row while the step is in flight, and it is released once the step ends. When a line is spent, no new step starts: the steps in flight finish, then the run blocks the task (`budget-spent`, with the funding it asks for) or, on the task's last attempt, fails as `budget_spent` with no funding asked, as before. Its error message says how many steps ran before the refusal.
- The next attempt's brief points at the results of the steps the stopped attempt completed.
- The run's view shows `task.budget.state` as `due` between steps, `reserved` while a step holds its reservation, and `released` once the run finished. Each `workflow.task.budget` event names its step's node.
