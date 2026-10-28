---
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-approvals": minor
"@tsuuanmi/system-approvals-core": minor
---

A run's own tests and the repository's read-only checks are decided by the Worker tool gate's policy, so the lead no longer classifies test commands (T326, D109, PROP-0019). Until now a form the lead's script did not know (`--silent`, `test:related <files> -- …`, `--reporter=json --outputFile=<file>`) asked, and each one stopped the lead's loop until the script was patched.
- `autonomy-policy@1.6` adds two things to command rules: an option may take a path (`kind: path` with a `scope`), and a rule has `enforce`, `on` (the default) or `warn`. A `warn` rule grants nothing: the gate records a `gate` decision naming the rule it would have allowed (`warnedRule`) and the command asks as before.
- `policies/system.json` is proposed as version 4 with the rules, all `enforce: warn`:
  - `corepack pnpm [exec] vitest run <spec files or tests directories>` and `corepack pnpm [-s] test:related <paths>`, at most 60 paths, all inside the run's worktree;
  - with only a reporter (`dot`, `default`, `verbose`, `basic`, `json`), `--silent[=true|false]`, `--exclude=<relative path>`, and `--outputFile[.<reporter>]=<a file inside the worktree>` (after `--` for `test:related`).
- These still ask: a path outside the worktree, a `..`, `.git` or `.system`, an `--outputFile` outside the worktree, an unknown option (`--watch`, `--coverage`, `-u`), and a command after `;` or `&&`.
- The read-only checks (`lint`, `typecheck`, `check`, `check:<name>`) are the existing `check-script` rule.
- Turning the rules on takes two policy changes the operator approves: the studio policy holds them without `enforce`, and `policies/system.json` version 5 drops `enforce` from its copies. A project policy's `warn` copy differs from the studio's, so it keeps that rule out of force for the project: the studio's change alone leaves every such command asking. Only after both changes does the lead delete `ownTests` from its coordination script.
