# ADR-0038: Claude Code Workers run commands inside two confinements: reads by the host, commands by the SDK's sandbox

- **Status:** Proposed
- **Date:** 2026-10-22
- **Related:** [PROP-0010](../../proposals/0010-base-version.md) (B3: "confined commands for
  `validate`, decided by its own ADR"), [ADR-0024](0024-agent-workers-confined-for-reads.md),
  [ADR-0036](0036-guarantee-core-and-capability-plugins.md), REQ-WRK-6, QA-6,
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-8](../../architecture/invariants.md#inv-8-credentials-never-cross-upward),
  [INV-12](../../architecture/invariants.md#inv-12-data-egress-is-explicit),
  [agent runtimes](../../design/agent-runtimes.md#admission-evidence)

## Context

A Claude Code Worker has no Bash today (`executes: false`), so it never proves `validate`: it
cannot run the tests and checks that make a writing step verifiable, and PROP-0008's autonomy
matrix lets a workspace write run unasked only when "tests, lint, and independent review pass".
Base needs Claude Code to run commands, confined to its workspace with no network.

What exists:

- ADR-0024 confines **reads** for agent Workers. Codex and ACP agents run under the host's
  bubblewrap wrapper, proven positively on the host by `proveConfinement`. Claude Code does not:
  its pre-approved tools are scoped to the workspace, so it reports `readsConfined` from its own
  policy. With Bash allowed, that no longer holds: a shell reads anything the user can.
- The Agent SDK (0.3.x) has a built-in command sandbox, `sandbox` in the query options, built on
  Anthropic's sandbox runtime (`@anthropic-ai/sandbox-runtime`, Apache-2.0; bubblewrap and a
  network proxy on Linux). It takes `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`,
  filesystem `allowWrite`, `denyRead`, and `denyWrite`, a network `allowedDomains` list (empty: no
  network), and credential masks.
- Codex already runs its own sandbox nested inside the host's bubblewrap (verified live on
  2026-10-14), so nesting works on the hosts the project supports.

## Options

1. **Keep commands off.** Claude Code Workers never `validate`; tests run elsewhere. This fails
   PROP-0010's goal 2 and keeps every writing step behind an approval.
2. **The SDK's sandbox alone.** Enable it with `failIfUnavailable`, no unsandboxed commands,
   writes to the workspace, no network, and `denyRead` for every path ADR-0024 hides. One
   mechanism, but read confinement then rests on a second implementation of ADR-0024's list, and
   is proven only by running a model turn.
3. **Wrap the whole runtime ourselves** with `@anthropic-ai/sandbox-runtime` around the `claude`
   process. A new direct dependency duplicating what the SDK ships, and every command, tool, and
   model call shares one set of rules.
4. **Both layers: the host's read confinement around the runtime, the SDK's sandbox for its
   commands.** Claude Code runs under `agent-runtime-core`'s bubblewrap wrapper like Codex and ACP
   (ADR-0024's list, proven by `proveConfinement`), and its Bash runs in the SDK's sandbox inside,
   with writes confined to the workspace and no network.

## Decision (proposed)

Option 4.

- Claude Code runs under the host's read confinement, exactly as Codex and ACP agents do. It then
  proves `readsConfined` positively on the host, instead of stating it from its own policy.
- A `workspace-write` run enables the SDK's sandbox with:
  - `enabled: true` and `failIfUnavailable: true`: a run whose sandbox cannot start fails, never
    runs commands unconfined (INV-2);
  - `allowUnsandboxedCommands: false`: no escape hatch, whatever the model asks;
  - `filesystem.allowWrite`: the run's workspace only (a git worktree per writing task);
  - `network.allowedDomains: []`: no network. A later, operator-configured allow list (a package
    registry) is an egress policy decision ([INV-12](../../architecture/invariants.md#inv-12-data-egress-is-explicit)),
    not a runtime default.
- A `read-only` run keeps Bash off.
- The runtime reports `executes: true` only when its probe proves both layers on this host:
  `proveConfinement` for reads, and a nested sandbox start inside the confinement (a namespaced
  `true` with no network), the same check Codex's probe makes. Otherwise it is `executes: false`
  and `validate` work is not admitted there; the reason is reported (INV-2).
- The autonomy policy decides what a command may do (ADR pending with B5): the sandbox confines
  where it can act, the policy decides whether it should.
- No new dependency: the sandbox ships with the Agent SDK, which is depended on and never vendored.

## Consequences

- Claude Code Workers can `validate`: run the tests, linters, and type checks of their worktree,
  offline. Writing steps can then pass the autonomy policy's checks without the operator.
- Read confinement becomes uniform across agent runtimes, and proven on the host for Claude Code
  too.
- Commands that need the network (installing packages) fail inside a Worker. Dependencies are
  prepared in the worktree before the run, or a later ADR adds an egress-governed allow list.
- The threat model's agent-runtime section is updated with B3: a confined shell, its proof, and
  what remains (kernel escapes, which the sandbox runtime does not claim to stop).
- If the SDK's sandbox options change shape, the probe fails and the Worker stops executing
  (fail closed); the adapter's conformance suite catches the change.
- Revisit if nesting fails on a supported host (then Option 3), or if the SDK's sandbox gains a
  positive, model-free self-test (then the nested probe can use it).
