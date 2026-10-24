---
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-workers": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-mcp-server": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-cli": minor
"@tsuuanmi/system-report": minor
"@tsuuanmi/system-gateway-core": minor
"@tsuuanmi/system-web-ui": minor
"@tsuuanmi/system-artifacts": patch
---

You see, and can free, the agent runs whose liveness needs you (PROP-0013, ADR-0056's amendment):
- `system health` and MCP `status` have a `liveness` check: degraded while a run that ended without being known to be gone holds its session and worktree, or while a Worker source cannot tell; a stalled run, or one still being looked at, is named. The operator's `status` lists the runs and their counts.
- `system explain <run>` shows a run's executions that are stalled, being looked at, or held: the verdict, its looks, each signal, what each holds, and what to do; `system explain <arun_…>` explains one by its id. The Workers tab's Doing now and `system roster` show them too (`mcp-roster@1.2`), and the report's attention section counts them and lists the runs still held (`mcp-report@1.2`), never as interruptions.
- `system free <arun_…> --agent-gone [--commit-worktree] [note]` (MCP `agent_run_free`, operator scope, `mcp-agent-runs@1.0`) frees the session and worktree of a run whose liveness is unknown, on your recorded word that its agent is gone. It is refused while the run's liveness is still being looked at or its holder or agent process is present. A worktree is removed only when clean, or with `--commit-worktree` once its changes are committed on its branch; the branch stays ([runbook](../docs/operations/runbooks.md#a-runs-liveness-is-unknown)).
- Stopping a run that started and that no process holds now gives it a liveness verdict first: found gone, it ends; otherwise it ends `aborted` with its session and worktree held for you to free, where before it freed them at once.
- The `workers` seam gains an optional `liveness()`; the agents source answers it.
- Every Artifacts instance in a process shares one schema registry, which fixes the evaluations `integrity-invalid` test's timeout under load.
