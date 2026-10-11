# @tsuuanmi/system-runtime-acp

Agent runtime providers **`acp:<name>`**: any
[Agent Client Protocol](https://agentclientprotocol.com) agent as a Worker,
through the official ACP SDK. This is the generic path; Claude Code has its own
first-class provider.

- **Config:** `agents`. Each entry has a `name`, a `command` with optional
  `args` and `env`, and `honoursPermissions` (default false). Each agent
  registers as the runtime `acp:<name>`, for `agent-workers` entries to name.
- **Probe:** the protocol handshake only (`initialize`). It never runs a task.
  `resume` is the agent's `loadSession`. `executes` is false.
- **The client side enforces the policy:**
  - every `requestPermission` is answered with a reject option;
  - `readTextFile` is served inside the workspace only, with real paths:
    symlinks and `..` cannot leave it;
  - no write and no terminal capability is advertised, and no MCP server is
    passed;
  - what ACP cannot express exactly (a tool list, a model, a turn limit) is
    refused, never ignored.
- **Trust:** an agent can still act on the disk without asking. So `read-only`
  is offered only for an agent the operator vouches for (`honoursPermissions`,
  INV-6). Any other agent offers no sandbox, and its Workers stay unavailable.
- **Run:**
  - a new session or `loadSession` (`resume`), then one prompt; the answer is the
    agent's message chunks;
  - an abort sends `session/cancel`, then stops the process;
  - stop reasons map to the failure taxonomy (`max_tokens` / `max_turn_requests`
    → `timeout`, `refusal` → `invalid_input`, `cancelled` → `aborted`).
- **Verified:** against a scripted ACP agent subprocess, and live with
  `@agentclientprotocol/claude-agent-acp` 0.89.1 (handshake only).
- **Injects:** `agentRuntimes`.
