# Agent runtimes (Claude Code, Codex, ACP agents, the Antigravity CLI as Workers)

> Target state. Seam: `ctx.agentRuntimes` ([plugin model](../architecture/plugin-model.md#seam-catalog)).
> Requirements: REQ-WRK-5, REQ-WRK-6. Decision: [ADR-0009](../decisions/adr/0009-claude-and-codex-first-class.md).
>
> Implemented in [`agent-runtime-core`](../../packages/agent-runtime-core/README.md),
> [`agent-workers`](../../packages/plugins/agent-workers/README.md), and the four runtime
> plugins below; differs from target: `persistent-conversation` rests on the probe's `resume`
> flag, not on a resume conformance test, or, for a review member's steps on a runtime
> without it, on the source's exact replay; a started run is never reconciled from the
> agent's own records (it fails as `reconciliation_failed` once a liveness verdict finds it gone,
> [restart and liveness](#restart-and-liveness)); only Claude Code reports its agent process, so
> another runtime's started runs reach the operator as `unknown`; its usage is not reconciled from
> the agent's session transcript; evidence beyond the final message
> and the workspace's git subject is not stored; ACP agents cannot ask a
> [tool gate](#tool-gate) before each tool call, so the `agents` source admits none of their
> Workers; the Antigravity CLI gates only on an agy version verified live (1.4.6), offers no
> sandbox on any other, and has no [identity reader](#identity-readers); the Codex and Claude Code
> readers rest on the fields seen on this host and on fixtures, not on PROP-0012 phase A's
> supervised check on the operator's real accounts; and until the operator applies the
> [move from hand-named rows](#migration-from-hand-named-rows) (PROP-0012's migration step 5),
> hand-named Workers run in their runtime's own home, also while its account is `unverified`
> (REQ-ACC-11 holds for derived Workers).

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
  abstract confinement(bind?: { readOnly?: string[]; writable?: string[] }): Confinement;  // the read confinement (below)
}

interface AgentRuntimeProvider {
  readonly kind: string;                    // "claude-agent-sdk", "codex-sdk", "acp:<name>", "antigravity-cli"
  readonly title?: string;                  // its name for people ("Claude Code"), shown only (below)
  readonly home?: string;                   // its own configured home, adopted as slot 1 (below)
  probe(options?: { home?: string }): Promise<RuntimeEvidence>;  // a named home: through probeIn only
  run(spec: RunSpec, signal: AbortSignal,
      onHandle?: (nativeHandle: string) => void,
      observer?: RunObserver): Promise<RunResult>;   // its process and activity (PROP-0013)
  identity?(home: string, key: Uint8Array): Promise<IdentityReading>;  // who is signed in (below)
  loginCommand?(home: string): { command: string; args: string[]; env: Record<string, string> };
  limits?(options: { home?: string }, signal: AbortSignal): Promise<LimitReport>;  // an account's usage report (below)
}

type LimitReport = { limits: LimitObservation[] } | { unreadable: string };  // never a throw

interface RuntimeEvidence {
  available: boolean;
  detail: string;                           // the version found, or what is missing
  version?: string;
  sandboxes: ("read-only" | "workspace-write")[];  // policies it can enforce exactly
  resume: boolean;                          // a finished run can be continued by its handle
  executes: boolean;                        // runs commands confined to the workspace
  readsConfined: boolean;                   // host state unreadable to the agent, proven now
  gatesToolCalls: boolean;                  // asks RunSpec.toolGate before every tool call
  homes?: boolean;                          // runs in the home a run or probe names (ADR-0051)
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
  home?: string;                            // one account's home; refused unless `homes` (ADR-0051)
}

type ToolGate = (call: { tool: string; input: unknown; callId?: string }, signal: AbortSignal) =>
  Promise<{ decision: "allow" } | { decision: "deny"; reason: string }
        | { decision: "defer"; reason: string; requestId: string }>;

interface RunObserver {                     // optional; a callback that throws changes nothing
  onProcess?(process: { pid: number }): void; // the outermost confined agent process, once
  onActivity?(at: number): void;            // the agent did something (a stream event)
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

A provider's `title` (optional, plain text on one line, at most 64 characters, `titleOf`) is the
only place a runtime's product name is written: the roster's display names and the operator's
account listing show it ([display names](roster.md#display-names)); nothing routes on it
([INV-11](../architecture/invariants.md#inv-11-no-tool-lock-in)). Claude Code, Codex, and the
Antigravity CLI give one; an ACP agent, whose kind the operator names, gives none and is shown by
its kind. The provider suite checks a title that is given.

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

### A worktree's setup

> Decision: [ADR-0058](../decisions/adr/0058-a-run-worktree-is-set-up-offline-before-its-agent-starts.md)
> (proposed). Implemented in [`agent-workers`](../../packages/plugins/agent-workers/README.md)
> (`src/setup.ts`).

A new worktree is a checkout, with no dependencies, and a Worker's commands have no network
([confined commands](#confined-commands)). So the operator may declare, per repository, a
**setup** (`worktreeSetup`): commands the `agents` source runs in a workflow run's worktree before
any agent works in it, so the repository's checks can run there offline, from what the host
already holds.

```yaml
worktreeSetup:
  - repository: /home/me/src/project      # a worktreePerRun Worker's workspace
    commands:                             # words split on single spaces; no shell
      - corepack pnpm install --frozen-lockfile --offline --store-dir=/home/me/.local/share/pnpm/store/v11 --package-import-method=copy
    views:
      - { path: /home/me/.local/share/pnpm/store/v11, copy: [index.db, index.db-wal], readOnly: [files] }
    timeoutSeconds: 600
```

- **When.** Before an agent run that works in a workflow run's worktree starts, after the worktree
  is acquired and before the brief's files are written or anything reaches the agent, unless the
  worktree's setup already ran under the definition loaded now (its hash, stored on the worktree).
  So it runs once per worktree and definition, before the first agent run, and a later run,
  reviewers included, works in the worktree as it is; a changed definition runs again; a worktree
  added again from its branch is set up again. One setup at a time per worktree. A run of no
  workflow run works in the configured workspace and gets none.
- **The policy allows each command**, by its exact argv, as it does a Worker's `Bash` call
  ([approvals](approvals.md#a-worktrees-setup)): `forbid` refuses the setup, `auto` and `notify`
  run the command, and `ask` waits on one request per command bound to the worktree and the setup's
  hash, used once. With no queue loaded, nothing runs.
- **Confined.** Each command runs under the read confinement with more: the host's file system
  read-only except the worktree (`confinedCommand`'s `readOnly`), no network but its own loopback
  (`network: false`), the worktree as its directory, a private `/tmp` as its `TMPDIR`, its own PID namespace and
  session, the daemon's scrubbed environment (`childEnvironment`), and the setup's deadline
  (SIGKILL; bubblewrap takes the namespace with it). The confinement is proven on the host
  (`proveConfinement`) before each setup.
- **Views.** A host directory the setup must write, though its content must stay the host's (a
  package store whose index is a database opened for writing), is a view: the setup sees, at its
  path, a fresh private directory under `<worktreeRoot>/.setup`, with the files `copy` names copied
  in (as themselves, never through a link, at most 1 GiB each; a file the host lacks is not copied)
  and the paths `readOnly` names bound back read-only; it is removed when the setup ends. A view
  of, or holding, a path hidden from agents, one reached through a link, or one overlapping the
  worktree is refused. Since the store is read-only and on another mount, the installer copies into
  the worktree and never links: a Worker that writes its worktree cannot change the host's store.
- **Fails closed** ([INV-2](../architecture/invariants.md#inv-2-fail-closed)): a setup not allowed,
  waiting for an approval, or failing (a command's exit code or signal, the deadline, a view or the
  confinement refused) fails the run as `config_error`, unsent, its message naming the command and
  the last part of its output. It is never skipped: the next run of the workflow run tries again.
- **Recorded** ([INV-13](../architecture/invariants.md#inv-13-every-decision-is-an-artifact)): a
  `gate` decision of rule `agent-workers.worktree-setup` (`start`, or `refuse` with why; its inputs
  the policy's decisions and the approvals used; its detail the worktree, the setup's hash, and the
  failed command), named among the run's decisions, and an `agent-workers.worktree.setup` event
  (`ran`, `refused`, or `waits`).
- **Checked at load:** a setup for a repository no `worktreePerRun` Worker works in, two for one
  repository, a command a policy could not list (empty word, shell metacharacter, over 200
  characters), more than 16 commands, or a view with a relative path, a name that is not plain, or
  a path that climbs is refused (`config_error`).

What the setup writes stays in the worktree. Files the repository ignores (`node_modules/`) are not
in the run's subject, and go with the worktree at its retention.

Worktrees are bounded ([INV-9](../architecture/invariants.md#inv-9-everything-is-bounded)):
once every agent run of a workflow run has finished and the retention has passed, a
`retention` decision ([INV-13](../architecture/invariants.md#inv-13-every-decision-is-an-artifact))
retires the worktree: its changes are committed on its branch and it is removed. A branch is never
deleted, nothing is forced, and a worktree that cannot be committed or removed stays for the
next sweep. The [`agent-workers` README](../../packages/plugins/agent-workers/README.md)
has the configuration and every rule.

The retention reads the agent runs only, never the board: a task's attempt ends its runs, and its
worktree retires `worktreeRetentionHours` after the last of them ended, whether the attempt failed
or its result was accepted, rejected, or is still held for the operator's review. Until then each
attempt keeps a worktree of its own.

### The operator's removal of run worktrees

The operator sees every worktree not removed yet with `agent_worktrees` (operator scope,
`mcp-agent-runs@1.1`; `system worktrees`): its workflow run, branch, state (`in-use` while an agent
run of its workflow run is queued or running, `held` while one ended without being known to be
gone, `finished` otherwise), what it holds (`clean`, `uncommitted`, `gone`, or `not-intact`), and
when the retention removes it. At most 100, oldest first, with the count of all
([INV-9](../architecture/invariants.md#inv-9-everything-is-bounded)).

With `agent_worktrees_remove` (`system worktrees remove`) they remove the finished ones now instead
of waiting, every one or one workflow run's:

- **Never discarding a change.** A worktree is removed only while it is `finished` and holds nothing
  uncommitted, or, with `commitChanges`, once its changes are committed on its branch as the
  retention commits them. One in use or held stays (a held run is freed first, [freeing what a run
  holds](#freeing-what-a-run-holds)), and so does one not intact: git is not run there. The branch
  always stays; nothing is forced.
- **Recorded first** ([INV-13](../architecture/invariants.md#inv-13-every-decision-is-an-artifact)):
  one `retention` decision of the operator's (decider `operator.worktrees`, not deterministic, the
  note as its rationale) names every worktree planned for removal, and is stored on each one
  removed. With none to remove, nothing is decided. Each is looked at again alone before it is
  removed, as the retention does, so one an agent run took meanwhile stays.
- **Bounded:** at most 50 worktrees a call; the output says how many it did not look at.
- **Its output is checked on its plan before anything is decided**: an output its schema refuses
  (a defect) decides and removes nothing.

### Landing a worktree

> Decision: [ADR-0060](../decisions/adr/0060-an-accepted-result-lands-on-the-operators-merge-approval.md)
> (proposed). Implemented in [`agent-workers`](../../packages/plugins/agent-workers/README.md)
> (`src/worktrees.ts`); the engine asks ([landing an accepted result](workflow-engine.md#landing-an-accepted-result)).

The `agents` source answers `land(step)` on the `workers` seam for the worktrees it holds, one change
at a time per repository, as every worktree change:

- **`commit`**: only while no agent run of the workflow run is unfinished or not known to be gone
  (else it waits: INV-15), only while the worktree is intact and on its branch, and only while it is
  still the accepted subject (`git:<HEAD>:<hash of every change on top>`, captured again after
  `.system/` is removed as the retention removes it). Then `git add --all` and one commit by
  `system <system@localhost>`, with the engine's message and a `System-Subject` trailer naming the
  accepted subject. A tree that moved is refused, and nothing is committed. A clean worktree whose
  HEAD is that commit, on top of the accepted HEAD, is found committed (a restart). The answer names
  the branch's head, the repository's checked-out branch and its head (the base), whether the base
  already holds the head, and the `git diff --stat` against it.
- **`merge`**: only while the branch is at the approved head, the repository has the approved base
  branch checked out at the approved base, and its tracked files are clean; then `git merge --no-ff`
  of the branch, the system its author, hooks off as for every git call. A base that already holds
  the head is found merged (a restart). A conflict is aborted (`git merge --abort`) and the
  repository checked to be as it was. Nothing is forced, reset, deleted, or pushed.

So the repository's main working tree is written only by a merge the operator approved, or the
policy allowed, at the exact SHAs it was asked on. The worktree itself stays until the retention
removes it; it is clean then, and its branch always stays.

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
  Every confined command (an agent and everything it starts, a probe, a worktree's setup) has a
  temporary directory of its own: a fresh tmpfs at `/tmp`, never the host's, which `TMPDIR`,
  `TMP`, and `TEMP` name whatever the daemon's own are (`confinedCommand`, T113), so a tool's
  temporary files and unix sockets (a test runner's IPC pipe) land there and go with it.
  Each agent runs in a home of its own (Codex's `CODEX_HOME`, Claude Code's
  `CLAUDE_CONFIG_DIR`, the Antigravity CLI's `HOME`, each under `<DSH_HOME>/system`), never the
  operator's login, which is hidden; the operator signs in there once, and a probe that finds no
  one signed in, or cannot tell (a status it cannot read is no sign-in), reports the Worker
  unavailable ([runbook](../operations/runbooks.md#agent-workers)).
  Several accounts per runtime each get a home of their own (an enrollment slot), and a run binds
  back only its own account's home ([agent accounts](#agent-accounts)).
  Codex also runs with the terminal devices hidden ([Codex's gate](#codexs-gate)). Each probe
  reports `readsConfined`, proven positively on the host by `proveConfinement`, and the `agents`
  source checks it again before each run starts.
- **Egress** ([INV-12](../architecture/invariants.md#inv-12-data-egress-is-explicit)). The
  agent runs here, but its model is remote. So the `agents` source checks each prompt with
  `ctx.egress` (Worker class `agent`) before the agent starts, keeps the decision id on the run,
  and fails a denied run as `egress_denied`, never submitted. By default the `agent` class
  receives `public` and `operator-shared` work only, although routing admits `local-private`
  work to a local Worker ([routing](routing.md#data-locality-policy)).

## Agent accounts

> Decision: [ADR-0051](../decisions/adr/0051-agent-accounts-are-enrolled-slots-identified-by-their-login.md)
> (proposed), from [PROP-0012](../proposals/0012-agent-accounts.md). Built: the seam's additions,
> their suite, and a fake that passes it (phase B); identity readers for Codex and Claude Code,
> runs and probes in a named home, enrollment slots, quarantine, and `enrollment` decisions
> (phase E); Workers derived as account × role, per-account concurrency, load, and pools, and the
> move from hand-named rows (phase F). Differs from target: the readers rest on the fields seen on
> this host and on fixtures, not yet on phase A's supervised check on the operator's accounts
> ([below](#identity-readers)); and until the operator applies the move
> ([below](#migration-from-hand-named-rows)), hand-named Workers keep running in their runtime's
> own home, also while its account is `unverified` (REQ-ACC-11 holds for derived Workers: the
> hand-named ones keep their behaviour until the cutover, PROP-0012's migration step 5).

Several sign-ins per runtime are told apart by who is signed in, never by a name:

- **Slots are homes.** An enrollment slot is an owner-only home under the DSH home,
  `<DSH_HOME>/system/agent-homes/<provider>/<n>`, hidden from every agent child; slot 1 adopts the
  runtime's own home where it is ([below](#enrollment-and-quarantine)). A run binds back only its
  own account's home. The slot's number never names, orders, or identifies an account.
- **`RunSpec.home` and `probe({ home })`.** A provider that runs in a named home reports `homes`.
  One that does not refuses a run naming a home (`config_error`) before anything runs, never runs
  it in its own home instead; and `probeIn(provider, home)` asks a named home only of a provider
  whose own probe reports `homes`, else the evidence is unavailable. Codex and Claude Code report
  `homes`: a named home must already be an owner-only directory of this user (`homeProblem`; it is
  never made by a run or a probe), and it then stands for the runtime's own home everywhere (the
  environment variable, the bind back, the MCP and sign-in checks). The ACP runtime and the
  Antigravity CLI run in their own home only. A provider may also name its own configured home
  (`home`, optional), which a Worker source adopts as slot 1.
- **`identity(home, key)`** reads who is signed in to that home, under the same confinement as a
  run, and returns:

  | Status | When | Carries |
  |---|---|---|
  | `verified` | the runtime's own sign-in check passes and the reader reads the principal whole, on a CLI version a supervised check verified | `hmac` (`identityHmac`: HMAC-SHA256 keyed by the per-install key, over the provider and the principal's parts in canonical order), `reader`, `runtimeVersion`, a masked `hint` (`maskEmail`) |
  | `missing` | no sign-in in the home | why |
  | `ambiguous` | the principal cannot be read whole | why |
  | `unverified` | no reader is verified for this runtime or its version | why, the version |

  No token and no raw principal leaves the provider
  ([INV-8](../architecture/invariants.md#inv-8-credentials-never-cross-upward)); a home it cannot
  read is a reading, never a throw. The account id is `accountIdOf(provider, hmac)`,
  `<provider>:<first 16 hex characters>`; the full HMAC is what is compared
  ([`agent-account`](../reference/schemas.md#agent-account)).
- **`loginCommand(home)`**: the runtime's own sign-in command for that home (for example
  `CODEX_HOME=<home> codex login`), which the operator runs in their own terminal; its environment
  names the home and sets no session bus, so the sign-in lands in the home's own files, where a run,
  which starts without D-Bus, reads it. The daemon runs no interactive sign-in.
- **Conformance** (`agentRuntimeIdentityConformance`, for a provider that reads identity): one
  login gives one HMAC across reads, a restart, and a re-login; two logins two; one login in two
  homes one (a duplicate the caller quarantines); another key another; a signed-out, never
  signed-in, or absent home is never `verified`; the reading holds no principal; the sign-in command
  names the home and no session bus; a run in a named home runs, and a relative one is refused.
  Every provider also passes the provider suite's refusal of a home it does not run in.
  `FakeAgentRuntime` (scripted homes) passes both.
- **One account, every role** (PROP-0012 phase C). The Workers of one account are its
  `siblings`: a derived Worker's account is its own ([below](#workers--account--role)); hand-named
  Workers run in their runtime's one home, so all of a runtime's are one account, whose
  `account.id` is the runtime. A cooldown or a closed pool of any of them holds them all
  (`quota-exhausted`, with `limitUntil` the latest reset), a failover leaves them all out, and a
  team counts them as one account ([distinct accounts](teams.md#distinct-accounts)). A session
  stays on its one Worker.

### Identity readers

Each reader reads only the fields it names, from files of the home it is given, opened without
following a link (a run can write its own home) and bounded in size (`readHomeJson`), after the
runtime's own sign-in check in that home under the read confinement and with none of the
operator's forwarded variables. Only the keyed hash (and a masked email) leaves the runtime.

| Runtime | Reader | Pinned to | Sign-in check | Principal (hashed) | Hint |
|---|---|---|---|---|---|
| `codex-sdk` | `codex-auth-json` | Codex 0.164.0 | `codex login status` says `Logged in using ChatGPT` (an API-key sign-in names no person: `ambiguous`) | `tokens.account_id` of `auth.json`, the ChatGPT account id | none (the email is only in the id token, which is never read) |
| `claude-agent-sdk` | `claude-state-file` | Claude Code 2.1.308, 2.1.309, 2.1.310 | `claude auth status` says `loggedIn`, and the home keeps that sign-in in its own `.credentials.json` (existence only; elsewhere is `unverified`) | `oauthAccount.accountUuid` and `oauthAccount.organizationUuid` of `.claude.json`, both whole (never the email alone) | `oauthAccount.emailAddress`, masked |
| `antigravity-cli` | none | — | — | no file or command was shown to name the signed-in Google account: no account of it can be enrolled (one enrolled before reads `unverified`) | — |

- **Version-pinned** as agy's hook is ([ADR-0043](../decisions/adr/0043-antigravity-cli-workers-gated-on-a-version-verified-live.md)):
  `VERIFIED_IDENTITY_VERSIONS` in each runtime; on any other version a reading is `unverified`,
  and its reason names the version found, the executable, and the versions the reader admits
  (Claude Code: `found Claude Code 2.1.311 (<executable>); its identity reader admits only
  2.1.308, 2.1.309, 2.1.310`). A pinned executable that is no longer there (Claude Code's updater prunes old
  versions under `~/.local/share/claude/versions`) is named as such, with where to keep a checked
  copy (`~/.dsh/system/tools/claude/<version>/`, bound back read-only to every agent as Codex's
  executable is; [runbook](../operations/runbooks.md#keep-claude-codes-pinned-version)); the
  probe says the same.
- **The Antigravity CLI has no reader.** agy 1.4.6 keeps its sign-in under
  `~/.gemini/antigravity-cli` in its own `HOME`, and no file or command was shown to name the
  signed-in Google account without reading its token (PROP-0012 open question 1). Finding one needs
  a supervised check on a signed-in throwaway home, field names only, as agy's hook was checked; it
  was not done (T103). So no account of it can be enrolled
  ([below](#enrollment-and-quarantine)).
- **Evidence.** The file and field names were seen on this host (two Codex
  homes signed in as two accounts showed two `tokens.account_id`; values were never read into any
  record), and each reader is tested against redacted fixtures of that shape and passes the
  identity suite. Claude Code 2.1.309 and 2.1.310 were checked against 2.1.308 from their binaries
  (2026-10-24, T101): every unit of code the reader relies on (`auth status`'s JSON, the config
  directory, the credentials and state file paths, the `oauthAccount` writer) is the same but for
  minified names, and `--version` and a signed-out `auth status` in a throwaway home answer as
  2.1.308's. **Phase A's supervised check on the operator's real accounts is still owed**: that
  each id stays equal across a restart, a token refresh, and a re-login, and differs for two
  accounts, on the pinned versions. Until it is done the pins rest on the shapes seen, not on that
  check.
- **A Codex workspace plan** shares its ChatGPT account id among its members (PROP-0012 open
  question 3): two such homes read as one principal, which enrollment quarantines as `duplicate`,
  the safe side.

### Enrollment and quarantine

The `agents` source ([`agent-workers`](../../packages/plugins/agent-workers/README.md)) keeps each
slot as an `agent-account@1.x` record and every change of what a slot holds as an `enrollment`
decision, recorded before the record changes, in one transaction with it; inputs are the slot's
earlier decision, never the principal
([INV-13](../architecture/invariants.md#inv-13-every-decision-is-an-artifact)). A quarantine
says what its reading found (`quarantine.detail`, `agent-account@1.1`: the decision's reason, for
`unverified` the version found and the ones admitted), so health, `system account list`, the
roster, and a refused run name it, not only the reason.

- **Slots.** A runtime has `slots` (on its `agent-workers` `providers` entry, default 1, at most
  64). Slot 1 is the runtime's own configured home, adopted where it is; slot `n` is
  `<accountHomes>/<runtime>/<n>` (default `<DSH_HOME>/system/agent-homes`), made owner-only when
  taken. Both are under the DSH home, hidden from every agent child.
- **The key** of the ids is 32 random bytes made once in the credential vault (record
  `system-agent-workers/identity-key`), under its lock, and never made again: no vault, or a key of
  another length, and nothing is read. Losing it changes every id; it is backed up with the vault.
- **`system account login <runtime>`** (MCP `account_enroll`, step `begin`): take the lowest free
  slot (or the one named), record it `enrolled`, and return the runtime's `loginCommand` for its
  home, which the CLI runs in the operator's terminal without D-Bus; the daemon runs no interactive
  sign-in. A runtime with no `identity` takes no free slot (`config_error`, nothing made or
  recorded): its account could only ever be `unverified` and take no derived work, and adopting its
  home would hold the hand-named Workers running there while the slot is `enrolled` (fail closed
  before acting, [INV-2](../architecture/invariants.md#inv-2-fail-closed)). A slot taken before
  (an earlier release) can still be signed in again and verified. Then step `verify` reads the
  identity and records the status:

  | Reading | Status |
  |---|---|
  | `verified`, equal to the pinned principal (or none pinned), held by no other slot of the runtime | `ready` |
  | `missing` | `signed-out` |
  | `verified`, another principal than the pinned one | `quarantined`, `changed` (the pinned account stays on the record; `--accept` takes the new one as a new account) |
  | `verified`, the same full hash as another slot | both `quarantined`, `duplicate` |
  | `verified`, another slot's short id under a different full hash | both `quarantined`, `ambiguous` |
  | `ambiguous` | `quarantined`, `ambiguous` |
  | `unverified`, or a runtime with no `identity` (a slot taken before) | `quarantined`, `unverified` |

- **Output checked before it commits.** The account tools check the output a call that changes
  anything would give against `mcp-agent-accounts@1.2` before the change commits (a slot taken, a
  reading recorded, a slot freed, a cutover applied or rolled back): an output its schema refuses
  is a defect, refused with nothing changed, never reported after the work is done.

- **Read again** at each probe of the runtime (every `ready` account; an account home's probe,
  that home's), which runs in the background every half `probeTtlMs`
  ([admission evidence](#admission-evidence)), and before each run (the account in the run's home). A re-read only takes away: a changed principal is quarantined, a
  missing one signed out, each recorded first; it never lifts a quarantine or a sign-out, and never
  quarantines a peer. Only the operator's `verify` (or `login`) does.
- **Who takes work.** A Worker derived as account × role takes work only while its account is
  `ready` ([below](#workers--account--role)). Hand-named Workers, until the operator applies the
  move ([below](#migration-from-hand-named-rows)), run in their runtime's own home, slot 1's. They
  take work while no slot holds that home (as before enrollment), while its account is `ready`, or
  while it is `unverified` (the runtime has no verified reader, so nothing better was known before
  enrollment either; never beyond slot 1). Enrolled and not yet verified, signed out, or
  quarantined `changed`, `ambiguous`, or `duplicate`, they read `unavailable` with the reason, and a
  run already queued fails before anything is sent (`config_error`).
- **Removal** (`account_remove`) records `removed` and frees the slot; its home and the sign-in in
  it are kept.
- **Health** (`agent-accounts`) names every account that is not `ready`, with its status and why;
  `system account list` (MCP `account_agents`) lists each slot beside the website accounts, with
  the Workers that run on it.
- **An event** for a slot newly quarantined, or quarantined for another reason:
  `agent-workers.account.quarantined` names the provider, slot, account id, reason, and the
  Workers that take no work, with the `enrollment` decision, never the principal or its hint; a
  [notification](notifications.md) reads it. A failed append is logged; the change stands.

### Workers = account × role

PROP-0012 phase F ([ADR-0051](../decisions/adr/0051-agent-accounts-are-enrolled-slots-identified-by-their-login.md)).
The `agent-workers` row names no Worker by hand: it defines **roles** once, and **assigns** each
enrolled account its roles, by the id its login was verified as. The assignment is configuration,
the trusted envelope of account choice
([INV-6](../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes)).

```yaml
- id: agent-workers
  config:
    providers:
      - { provider: claude-agent-sdk, slots: 2, maxConcurrentRunsPerAccount: 1, pool: claude-plan, windows: { five_hour: five-hour } }
      - { provider: codex-sdk, slots: 2 }
    roles:
      - id: review
        workspace: /home/me/src/project
        sandbox: read-only
        tier: standard
        runtimes: { claude-agent-sdk: { maxTurns: 4 } }
    assignments:
      - { account: "claude-agent-sdk:1f0c2b7e9a5d3c41", roles: [review], label: science }
      - { account: "codex-sdk:04aa5c1e9b7d3f20", roles: [review] }
```

- **A role** holds what the work needs (workspace, sandbox, tier, quota class, `worktreePerRun`,
  `reviewMember`, and the `kinds` of work its Workers take,
  [work kinds](routing.md#work-kinds)) and, under `runtimes.<runtime>`, what differs per runtime
  (`tools`, `model`, `maxTurns`, `family`), never a routing input. So which runtime takes a kind
  of work is the assignments': a role `code` given `kinds: [code]` and assigned to one runtime's
  accounts keeps source-code steps on them (ADR-0057).
- **The Worker** of an account in a role is `agent:<accountId>/<role>`, derived (a pure function of
  the configuration: the same roles and assignments always give the same Workers). Its runtime is
  the account's provider, its family the role's `family` for that runtime or the runtime, its
  capabilities what the probe proves in its account's home. An account with no assignment has no
  Worker; an assignment naming an account that is not `ready` (no slot holds it, not verified,
  signed out, or quarantined, `unverified` included) derives a Worker that reads `unavailable` with
  the account's reason, and probes nothing.
- **An account's label** (`assignments[].label`, optional, plain text on one line, at most 64
  characters) is the operator's name for the account, such as `science` or `lead`, for people
  only: the roster's display name (`Claude Code · science · review`,
  [display names](roster.md#display-names)), the Workers tab, and `system account list` show it.
  It is never a routing input, never part of a Worker id, and never kept on the account's record;
  changing it changes no id: ids stay stable keys, and the meaning goes in a display name.
- **Its account's home.** Runs and probes name the account's home (`RunSpec.home`, `probeIn`),
  none when it is the runtime's own (slot 1); the account is read again before each run, as the
  sandbox proof is.
- **Per account** (the `agents` source does for agent accounts what `turns` does for website
  accounts):
  - one scheduler per account runs `maxConcurrentRunsPerAccount` (on the provider, default 1, at
    most 16) of its runs at once across its roles, on top of one run at a time per Worker; in-process,
    since one daemon owns the runs ([INV-1](../architecture/invariants.md#inv-1-one-authoritative-runtime));
  - each Worker reports its account's `load`: `running` and `queued` across the account's Workers,
    `pending` admissions (counted by the source's `reserve` from routing until the run is started),
    and `slots`; it reads `busy` while `running` reaches `slots`, so least-busy routing
    ([ADR-0033](../decisions/adr/0033-least-busy-routing.md)) prefers a less busy account;
  - `siblings` are the account's Workers; a limit's cooldown, and a closed pool, hold the account.
- **Pools per account.** The provider's `pool` names a template of the resources row
  ([pool templates](resources.md#pool-templates)): each account's Workers draw on its own pool
  `<pool>/<accountId>`, with the provider's `windows` (once per provider, not per Worker) and
  `limitCooldownSeconds`. The source declares its ready assigned accounts of metered providers to
  the ledger (`declare`); without that pool its Workers are `unavailable`. A limit on one account
  never closes another's.

Hand-named Workers (`workers`) are the shape before phase F; one row holds one shape or the other.

### Migration from hand-named rows

`system account migrate` (MCP `account_migrate`, operator scope;
[runbook](../operations/runbooks.md#migrate-agent-workers-to-accounts--roles)) moves the hand-named
Workers to derived ones. It plans by default and changes nothing; `--apply` applies the plan;
`--rollback` undoes it.

- **The plan** (rule `agent-workers.migration` version 3, pure): each runtime's configured home is slot 1 of
  its provider, adopted where it is; rows that agree on the work's settings (their `kinds`
  included) become one role
  (`review` when read-only, `develop` when writing; another of a kind `review-2`, …; a second row of
  one runtime starts another role), with what each runtime set under `runtimes`, the rows' `kinds`,
  and their `description` when every row of the role gives the same one (none otherwise: a role's
  description is every one of its Workers', version 3); the account in
  slot 1 is assigned the roles of its runtime's rows, by its verified id; an old `pool` becomes the
  provider's pool template, with its windows and cooldown; and `maxConcurrentRunsPerAccount` is the
  number of the runtime's rows, so as many of its runs run at once as did. The live patch's
  `claude-research`, `codex-review`, and `agy-review` become one role `review`, with `maxTurns: 4`
  for Claude Code and the model for the Antigravity CLI.
- **What stops it** (each named, with what to do): a runtime not registered; no account in slot 1
  (enroll it first); slot 1 not the runtime's own home; an account not `ready`; rows of one runtime
  drawing on different pools, windows, or cooldowns; a pool the ledger does not configure. A
  runtime with no identity reader (the Antigravity CLI), whose account cannot be enrolled, and an
  `unverified` account (a slot taken before) wait: the cutover waits for its reader, unless the
  operator stops that runtime's Workers at the cutover (`--stop <runtime>`; PROP-0012 open
  question 1, as proposed). A stopped runtime's role keeps what it set for it, for the assignment
  the operator adds once its account can be verified.
- **Its output is checked first.** The tool's output (`mcp-agent-accounts@1.2`) is checked inside
  the apply's or the rollback's transaction, after every write and before the commit: an output
  its schema refuses is a defect, and the call is refused with nothing decided or moved (before
  1.2, a plan whose roles had `kinds` was refused only after an apply had committed).
- **Apply**, refused while a run of a hand-named Worker is queued or running (drain first), in one
  transaction: an `enrollment` decision per hand-named Worker (`migrated` to its new id, its input
  the account's latest enrollment decision, or `stopped`); each of its agent sessions and runs moved
  to its new id, so a continued session stays on its account and in its home; and the cutover's own
  `enrollment` decision (`applied`, its inputs the moves'). Applying again changes nothing.
- **The cutover.** Until the move is applied, both shapes load, and hand-named Workers route and
  run exactly as before this phase: no load, the runtime as the account, one run at a time per
  Worker, no pool declared (tested). Once it is applied, hand-named Workers still loaded take no
  work and start nothing, and a row that names any is refused at load with the path, the decision,
  and the way back (`config_error`, REQ-HOST-2). The operator puts the printed row in the profile
  patch and restarts.
- **Rollback**, refused while a run of a Worker it moved to is queued or running: each session and
  run moved goes back to its hand-named Worker (one moved again since stays), the refusal is
  lifted, and a `rolled-back` decision is recorded, its input the cutover's. Then the old row loads
  again. Results, usage records, and decisions keep the Worker ids they were written with, and
  still explain; the `workerSessions` records of team members are not moved.

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
prepared before the run, in a worktree by its repository's [setup](#a-worktrees-setup), offline
from what the host holds.

Commands that listen on a unix socket fail inside a Worker too, whatever the directory: both
command sandboxes refuse unix sockets on Linux by a seccomp filter (`EPERM`), the SDK's unless
`network.allowAllUnixSockets` (which the SDK's settings describe as disabling that blocking) and
Codex's as part of its no-network sandbox (from its documented design; not re-checked live). The
`tsx` CLI is one: it opens an IPC pipe in its temporary directory (`/tmp/tsx-<uid>/<pid>.pipe`)
for every script, so a repository check started through it fails as
`listen EPERM: operation not permitted` (T113). The private `/tmp` above is not the cause and
does not lift it. Allowing unix sockets would let a command reach any socket the confinement
leaves visible (a container engine's, a system bus), a loosening of ADR-0038 that needs its own
decision, so none is made: such a check runs outside the Worker, or the repository starts its
scripts without a unix socket, as this one does: `node --import tsx <script>` registers tsx's
loader in the process and opens no socket, where the `tsx` CLI listens on its pipe. (A worktree's setup runs under the read confinement alone, so its
commands can listen on one.) The sandbox runtime does not claim to stop a kernel escape
([threat model](../security/threat-model.md#threats-and-controls)).

## Metering

What a run consumed comes from the runtime's own objective numbers, never from the model's text
([resources](resources.md)). A provider reads them from the agent's own messages and reports
them in provider-neutral names (`RunMetering`); a run that fails attaches them to its error
(`withMetering`), so a failed or aborted run is metered too. The provider conformance suite
checks that what a provider reports holds together: input includes its cached part, and
per-model counts sum to the totals. A provider that reports nothing passes. The Claude
Agent SDK provider reports usage (from the result's `modelUsage`) and rate-limit observations
([its README](../../packages/plugins/runtime-claude-agent-sdk/README.md)); the Antigravity CLI
provider reports turns, usage from agy's own result (normalized by the one reading whose sum is
agy's total), and the main model when an event names it
([its README](../../packages/plugins/runtime-antigravity-cli/README.md)); the Codex and ACP
providers report no usage. Codex and the Antigravity CLI report a usage limit's reset time
([limit readings](#limit-readings)).

The `agents` source meters a Worker that draws on a resource pool through `ctx.resources`: a
hand-named Worker whose configuration names a `pool` (with its `account`), or a derived Worker of a
provider that names a pool template (its account's pool,
[above](#workers--account--role)). It follows [a run's budget](resources.md#a-runs-budget):

1. The Worker is `quota-exhausted` while its pool is unavailable, so routing skips it; with no
   ledger, or a pool the ledger does not configure, it is `unavailable`.
2. Before the agent starts, the run reserves one run on the pool. The `budget` decision joins
   the run's decisions; a refused reservation fails the run unsubmitted, and nothing runs.
3. After the run, completed or not, one `usage-record` (source `runtime-result`) carries the
   runtime's numbers, and each limit observation becomes a `limit-state` reading of the pool
   window the configuration maps the runtime's window name to (`windows`); an unmapped window is
   skipped. Before the record, a derived Worker's account's own usage report is read once, and its
   observations recorded after the run's ([an account's usage report](#an-accounts-usage-report)).
   Then the reservation is released. The reservation and the record name the board task
   and project the run's brief serves, if any, so the ledger counts the run against that task's
   budget ([a task's budget](workflow-engine.md#a-tasks-budget)).
4. A run that fails `quota_exhausted` and left no `limited` reading (neither its runtime nor the
   account's usage report read after it gave a reset time, or the ledger could not place one)
   closes every window of the pool: a `limited` reading (source `limit-notice`) for the Worker's
   `limitCooldownSeconds`, until a later reading says otherwise. A limit is never retried on the
   same pool unseen ([fail-closed rules](resources.md#fail-closed-rules)).

A run that started before a restart has no result message, so nothing is recorded for it then;
its usage is reconciled from the agent's session transcript later (planned). A Worker with no
pool is not metered, but its limits still hold: a run that fails `quota_exhausted` on one (or on a
metered Worker whose ledger did not take the reading) cools down every Worker of its account (for
hand-named Workers, every Worker of the runtime, which share its one home and so its one sign-in).
They are `quota-exhausted` until the
reset time the runtime named (in the run, or in the account's usage report read after it), else for
`limitCooldownSeconds`, at most seven days, across a restart (event `agent-workers.cooldown`;
[agent Workers](../../packages/plugins/agent-workers/README.md)).

A metered run whose usage the ledger could not count (its runtime reported neither tokens nor
turns, the host stopped while it ran, or the ledger refused or failed its record) is recorded as
one `usage.unknown` event, a cap counting it as 0 until a record of it is counted
([usage the ledger cannot count](resources.md#usage-the-ledger-cannot-count)). A record refused
as `invalid` with a per-model split is first offered again with its totals alone.

### Limit readings

A limit is waited out until the reset its runtime names, so each runtime reads the reset from what
the installed agent itself reports, never from the model's text, and only on a version whose
format was checked ([fail-closed rules](resources.md#fail-closed-rules)). A reading that cannot
be read is no reading: the run's limit then closes the pool for the Worker's
`limitCooldownSeconds`, never opens it. On a version not checked, the format is not read at all,
and says so: Codex's run error (`its reset time is not read: …`), or an account's usage report
`unreadable`, naming the version.

| Runtime | What the installed version exposes | What is read | Versions |
|---|---|---|---|
| Claude Code | a `rate_limit_event` per limit check in the SDK's stream: `rateLimitType` (the window), `status`, `resetsAt` (Unix seconds), `utilization` | every event, as an observation of its window | any (the SDK's own types) |
| Codex | `codex exec --experimental-json`, which the SDK drives, emits no rate-limit event; a turn that hits the usage limit fails (`turn.failed`) with Codex's message, which names when to try again, to the minute, in the process's local time: `… try again at 3:04 PM.` (today) or `… at Oct 25th, 2026 3:04 PM.`, or `… try again later.` | the reset time of a `quota_exhausted` turn's message, as a `rejected` observation of window `*` (the message names no window, so the pool closes as a whole), one minute late (the minute is truncated). The time is read in the zone the child ran in: the `TZ` of its environment (the operator's `env.TZ`, else the daemon's `TZ`), else the host's zone as Node resolves it; the runtime never sets `TZ`. A time without a date is on the child's date when read (late past its midnight, never early); a wall-clock time a DST change shows twice, or never, is read as the later instant. A `TZ` that is no IANA zone name as the child would read it (empty, a POSIX rule such as `UTC0`, an offset, a name in the wrong case, or one Intl does not know) gives no reading, and the error says so | `VERIFIED_LIMIT_VERSIONS`: 0.164.0 |
| Antigravity CLI | the run's stream and its quota errors name no reset (`individual quota reached`, `You have exhausted your quota on this model.`); print mode answers `/usage` itself, without an agent turn, and `--output-format json` writes the quota summary: groups of buckets, each with an `id`, `window`, `disabled`, `remaining_fraction`, `remaining_amount`, and `reset_time` (RFC 3339, UTC) | nothing in the run; after a run that hit a quota, the `agents` source reads the account's usage report (`limits`: `agy --print=/usage --output-format json`, [below](#an-accounts-usage-report)), whose rejected bucket gives the reset | `VERIFIED_LIMIT_VERSIONS`: 1.4.6 |

The runtime's window names (a Claude `rateLimitType` or `get_usage` window, a Codex window's length,
an Antigravity bucket `id`) are opaque, and the Worker's `windows` maps them to the pool's windows;
`*`, or an unmapped rejection, closes every window of the pool ([metering](#metering), step 3).

Evidence, checked 2026-10-24 on the installed versions; no account was used, so each format is
also a [release check](../validation/release-checklist.md) on a live account:

- **Codex 0.164.0** (`@openai/codex` 0.164.0 with `@openai/codex-linux-x64`, under the DSH tools
  directory; the SDK `@openai/codex-sdk` 0.162.1 in `node_modules`). The SDK's
  `dist/index.d.ts` types `ThreadEvent` as `thread.started`, `turn.started`, `turn.completed`
  (token usage only), `turn.failed` (`{ message }`), `item.*`, and `error`; the binary's event
  names are the same. The binary holds the message's parts (`You’ve hit your usage limit`,
  ` Try again at `, ` or try again at `, ` or try again later.`) and the reset's formats
  (`%-I:%M %p`; `%b %-d` + `st|nd|rd|th` + `, %Y %-I:%M %p`). `codex app-server generate-ts`
  shows the app server's `account/rateLimits/read` and `account/rateLimits/updated`
  (`RateLimitSnapshot`: `primary` and `secondary` windows with `usedPercent`,
  `windowDurationMins`, `resetsAt` in Unix seconds), which `codex exec` does not emit and an
  account's usage report reads ([below](#an-accounts-usage-report)). Fixtures:
  `runtime-codex-sdk/tests/fixtures/codex-0.164.0-limit-messages.json`.
- **agy 1.4.6** (`~/.local/bin/agy`). Its embedded changelog: print mode answers `/usage`,
  `/quota`, and `/credits` "without starting an agent turn, spending quota, or leaving a
  conversation behind", and "piped and `--json` output still use UTC timestamps". Its Go type
  descriptors: `steps.JSONOutput` (`status`, `response`, …, `command`: `steps.JSONCommand`
  `{ name, data }`), `printmode.quotaJSON` (`description`, `groups`), `printmode.groupJSON`
  (`name`, `description`, `buckets`), `printmode.bucketJSON` (`id`, `name`, `description`,
  `window`, `disabled`, `remaining_fraction` a float, `remaining_amount` an integer,
  `reset_time` a string), and `printmode.agentErrorPayload` (a run's error: `short_error`,
  `status`, `error_code`, `code_kind`, `retryable`, `error_id`; no reset). `printmode.bucketReset`
  formats a reset with RFC 3339, and `headless.buildOutput` sets `status` to `SUCCESS`. Fixtures:
  `runtime-antigravity-cli/tests/fixtures/agy-1.4.6-usage.json`.

Not read in a run: usage percentages of a Codex run (`codex exec` reports none); agy's credits
(`/credits`). An account's shares between runs come from its usage report (below).

### An account's usage report

> Decision: [ADR-0059](../decisions/adr/0059-quota-readings-from-each-accounts-own-usage-report.md)
> (accepted 2026-10-24, D55), from the operator's request of 2026-10-24 (T96;
> [research](../research/quota-builtins-2026-10-24.md)). Implemented in the three runtimes'
> `limits` and in [`agent-workers`](../../packages/plugins/agent-workers/README.md)
> (`src/reports.ts`). Differs from target: each reader rests on the installed binaries and on
> fixtures, not yet on a live account ([release checklist](../validation/release-checklist.md)); the
> Codex reader's exchange rests on `codex app-server generate-ts` on 0.164.0, not re-checked since.

A run's own events give a window's share only near or at a limit (Claude Code's
`rate_limit_event` carries `utilization` only then), and nothing is read between runs. Each runtime
also reports every window of the signed-in account on request, without a model turn: the optional
`limits({ home }, signal)` reads it, and the `agents` source records it in the account's pool
([resources: readings from an account's usage report](resources.md#readings-from-an-accounts-usage-report)).

- **The seam.** `limits` reads the account signed in to `home` (its own home when absent; a
  provider without `homes` answers a named home `unreadable`), under the probe's confinement and
  environment, starting no model turn, spending no quota a run would, and leaving no conversation
  behind; a runtime that cannot promise that does not implement it. It reads a format only on a
  runtime version whose format was checked, else `unreadable`, naming the version; it never throws.
  A Worker source asks it through `readLimits` (30 s, aborted with its caller, fail-closed on
  anything the seam does not define). The usage report suite (`agentRuntimeLimitsConformance`)
  checks it; the fake and the three readers pass it.
- **The readers** (each converts its own units: a share used 0 to 100, ISO times, a reset more than
  400 days away dropped, and a window with nothing left `rejected`; a report in any other shape is
  `unreadable` as a whole):

  | Runtime | Report | Windows | Versions |
  |---|---|---|---|
  | Claude Code | the SDK's `get_usage` control request (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`) in a session sent no message (streaming input that never yields), with no tool, settings, MCP server, or hook, and no session written (`persistSession: false`); then closed | each window of `rate_limits` (when `rate_limits_available`) whose `utilization` is a number: `five_hour`, `seven_day`, `seven_day_oauth_apps`, and the per-model weekly windows, each under its name (the names a `rate_limit_event` uses); a window is told by its shape, an object with a `utilization` (the endpoint's body adds entries without a new Claude Code version, T111), so the entries that are not (arrays such as `model_scoped` and `limits`, objects without a `utilization` such as `spend`, booleans, strings, nulls) and `extra_usage` are skipped, while a number or a window with a field of the wrong type is `unreadable`; the plan type and the session are not read; `rate_limits_available: false` (an API key) is `unreadable` | `VERIFIED_LIMIT_VERSIONS`: 2.1.308, 2.1.309, 2.1.310 |
  | Codex | `codex app-server` in the account's `CODEX_HOME` (a home with no MCP server, the runtime's `--config` overrides): `initialize`, `initialized`, `account/rateLimits/read`, then ended; no thread, no turn | `primary` and `secondary`, each named by its length, `<windowDurationMins>m` (`300m`, `10080m`), since which is the five-hour window is not fixed by name; one of no stated length only when used up, as `*` | `VERIFIED_RATE_LIMITS_VERSIONS`: 0.164.0 |
  | Antigravity CLI | `agy --print=/usage --output-format json` in its own home only, which print mode answers itself (as [above](#limit-readings)) | each enabled bucket that says what is left, by its `id` | `VERIFIED_LIMIT_VERSIONS`: 1.4.6 |

- **When the `agents` source reads** (for a runtime that implements `limits`): once after each run
  of a derived Worker on a declared pool, and after any run that hit a limit (so a reset read there
  wins over the cooldown fallback; with no pool, the account cools down until the report's
  rejected reset), in the home the run ran in, before the run's usage is recorded and its
  reservation released; and every `limitReadSeconds` (the provider entry; default 600, 60 to
  86400, `0` off, with `pool` only) for each ready, assigned account with a declared pool, skipped
  while a read of it is less than that old, at most one periodic read in flight per runtime, the
  first pass a few seconds after a start. A stop aborts a read in flight.
- **Fail-closed.** A report's observations become readings as a run's do (`source:
  runtime-result`, the same `windows` and cooldown), except that **a report never opens a window a
  `limited` reading closed** before the later of that reading's `resetsAt` and `cooldownUntil`:
  that `ok` reading is not recorded, and is logged. An `unreadable` report, a timeout, or a failure
  records nothing and is logged; the window keeps its last reading and `observedAt`, which the
  roster shows. Why it could not be read, and when, is kept per account until a report is read
  (`agentAccounts.unreadReport`, in memory), and the operator's roster says it on each window of
  the account with no reading yet (`used unknown (no reading yet: its account's usage report could
  not be read at <time>: <why>)`).
- **Evidence** (2026-10-24, no account used): Claude Code's handler, the shaping of its answer
  (`rate_limits` is the body of the account's `GET /api/oauth/usage`, or the CLI's snapshot of it
  under a minute old, kept per account in the home's `.claude.json`), the response schema (window
  `{ utilization, resets_at }`, "Percentage of the window used, 0-100"), and the `/usage` renderer
  (`Math.floor(utilization)` "% used") are the same in 2.1.308, 2.1.309, and 2.1.310 but for
  minified names, and the read writes no transcript and sends no model request; Codex's and agy's
  as [above](#limit-readings). Fixtures: `runtime-claude-agent-sdk/tests/fixtures/claude-get-usage.json`
  and `claude-get-usage-live.json` (the shape a live answer took on 2026-10-24, T111),
  `runtime-codex-sdk/tests/fixtures/codex-0.164.0-rate-limits.json`,
  `runtime-antigravity-cli/tests/fixtures/agy-1.4.6-usage.json`.
- **What stays unknown:** absolute amounts (each report gives shares); windows a runtime does not
  report; an account on an API key; the Antigravity CLI beyond its one home (no identity reader, so
  its accounts are never `ready` and no derived Worker of it is read periodically); website accounts
  and the Gemini API.

## Admission evidence

The Worker registry admits an agent-runtime Worker only on evidence from `probe()`, never
because of its name. A Worker whose runtime is missing, cannot enforce the configured
sandbox, or does not report `readsConfined` and `gatesToolCalls`, is `unavailable`; so is a `worktreePerRun` Worker
whose workspace cannot hold a worktree per run (`config_error`).

A probe can take longer than the 5 s the router gives a whole Worker source to describe its
Workers ([sources that do not answer](routing.md#sources-that-do-not-answer)), so the `agents`
source never waits for a re-probe in a describe:

- **Per home.** A runtime is probed in its own home, and apart from it in each account home a
  derived Worker's runs run in ([its account's home](#workers--account--role)); everything below
  holds for each. A derived Worker whose account is not `ready` probes nothing.
- **Bounded staleness.** A probe result stands for `probeTtlMs` (5 min) from when its probe
  started, never longer: past it, the result admits nothing and the Worker is `unavailable` until
  the next probe finishes. A describe waits only for the first probe of a runtime in a home.
- **Refreshed in the background.** Once a result is half that old, the next probe starts in the
  background, whether or not anything reads, one at a time per runtime and home, so a fresh result
  normally replaces it before it expires. An account home is probed in the background only while
  a Worker whose account is `ready` runs in it; one that is not is forgotten, and a later read
  probes it first.
- **Accounts read again.** Each probe, a background one included, reads the runtime's `ready`
  accounts again (an account home's alone) before its result stands
  ([enrollment](#enrollment-and-quarantine)).
- **The latest result wins.** A probe that throws, or proves less, replaces an older success at
  once: no Worker is admitted on evidence a later probe contradicts (INV-2).
- **A run's own check** before the agent starts waits for a result within `probeTtlMs`.
- **Each probe is bounded.** A probe that has not settled within `probeTtlMs` of its start (5 min
  with `probeTtlMs: 0`), its accounts' re-read included, when its result could no longer stand, is
  refused as `probe timed out`: it admits nothing, its late answer is dropped, and the next probe
  starts. A stop waits for a probe in flight no longer than that.

| Capability | Offered when |
|---|---|
| `local-data` | the Worker is ready (it runs on this machine, in its workspace) |
| `review` | the sandbox is `read-only`: a review is independent of the change ([INV-15](../architecture/invariants.md#inv-15-one-writer-per-subject)) |
| `develop` | the sandbox is `workspace-write` |
| `validate` | the sandbox is `workspace-write` and the probe reports `executes` ([confined commands](#confined-commands)) |
| `persistent-conversation` | the probe reports `resume`. Target: a resume conformance test passes. This is what qualifies a runtime as a long-lived [team member](teams.md#membership-model-a) |
| `reason`, for a review member's steps only | the Worker is under the [review-member profile](#review-members) (`reviewMember`, read-only), granted by the profile while it is enforced: the Worker is ready, so its runtime enforces the read-only sandbox, `readsConfined`, and `gatesToolCalls` |
| `persistent-conversation`, for a review member's steps only | the Worker is under the profile and the probe does not report `resume`: the source keeps the member's conversation by an exact, recorded replay (evidence `conformance`) |

An agent Worker never offers plain `reason`, so ordinary asks never spend agent-plan quota
([P1](../requirements/purpose.md)). The offers a review member adds are scoped to a review member's
steps ([scoped offers](routing.md#scoped-offers)): an ask, a brainstorm, research, a planner, or a
digest never reaches them.

### Review members

The operator may place a read-only agent Worker under the **review-member profile**
(`reviewMember: true`;
[ADR-0049](../decisions/adr/0049-read-only-agent-workers-as-review-members.md)). It can then be a
member of a [`review` team](teams.md#review), beside a website Worker or another agent runtime, by
configuration only: the experiment that swaps one member's Worker for another's needs nothing
else. The configuration is refused at load unless the sandbox is `read-only`, the Worker names its
provider `family` (the same as other Workers' of the vendor whose models it runs, so two members of
one vendor stay apart; [provider diversity](routing.md#provider-diversity)), and `worktreePerRun`
is off.

- **The profile grants `reason`, never the Worker.** The offer exists only while the profile is
  enforced: the Worker is ready, so its runtime's probe proves now that it enforces the read-only
  sandbox, keeps host state unreadable, and asks the run's gate before every tool call. It is
  scoped to a review member's steps.
- **Every member step runs under the profile**, or not at all (`config_error`, nothing run):
  - the Worker is under the profile (a Worker that is not never runs one, not even its first);
  - its workspace is an empty directory outside any git work tree, checked before anything is
    sent, so nothing a runtime reads on its own (an instruction file, the repository above)
    reaches the member: its material is its prompt alone, the source the engine read at the pinned
    commit;
  - its gate denies every tool call, each a recorded `gate` decision: no write, no read;
  - after the step the workspace must still be empty, or the run fails as
    `reconciliation_failed`, its answer not trusted;
  - its record is `agent-result@1.3`, `profile: review-member`.
- **Why a member needs a conversation.** Each member is asked at least twice: its proposal, then
  its sealed ballot, and a debate turn after a split. The ballot and debate prompts quote the
  findings and ballots only; the request, the source, and the member's own findings are in its
  conversation ([teams](teams.md#ballots)).
- **On a runtime that resumes** (Claude Code, Codex), it continues natively, as every session
  does. A member step whose session has earlier turns but no native conversation is refused
  (`invalid_input`, unsent): a member is never given a fresh conversation for a continuation.
- **On a runtime that cannot** (the Antigravity CLI), the `agents` source **replays** it. This is a
  replay, not a resume: each later step starts a new agent conversation whose message holds the
  session's earlier completed turns of its generation, in order, each its message and its answer
  exactly as recorded, between fence lines derived from its own text, then the new message. Every
  earlier turn ran under the profile, so no tool ran in it, and a turn is exactly its message and
  its answer; failed turns are no part of it. The runtime is never asked to resume, and the
  session keeps no native handle, so no brief claims one. A reset starts a new replay.
  - **Recorded.** The runs it replays are fixed when the step is first prepared. Its
    `agent-result@1.3` names them (`replay.runs`), their answers (`replay.answers`, also the
    artifact's `inputs`), and the hash of everything sent (`replay.promptHash`).
  - **Fails closed**, unsent: an earlier turn still open, one not run under the profile, one
    whose answer is no longer stored (`invalid_input`), or more than `maxReplayChars` (default
    200,000) characters of earlier turns. A history is never cut (INV-9).
  - Egress checks what is sent, the replay included, at the strictest classification of its turns
    (INV-12).
- **Outside a member's steps**, a session that a runtime without `resume` is asked to continue is
  refused (`config_error`, unsent).

## Turn semantics

- **Idempotency.** Every run is keyed by a logical request id. Target: where the agent writes
  a local session or rollout record, reconciliation reads it before restarting a run. Today a
  run that started before a stop is never run again: once a [liveness verdict](#restart-and-liveness)
  finds it gone, it fails as
  `reconciliation_failed` and names its native session. A run whose
  lease another process holds is looked at again when that lease would expire, so a crashed
  holder never strands it.
- **Completion.** The SDK's terminal event means *provider terminal*, not acceptance. The
  Worker's result is accepted only by the routing layer
  ([INV-3](../architecture/invariants.md#inv-3-completion-boundaries-are-distinct)).
- **Cancellation.** The abort signal is passed to the SDK, and the outcome (cancelled, or
  completed before cancel) is reported. An agent subprocess that ignores the cancel is ended:
  SIGTERM after a grace period, then SIGKILL, so it cannot hang a run.
- **Evidence.** The result artifact carries the final message, the prompt hash, the sandbox,
  the workspace the run worked in (with `worktreePerRun`, its [worktree](#workspaces)), and, for a git working tree, its exact subject after the run, which a review
  binds to (a tree git cannot read then fails the run as `reconciliation_failed`, never stored as one with no subject); with `@1.2`, the run's main model and token usage, in total and per model. Target: diffs, commands run, and test results stored as artifacts with their
  hashes.

## Restart and liveness

A started run is gone only on a [liveness verdict](scheduling-and-leases.md#liveness-verdict) of
`dead`, never on its lease alone
([ADR-0056](../decisions/adr/0056-a-failed-lease-renewal-is-not-a-lost-lease-and-death-needs-a-verdict.md),
PROP-0013 L1 and L2).

- **What is recorded.** At submission the `agents` source records the run's holder (this
  process: host, boot, pid, start time) and the submission as its first activity. A runtime that
  reports its agent process (`RunObserver.onProcess`; Claude Code reports the outermost process of
  its confinement, whose end ends the agent under `--die-with-parent`) has it recorded once. Its
  activity (`onActivity`; Claude Code reports each SDK message) is written at most once per
  heartbeat, a third of the run lease. Every write is fenced by the run's lease. Codex, ACP, and the
  Antigravity CLI report neither yet, so those signals stay `unknown`.
- **A heartbeat that fails** does not stop a run: its lease is lost only when a renewal finds it
  expired, taken over, or invalidated, or when its expiry passes unrenewed
  ([lease generations](scheduling-and-leases.md#lease-generations)).
- **A started run whose holder no longer holds it** (a restart, a lost lease retaken) gets a
  verdict before anything is reconciled:
  - `dead`: it fails as `reconciliation_failed` (`USER_ACTION`), never run again, with a
    `reconciliation` decision (rule `agent-workers.reconcile` version 2) that records the verdict and
    every signal. Its session and worktree are free again;
  - every signal gone but activity within `deadAfterSeconds` (default 120, twice the run lease): it
    is looked at again once the bound has passed, and that look is not counted;
  - anything else (`unknown`, or `stalled` for an agent process still present): looked at again
    with a bounded backoff (a minute, doubling, at most 15 minutes). After `maxUnknownVerdicts`
    (default 3) verdicts in a row it goes to the operator: it fails as `reconciliation_failed`, the
    decision saying it is not declared dead, and `agent-workers.run.unknown` is appended (`agentRun`,
    `worker`, `verdict`, `looks`, `cause`, `rule`, the decision).
- **The operator cancels a started run that no process holds** (between two looks, say): its agent
  cannot be stopped from here, so it gets a verdict first, as above, recorded as a `reconciliation`
  decision (`cause: cancel`). `dead` ends it `aborted` as gone; any other verdict ends it `aborted`
  not known to be gone, held as below, and `agent-workers.run.unknown` is appended. Its reservation
  is released and its usage recorded as unknown (`interrupted`). A run its holder runs here is
  aborted in place, and a queued one never starts, as before.
- **A run that ended without being known to be gone** holds its session and its worktree (INV-15)
  until the operator [frees it](#freeing-what-a-run-holds). The source runs nothing more in either
  (`config_error`, unsent), the retention sweep keeps the worktree, and [`held`](#held-sessions)
  says so.
- **A stall.** While a run is held, at each beat a run whose agent process is present and that
  has been quiet for `stallSeconds` (default 300) is `stalled`. It is reported once per stall: event
  `agent-workers.run.stalled` (`agentRun`, `worker`, `quietSeconds`, `stallSeconds`, `rule`) and a
  log line. Nothing is sent to the session and nothing is stopped: the run's own deadline and turn
  limit end it.

### Held sessions

The `agents` source answers `held(sessionId)` on the `workers` seam: why the session takes no input
now, derived when asked from its durable facts, never a stored flag. A session is held when:

- its latest run has not finished;
- any of its runs ended without being known to be gone;
- its latest run stopped on a deferred tool call whose approval request is still open. The run
  records the request; for a run from before that, the gate's `agent-workers.tool.deferred` event
  names it. The queue is asked for the request's state. With no queue loaded, or a request it cannot
  read or does not hold, the session cannot be shown free.

An answered request (approved, rejected, expired, or withdrawn) frees it. On approval, the engine's
one continuation of the deferred call is the session's input
([a deferred tool call](workflow-engine.md#a-deferred-tool-call)). A run the operator freed no
longer holds it.

### What the operator sees

The `agents` source answers `liveness()` on the `workers` seam (optional, additive; PROP-0013): its
runs whose liveness needs the operator's look, read from its durable facts when asked, at most 64,
the latest first, with the counts of all:

| State | Which runs | What it tells |
|---|---|---|
| `stalled` | running, a stall reported and not yet over | the agent process as this host shows it, the latest activity; nothing is sent to it, its own deadline ends it |
| `looking` | started, its holder gone, verdicts being taken | the latest verdict, its looks of `maxUnknownVerdicts`, each signal as this host shows it now |
| `unknown` | ended without being known to be gone, not freed | the verdict and looks, the signals its `reconciliation` decision recorded, what it holds, and `system free` |

Each names its session and its workflow run's worktrees (what it holds) and what the operator can
do. The surfaces read it through the seam, never the source: MCP `status` and `system health` (a
`liveness` check, degraded while an `unknown` run holds what it ran in or a source cannot tell; the
operator's `status` lists the runs), `explain` of a workflow run or of the execution itself, the
roster's **Doing now** ([roster](roster.md)), and, from the events, the report's attention section
([reports](reports.md#what-it-counts)).

### Freeing what a run holds

A run that ended `unknown` holds its session and worktree for good: whether its agent is gone is the
operator's judgement (ADR-0056). The operator gives it with `agent_run_free` (operator scope,
`mcp-agent-runs@1.0`; `system free <run> --agent-gone`):

- **On the operator's word only.** `agentGone` must be true; it is the operator's statement that no
  process of the agent runs, recorded first as their `reconciliation` decision (decider
  `operator.free`, not deterministic, the note as its rationale) with the signals as this host shows
  them then and what happens to each worktree (INV-13). The run keeps it (`liveness_freed`), and
  `agent-workers.run.freed` is appended. From then on `held`, a later run's check, and the retention
  sweep no longer count it.
- **Refused, changing nothing** (INV-2): a run that holds nothing (completed, found `dead`, or
  ended with its agent stopped by its holder); while its liveness is still being looked at, or
  another started run of its session or worktree has not finished; while a process holds its lease;
  while its holder or its agent process is present on this host, whatever the operator said.
- **Its worktree** (a Worker with `worktreePerRun`): removed only while no other agent run of its
  workflow run is unfinished or not known to be gone, and only when it holds nothing uncommitted,
  or, with `commitWorktree`, once its changes are committed on its branch as the retention commits
  them. The branch always stays, nothing is forced, and a worktree that stays is the retention's.
  The decision is stored on the worktree's record. A freed run may be freed again for its worktree
  only, each time its own decision; with no worktree of it left, that is refused.
