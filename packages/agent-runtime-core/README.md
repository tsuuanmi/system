# @tsuuanmi/system-agent-runtime-core

Capability **seam definition** for agent runtimes
([design](../../docs/design/agent-runtimes.md), plugin rule 2).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.agentRuntimes` | abstract `AgentRuntimes` with `register`, `get`, `list`, `confinement`; `AgentRuntimeProvider` (`probe`, `run`, optional `identity`, `loginCommand`), `RunSpec`, `RunResult`, `RunMetering`, `TokenUsage`, `ModelUsage`, `LimitObservation`, `RuntimeEvidence`, `ProbeOptions`, `IdentityReading`, `LoginCommand`, `SandboxMode`, `ToolGate`, `ToolCall`, `ToolVerdict`; `askToolGate`, `isToolVerdict`, `TOOL_GATE_MS`; `withMetering`, `meteringOf`; `identityHmac`, `accountIdOf`, `maskEmail`, `probeIn`, `homeProblem`, `readHomeJson`, `MAX_HOME_FILE_BYTES` | `@tsuuanmi/system-agent-runtimes` |

- A provider adapts one agent (Claude Code, Codex, an ACP agent) to `run(spec)`.
  Only the agent's native handle crosses the seam (INV-7).
- **Metering** ([resources](../../docs/design/resources.md)): a `RunResult` may carry what the
  run consumed (`RunMetering`), from the agent's own objective numbers, never the model's
  text: `resultId` (the runtime's identity of its result, for deduplication), `model` (the main
  loop's), `usage` (normalized: `inputTokens` includes cached input), `models` (per model, with
  `costUsd`; each count of `usage` is their sum), `turns`, `costUsd`, and `limits` (rate-limit
  observations: the runtime's own window name, kept opaque (INV-11), `allowed`, `warning`, or
  `rejected`, `resetsAt` and `observedAt` in ISO time, `usedPercentage`). Every field is
  optional: a missing number stays missing. A run that fails attaches what it consumed to its
  error (`withMetering`), read back with `meteringOf`. Names are provider-neutral; the
  [`agent-workers`](../plugins/agent-workers/README.md) source maps them into the ledger.
- A provider refuses a policy it cannot enforce exactly, with a `config_error`.
  It never loosens a policy.
- **Tool gate** ([approvals](../../docs/design/approvals.md#a-workers-tool-calls)):
  `RunSpec.toolGate` is a per-tool-call gate from the Worker source that owns
  the run (trusted, INV-6): given a `ToolCall` (`tool`, `input`, and the
  runtime's opaque `callId`), it answers a `ToolVerdict`: `allow` (the call
  goes on to the runtime's own policy, which still holds), `deny` with a
  `reason` the agent is told, or `defer` with a `reason` and the approval
  `requestId` it waits for. A provider that gates (`RuntimeEvidence.gatesToolCalls`)
  asks it before every tool call, subagents' included, through
  `askToolGate(gate, call, signal, ms)`: a gate that throws, gives an unknown
  verdict, or does not answer within the provider's bound (`ms`) is a deny, and
  the gate's own signal aborts with the run or the bound.
  After a `defer` it runs no further tool call and ends the run with a
  `config_error` naming the request: a deferred run never completes. A provider
  that cannot ask it before every call reports `gatesToolCalls: false` and
  refuses a run that carries one (`config_error`), never ignores it. The
  contract names no tool: the gate's owner classifies tool names.
  `askToolGate(gate, call, signal, ms)` asks it as a gating provider must:
  bounded (`TOOL_GATE_MS`, 30 s, by default), and a throw, an undefined verdict
  (`isToolVerdict`), or no answer in time is a `deny`.
- **Agent accounts** ([ADR-0051](../../docs/decisions/adr/0051-agent-accounts-are-enrolled-slots-identified-by-their-login.md),
  [design](../../docs/design/agent-runtimes.md#agent-accounts)), all optional:
  - `RunSpec.home` and `probe({ home })`: one account's home. A provider that runs
    in a named home reports `RuntimeEvidence.homes`; one that does not refuses a run
    naming a home (`config_error`) before anything runs, never ignores it.
    `probeIn(provider, home)` asks a named home only of a provider whose own probe
    reports `homes`, and reads unavailable otherwise or for a relative home;
  - `identity(home, key)`: who is signed in to that home, as an `IdentityReading`:
    `verified` with the keyed `hmac` (`identityHmac(key, provider, parts)`:
    HMAC-SHA256 over the provider and the parts in canonical order; it refuses a
    key under 16 bytes and an empty part), the `reader`, the `runtimeVersion`,
    and a masked `hint` (`maskEmail`); or `missing`, `ambiguous`, `unverified`
    with why. Never a token or the raw principal (INV-8), never a throw for a home
    it cannot read. `accountIdOf(provider, hmac)` is the account id;
  - `loginCommand(home)`: the runtime's own sign-in command, its environment
    naming the home and no session bus;
  - `home`: the provider's own configured home, which a Worker source adopts as
    slot 1 of its accounts;
  - for readers: `homeProblem(home)` (an existing owner-only directory of this
    user, not a link, or why not; it never makes one) and `readHomeJson(path)`
    (a JSON object from a regular file of this user, opened without following a
    link and at most `MAX_HOME_FILE_BYTES`; `absent`, or `refused` with why,
    never its content), since a run can write its own home.
- **`childEnvironment(forward, explicit)`** is the environment every runtime's
  child process starts with (INV-8):
  1. DSH's own `scrubbedParentEnv()` (`@deepseek-ai/dsh-subprocess`): every name
     matching `/KEY|PASSWORD|SECRET|TOKEN/i` and every `DSH_*` name is removed;
     `PATH`, `HOME`, locale, and the proxy variables
     (`@deepseek-ai/dsh-http-proxy`) are kept;
  2. then the daemon variables the operator forwards **by name** (`forwardEnv`),
     such as an API key or the gateway's model token; a name the daemon does not set is
     absent;
  3. then explicit values (`env`), which win. A secret never belongs there.
- **Read confinement** ([ADR-0024](../../docs/decisions/adr/0024-agent-workers-confined-for-reads.md)):
  `RuntimeEvidence.readsConfined`; the `Confinement` type (`bwrap`, `hide`,
  `readOnly`, `writable`) that `ctx.agentRuntimes.confinement()` returns;
  - `confinedCommand(command, args, confinement)`: the bubblewrap command line
    (`--die-with-parent --unshare-pid --new-session --dev-bind / / --proc /proc`,
    then, shallowest first, a tmpfs over each hidden directory, the null device
    over each hidden file, and the binds back; missing paths skipped, symlinks
    resolved). A bind that is, or holds, a hidden path is refused;
  - `proveConfinement(confinement)`: on this host, positively: the command runs;
    each masked directory is not the host's (device and inode) and lists only the
    way down to what is bound back; each hidden file is the null device. Anything
    else is `confined: false`, and an absent operator entry is named;
  - `writeLauncher(dir, name, command)`: an owner-only script, named by its
    content and written whole (temporary file, rename), for SDKs that start a
    program path without arguments; an existing file is reused only when it is
    exactly that content;
  - `childEnvironment` also drops the variables that lead to the operator's
    session: `DBUS_SESSION_BUS_ADDRESS`, `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`,
    `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`;
  - `conformance/passthrough-bwrap.sh`: a test double that drops the options and
    execs the command.
- Conformance:
  - `conformance/agent-runtimes.ts` has `agentRuntimesConformance` for the
    registry;
  - `agentRuntimeProviderConformance` covers probe, run, handle, refusal (a
    tool gate refused by a provider that does not gate, before anything runs),
    and abort, against a scripted agent the provider's own test supplies, and that
    what a run reports it consumed holds together, or is absent
    (`expectConsistentMetering`: whole counts, input including its cached part,
    per-model counts summing to the totals, limits with an opaque window and ISO
    times). A provider that reports nothing passes as it is. It also refuses a run
    naming a home the provider does not run in;
  - `agentRuntimeIdentityConformance` (`IdentityHarness`: the provider, and how
    to sign a scripted home in and out) for a provider that reads identity: one
    HMAC per login across reads, a restart, and a re-login, two logins two, one
    login in two homes one, another key another, no unreadable home verified, no
    principal in the reading, a sign-in command that names the home and sets no
    session bus, and a run in a named home;
  - `FakeAgentRuntime`: scripted homes (`signIn`, `signOut`), a reader verified on
    one version, passing both suites (`tests/identity.spec.ts`).
- **Dependencies:** `@deepseek-ai/dsh-subprocess` and its peer
  `@deepseek-ai/dsh-http-proxy`, for the scrub only.
