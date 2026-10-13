# ADR-0024: Agent Workers are confined for reads; host state is never readable

- **Status:** Proposed
- **Date:** 2026-10-14
- **Related:** [PROP-0003](../../proposals/0003-production-readiness.md#m6a-security-hardening),
  REQ-WRK-6, QA-6,
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-8](../../architecture/invariants.md#inv-8-credentials-never-cross-upward),
  [agent runtimes](../../design/agent-runtimes.md#admission-evidence)

## Context

Agent-runtime Workers (Claude Code, Codex, ACP agents) run as the operator's
user. Each one enforces the workspace policy with its own sandbox (REQ-WRK-6):

- the Claude Worker's pre-approved rules are scoped to the workspace, reads
  included;
- ACP agents get file reads served inside the workspace only;
- Codex confines **writes** to the workspace, but its default Linux sandbox
  (Landlock) leaves **reads** open. A Codex Worker, even a `read-only` one, can
  read `<DSH_HOME>/system/`: the vault key, the control tokens, the store, and the
  login profiles. The threat model records this as a gap.

Codex also has a bubblewrap backend that can mount only chosen readable roots.
`bwrap` can also be used directly to hide a directory from any child process.
Some Linux distributions restrict the unprivileged user namespaces that both
need.

## Options

1. Document the gap and leave it to the operator.
2. Encrypt everything under `<DSH_HOME>/system/` so reads reveal nothing.
3. **Make read confinement part of a runtime's admission evidence.** A runtime
   that cannot prove that host state is unreadable is unavailable.

## Decision

Option 3.

- Runtime evidence gains `readsConfined`. The policy for every agent Worker
  denies reads of `<DSH_HOME>/system/**` and of the configured vault key path,
  whatever the Worker's sandbox mode.
- A runtime proves `readsConfined` in its probe. A runtime that cannot is
  unavailable, and routing reports why (INV-2).
- Mechanism per runtime:
  - Codex: its bubblewrap backend with restricted readable roots, if its
    configuration can express the policy; otherwise `agent-runtime-core` starts
    the child under `bwrap` with the state directory hidden. The implementation
    spike chooses and records the reason in the
    [dependency register](../../engineering/dependencies.md).
  - Claude Code and ACP agents: their existing workspace-scoped reads already
    satisfy the policy; they assert it in conformance.
- The seam's conformance suite gains a case: a read outside the workspace is
  denied. A real-`bwrap` test runs in CI, which fails rather than skips when
  `bwrap` is missing, as it already does for Xvfb.

## Consequences

- An agent Worker can no longer read credentials or control tokens, so INV-8
  holds against Workers as well as clients.
- A host where user namespaces are unavailable cannot run Codex Workers until the
  operator enables them; the probe says so.
- Option 2 is not needed for this threat, which keeps the store unencrypted
  (the threat model's precondition of disk encryption still applies).
- macOS needs its own mechanism (the platform sandbox) in M7.
- Revisit when Codex's default Linux sandbox confines reads by itself.
