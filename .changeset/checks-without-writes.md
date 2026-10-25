---
"@tsuuanmi/system-workflow": minor
---

A board task with no write subject gets its required checks at acceptance (T165, ADR-0063): the lead's tasks name no `writes` so several run on one repository at once, and until now their checks were never run, so each review waited for the operator with "checks pending: tests, lint". The engine now runs them on the git working tree the run's latest agent result is on, as for a plain run, and when one ran there to an exit code the task's result binds to that exact tree (`git-head` at its version, the agent result naming it among the result's artifacts), so the acceptance that reports them binds to it (INV-5): passed, the result is accepted without the operator; failed, another attempt. A tree that moved since, or a result on no git working tree, keeps them pending. A task with a write subject is unchanged.
