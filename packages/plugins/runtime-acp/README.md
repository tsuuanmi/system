# @tsuuanmi/system-runtime-acp

Agent runtime providers **`acp:<name>`**: any
[Agent Client Protocol](https://agentclientprotocol.com) agent as a Worker,
through the official ACP SDK. This is the generic path; Claude Code has its own
first-class provider.

- **Config:** `agents`. Each entry has a `name`, a `command` with optional
  `args`, `env` (explicit values, never a secret) and `forwardEnv` (daemon
  variables passed by name, such as an API key the agent needs), and
  `honoursPermissions` (default false). Each agent registers as the runtime
  `acp:<name>`, for `agent-workers` entries to name.
- **Environment:** the agent starts without the daemon's credentials (INV-8),
  with `childEnvironment` (agent-runtime-core): credential-shaped and `DSH_*`
  variables are scrubbed, and only `forwardEnv` and `env` add to it.
- **Probe:** the protocol handshake only (`initialize`). It never runs a task.
  `resume` is the agent's `loadSession`. `executes` is false.
- **The client side enforces the policy:**
  - every `requestPermission` is answered with a reject option;
  - `readTextFile` is served inside the workspace only, with real paths:
    symlinks and `..` cannot leave it;
  - no write and no terminal capability is advertised, and no MCP server is
    passed;
  - what ACP cannot express exactly (a tool list, a model, a turn limit, a
    run's tool gate) is refused, never ignored. An agent asks the client only
    for what it chooses to, so not every tool call could reach a gate: the probe
    reports `gatesToolCalls: false`, and the `agents` source admits none of its
    Workers ([tool gate](../../../docs/design/agent-runtimes.md#tool-gate)).
- **Trust:** an agent can still act on the disk without asking. So `read-only`
  is offered only for an agent the operator vouches for (`honoursPermissions`,
  INV-6). Any other agent offers no sandbox, and its Workers stay unavailable.
- **Read confinement** ([ADR-0024](../../../docs/decisions/adr/0024-agent-workers-confined-for-reads.md)): the agent process
  starts under bubblewrap with the `ctx.agentRuntimes` confinement, so what it
  reads on its own cannot reach the DSH home either. The probe proves it
  (`readsConfined`); without a confinement, a run is refused.
- **Run:**
  - a new session or `loadSession` (`resume`), then one prompt; the answer is the
    agent's message chunks;
  - an abort sends `session/cancel`; after 3 s the process gets SIGTERM, and
    after 5 s more SIGKILL (`cancelMs`, `killMs`: constructor timing, not
    configuration), so an agent that ignores both cannot hang a run;
  - stop reasons map to the failure taxonomy (`max_tokens` / `max_turn_requests`
    → `timeout`, `refusal` → `invalid_input`, `cancelled` → `aborted`).
- **Verified:** against a scripted ACP agent subprocess, and live with
  `@agentclientprotocol/claude-agent-acp` 0.89.1 (handshake only).
- **Injects:** `agentRuntimes`.
