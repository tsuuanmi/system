# Operations

How to run `system` day to day, and what to do when something goes wrong.
These documents describe **current** commands: `system` CLI commands
([CLI](../../packages/cli/README.md)), and, where the CLI has none (the board, the approval
queue, the resource ledger), MCP tools called through a client
([MCP tools](../reference/mcp-tools.md)) and the operator page (`system ui`,
[web UI](../reference/web-ui.md)).

| Document | Owns |
|---|---|
| [runbooks.md](runbooks.md) | routine procedures. **Setup:** first start, agent Workers (Claude Code, Codex, the Antigravity CLI) and agent Workers as review team members, turning an off row back on, swapping the digest provider, API and local models (a model call that times out), the API-first preset, one provider family. **Accounts:** removing the free ChatGPT account, pooling a provider's accounts, account re-auth, two accounts signed in as one person, enrolling an agent account, a quarantined agent account, migrating agent Workers to accounts × roles. **The host:** the manifest check, backup and restore, key custody, running as a service, upgrade with drain, the live install's update to Base ([`scripts/live-update.sh`](../../scripts/live-update.sh)), rotating a control token, a Worker source that does not answer, retention. **Runs:** a review member that fails on a website, why a step's answer was rejected, a step that failed on a placeholder. **The board, the approval queue, and the resource ledger:** an expired request, a waiting task, a review, pausing or closing a project, a remediation fix, a deferred tool call, a policy change, the queue proposing a policy change, a limited pool, usage the ledger could not count, a run's worktree |
| [examples/](examples/README.md) | files a runbook asks you to copy or merge, such as the live patch's rows for Base |
| [pilot.md](pilot.md) | Base's pilot (PROP-0010 B8): name the repository and the Workers, charter the project, plan and run its tasks on the `algorithm-development` template day by day, restart, close the project, and read the baseline |
| [playbooks.md](playbooks.md) | responses to incidents: a stuck run, an AMBIGUOUS reconciliation, quota exhaustion, work that waits for an account's limit, a provider UI change, a website conversation that could not be deleted |

Experiments on the live install (a second lead taking over a project, swapping a review member's
Worker) have their protocols beside their records, in [validation](../validation/experiments/README.md).
