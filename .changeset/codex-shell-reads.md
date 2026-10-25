---
"@tsuuanmi/system-agent-workers": minor
---

A Worker's read-only inspection commands inside its workspace are reads (T147): Codex reads files through its shell, and every `cat` or `rg` used to wait for the operator.
- The tool gate classifies a `Bash` call as `read` when it is one of a fixed set of forms, each word matched exactly: `cat`, `head`, `tail`, `wc`, `ls`, `stat`, `file` with a few options; `sed -n <a>[,<b>]p <path>`; `rg` and `grep` with allowed options (never `--pre`, `-f`, `-z`, `-L`); and `find` with only `-name`, `-iname`, `-path`, `-type`, `-maxdepth`, `-mindepth`. Every path is absolute, holds no `..`, and is inside the workspace on disk, and at least one is named. Codex's hook does not report the `workdir` a command runs in, so a relative path, a form that names no path, and `git` (which finds its repository and configuration in the working directory) stay a `command`. Anything else stays a `command`, by its exact argv, as before; the policy and its `commands` list are unchanged.
- Git runs what its configuration names, so a file-writing tool (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `apply_patch`, `write_file`, `edit_file`) may no longer write into `.git` (anywhere in the path, as written or on disk): it is denied by the gate's own rule.
