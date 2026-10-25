---
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-workflow": patch
"@tsuuanmi/system-workers-core": patch
---

A run's required checks, after the review of ADR-0063 (T163, T164):
- Exact subjects bind every untracked file's whole content, hashed in chunks whatever its size: a large file changed to the same size with its mtime restored is another subject. A file that changes while it is read, or untracked files past `maxHashBytes` (default 8 GiB) in all, leave the subject unknown (the capture throws) instead of guessed. New `ignoredPath(workspace, path)`.
- A check sees the run's worktree read-only, so it cannot pass on code it swapped in for a while; `worktreeSetup[].checkScratch` names the git-ignored paths it may write (a test runner's cache), each a fresh private directory of that check alone (each check gets a confinement of its own), discarded after it, so the next check never sees what it wrote.
- A check's command starts through a fixed launcher (System's own Node, bound back read-only) that spawns it and says on its own channel whether the exec itself succeeded: one never executed (bubblewrap refused, no such command, an executable whose `#!` interpreter is missing) is an infrastructure `error`, not a failed check, while a command that runs and exits 127 by itself is failed. A command whose nested bubblewrap is refused reports it on the descriptor `SYSTEM_CHECK_REPORT_FD` names (`nested-confinement-refused: <detail>`); its nonzero exit is then an `error` too, so the result is held for the operator instead of sent back as another attempt. Any other nonzero exit is a failed check: no probe of the host decides another command's cause.
- Each check that ran is stored per run, worktree, subject, check, argv, and setup (`agent_check_runs`, migration 17) and its record reused when asked again, after a restart too; one a crash interrupted, or a stop of the run (a lost lease) killed, is an `error`, and one that ended before a stop is stored as it ended before the stop is honoured: none is run again to replace what it came to. The workflow engine finishes a board task's run whose acceptance it already stored without asking its checks again (INV-4).
