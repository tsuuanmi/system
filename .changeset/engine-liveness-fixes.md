---
"@tsuuanmi/system-workflow": patch
---

Workflow liveness fixes:
- A run whose lease is lost while a node waits on its execution is taken back, instead of staying `running` until the next start.
- A scheduler exception fails the node it happened on, as `internal`/`CODE_FIX`, so `continue` can reopen it. Before, the run failed with no failed node, and `continue` refused it.
- A node whose Worker source is gone fails as `config_error`.
- `approve` no longer treats a tie as a plan's gate.
- A node with `differentFrom` routes beside the node it names even when it is listed first. Before, it waited for that node's whole execution.
