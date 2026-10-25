---
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-workers": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-schemas": minor
---

A run's required checks run on its exact result (T151, ADR-0063, proposed):
- Before a written result's acceptance, the workflow engine asks the autonomy policy which checks it requires of it that are commands (`tests`, `typecheck`, `lint`) and asks the Worker source that holds the run's worktree to run them on the exact tree the result is on, through the new optional `ctx.workers.check(step, signal)`. The acceptance decisions (`workflow.task-acceptance` and `workflow.run-acceptance`, now version 2) report each check that ran to an exit code, passed or failed, name the evidence among their inputs, and keep an `error` pending. The board binds them as before: passed, the result is accepted without the operator; failed, another attempt; pending, held for the operator.
- The `agents` source runs each check with the command the operator configures beside the repository's setup (`worktreeSetup[].checks`, `checkTimeoutSeconds`, default 1800), only when the policy lets its exact argv run unasked, in the setup's confinement and views, on a worktree that is still the result's tree and set up under the setup loaded now. Exit 0 passes, another code fails; a timeout, a signal, a command that cannot start, or a tree the check changed is an error. What ran is one `check-run@1.0` evidence artifact (new schema).
- With no checks configured, nothing changes: every check stays pending and the operator accepts the result.
