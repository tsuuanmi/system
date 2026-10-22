---
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-agent-workers": minor
---

A workspace per writing task (B3, the last item of the P1 follow-up):
- `WorkerStart` may name the workflow run an execution belongs to (`runId`), and the workflow engine names it on every execution (its conformance contract is now 1.1).
- An agent Worker configured with `worktreePerRun` works, for each workflow run, in that run's own git worktree of its repository (`<worktreeRoot>/<repository>-<hash>/<runId>`, default root `<DSH_HOME>/system/worktrees`), on the branch `system/run/<runId>`, never in the repository's main working tree. Every agent run of the workflow run on that repository, reviewers included, works in the same worktree, so exact-subject review and remediation bind to the tree the writer changed. The mapping is stored, so a restart reuses it.
- Once every agent run of a workflow run has finished and the last ended more than `worktreeRetentionHours` ago (default 168; 0 keeps them), a `retention` decision retires its worktree: the changes are committed on its branch by `system <system@localhost>` and the worktree is removed. A branch is never deleted and nothing is forced: a worktree that cannot be committed or removed stays for the next sweep.
- A Worker without `worktreePerRun` works as before. Workers configured with one workspace must agree on it.
