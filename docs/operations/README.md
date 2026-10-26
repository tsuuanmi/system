# Operations

How to run `system` day to day, and what to do when something goes wrong.
These documents describe **current** commands: `system` CLI commands
([CLI](../../packages/cli/README.md)), and, where the CLI has none (the board, the approval
queue, the resource ledger), MCP tools called through a client
([MCP tools](../reference/mcp-tools.md)) and the operator page (`system ui`,
[web UI](../reference/web-ui.md)).

| Document | Owns |
|---|---|
| [runbooks.md](runbooks.md) | routine procedures: setup, accounts, the host (the live install's update to Base, [`scripts/live-update.sh`](../../scripts/live-update.sh), and its automatic update, [`scripts/live-auto-update.sh`](../../scripts/live-auto-update.sh); running the live daemon under its `system.service` unit), runs, the board, the approval queue, and the resource ledger |
| [examples/](examples/README.md) | files a runbook asks you to copy or merge, such as the live patch's rows for Base |
| [pilot.md](pilot.md) | Base's pilot (PROP-0010 B8): name the repository and the Workers, charter the project, plan and run its tasks on the `algorithm-development` template day by day, restart, close the project, and read the baseline |
| [lead-playbook.md](lead-playbook.md) | the lead's playbook (handbook layer 4, role `lead`): its decision rights, daily loop, deferred commands, salvage, landing hygiene, live updates, filing a task, safety, and recording; [examples/LEAD.md](examples/LEAD.md) is the onboarding checklist a project's `LEAD.md` copies |
| [playbooks.md](playbooks.md) | responses to incidents: a stuck run, an AMBIGUOUS reconciliation, quota exhaustion, work that waits for an account's limit, a provider UI change, a website conversation that could not be deleted |

Experiments on the live install (a second lead taking over a project, swapping a review member's
Worker) have their protocols beside their records, in [validation](../validation/experiments/README.md).
