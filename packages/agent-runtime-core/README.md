# @tsuuanmi/system-agent-runtime-core

Capability **seam definition** for agent runtimes
([design](../../docs/design/agent-runtimes.md), plugin rule 2).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.agentRuntimes` | abstract `AgentRuntimes` with `register`, `get`, `list`; `AgentRuntimeProvider` (`probe`, `run`), `RunSpec`, `RunResult`, `RuntimeEvidence`, `SandboxMode` | `@tsuuanmi/system-agent-runtimes` |

- A provider adapts one agent (Claude Code, Codex, an ACP agent) to `run(spec)`.
  Only the agent's native handle crosses the seam (INV-7).
- A provider refuses a policy it cannot enforce exactly, with a `config_error`.
  It never loosens a policy.
- **`childEnvironment(forward, explicit)`** is the environment every runtime's
  child process starts with (INV-8):
  1. DSH's own `scrubbedParentEnv()` (`@deepseek-ai/dsh-subprocess`): every name
     matching `/KEY|PASSWORD|SECRET|TOKEN/i` and every `DSH_*` name is removed;
     `PATH`, `HOME`, locale, and the proxy variables
     (`@deepseek-ai/dsh-http-proxy`) are kept;
  2. then the daemon variables the operator forwards **by name** (`forwardEnv`),
     such as an API key or the gateway token; a name the daemon does not set is
     absent;
  3. then explicit values (`env`), which win. A secret never belongs there.
- Conformance:
  - `conformance/agent-runtimes.ts` has `agentRuntimesConformance` for the
    registry;
  - `agentRuntimeProviderConformance` covers probe, run, handle, refusal, and
    abort, against a scripted agent the provider's own test supplies.
- **Dependencies:** `@deepseek-ai/dsh-subprocess` and its peer
  `@deepseek-ai/dsh-http-proxy`, for the scrub only.
