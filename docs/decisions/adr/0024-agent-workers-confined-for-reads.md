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
  (bubblewrap in 0.162.1, Landlock in older releases) leaves **reads** open. A
  Codex Worker, even a `read-only` one, can read `<DSH_HOME>/system/`: the vault
  key, the control tokens, the store, and the login profiles. The threat model
  records this as a gap.

Codex can also be configured to mount only chosen readable roots. `bwrap` can be
used directly to hide a directory from any child process. Some Linux
distributions restrict the unprivileged user namespaces that both need.

Host state is not only under the DSH home. The session's runtime directory holds
the user's message bus, through which a process can ask the user's service
manager to run a command outside any sandbox, and the key agents. The temporary
directories hold the browsers' live profiles, the display cookie (which drives
the accounts' browsers), and the remote-login socket. An operator can move the
vault, its key, the store, and the login profiles anywhere.

## Options

1. Document the gap and leave it to the operator.
2. Encrypt everything under `<DSH_HOME>/system/` so reads reveal nothing.
3. **Make read confinement part of a runtime's admission evidence.** A runtime
   that cannot prove that host state is unreadable is unavailable.

## Decision

Option 3.

- Runtime evidence gains `readsConfined`. Whatever the Worker's sandbox mode, an
  agent never reads:
  - the **whole DSH home** (the vault and its key, the control tokens, the
    store, the login profiles, and DSH's own credentials);
  - the session's runtime directory (`$XDG_RUNTIME_DIR`), the temporary
    directories (`$TMPDIR`, `/tmp`, `/var/tmp`, `/dev/shm`), and
    `$CREDENTIALS_DIRECTORY` under systemd;
  - the usual credential stores in the home directory (`.ssh`, `.gnupg`,
    `.aws`, `.codex`, `.Xauthority`, `.config/gh`, `.docker/config.json`);
  - every **registered secret path**: each plugin that owns a secret registers
    its path for as long as it exists (`registerSecretPath` in `system-libs`;
    the vault and its key, the store, login profiles, the display cookie, the
    remote-login socket), wherever the operator keeps it;
  - operator-named paths (`agent-runtimes` config `hide`).
- `ctx.agentRuntimes` owns the confinement (`agent-runtimes` configuration:
  `bwrap`, `hide`, `readOnly`). Operator tools (`$DSH_HOME/system/tools`) come
  back read-only; a Worker's own home and its workspace come back as its sandbox
  allows. A bind that would re-expose a hidden path (it is one, or holds one) is
  refused. `bwrap` is resolved once to an absolute path, a root-owned one first.
- A runtime proves `readsConfined` in its probe, on this host, **positively**:
  inside, each masked directory (each hidden directory, and each on the way down
  to a bind) is not the host's by device and inode and lists only the next path
  component; each hidden file is the null device. A runtime that cannot prove it
  is unavailable, and routing reports why (INV-2). The agent Worker source checks
  the proof again just before a run starts, so a queued or recovered run never
  starts on a stale proof.
- Mechanism: `agent-runtime-core` starts the agent under bubblewrap with its own
  PID namespace and `/proc` (nothing it starts outlives the run, and it cannot see
  the daemon's processes), its own session (it cannot inject input into the
  daemon's terminal), `--die-with-parent`, `--dev-bind / /`, then the mounts,
  shallowest first. The child's environment drops the variables that lead to the
  operator's session (message bus, key agents, displays). Per runtime:
  - Codex: through an owner-only launcher script, since its SDK takes a program
    path only (written whole, then renamed; reused only when it is exactly that
    content). Codex's own sandbox still runs inside and still confines writes
    (verified live 2026-10-14); the probe also starts it inside the confinement
    (`codex sandbox -- true`). Codex's newer permission profiles were not used:
    their configuration schema changes between releases.
  - ACP agents: spawned under bubblewrap directly. Serving file reads inside the
    workspace was not enough: an agent can read the disk on its own.
  - Claude Code: its pre-approved tools are scoped to the workspace, reads
    included, and nothing else is allowed (verified live 2026-10-13), so it
    reports `readsConfined` without a wrapper. That is a property of its policy,
    stated by the runtime, not proven on the host by the probe; running it
    under the same launcher would make it proven.
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
- Abstract Unix sockets are not files, so hiding paths does not hide them. The
  one that matters is an X server's, which needs the hidden display cookie; a
  session bus on an abstract address is not reached because its address
  variable is dropped, but an agent that knew the address could connect. Hiding
  them needs a network namespace, which would also cut the agent off from its
  model.
- Paths in the home directory beyond the listed credential stores stay
  readable: an operator adds them to `hide`.
- Revisit when Codex's default Linux sandbox confines reads by itself.
