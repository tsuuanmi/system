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
- Conformance:
  - `conformance/agent-runtimes.ts` has `agentRuntimesConformance` for the
    registry;
  - `agentRuntimeProviderConformance` covers probe, run, handle, refusal, and
    abort, against a scripted agent the provider's own test supplies.
