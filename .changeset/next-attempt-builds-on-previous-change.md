---
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-agent-workers": minor
---

A board task's next attempt builds on the previous attempt's change instead of a clean tree (T271, after T267):
- An attempt that ends without its result being accepted (a failed step, a failed acceptance, a cut, the review bound reached, a rejected fix, a question, the operator's rejection of a held result) keeps its writing step's change as its result: a commit on the attempt's own run branch, made through the `commit` landing step by the source that holds the worktree. The attempt's dossier records the sha (or why it was not kept), and the run's outcome shows `kept`. It is durable: marked pending in the report's own transaction, asked again when the engine starts and before the next attempt decides.
- The next attempt carries that change however the attempt ended, not only after a later step's failure. When the repository's HEAD moved since, the source replays the change on it (a three-way merge of the trees in a scratch index): without conflict, the new worktree starts at HEAD holding the change; with a conflict, it starts at the change's own base, the conflicting files named in the carry (`rebase`), the brief, and the dossier, for the Worker to resolve. The dossier says which attempt the tree came from and the commit that keeps it.
- A task opts out with `task.fresh: true` on the start (also on the MCP `run` tool): the run starts from HEAD, and the dossier says so.
- The `workers` seam gains the additive optional `CarryStep.onto` (the commit the task writes now: the carry goes onto it only while it is HEAD) and `Carried.rebase`; a carry takes a commit the system made of exactly the earlier subject (the kept one) as it is.
