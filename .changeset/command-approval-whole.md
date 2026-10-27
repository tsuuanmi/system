---
"@tsuuanmi/system-agent-workers": minor
---

A command approval shows the whole command, and Workers are told to use short relative paths (T295): a Bash command's request carried only its first 500 characters, so the lead could not read a long vitest command and denied it, and the Worker asked the same way again.
- The request's `consequences` hold the whole command, up to 1,500 characters; a longer command is refused by the gate (`invalid-input`) with a reason asking for a shorter one, never cut.
- A writing Worker's brief tells it to name several test files in one command with paths relative to its worktree (a command the operator is asked about, read whole), and one test file, which runs as a write of the workspace, by its absolute path as before.
- The operator's note on a rejection reaches the Worker in the denied call's tool result.
