# ADR-0024: Agent Workers are confined for reads; host state is never readable

- **Status:** Accepted
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

- Runtime evidence gains `readsConfined`. Every agent Worker is denied reads of
  the **whole DSH home** (the vault and its key, the control tokens, the store,
  the login profiles, and DSH's own credentials), of `$CREDENTIALS_DIRECTORY`
  when the host runs under systemd, and of operator-named paths such as a vault
  `keyFile` kept elsewhere, whatever the Worker's sandbox mode.
- `ctx.agentRuntimes` owns the confinement (`agent-runtimes` configuration:
  `bwrap`, `hide`, `readOnly`). The DSH home is always hidden. Operator tools
  (`$DSH_HOME/system/tools`) come back read-only, and a Worker's own home
  writable.
- A runtime proves `readsConfined` in its probe, on this host. A runtime that
  cannot is unavailable, and routing reports why (INV-2).
- Mechanism: `agent-runtime-core` starts the agent under bubblewrap
  (`--dev-bind / /`, an empty tmpfs over each hidden directory, an unreadable
  node over each hidden file, the binds back, and `--die-with-parent` so that
  stopping the run ends the agent). Per runtime:
  - Codex: through an owner-only launcher script, since its SDK takes a program
    path only. Codex's own sandbox still runs inside and still confines writes
    (verified live 2026-10-14). Codex's newer permission profiles were not used:
    their configuration schema changes between releases.
  - ACP agents: spawned under bubblewrap directly. Serving file reads inside the
    workspace was not enough: an agent can read the disk on its own.
  - Claude Code: its pre-approved tools are scoped to the workspace, reads
    included, and nothing else is allowed (verified live 2026-10-13), so it
    reports `readsConfined` without a wrapper.
- Tests: the confinement against the real bubblewrap (CI requires it, as it
  requires Xvfb), its proof failing closed, each runtime's evidence, and an ACP
  agent that looks at a hidden file on its own.

## Consequences

- An agent Worker can no longer read credentials or control tokens, so INV-8
  holds against Workers as well as clients.
- A host without bubblewrap, or where unprivileged user namespaces are refused
  (Ubuntu 23.10 and later restrict them through AppArmor), cannot run Codex or ACP
  Workers until the operator allows them; the probe says so
  ([runbook](../../operations/runbooks.md#agent-workers)).
- Option 2 is not needed for this threat, which keeps the store unencrypted
  (the threat model's precondition of disk encryption still applies).
- macOS needs its own mechanism (the platform sandbox) in M7.
- Revisit when Codex's default Linux sandbox confines reads by itself.
