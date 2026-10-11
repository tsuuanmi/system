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
abstract class AgentRuntimes extends Service {     // ctx.agentRuntimes
  abstract register(provider: AgentRuntimeProvider): void;  // for the plugin's lifetime
  abstract get(kind: string): AgentRuntimeProvider | undefined;
  abstract list(): string[];
}

interface AgentRuntimeProvider {
  readonly kind: string;                                // "claude-agent-sdk", "codex-sdk", "acp:<agent>"
  probe(): Promise<RuntimeEvidence>;                    // installed? version? policies it can enforce? resumable?
  run(spec: RunSpec, signal: AbortSignal,
      onHandle?: (nativeHandle: string) => void): Promise<RunResult>;  // RunSpec.resume continues a session
}
```

Workers are not providers. The `agents` Worker source
([`agent-workers`](../../packages/plugins/agent-workers/README.md)) turns each
configured Worker into a capability descriptor, a durable run, and a result
artifact (`agent-result@1.0`). The provider only drives the agent.

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

## Built so far

- `ctx.agentRuntimes`: the definition in
  [`agent-runtime-core`](../../packages/agent-runtime-core/README.md), its
  registry, and both conformance suites.
- The [`agents` Worker source](../../packages/plugins/agent-workers/README.md):
  - Workers are configured as `agent:<id>`, with a workspace, a sandbox, tools,
    and a tier. They are local and use `agent-plan` quota.
  - Capabilities come from `probe()`: `review`, `local-data`, plus `develop` and
    `validate` when writable, plus `persistent-conversation` when resumable.
    `validate` also needs the runtime to execute commands confined to the
    workspace.
    Never plain `reason`, so plain asks never spend the agent plan (P1).
  - Runs are durable, one at a time per Worker. A run started before a stop
    fails as `reconciliation_failed` and names its native session; it is never
    re-run.
- [`runtime-claude-agent-sdk`](../../packages/plugins/runtime-claude-agent-sdk/README.md):
  read-only and workspace-write, with exact tools, no prompts, no settings files,
  and no MCP servers. Writes are pre-approved only inside the workspace. There
  is no Bash yet, so no `validate`.
- [`runtime-acp`](../../packages/plugins/runtime-acp/README.md): any ACP agent,
  with the client side enforcing the policy. Permission requests are rejected,
  reads are confined to the workspace, and nothing is advertised for writes or
  terminals. It offers `read-only` only for agents the operator vouches for.
- The workflow template `review` routes to these Workers by capability.
