---
"@tsuuanmi/system-agent-workers": patch
---

A Worker can read the git history it needs without asking (T276). On T268, a Worker could run only the git commands on the policy's commands list (`git log --oneline -20`), so it could not look up older commits or its previous attempt's run branch.
- The tool gate recognises the git history reads, each word an exact option or a word a fixed pattern allows: `git log` with a ref or range, `--oneline`, `-n <k>`, `--format=<placeholders>`, and paths inside the workspace; `git show <sha>[:<path>]`; `git diff <a> <b>` (also `--stat`); `git branch --list system/run/<runId>`. A revision is a ref name, a hex id, or a range of two: it holds no `..` segment and no segment starting with `.`, so it can never name a file outside the worktree. `git diff` would otherwise diff two such words as files, with no index.
- Under every runtime today (none enforces clean shells), such a read is judged as a command on the commands list is: as a command first, so a forbidden command class still denies it, then, where that asks, as a workspace write. So it runs wherever workspace writes run unasked. Under a runtime with clean shells it is a read.
- A write (`git commit`, `git push`, `git checkout -b`, `git branch <name>`), `git diff --output=…`, `-c`, `-C`, `--git-dir`, `--ext-diff`, and every other form stay a command, which the policy asks about.
- The brief names the reads in one line. A Worker given the workspace reads server is no longer told never to use git in a shell.
