---
paths:
  - packages/plugins/agent-workers/
  - packages/plugins/agent-runtimes/
  - packages/plugins/runtime-acp/
  - packages/plugins/runtime-claude-agent-sdk/
  - packages/plugins/runtime-antigravity-cli/
  - packages/plugins/runtime-codex-sdk/
  - packages/plugins/workers/
  - packages/plugins/browser-patchright/
  - packages/plugins/display-virtual/
  - packages/agent-runtime-core/
  - packages/workers-core/
owner: lead
version: 1
---
# Review guide: agent Workers, runtimes, and confinement

## What failure looks like here
- A confinement that leaks. Past leaks: a child process reading another's descriptors through `/proc/<pid>/fd` (a channel out of the sandbox); a variable named `pnpm_config_*` (or any tool's own prefix) passed into a confined command that changes what the tool does; the environment a command inherits holding a credential. Any new way a confined process sees host state, the network, or a secret is important.
- A browser started inside the sandbox that needs a capability the sandbox removes (user namespaces, a display, `/dev/shm`): it works on the author's machine and fails or silently falls back under confinement. A fallback to an unconfined launch is important (INV-2).
- A command that hangs the Worker: an install or fetch that waits on a network that is not there, with no bound. Every command has a time bound (INV-9).
- A tool call that bypasses the gate, or a gate rule written as a pattern instead of the command's exact words.
- A runtime or Worker named in routing code, a team, or a workflow (INV-11), or a second implementation of what one provider already does (INV-1).

## What to check first
1. Every environment variable, mount, and file descriptor the change adds to a confined process: who sets it, who can read it.
2. What happens when the sandbox is absent or the probe fails: the Worker must be refused, never run unconfined.
3. The runtime's conformance suite and the agent-workers tests that start a real confined process; a mock where a real process is cheap is a finding.
4. Anything that writes outside the run's worktree or reads outside its allowed reads.

## Paths to skip
- Recorded runtime transcripts and fixtures under `tests/fixtures/`.
- Vendored or generated runtime schemas (their source is named in the change).

## Nit cap
At most 3 nits in all, then "and N more nits". A nit is never `important`.

## Evidence rule
Every finding names a file and a line and the exact path an attacker or a failure takes: "`gate.ts:231` lets `X` through when `Y`". A confinement finding includes the command that shows it, or says why it could not be run.

## Summary rule
Open with the count: "1 important, 2 nits, 0 pre-existing". Say first whether confinement is unchanged, narrowed, or widened.
