# @tsuuanmi/system-runtime-codex-sdk

Agent runtime `codex-sdk`: **Codex as a Worker** (REQ-WRK-5)
([agent runtimes](../../../docs/design/agent-runtimes.md)). It runs the
operator's installed `codex` through the official Codex TypeScript SDK.

- **Policy, exactly or refused (REQ-WRK-6):**
  - the sandbox (`read-only`, or `workspace-write` with writes confined to the
    workspace) and the working directory come from the Worker's configuration;
  - approvals are `never`, so whatever the sandbox refuses fails instead of
    waiting for a person (an escalated command is refused by Codex itself);
  - network access and web search are off, and so are the Codex features that
    add tools no hook sees, or work and servers outside the run (`FEATURES_OFF`:
    apps, plugins, subagents, image generation, browser and computer use, code
    mode, tool suggestions, skill MCP installs, standalone web search, goals,
    memories); hooks are on;
  - the `codex` process starts without the daemon's credentials (INV-8):
    always with `childEnvironment` (agent-runtime-core), so credential-shaped
    and `DSH_*` variables are scrubbed;
  - Codex runs in **its own Codex home** (`CODEX_HOME`, config `home`, default
    `<DSH_HOME>/system/codex-home`, created owner-only), never the operator's
    `~/.codex`, where `system mcp-config codex` puts the `system` MCP server.
    Codex starts MCP servers outside its sandbox, so a Worker would reach their
    tools (`approve`, the credential tools, …). The probe and every run call
    `codex mcp list --json` on that home and fail closed (`config_error`) if any
    enabled MCP server is configured. A `config` holding `mcp_servers` or
    `hooks`, turning on a feature the runtime keeps off, or turning hooks off,
    is refused. A `-c mcp_servers={}` override would not clear them, because
    Codex merges its configuration, hence the separate home;
  - **signed in there:** unless `config` names a model provider (other than the
    built-in `openai`) or an API key is forwarded (`CODEX_API_KEY`,
    `OPENAI_API_KEY`), the probe runs `codex login status` under the
    confinement, and a home no one signed in to makes the Worker unavailable,
    saying where to sign in;
  - Codex has no tool allow-list and no turn limit, so a configured `tools` or
    `maxTurns` is refused, not ignored.
