---
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-profile-software-development": minor
---

Tests scale with the change (T299): a Worker runs the tests of what it changed, the acceptance runs the related ones, and the full suite runs once, at the landing (a full run was 240 s; with up to 9 tasks at once, each ran it at least twice).
- `pnpm test:related <file>…`: each given test file, and for any other file the tests of its package and of every package that depends on it (through the graph `test:affected` reads). A `package.json`, the lockfile, `tsconfig*.json`, `vitest*.ts`, CI, or a path no rule places selects the whole suite. A Worker's call with absolute paths inside its worktree is admitted unasked by the gate (a write of the worktree).
- `CheckStep.scope` (`acceptance`, the default, or `landing`) is told to each check command as `SYSTEM_CHECK_SCOPE`. `test:affected` under it runs the related tests at acceptance and the whole suite at the landing. A landing's check result is stored apart from the acceptance's on the same tree.
- An acceptance check is also told the commit its run's worktree was cut at (`SYSTEM_CHECK_BASE`): the related tests are those of the files the result itself changed since then, never of what its branch gained before; with none recorded, the whole suite runs.
- Every landing runs its checks with `scope: 'landing'` once, in the check queue, before the merge is asked: on the rebased tree when the base moved, and on the committed tree when it did not (a `committed` land answer now names that tree, `subject`; the landing's `verify`). A failure goes back as another attempt with its failing tests named in the reason and in the task's dossier.
- The writing steps' prompts, the handbook (W15), and the engineering docs tell a Worker to run `test:related`, never the full suite.
