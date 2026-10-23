# ADR-0042: Codex Workers ask the run's tool gate through a PreToolUse hook bridge, proven on the host

- **Status:** Proposed
- **Date:** 2026-10-23
- **Related:** [ADR-0009](0009-claude-and-codex-first-class.md),
  [ADR-0024](0024-agent-workers-confined-for-reads.md),
  [ADR-0038](0038-confined-commands-for-claude-code-workers.md),
  [ADR-0039](0039-base-guarantee-seam-contract-changes.md), REQ-WRK-5, REQ-WRK-6,
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-6](../../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes),
  [INV-11](../../architecture/invariants.md#inv-11-no-tool-lock-in),
  [agent runtimes](../../design/agent-runtimes.md#codexs-gate)

## Context

B5 puts every tool call of an agent run to the autonomy policy through the run's tool gate
(`RunSpec.toolGate`), and the `agents` source admits only Workers whose runtime reports
`gatesToolCalls` (ADR-0039). Claude Code gates through an in-process hook of its SDK. Codex ran
its tools with approvals `never` and no hook, so no Codex Worker was admitted.

Codex 0.164 runs PreToolUse hooks: commands it starts before a tool call, with the call as JSON on
stdin. Checked live on this host against a scripted model, it:

- runs a hook from configuration only when it is trusted, by the sha256 of the hook's definition
  recorded under its key, and skips an untrusted one without a word;
- runs the tool when a hook exits non-zero (other than 2), prints what it cannot read, or times
  out: a hook fails open;
- refuses `allow` and `ask` as decisions; a block (`deny`, or exit 2 with a reason) is the only one;
- reports `exec_command` as `Bash` with its `command` only, and `apply_patch` and `view_image`
  under their own names;
- does not run the hook for `write_stdin`, which writes to a running command's terminal;
- offers hosted tools (web search, image generation) that run at the model's provider, and
  features (apps, plugins, subagents) that add tools or work outside the run.

## Options

1. **Keep Codex Workers out.** Safe, but Codex stays a client only, against ADR-0009.
2. **Codex's own approvals** (`on-request`, `untrusted`): Codex asks only for what its sandbox
   policy escalates, never for a plain command or a write inside the workspace, so the policy
   would not see most calls.
3. **The Codex app-server protocol**, whose approval requests reach the client. It covers the same
   escalations as option 2, is marked experimental, and would replace the SDK the runtime is built
   on.
4. **A PreToolUse hook bridge, proven on the host.** The run installs one hook, trusted by its
   hash, that reaches the run's in-process gate over a private channel; the runtime closes what the
   hook does not see, and the probe proves it end to end before any Worker is admitted.

## Decision

Option 4.

- **One hook, per run, by configuration.** `hooks.PreToolUse` with matcher `*` and its trust
  (`hooks.state`, the definition's sha256) are `--config` overrides of the run, never a file; no
  other hook is trusted. The hook is a script the runtime ships (Node built-ins only), run by the
  daemon's `node`.
- **A private channel.** Per gated run, a unix socket in a fresh owner-only directory, bound into
  the read confinement read-only, and a 256-bit key; Codex passes both to the hook in its
  environment and keeps them from its own commands (`shell_environment_policy.exclude`). The
  bridge asks the gate with `askToolGate` (30 s, fail-closed), and denies a wrong key, an input
  that is not a PreToolUse call, or a call from another directory than the run's workspace.
- **Fail closed where Codex fails open.** The hook blocks on every failure of its own and answers
  before Codex's timeout. A tool item Codex reports that no allowed call accounts for stops the
  run. The probe reports `gatesToolCalls` only after one Codex turn on the host, with the run's
  configuration, hook, and confinement, against a scripted model on loopback: the hook answered
  before a tool call, its deny held, no terminal session started, and no hosted tool was offered.
- **Verdicts.** `allow` gives no decision, so Codex's sandbox still decides; `deny` blocks with
  the reason; `defer` blocks with the reason and the request, and the runtime ends the run (a hook
  cannot end a turn), which fails as `config_error` naming the request.
- **Close what the hook does not see.** Codex runs with `/dev/ptmx` and `/dev/pts` hidden, so no
  session has a terminal for `write_stdin` to write to; web search is off; the features that add
  unhooked tools or outside work stay off, and a configuration that turns one on, or holds
  `hooks`, is refused.
- **Classification stays the gate's.** The `agents` source's table gains Codex's tool names
  (`apply_patch` by the files its patch names, read strictly; `view_image` as a read); the gate
  contract and the routing code still name no runtime (INV-11).
- The bundle's `runtime-codex-sdk` row stays off (PROP-0004); the operator turns it on.
- No new dependency: the Codex SDK and CLI are already used, never vendored.

## Consequences

- Codex Workers can be admitted for `review`, `develop`, and `validate`, under the same policy as
  Claude Code Workers; each call is judged, and deferred calls continue in a later run.
- The bridge rests on Codex's hook behaviour as of 0.164 (the trust hash, exit codes, tool names).
  A release that changes it fails the probe, not a run: the Workers become unavailable, the reason
  in `detail`.
- A hook that let a tool run is detected after that call, not before; the call ran inside Codex's
  sandbox and the read confinement. The probe makes this unlikely, not impossible (a Codex upgrade
  between two probes).
- A Codex Worker has no terminal: interactive commands fail, as they would without input.
- A deferred call is denied in Codex's thread; in the later run the model makes it again, and only
  the same input finds the approval.
- Revisit if Codex gains a hook decision that ends a turn, an `allow` that keeps its sandbox, or a
  hook on `write_stdin`; or if the app-server's approval flow comes to cover every tool call.
