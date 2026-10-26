---
"@tsuuanmi/system-agent-workers": patch
---

A landing's generated files are made on the dependencies the merged tree names, never on stale ones (T263): before the commands that make a repository's declared generated files again at `merge` and `rebase` (`worktreeSetup[].generated`) run, the worktree's setup runs again on the merged or rebased tree when that changed its `dependencyFiles`, confined and offline as for a check (`refresh`, a `gate` decision of rule `agent-workers.worktree-setup-again`, named among the regeneration's autonomy decisions). Since those commands never install, they would otherwise run on what the setup installed for the run's own tree. A setup that cannot run again (a package the store lacks, say) refuses the landing, the repository as it was.
