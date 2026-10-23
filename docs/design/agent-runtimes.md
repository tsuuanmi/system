# Agent runtimes (Claude Code, Codex, ACP agents, the Antigravity CLI as Workers)

> Target state. Seam: `ctx.agentRuntimes` ([plugin model](../architecture/plugin-model.md#seam-catalog)).
> Requirements: REQ-WRK-5, REQ-WRK-6. Decision: [ADR-0009](../decisions/adr/0009-claude-and-codex-first-class.md).
>
> Implemented in [`agent-runtime-core`](../../packages/agent-runtime-core/README.md),
> [`agent-workers`](../../packages/plugins/agent-workers/README.md), and the four runtime
> plugins below; differs from target: `persistent-conversation` rests on the probe's `resume`
> flag, not on a resume conformance test (planned); a started run is never reconciled from the
> agent's own records (it fails as `reconciliation_failed`); evidence beyond the final message
> and the workspace's git subject is not stored; ACP agents cannot ask a
> [tool gate](#tool-gate) before each tool call, so the `agents` source admits none of their
> Workers; the Antigravity CLI gates only on an agy version verified live (1.4.6), and offers no
> sandbox on any other.

An **agent runtime** is an external coding agent that `system` drives as a Worker. It is the
counterpart of the [gateways](gateways.md), where the same agents act as clients. The
`agent-runtimes`, `runtime-claude-agent-sdk`, and `agent-workers` rows are on in the default
composition (PROP-0010 B3), with no Worker until the operator names a repository
([runbook](../operations/runbooks.md#agent-workers)); the Codex, ACP, and Antigravity CLI rows are off
([turn one on](../operations/runbooks.md#turn-an-off-row-back-on)), and the `api-first` preset
turns them on.

## Providers

| Provider plugin | Kind | Backed by | Policy holder |
|---|---|---|---|
| [`runtime-claude-agent-sdk`](../../packages/plugins/runtime-claude-agent-sdk/README.md) | `claude-agent-sdk` | official Claude Agent SDK, on the operator's installed `claude` | exact built-in tools, file tools pre-approved inside the workspace only; `Bash` in `workspace-write` runs only, inside the SDK's sandbox ([confined commands](#confined-commands)); its own home; no settings files, hooks from disk, or MCP servers; the run's tool gate as its one PreToolUse hook |
| [`runtime-codex-sdk`](../../packages/plugins/runtime-codex-sdk/README.md) | `codex-sdk` | official Codex SDK, on the operator's installed `codex` | Codex's own sandbox (read-only or workspace-write); approvals `never`; network, web search, and the features that add unhooked tools off; no terminal; its own Codex home, with no MCP server; the run's tool gate as its one PreToolUse hook, through a private channel ([Codex's gate](#codexs-gate)) |
| [`runtime-acp`](../../packages/plugins/runtime-acp/README.md) | `acp:<name>` | official ACP SDK, with an agent subprocess | the client side: permission requests refused, reads confined to the workspace, no writes or terminals advertised; no tool gate (refused) |
| [`runtime-antigravity-cli`](../../packages/plugins/runtime-antigravity-cli/README.md) | `antigravity-cli` | the operator's installed `agy`, in print mode (stream-json); no SDK exists | its PreToolUse hook, bridged to the run: the runtime's own rules (the sandbox's reading and file-editing tools only, no command; every location inside the workspace), then the run's gate; its own home (`HOME`), with no MCP server, plugin, or other hook, in it or in the workspace; the run's tool gate after its rules, and a sandbox, only on an agy version verified live ([ADR-0043](../decisions/adr/0043-antigravity-cli-workers-gated-on-a-version-verified-live.md)) |

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
  readonly kind: string;                    // "claude-agent-sdk", "codex-sdk", "acp:<name>", "antigravity-cli"
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
  readsConfined: boolean;                   // host state unreadable to the agent, proven now
  gatesToolCalls: boolean;                  // asks RunSpec.toolGate before every tool call
}

interface RunSpec {
  prompt: string;
  workspace: string;                        // absolute root
  sandbox: "read-only" | "workspace-write";
  tools?: string[];                         // allow-list; empty: the minimal set for the sandbox
  model?: string;                           // operator configuration, never a routing input
  maxTurns?: number;
  resume?: string;                          // native handle of a conversation to continue
  toolGate?: ToolGate;                      // asked before every tool call (below)
}

type ToolGate = (call: { tool: string; input: unknown; callId?: string }, signal: AbortSignal) =>
  Promise<{ decision: "allow" } | { decision: "deny"; reason: string }
        | { decision: "defer"; reason: string; requestId: string }>;

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

## Tool gate

The `agents` source gives every run a gate, built from the autonomy policy (`ctx.approvals`), and
the runtime asks it before each tool call the agent makes
([approvals](approvals.md#a-workers-tool-calls): how a call is classified, what each verdict
does, and how a deferred call resumes). The gate comes from the source, never from the agent
(INV-6), and its verdict narrows, never widens, what the runtime's own policy allows: `allow`
passes the call on to that policy, `deny` refuses it with a reason the agent is told, and
`defer` stops the run at the call until the operator answers. A run a gate deferred fails as
`config_error`, naming the request, and a later run of its session makes the call once approved.

A runtime that can ask the gate before every tool call reports `gatesToolCalls`; one that cannot
refuses a run that carries a gate (`config_error`), and its Workers are not admitted. Each gating
runtime asks it with `askToolGate` (agent-runtime-core): bounded at 30 s, and a gate that throws,
answers a verdict the contract does not define, or answers late is a deny. Claude Code compiles
the gate to one PreToolUse hook on every tool, an in-process callback of its SDK. Codex runs a
PreToolUse hook as a command, so its gate goes through a bridge ([below](#codexs-gate)). The
Antigravity CLI also runs a command hook before each tool call, which its runtime bridges to the
run (a socket in an owner-only directory, a per-run token, any failure a deny,
[its README](../../packages/plugins/runtime-antigravity-cli/README.md)): it asks its own rules,
then the gate, and a `defer` is denied and ends the run. agy runs the tool when a hook exits 0
printing nothing, so the command in its `hooks.json` prints a deny itself whenever the run's
hook gives no answer. That agy runs the hook before each tool call takes a model turn to show, so
the runtime reports `gatesToolCalls` (and offers a sandbox) only on an agy version a supervised
live check verified (`VERIFIED_HOOK_VERSIONS`: 1.4.6), whose tool names (`read_file`,
`write_file`, `edit_file`) the `agents` source classifies; on any other version it refuses every
run ([ADR-0043](../decisions/adr/0043-antigravity-cli-workers-gated-on-a-version-verified-live.md)).
An ACP agent asks the client only for what it chooses to, so it does not gate.

### Codex's gate

Codex 0.164 runs PreToolUse hooks as commands, before each tool call, with the call as JSON on
stdin ([ADR-0042](../decisions/adr/0042-codex-workers-ask-the-gate-through-a-hook-bridge.md)).
What it does with a hook was established live on the host, and the bridge is built around it:

| Codex 0.164 | So the runtime |
|---|---|
| a hook from configuration runs only when trusted: the sha256 of its definition's sorted-key JSON is recorded under its key; an untrusted hook is skipped without a word | passes the hook and its trust per run as `--config` overrides (`hooks.PreToolUse`, `hooks.state`), never in a file; no other hook is trusted |
| a hook that exits non-zero (other than 2), prints what Codex cannot read, or times out lets the tool run | ships a hook (`gate-hook.js`, Node built-ins only) that blocks on every failure (exit 2, the reason on stderr) and answers within 90 s, under Codex's 120 s timeout |
| `permissionDecision: allow` and `ask` are refused; a block (`deny`, or exit 2) is the only decision | maps `allow` to no output, so Codex's own sandbox still decides; `deny` to a block with the reason; `defer` to a block with the reason and the request, then ends the run |
| `exec_command` is reported as `Bash` with `command` only; `apply_patch` with the patch as `command`; `view_image` with `path` | lets the gate's table classify them by these names ([approvals](approvals.md#how-a-call-is-classified)) |
| `write_stdin` writes to a running command's terminal without asking a hook; a session without a terminal has its stdin closed | hides `/dev/ptmx` and `/dev/pts` from Codex, so no session gets a terminal (nor reaches the operator's) |
| hosted tools (web search, image generation) run at the model's provider, where no hook sees them; apps, plugins, and subagents add tools or work outside the run | turns web search off and keeps those features off (`FEATURES_OFF`); a configuration that turns one on, or holds `hooks`, is refused |

- **The channel.** Per gated run, the runtime opens a unix socket in a fresh owner-only directory
  under `<DSH_HOME>/system/run`, bound into the run's confinement read-only with the hook script
  and `node`, and a 256-bit key. Codex passes its environment to the hook, which reads the socket
  and the key there (`SYSTEM_CODEX_GATE_SOCKET`, `SYSTEM_CODEX_GATE_KEY`); Codex's own commands
  never get them (`shell_environment_policy.exclude`). The hook sends the key and its input on one
  connection and reads one answer. The bridge denies a wrong key, an input that is not a
  PreToolUse call, a call from another directory than the run's workspace, and any call after a
  defer; it bounds the input (16 MiB), the connections at once (16), and each connection's time.
  The directory, the socket, and the run's launcher are removed when the run ends.
- **A tool that ran past the gate.** Codex reports each tool's work as an item (a command, a file
  change, an MCP call, a web search). Every item a tool produces must be accounted for by a call
  the gate allowed; one that is not (a hook that failed and let the tool run) stops the run, which
  fails as `config_error`. That is detection after one call, not prevention: the probe is the
  prevention.
- **A deferred call.** Codex's hooks cannot end a turn, so the runtime ends the run itself once
  the gate defers: the call is blocked, its reason naming the request is the call's output in the
  thread, every later call is denied, and the Codex process is stopped. A later run of the same
  thread makes the call again; the gate finds the approval for that exact input.
- **The proof.** The probe reports `gatesToolCalls` only after one turn on this host, with the
  run's configuration, hook, and confinement, against a scripted model the probe serves on loopback
  (a random path; no account and no provider is reached; `--ephemeral`): the first request offers
  only tools Codex runs itself; a command the probe's gate denies comes back as the hook's block
  and did not run; a terminal command the gate allows starts no terminal session; and the turn
  ends with the scripted answer. Otherwise `gatesToolCalls: false`, the reason in `detail`, and no
  Codex Worker is admitted. A Codex upgrade that changes any of the above fails the proof, not a
  run.

## Workspaces

A run works in its Worker's configured workspace, unless the Worker is configured with
`worktreePerRun` (PROP-0010 B3). Then each run that belongs to a workflow run (the engine
names it in `WorkerStart.runId`) works in that run's own git worktree of the repository, on
the branch `system/run/<runId>`, never in the repository's main working tree
([INV-15](../architecture/invariants.md#inv-15-one-writer-per-subject)). There is one
worktree per repository and workflow run: the first agent run creates it from the
repository's HEAD, and every later one of that run on that repository works in it, reviewers
included. So exact-subject review and remediation
([workflow engine](workflow-engine.md#exact-subject-gates)) bind to the tree the writer
changed. The provider only sees a `RunSpec` whose workspace is the worktree. A worktree under
the DSH home is bound back like any workspace: writable for `workspace-write`, read-only for
`read-only`. A brief's files (`brief@1.2` `files`, such as a board task's `TASKS.md`) are written
into the run's own worktree before the agent starts, under a `.system/` that git ignores, read-only
and never read back ([TASKS.md in a run's workspace](workflow-engine.md#tasksmd-in-a-runs-workspace));
a run with no worktree of its own gets none.

Worktrees are bounded ([INV-9](../architecture/invariants.md#inv-9-everything-is-bounded)):
once every agent run of a workflow run has finished and the retention has passed, a
`retention` decision ([INV-13](../architecture/invariants.md#inv-13-every-decision-is-an-artifact))
retires the worktree: its changes are committed on its branch and it is removed. A branch is never
deleted, nothing is forced, and a worktree that cannot be committed or removed stays for the
next sweep. The [`agent-workers` README](../../packages/plugins/agent-workers/README.md)
has the configuration and every rule.

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
  any, with plugins and apps off; the Antigravity CLI runs in its own home and fails closed if
  that home, or the workspace's customization roots, configure any, or a plugin or hook of their
  own.
- **Reads** ([ADR-0024](../decisions/adr/0024-agent-workers-confined-for-reads.md)). The host
  state is never readable to an agent. `ctx.agentRuntimes.confinement()` names what to hide
  (the DSH home, the session's runtime directory, the temporary directories, credential
  stores, every path registered with `registerSecretPath`, and operator paths) and what to
  bind back (the operator's tools read-only; the Worker's own home and its workspace as its
  sandbox allows; never a bind that holds a hidden path). Every runtime starts its agent under
  bubblewrap with that confinement (`confinedCommand`: its own PID namespace and session,
  `--die-with-parent`): Codex through an owner-only launcher (`writeLauncher`), ACP agents
  and the Antigravity CLI directly, Claude Code through the SDK's `spawnClaudeCodeProcess`, which wraps the SDK's own
  command line ([ADR-0038](../decisions/adr/0038-confined-commands-for-claude-code-workers.md)).
  Each agent runs in a home of its own (Codex's `CODEX_HOME`, Claude Code's
  `CLAUDE_CONFIG_DIR`, the Antigravity CLI's `HOME`, each under `<DSH_HOME>/system`), never the
  operator's login, which is hidden; the operator signs in there once, and a probe that finds no
  one signed in reports the Worker unavailable ([runbook](../operations/runbooks.md#agent-workers)).
  Codex also runs with the terminal devices hidden ([Codex's gate](#codexs-gate)). Each probe
  reports `readsConfined`, proven positively on the host by `proveConfinement`, and the `agents`
  source checks it again before each run starts.
- **Egress** ([INV-12](../architecture/invariants.md#inv-12-data-egress-is-explicit)). The
  agent runs here, but its model is remote. So the `agents` source checks each prompt with
  `ctx.egress` (Worker class `agent`) before the agent starts, keeps the decision id on the run,
  and fails a denied run as `egress_denied`, never submitted. By default the `agent` class
  receives `public` and `operator-shared` work only, although routing admits `local-private`
  work to a local Worker ([routing](routing.md#data-locality-policy)).

## Confined commands

A Worker proves `validate` only when its runtime runs commands confined to the workspace with no
network (`executes`). Codex runs its commands in its own sandbox, nested in the read confinement.
Claude Code runs them under two confinements
([ADR-0038](../decisions/adr/0038-confined-commands-for-claude-code-workers.md)):

- **Reads, by the host:** the read confinement above, around the whole Claude Code process.
- **Commands, by the SDK's sandbox:** a `workspace-write` run offers `Bash` and enables the
  SDK's sandbox (Anthropic's sandbox runtime, shipped in Claude Code: bubblewrap and a network
  proxy on Linux) with `enabled` and `failIfUnavailable` (a run whose sandbox cannot start
  fails, never runs a command unconfined), `allowUnsandboxedCommands: false`,
  `filesystem.allowWrite` the run's workspace only, and `network.allowedDomains: []` with
  `strictAllowlist`, so a host is refused by the sandbox itself and never asked about. A
  `read-only` run has no `Bash` and no sandbox. An allow list for the network (a package
  registry) would be an egress decision
  ([INV-12](../architecture/invariants.md#inv-12-data-egress-is-explicit)), not a runtime
  default.
- **The proof:** the probe reports `executes: true`, and offers `workspace-write`, only when
  both layers hold on this host: `proveConfinement`, then a nested sandbox start inside the
  confinement (bubblewrap on Claude Code's own PATH, a namespaced `true` with its own network
  and PID namespaces over a read-only root), the check Codex's probe makes with its own
  sandbox. Otherwise `executes: false` and `read-only` only, the reason in `detail` (INV-2):
  its Workers review but never `develop` or `validate` on this host. A `workspace-write` run
  starts the nested sandbox again before Claude Code starts, and is refused (`config_error`)
  when it does not; inside the run, `failIfUnavailable` guards the sandbox Claude Code starts.
- **The policy still decides:** the sandbox bounds where a command acts; the run's
  [tool gate](#tool-gate) decides whether it runs at all, by its exact argv
  ([approvals](approvals.md#a-workers-tool-calls)): a word with a shell metacharacter is
  forbidden, and with the default studio policy any other command asks the operator unless a
  rule lists it.

The Antigravity CLI offers no command tool (`run_command` is denied), so its Workers never
`validate`: agy's own terminal sandbox (`--sandbox`) has no model-free proof.

Commands that need the network (installing packages) fail inside a Worker: dependencies are
prepared in the repository before the run. The sandbox runtime does not claim to stop a kernel
escape ([threat model](../security/threat-model.md#threats-and-controls)).

## Metering

What a run consumed comes from the runtime's own objective numbers, never from the model's text
([resources](resources.md)). A provider reads them from the agent's own messages and reports
them in provider-neutral names (`RunMetering`); a run that fails attaches them to its error
(`withMetering`), so a failed or aborted run is metered too. The provider conformance suite
checks that what a provider reports holds together: input includes its cached part, and
per-model counts sum to the totals. A provider that reports nothing passes. Today the Claude
Agent SDK provider reports usage (from the result's `modelUsage`) and rate-limit observations
([its README](../../packages/plugins/runtime-claude-agent-sdk/README.md)); the Antigravity CLI
provider reports turns, usage from agy's own result (normalized by the one reading whose sum is
agy's total), and the main model when an event names it
([its README](../../packages/plugins/runtime-antigravity-cli/README.md)); the Codex and ACP
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
   skipped. Then the reservation is released. The reservation and the record name the board task
   and project the run's brief serves, if any, so the ledger counts the run against that task's
   budget ([a task's budget](workflow-engine.md#a-tasks-budget)).
4. A run that fails `quota_exhausted` and left no `limited` reading (Codex and the Antigravity
   CLI report no limit observation) closes every window of the pool: a `limited` reading (source
   `limit-notice`) for the Worker's `limitCooldownSeconds`, until a later reading says otherwise.
   A limit is never retried on the same pool unseen ([fail-closed rules](resources.md#fail-closed-rules)).

A run that started before a restart has no result message, so nothing is recorded for it then;
its usage is reconciled from the agent's session transcript later (planned). A Worker with no
pool is not metered, but its limits still hold: a run that fails `quota_exhausted` on one (or on a
metered Worker whose ledger did not take the reading) cools down every Worker of its runtime,
which share the runtime's one home and so its one sign-in. They are `quota-exhausted` until the
reset time the runtime named, else for `limitCooldownSeconds`, at most seven days, across a
restart (event `agent-workers.cooldown`; [agent Workers](../../packages/plugins/agent-workers/README.md)).

## Admission evidence

The Worker registry admits an agent-runtime Worker only on evidence from `probe()`, never
because of its name. A Worker whose runtime is missing, cannot enforce the configured
sandbox, or does not report `readsConfined` and `gatesToolCalls`, is `unavailable`; so is a `worktreePerRun` Worker
whose workspace cannot hold a worktree per run (`config_error`).

| Capability | Offered when |
|---|---|
| `local-data` | the Worker is ready (it runs on this machine, in its workspace) |
| `review` | the sandbox is `read-only`: a review is independent of the change ([INV-15](../architecture/invariants.md#inv-15-one-writer-per-subject)) |
| `develop` | the sandbox is `workspace-write` |
| `validate` | the sandbox is `workspace-write` and the probe reports `executes` ([confined commands](#confined-commands)) |
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
  the workspace the run worked in (with `worktreePerRun`, its [worktree](#workspaces)), and, for a git working tree, its exact subject after the run, which a review
  binds to; with `@1.2`, the run's main model and token usage, in total and per model. Target: diffs, commands run, and test results stored as artifacts with their
  hashes.
