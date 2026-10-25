---
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-workflow": minor
---

A landing whose merge conflicts only in files the repository declares generated regenerates them and merges (T166):
- A repository's worktree setup may declare `generated: { paths, commands }` (`worktreeSetup[].generated`): 1 to 32 repository-relative paths, a `*` matching within one segment, and 1 to 16 command lines that make them, checked at load and outside the setup's hash.
- On the operator's approved merge, when every conflicted file is one of them, the `agents` source makes the merge again in the run's worktree: detached at the approved base, the branch merged without a commit, each conflicted file taken from either side, then the commands run, each only when the autonomy policy lets its exact argv run unasked, in the setup's confinement (no network) and views. Only when they exit 0, change no file but the declared ones, and change nothing when run again on the merge commit is the base fast-forwarded to that one merge commit of the base and the head. Any other conflict, a command not allowed or failing, or one that changes another file still refuses, the repository as it was.
- `Landed`'s `merged` answer gains an optional `regenerated` (the files, the commands, and their autonomy decisions), and the workflow engine's `merge` decision names them, the commands' autonomy decisions among its inputs.