- **The run's tool gate** (`RunSpec.toolGate`,
  [Codex's gate](../../../docs/design/agent-runtimes.md#codexs-gate)) is the one
  PreToolUse hook, on every tool (`*`), a command Codex runs before each call:
  - per gated run, `gate.ts` opens a unix socket in a fresh owner-only directory
    under the run directory (`<DSH_HOME>/system/run`) and a 256-bit key; Codex
    hands both to the hook through its environment
    (`SYSTEM_CODEX_GATE_SOCKET`, `SYSTEM_CODEX_GATE_KEY`), which Codex's own
    commands never get (`shell_environment_policy.exclude`, added to the
    operator's). The directory, the hook script, and `node` are bound into the
    confinement read-only; all of it is removed when the run ends;
  - the hook (`gate-hook.js`, Node built-ins only, run by the daemon's `node`)
    sends the key and Codex's hook input, and turns the answer into Codex's
    decision: `allow` prints nothing, so Codex's sandbox still decides; `deny`
    blocks the call (exit 2, the reason on stderr); any failure of its own
    blocks too, since Codex runs the tool when a hook fails, prints what Codex
    cannot read, or times out; it answers within 90 s, under Codex's 120 s;
  - the hook and its trust go in as `--config` overrides per run
    (`hooks.PreToolUse`, and `hooks.state` with the sha256 of the hook's
    definition, as Codex 0.164 trusts a hook), so no file is written and no
    other hook is trusted;
  - the gate is asked through `askToolGate` (30 s, fail-closed). The bridge
    denies a wrong key, an input that is not a PreToolUse call, a call from
    another directory than the workspace, and every call after a `defer`;
  - `defer` blocks the call with its reason and request id, then stops the run,
    which rejects with a `config_error` naming the request, whatever Codex
    reported. A later run of the thread makes the call again;
  - every tool item Codex reports (a command, a file change, an MCP call, a web
    search, anything but a message, reasoning, the plan, or an error) must be
    accounted for by a call the gate allowed; otherwise the run stops
    (`config_error`): a hook that let a tool run is caught after that call;
  - Codex runs with **no terminal**: `/dev/ptmx` and `/dev/pts` are hidden from
    it (`NO_TERMINAL`), because `write_stdin` writes to a running command's
    terminal without asking any hook; without a terminal, a command's stdin is
    closed. The operator's own terminals are out of reach too.
- **Reads are confined** ([ADR-0024](../../../docs/decisions/adr/0024-agent-workers-confined-for-reads.md)). Codex's own
  sandbox confines writes only, so Codex starts under bubblewrap with the
  `ctx.agentRuntimes` confinement: the DSH home is hidden, the Worker home is
  bound back writable, and the tools directory read-only. The SDK takes a
  program path only, so an owner-only launcher script under
  `<DSH_HOME>/system/run` holds the command line (named by its content; a
  gated run's is its own, removed with it). A `codex` installed under a hidden
  directory (the standalone installer's `~/.codex/packages`) is not reachable
  inside: install it elsewhere or bind its release directory back
  ([runbook](../../../docs/operations/runbooks.md#codex-workers)).
- **Probe:** `codex mcp list --json` on the Worker home (any server:
  unavailable), `codex --version`, the read confinement with Codex's own
  sandbox nested inside (`readsConfined`), the sign-in, then the gate's proof
  (`proof.ts`): one Codex turn with the run's configuration, hook, and
  confinement against a scripted model the probe serves on loopback (a random
  path, `--ephemeral`, no account or provider reached). `gatesToolCalls` is
  true only when the first request offers no hosted tool, a command the
  probe's gate denies is blocked and did not run, a terminal command starts no
  terminal session, and the turn ends with the scripted answer; otherwise the
  reason is in `detail`. Both sandboxes are supported, threads resume, and
  commands run inside the sandbox (`executes`), so a writable Codex Worker
  proves `validate`.
- **Runs:** a thread starts, or resumes by its native handle, the thread id
  reported as soon as the thread starts. The final agent message is the result.
  A failed turn is `session_broken`, or `quota_exhausted` for a usage limit.
- **Configuration:**
  - `executable` (default: `codex` on PATH);
  - `config`: Codex `--config` overrides, such as its model provider, passed as
    dotted overrides before the runtime's own;
  - `forwardEnv`: daemon variables passed to the process by name;
  - `env`: explicit values for the process, never a secret;
  - `home`: the Workers' Codex home; it must configure no MCP server.

  To run Codex on website Workers, point its model provider at the system
  Responses gateway. Put the model token (`system mcp-token --scope model`) into
  the daemon's environment as the variable the provider's `env_key` names (for
  example `SYSTEM_MCP_TOKEN`), never into a config file, and name that variable
  in `forwardEnv`: without it, the scrub removes the token and Codex cannot reach
  the gateway. Such a Worker needs no login, and its token reaches only the model
  gateways. A Worker on an OpenAI or ChatGPT login must be signed in inside its
  own home (`CODEX_HOME=<home> codex login`); the operator's `~/.codex` login is
  not used. The row stays off in the bundle (PROP-0004); the
  [runbook](../../../docs/operations/runbooks.md#codex-workers) turns it on.
- **Dependencies:** `@openai/codex-sdk`, whose per-platform Codex builds are
  ignored optional dependencies, and `system-libs` (`dshHome`,
  `ensurePrivateDir`). The gate relies on Codex's hook behaviour as of 0.164
  (above); the probe proves it on each host.
- **Live checks:** the [release checklist](../../../docs/validation/release-checklist.md)
  (a Codex Worker).
