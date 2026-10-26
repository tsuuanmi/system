# ADR-0043: Antigravity CLI Workers ask the run's tool gate through their PreToolUse hook, on an agy version verified live

- **Status:** Accepted
- **Date:** 2026-10-23 (accepted 2026-10-23, by the operator)
- **Related:** [ADR-0024](0024-agent-workers-confined-for-reads.md),
  [ADR-0039](0039-base-guarantee-seam-contract-changes.md),
  [ADR-0042](0042-codex-workers-ask-the-gate-through-a-hook-bridge.md), REQ-WRK-5, REQ-WRK-6,
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-11](../../architecture/invariants.md#inv-11-no-tool-lock-in),
  [agent runtimes](../../design/agent-runtimes.md#tool-gate)

## Context

The `runtime-antigravity-cli` row runs the Antigravity CLI (`agy`) as a Worker. agy has no
per-tool allow-list or workspace-scoped permission a headless run can be held to, so its runtime
holds every tool call at agy's PreToolUse hook: one `hooks.json` in the Workers' own agy home,
whose command reaches the run over a per-run socket with a token, the runtime's own rules first,
then the run's gate ([its README](../../../packages/plugins/runtime-antigravity-cli/README.md)).
The probe proves the bridge's half on the host (the command, run as agy runs it inside the
confinement, reaches the run's gate). It cannot prove agy's half, that agy runs the hook before
each tool call with the inputs the rules read: that takes a model turn. So the runtime offered no
sandbox and gated nothing, and the `agents` source admitted none of its Workers.

A supervised live check of agy 1.4.6 (2026-10-23, its economy model at its lowest effort, a scratch workspace,
a copy of the Workers' signed-in home; evidence in
`packages/plugins/runtime-antigravity-cli/tests/fixtures/agy-1.4.6-hook-inputs.json`) showed
that agy:

- runs the PreToolUse hook before each tool step of the session (the target of a write did not
  exist yet when the hook ran), synchronously, in the directory of `hooks.json`, with its own
  environment, the variables the run sets included;
- names the tool the model calls (`read_file`, `write_file`, `edit_file`, `run_command`), not
  the lowercased step type its hooks guide describes, and passes the model's arguments as
  `toolCall.args`, paths as absolute strings;
- gives that model (`<economy model>`) no tool that lists or searches a directory: it reads files by path,
  and runs a command for the rest;
- blocks the step on a `deny`, an exit status other than 0, output it cannot read, `{}`, a
  decision it does not define, or a hook past its timeout;
- **runs the tool when the hook exits 0 and prints nothing**: it fails open there;
- still refuses a command in a headless session after a hook's `allow` (its own permission
  check), but not a file write inside the workspace.

The runtime's own bridge, run through `AntigravityRuntime` under a production-like read
confinement, allowed, denied by its rules (a file outside the workspace, a customization root, a
tool the sandbox does not offer), and denied by the gate exactly as asked.

## Options

1. **Keep Antigravity CLI Workers out.** Safe, but agy stays unused as a Worker.
2. **Prove agy's half in the probe** with a scripted model, as Codex's probe does (ADR-0042).
   agy's options (`agy --help`, 1.4.6) offer no way to point it at a local model, so the probe
   would spend a real model turn, on the operator's quota, every time it runs.
3. **Admit only an agy version a supervised live check verified**, its tool names and fields
   in the runtime's rules and the gate's table, and close where agy fails open in the hook's own
   command.

## Decision

Option 3.

- **A version verified live.** The runtime keeps `VERIFIED_HOOK_VERSIONS` (1.4.6), each entry
  naming its evidence. On another version the probe offers no sandbox and reports no
  `gatesToolCalls`, and every run is refused; an upgrade is unverified until checked the same
  way ([runbook](../../operations/runbooks.md#antigravity-cli-workers)).
- **`gatesToolCalls` follows the hook layer.** The probe reports it exactly when the hook layer
  is proven: the bridge's self-test on the host and a verified version.
- **The hook always answers.** The command in `hooks.json` prints the run's hook's answer only
  when that hook exits 0 with an answer, and a deny itself in every other case, so agy's
  fail-open on an empty answer is never reached.
- **The tools as agy names them.** The runtime's rules offer `read_file` in a `read-only` run
  and add `write_file` and `edit_file` in a `workspace-write` run; `run_command` and every other
  tool are denied. The `agents` source's table classifies the three by `Path`, with exactly the
  fields recorded (`ArtifactMetadata`, which writes one of agy's own artifacts, is denied), and
  reads a `file:` URI as the path it names; the gate contract and the routing code still name no
  runtime (INV-11).

## Consequences

- Antigravity CLI Workers can be admitted for `review` and `develop`, under the same policy as
  the other agent Workers; never `validate` (no command is offered).
- A Worker on that model reads only files it is told of or finds named in what it reads:
  there is no listing or search tool, and the commands it would run for one are denied.
- Another model's tools are not verified, so they are denied: such a Worker can do nothing.
- The check trusts that one agy version runs its hooks the same way on every host. Revisit when
  agy gains a way to point it at a local model (a probe could then show agy's half, as Codex's
  does), a decision that ends a turn, or an allow-list a headless run can be held to.
