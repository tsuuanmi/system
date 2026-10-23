# Operations

How to run `system` day to day, and what to do when something goes wrong.
These documents describe **current** commands: `system` CLI commands
([CLI](../../packages/cli/README.md)), and, where the CLI has none (the board, the approval
queue, the resource ledger), MCP tools called through a client
([MCP tools](../reference/mcp-tools.md)) and the operator page (`system ui`,
[web UI](../reference/web-ui.md)).

| Document | Owns |
|---|---|
| [runbooks.md](runbooks.md) | routine procedures: first start, account re-auth, backup and restore, upgrade with drain, the live install's update to Base ([`scripts/live-update.sh`](../../scripts/live-update.sh)), retention; and for the board, the approval queue, and agent Workers: a waiting task, a review, pausing or closing a project, an expired request, a deferred tool call, a policy change, a limited pool, a run's worktree |
| [examples/](examples/README.md) | files a runbook asks you to copy or merge, such as the live patch's rows for Base |
| [pilot.md](pilot.md) | Base's pilot (PROP-0010 B8): name the repository and the Workers, charter the project, plan and run its tasks on the `algorithm-development` template day by day, restart, close the project, and read the baseline |
| [playbooks.md](playbooks.md) | responses to incidents: a stuck run, an AMBIGUOUS reconciliation, quota exhaustion, a provider UI change |

Experiments on the live install (a second lead taking over a project, swapping a review member's
Worker) have their protocols beside their records, in [validation](../validation/experiments/README.md).
