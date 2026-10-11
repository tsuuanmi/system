# Agent runtimes (Claude Code, Codex, ACP agents as Workers)

> Target state. Seam: `ctx.agentRuntimes` ([plugin model](../architecture/plugin-model.md#seam-catalog)).
> Requirements: REQ-WRK-5, REQ-WRK-6. Decision: [ADR-0009](../decisions/adr/0009-claude-and-codex-first-class.md).

An **agent runtime** is an external coding agent that `system` drives as a
Worker. It is the counterpart of the [gateways](gateways.md), where the same
agents act as clients.

## Providers

| Provider plugin | Backed by | Notes |
|---|---|---|
| `runtime-claude-agent-sdk` | official Claude Agent SDK (TypeScript) | Claude Code's agent loop, tools, and permission modes |
| `runtime-codex-sdk` | official Codex SDK (TypeScript) | Codex threads, sandbox modes, and approvals |
| `runtime-acp` | official ACP SDK, with an agent subprocess | any ACP-speaking agent. This is the generic fallback, not the primary path for Claude or Codex |

Each provider adapts **behavior** to the seam. SDK objects such as sessions,
threads, and events stay native, and only their handles cross the seam
([INV-7](../architecture/invariants.md#inv-7-no-mirrored-protocol-objects)).

## Seam contract

```ts
abstract class AgentRuntimes extends Service {
  // provider registration
  abstract register(provider: AgentRuntimeProvider): Disposable;
}

interface AgentRuntimeProvider {
  readonly kind: string;                                // "claude-agent-sdk", "codex-sdk", "acp:<agent>"
  probe(): Promise<RuntimeEvidence>;                    // installed? authenticated? version? continuable?
  start(spec: RunSpec, signal: AbortSignal): Promise<RunHandle>;
  resume?(handle: NativeHandle, input: TurnInput, signal: AbortSignal): Promise<RunHandle>;
}
```

`RunSpec` carries the objective, the workspace root, the sandbox policy, the
approval policy, and the tool allow-list. All of these come from trusted
envelopes ([INV-6](../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes)).
Each provider maps them onto the agent's own permission or sandbox modes. If a
requested policy cannot be expressed exactly, the run fails. It never loosens.

## Admission evidence

The Worker registry admits an agent-runtime Worker only on evidence from
`probe()` and conformance tests, never because of its name:

- `develop`, `review`, `validate`: a local workspace and a passing tool-use probe;
- `writable-workspace`: the sandbox mode allows writes inside the root only;
- `persistent-conversation`: `resume` exists and passes a resume conformance test.
  This is what qualifies a runtime as a long-lived
  [Team member](teams.md#membership-model-a). AgentOS could not get this from the
  DSH one-shot subagent bridges.

## Turn semantics

- **Idempotency.** Every run is keyed by a logical request id. Where the agent
  writes a local session or rollout record, reconciliation reads it before
  restarting a run (restart is reconciliation, not replay).
- **Completion.** The SDK's terminal event means *provider terminal*, not
  acceptance. The Worker's result is accepted only by the routing layer
  ([INV-3](../architecture/invariants.md#inv-3-completion-boundaries-are-distinct)).
- **Cancellation.** The abort signal is passed to the SDK, and the outcome
  (cancelled, or completed before cancel) is reported.
- **Evidence.** Diffs, commands run, test results, and the final message are
  stored as artifacts with their hashes.
