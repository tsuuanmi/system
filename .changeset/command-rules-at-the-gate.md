---
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-approvals": minor
"@tsuuanmi/system-approvals-core": minor
"@tsuuanmi/system-cli": minor
---

The lead's routine command judgements are now autonomy policy, decided at the gate (T319b, D107). Until now a lead approved a Worker's deferred read, test, edit, or scratch-removal commands with judges in its own scripts. System could not see those judges, so each command still asked, and a new project's lead would have to copy them.
- `autonomy-policy@1.4` adds `commandRules`. A rule holds:
  - a program and its literal subcommand words;
  - the flags and clustered letters allowed;
  - options with a value (a number bound, `oneOf`, a pattern) and required flags;
  - positional groups of a kind (`word`, `number`, `revision`, `revision-path`, `path`) with count bounds.
- A path has a scope:
  - `run-worktree`;
  - `repository-read`;
  - `scratch-file`: an untracked regular file;
  - `test-target`: an existing test file, or a tests directory, that vitest's substring filter selects alone. So `vitest run tests`, which selects every package's tests, asks.
- Only the studio policy grants a rule, as it grants the commands list. A rule is in force when the studio policy holds it and every project policy that carries rules holds the same rule. A project can drop a rule, never add or widen one.
- The gate's matcher (`agent-workers/src/command-rules.ts`) parses the command into words (no metacharacter, no empty word) and finds the rule. The policy then judges the command as `workspace-write`, and the recorded `autonomy` decision names the rule.
- These still ask: a word no rule allows (`--output=`, `git commit`, `..`), a path outside the worktree, a whole-suite `vitest run`, `rm` of a tracked file, and a word that starts with `#` (a shell comment). A forbidden `command` class still forbids.
- A relative path in `corepack pnpm vitest run <file>` or `test:related` is no longer refused at once. The shell starts in the worktree, so it is a command the rules judge, and it asks when no rule allows it.
- A `~` inside a word (`HEAD~1`) is no longer a shell metacharacter. A `~` at a word's start, or after `=` or `:` (where bash expands it), still is.
- `policies/system.json` is proposed as version 3 with the standard rules. The project template carries the same rules, so a new project starts with them. `system project new` also files them in the studio change when the studio policy lacks them. A policy change puts them in force; the lead never approves it.
