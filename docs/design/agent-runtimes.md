# Agent runtimes (Claude Code, Codex, ACP agents as Workers)

> Target state. Seam: `ctx.agentRuntimes` ([plugin model](../architecture/plugin-model.md#seam-catalog)).
> Requirements: REQ-WRK-5, REQ-WRK-6. Decision: [ADR-0009](../decisions/adr/0009-claude-and-codex-first-class.md).
>
> Implemented in [`agent-runtime-core`](../../packages/agent-runtime-core/README.md),
> [`agent-workers`](../../packages/plugins/agent-workers/README.md), and the three runtime
> plugins below; differs from target: `persistent-conversation` rests on the probe's `resume`
> flag, not on a resume conformance test (planned); a started run is never reconciled from the
> agent's own records (it fails as `reconciliation_failed`); evidence beyond the final message
> and the workspace's git subject is not stored.

An **agent runtime** is an external coding agent that `system` drives as a Worker. It is the
counterpart of the [gateways](gateways.md), where the same agents act as clients. The agent
runtime and agent Worker rows are off in the default composition (PROP-0004); an operator turns
them on ([runbook](../operations/runbooks.md#turn-an-off-row-back-on)), and the `api-first`
preset does.

## Providers

| Provider plugin | Kind | Backed by | Policy holder |
|---|---|---|---|
| [`runtime-claude-agent-sdk`](../../packages/plugins/runtime-claude-agent-sdk/README.md) | `claude-agent-sdk` | official Claude Agent SDK, on the operator's installed `claude` | exact built-in tools, pre-approved inside the workspace only; no settings files, hooks, or MCP servers |
| [`runtime-codex-sdk`](../../packages/plugins/runtime-codex-sdk/README.md) | `codex-sdk` | official Codex SDK, on the operator's installed `codex` | Codex's own sandbox (read-only or workspace-write); approvals `never`; network and web search off; its own Codex home, with no MCP server |
| [`runtime-acp`](../../packages/plugins/runtime-acp/README.md) | `acp:<name>` | official ACP SDK, with an agent subprocess | the client side: permission requests refused, reads confined to the workspace, no writes or terminals advertised |

ACP is the generic path for any ACP-speaking agent, not the primary path for Claude or Codex.

Each provider adapts **behavior** to the seam. SDK objects such as sessions, threads, and
events stay native, and only their handles cross the seam
([INV-7](../architecture/invariants.md#inv-7-no-mirrored-protocol-objects)).

## Seam contract

```ts
abstract class AgentRuntimes extends Service {     // ctx.agentRuntimes
  abstract register(provider: AgentRuntimeProvider): void;  // for the plugin's lifetime
  abstract get(kind: string): AgentRuntimeProvider | undefined;
  abstract list(): string[];
}

interface AgentRuntimeProvider {
  readonly kind: string;                    // "claude-agent-sdk", "codex-sdk", "acp:<name>"
  probe(): Promise<RuntimeEvidence>;
  run(spec: RunSpec, signal: AbortSignal,
      onHandle?: (nativeHandle: string) => void): Promise<RunResult>;
}

interface RuntimeEvidence {
  available: boolean;
  detail: string;                           // the version found, or what is missing
  version?: string;
  sandboxes: ("read-only" | "workspace-write")[];  // policies it can enforce exactly
  resume: boolean;                          // a finished run can be continued by its handle
  executes: boolean;                        // runs commands confined to the workspace
}

interface RunSpec {
  prompt: string;
  workspace: string;                        // absolute root
  sandbox: "read-only" | "workspace-write";
  tools?: string[];                         // allow-list; empty: the minimal set for the sandbox
  model?: string;                           // operator configuration, never a routing input
  maxTurns?: number;
  resume?: string;                          // native handle of a conversation to continue
}

interface RunResult extends RunMetering { text: string; nativeHandle?: string }

interface RunMetering {                     // every field optional: a missing number stays missing
  resultId?: string;                        // the runtime's identity of its result (deduplication)
  model?: string;                           // the main loop's model
  usage?: TokenUsage;                       // the whole run; inputTokens includes cached input
  models?: { model: string; usage: TokenUsage; costUsd?: number }[];  // usage is their sum
  turns?: number;
  costUsd?: number;                         // the runtime's own estimate
  limits?: LimitObservation[];              // rate-limit observations seen during the run
}

interface LimitObservation {
  window: string;                           // the runtime's own window name, opaque (INV-11)
  status: "allowed" | "warning" | "rejected";
  resetsAt?: string;                        // ISO time
  usedPercentage?: number;
  observedAt: string;
}
```

Workers are not providers. The `agents` Worker source
([`agent-workers`](../../packages/plugins/agent-workers/README.md)) turns each configured
Worker into a capability descriptor, a durable run, and a `report` artifact
(`agent-result@1.2` when the runtime reported its token usage, `@1.1` otherwise). The provider
only drives the agent.

The workspace, sandbox, tool allow-list, model, and turn limit come only from operator
configuration ([INV-6](../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes)).
Each provider maps them onto the agent's own permission or sandbox modes. If a requested
policy cannot be expressed exactly, the run is refused (`config_error`). It never loosens.
Codex, for example, refuses a tool allow-list or a turn limit, since it cannot express either.

## Credentials and egress

- **Environment** ([INV-8](../architecture/invariants.md#inv-8-credentials-never-cross-upward)).
  An agent process starts without the daemon's credentials. Every provider builds its child
  environment with `childEnvironment` from `agent-runtime-core`: DSH's own scrub of the daemon
  environment (credential-shaped and `DSH_*` names removed; `PATH`, `HOME`, locale, and proxy
  kept), then the variables the operator forwards **by name** (`forwardEnv`), then explicit
  values (`env`, never a secret). A credential reaches an agent only when the operator names
  it; its value never sits in configuration.
- **No MCP servers.** An agent's MCP servers can run outside its sandbox, and the operator's
  own client configuration holds the `system` MCP server (operator tools such as `approve`).
  So a Worker attaches none: Claude Code takes no settings files and a strict, empty MCP
  configuration; Codex runs in its own Codex home and fails closed if that home configures
  any.
- **Reads** ([ADR-0024](../decisions/adr/0024-agent-workers-confined-for-reads.md)). The host
  state is never readable to an agent. `ctx.agentRuntimes.confinement()` names what to hide
  (the DSH home, the session's runtime directory, the temporary directories, credential
  stores, every path registered with `registerSecretPath`, and operator paths) and what to
  bind back (the operator's tools read-only; the Worker's own home and its workspace as its
  sandbox allows; never a bind that holds a hidden path). A runtime whose own sandbox does not
  confine reads starts its agent under bubblewrap with that confinement (`confinedCommand`:
  its own PID namespace and session, `--die-with-parent`): Codex through an owner-only
  launcher (`writeLauncher`), ACP agents directly. Claude Code's pre-approved tools are scoped
  to the workspace, reads included, so it needs no wrapper. Each probe reports
  `readsConfined`, proven positively on the host by `proveConfinement`, and the `agents`
  source checks it again before each run starts.
- **Egress** ([INV-12](../architecture/invariants.md#inv-12-data-egress-is-explicit)). The
  agent runs here, but its model is remote. So the `agents` source checks each prompt with
  `ctx.egress` (Worker class `agent`) before the agent starts, keeps the decision id on the run,
  and fails a denied run as `egress_denied`, never submitted. By default the `agent` class
  receives `public` and `operator-shared` work only, although routing admits `local-private`
  work to a local Worker ([routing](routing.md#data-locality-policy)).

## Metering

What a run consumed comes from the runtime's own objective numbers, never from the model's text
([resources](resources.md)). A provider reads them from the agent's own messages and reports
them in provider-neutral names (`RunMetering`); a run that fails attaches them to its error
(`withMetering`), so a failed or aborted run is metered too. The provider conformance suite
checks that what a provider reports holds together: input includes its cached part, and
per-model counts sum to the totals. A provider that reports nothing passes. Today the Claude
Agent SDK provider reports usage (from the result's `modelUsage`) and rate-limit observations
([its README](../../packages/plugins/runtime-claude-agent-sdk/README.md)); the Codex and ACP
providers report none.

The `agents` source meters a Worker whose configuration names a resource `pool` (with its
`account`) through `ctx.resources`, following [a run's budget](resources.md#a-runs-budget):

1. The Worker is `quota-exhausted` while its pool is unavailable, so routing skips it; with no
   ledger, or a pool the ledger does not configure, it is `unavailable`.
2. Before the agent starts, the run reserves one run on the pool. The `budget` decision joins
   the run's decisions; a refused reservation fails the run unsubmitted, and nothing runs.
3. After the run, completed or not, one `usage-record` (source `runtime-result`) carries the
   runtime's numbers, and each limit observation becomes a `limit-state` reading of the pool
   window the configuration maps the runtime's window name to (`windows`); an unmapped window is
   skipped. Then the reservation is released.

A run that started before a restart has no result message, so nothing is recorded for it then;
its usage is reconciled from the agent's session transcript later (planned). A Worker with no
pool is not metered.

## Admission evidence

The Worker registry admits an agent-runtime Worker only on evidence from `probe()`, never
because of its name. A Worker whose runtime is missing, cannot enforce the configured
sandbox, or does not report `readsConfined`, is `unavailable`.

| Capability | Offered when |
|---|---|
| `local-data` | the Worker is ready (it runs on this machine, in its workspace) |
| `review` | the sandbox is `read-only`: a review is independent of the change ([INV-15](../architecture/invariants.md#inv-15-one-writer-per-subject)) |
| `develop` | the sandbox is `workspace-write` |
| `validate` | the sandbox is `workspace-write` and the probe reports `executes` |
| `persistent-conversation` | the probe reports `resume`. Target: a resume conformance test passes (planned). This is what qualifies a runtime as a long-lived [team member](teams.md#membership-model-a) |

An agent Worker never offers plain `reason`, so ordinary asks never spend agent-plan quota
([P1](../requirements/purpose.md)).

## Turn semantics

- **Idempotency.** Every run is keyed by a logical request id. Target: where the agent writes
  a local session or rollout record, reconciliation reads it before restarting a run. Today a
  run that started before a stop is never run again: it fails as `reconciliation_failed` and
  names its native session. A run whose lease another process holds is looked at again when
  that lease would expire, so a crashed holder never strands it.
- **Completion.** The SDK's terminal event means *provider terminal*, not acceptance. The
  Worker's result is accepted only by the routing layer
  ([INV-3](../architecture/invariants.md#inv-3-completion-boundaries-are-distinct)).
- **Cancellation.** The abort signal is passed to the SDK, and the outcome (cancelled, or
  completed before cancel) is reported. An agent subprocess that ignores the cancel is ended:
  SIGTERM after a grace period, then SIGKILL, so it cannot hang a run.
- **Evidence.** The result artifact carries the final message, the prompt hash, the sandbox,
  the workspace, and, for a git working tree, its exact subject after the run, which a review
  binds to; with `@1.2`, the run's main model and token usage, in total and per model. Target: diffs, commands run, and test results stored as artifacts with their
  hashes.
