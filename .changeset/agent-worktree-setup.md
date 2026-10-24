---
"@tsuuanmi/system-agent-runtime-core": minor
"@tsuuanmi/system-agent-workers": minor
---

A run's worktree can run the repository's checks without a network (ADR-0058, accepted 2026-10-24):
- `worktreeSetup` on the `agent-workers` row, per repository (a `worktreePerRun` Worker's workspace): command lines run in order in a workflow run's new worktree before any agent works in it, optional `views`, and `timeoutSeconds` (default 600). A worktree is set up once per setup definition (its hash); a changed setup runs again.
- Each command is judged by the autonomy policy as a `command` with its exact argv: `forbid` refuses, `auto` and `notify` run, `ask` opens one request per command bound to the worktree and the setup's hash, used once. List the command in the policy's `commands` to run it unasked.
- The commands run under the read confinement with the host read-only but the worktree, no network, a deadline, and private views of host directories (for pnpm: the store's index copied, its files bound back read-only), after the confinement is proven on the host.
- A setup not allowed, waiting, or failing fails the run as `config_error` before anything reaches the agent, naming the command and the end of its output; it is recorded as a `gate` decision (rule `agent-workers.worktree-setup`) on the run and an `agent-workers.worktree.setup` event.
- `confinedCommand` takes optional `options` (`readOnly`, `network: false`, `chdir`, `views`); with none, the command line is unchanged.
