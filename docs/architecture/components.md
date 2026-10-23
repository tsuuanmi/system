# Components and boundaries

> Target state. Layer placement is defined in the [layer map](README.md#layer-map); the packages
> of each layer and their dependencies are generated in [packages](packages.md). Mechanisms are
> linked to [design](../design/README.md). What each package does now is in its own `README.md`.

Each boundary below states what it **owns**, what it **does not own**, and its **contracts** to
the layers above. Each contract is published as one or more Cordis seams
([seam catalog](plugin-model.md#seam-catalog)).

Boundaries are cut by layer; the [core and plugin classes](plugin-model.md#core-and-plugin-classes)
cut the same seams by guarantee. Most boundaries hold both: Routing holds the gate (admission,
acceptance, egress) beside the routing policy, a decision input; Orchestration holds the work
state machine and the runner beside the workflow templates. A change to a guarantee seam's
contract needs an ADR ([ADR-0036](../decisions/adr/0036-guarantee-core-and-capability-plugins.md)).

## Kernel

- **Owns:**
  - the durable store: SQLite in WAL mode, per-plugin migrations, transactions, and
    `afterCommit` hooks ([ADR-0003](../decisions/adr/0003-sqlite-durable-store.md));
  - artifacts: immutable, content-addressed, schema-validated envelopes with lineage, including
    decision records ([artifacts](../design/artifacts.md));
  - the append-only event log, written in the same transaction as the change it reports;
  - leases with generations, and fencing of writes by a stale owner;
  - the encrypted credential vault behind DSH `ctx.credentials`;
  - the plugin host's record: every plugin of the composition with the manifest its package
    declares, and each plugin's lifecycle state, every change a decision
    ([plugin host](../design/plugin-host.md));
  - the libraries: canonical JSON hashing, the schema registry, durable owner-only files.
- **Does not own:** domain semantics. The kernel stores receipts and decisions, but it does not
  know what a workflow, a turn, or a Worker is.
- **Contracts:** `store.transaction / afterCommit / migrate`;
  `artifacts.put / get / list / read / recordDecision / explain`; `eventLog.append / query`;
  `leases.acquire / renew / release / fence / current`; DSH `credentials.resolve / set`;
  `pluginHost.list / get`.
- **Packages:** [store](../../packages/plugins/store/README.md),
  [artifacts](../../packages/plugins/artifacts/README.md),
  [event-log](../../packages/plugins/event-log/README.md),
  [leases](../../packages/plugins/leases/README.md),
  [credentials-vault](../../packages/plugins/credentials-vault/README.md),
  [plugin-host-core](../../packages/plugin-host-core/README.md),
  [plugin-host](../../packages/plugins/plugin-host/README.md),
  [libs](../../packages/libs/README.md).

## Provider runtime

- **Owns:**
  - the display (`ctx.display`): a private, X-authenticated Xvfb; never headless for turns;
  - the browser (`ctx.browser`): one headed Chrome context per account, opened from its
    portable state, and filtered capture of refreshed state;
  - accounts (`ctx.accounts`): records, revisioned portable auth state, credentials, and proven
    features, as encrypted grants in `ctx.credentials`;
  - login (`ctx.login`): login profiles, Save, the remote login desktop (which reserves the
    profile), and credential sign-in. A session-bound account's operations run in its login
    profile ([ADR-0030](../decisions/adr/0030-session-bound-accounts-use-their-login-profile.md));
  - provider turn receipts (`ctx.turnReceipts`) and the reconciliation decision;
  - the driver registry (`ctx.providers`) and one **driver** per website: `chatgpt-web` and
    `gemini-web`;
  - the libraries: the per-account scheduler, two-clock completion, the failure taxonomy,
    the turn mechanics every driver shares (`provider-core`), and the UI engine with the
    shared answer reading: UI maps as data, verification, and bounded self-heal
    ([UI operations](../design/ui-operations.md), `ui-ops`).
- **Does not own:** Worker admission ([routing](#routing)), workflow semantics, or when a turn
  runs ([capabilities](#capabilities)).
- **Contracts:** the `ProviderDriver` interface in `@tsuuanmi/system-provider-core`
  ([ADR-0005](../decisions/adr/0005-provider-runtime-interface.md)):
  - `provider`, `capabilities` (what the driver proves), `features` and `probeFeatures` (what
    an account may offer, proven per account without sending anything);
  - `loginUrl`, `stateOrigins` (what makes up the portable state), `checkAuth`, `identity`,
    and optional `signIn` (bounded credential sign-in);
  - `ask` (with `beforeSend`, where the receipt is written, and `onBinding`) and `snapshot`
    (reopen a bound conversation for reconciliation).

  Credentials never cross upward ([INV-8](invariants.md#inv-8-credentials-never-cross-upward)).
- **Design:** [browser runtime and account vault](../design/browser-runtime.md),
  [provider turns](../design/provider-turns.md),
  [scheduling and leases](../design/scheduling-and-leases.md).
- **Packages:** [provider-core](../../packages/provider-core/README.md),
  [ui-ops](../../packages/ui-ops/README.md),
  [display-virtual](../../packages/plugins/display-virtual/README.md),
  [browser-patchright](../../packages/plugins/browser-patchright/README.md),
  [accounts](../../packages/plugins/accounts/README.md),
  [login](../../packages/plugins/login/README.md),
  [turn-receipts](../../packages/plugins/turn-receipts/README.md),
  [providers](../../packages/plugins/providers/README.md),
  [provider-chatgpt-web](../../packages/plugins/provider-chatgpt-web/README.md),
  [provider-gemini-web](../../packages/plugins/provider-gemini-web/README.md).

## Capabilities

The capabilities are the **Worker sources**: each describes its Workers to `ctx.workers` and
runs the work the router admitted to them. Callers never reach a source directly.

- **Website Workers** (`ctx.turns`): one Worker per account and tier. It owns the durable turn
  (idempotent by request key), the egress check of the actual prompt, the per-account
  scheduler, the receipt before send, the write-back of refreshed state, the answer artifact,
  and reconciliation after a restart. Persistent sessions stay on their account. It records
  every website conversation it creates and deletes it on its site once its session is
  released ([conversation ledger](../design/provider-turns.md#conversation-ledger)).
- **Agent Workers** (`ctx.agentWorkers`): one Worker per configured agent, held to a policy from
  configuration (workspace, sandbox, tool allow-list). Its row, `agent-runtimes`, and the Claude
  Code runtime's are on in the default composition, with no Worker until the operator names a
  repository ([agent Workers](../operations/runbooks.md#agent-workers)); the Codex and ACP rows
  are off. A Worker's capabilities are what its
  runtime's `probe()` proves now; a policy the runtime cannot enforce leaves it unavailable, and
  only a runtime that proves its commands confined (`executes`) gives a writable Worker `validate`.
  Runs are durable, one at a time per Worker, and a run that started is never rerun by itself.
  The agent runs here but its model is remote, so each prompt passes the egress check first.
  Every tool call passes the run's gate, the autonomy policy through `ctx.approvals`, before it
  runs; a runtime that cannot ask a gate first is not admitted, and a call the policy asks
  about stops the run until the operator's verdict
  ([a Worker's tool calls](../design/approvals.md#a-workers-tool-calls)).
  A Worker configured with a resource pool is metered through `ctx.resources`: it reserves
  before a run, records one usage record from the runtime's own numbers after it, and records
  the runtime's limit observations ([agent runtimes](../design/agent-runtimes.md#metering)).
  A Worker configured with `worktreePerRun` works, per workflow run, in that run's own git
  worktree of its repository, and the source removes the worktree, its changes committed on
  the run's branch, once the run has been idle past a retention
  ([workspaces](../design/agent-runtimes.md#workspaces)).
- **Agent runtimes** (`ctx.agentRuntimes`): providers for Claude Code (Claude Agent SDK), Codex
  (Codex SDK), and ACP agents ([agent runtimes](../design/agent-runtimes.md)). Each agent
  process starts without the daemon's credentials, in a home of its own, and cannot read host
  state (the DSH home, the session's runtime and temporary directories, registered secret
  paths, every agent's login): the registry owns the read confinement, applied with
  bubblewrap around every agent ([ADR-0024](../decisions/adr/0024-agent-workers-confined-for-reads.md)).
  Commands run in each runtime's own sandbox nested inside it: Codex's, or, for Claude Code, the
  Agent SDK's, writing only the workspace and with no network, proven on the host by the probe
  ([ADR-0038](../decisions/adr/0038-confined-commands-for-claude-code-workers.md)).
- **Model Workers** (`ctx.models` and the `models` source): one Worker per entry of the
  operator's model catalog, an API model or a local one, over the DSH `llm` service
  ([models](../design/models.md)). Calls are durable and idempotent by key, the exact prompt
  passes the egress check (Worker class `model` or `model-local`), output tokens, concurrency,
  re-attempts, and time are bounded, and a call interrupted by a restart is sent once more at
  most ([purpose P4](../requirements/purpose.md#p4-cheap-models-do-low-level-work-strong-models-do-hard-work)).
  The source also keeps sessions by replaying their transcript
  ([ADR-0031](../decisions/adr/0031-model-worker-sessions-by-replay.md)).
- **Does not own:** routing decisions, acceptance, or the steps of a workflow.
- **Contracts:** the `WorkerSource` interface in `@tsuuanmi/system-workers-core`:
  `describe` (capability descriptors with evidence), `start` (durable at once, idempotent by
  `key`; `runId` names the workflow run the execution belongs to; `brief` names the
  `brief@1.x` the source renders its prompt from at start, its pointers resolved and
  egress-checked there, [briefs](../design/workflow-engine.md#briefs)), `get`, `wait`, and
  optional `sandbox` (the confinement a brief names), `affinity`, `handle`, `reset`, `cancel`. An agent runtime
  provides `kind`, `probe()` (`RuntimeEvidence`), and `run(spec, signal, onHandle)`, whose
  result may carry what the run consumed (`RunMetering`) and whose `spec.toolGate` it asks
  before each tool call (`allow`, `deny`, `defer`). `ctx.models`
  provides `list()` (catalog entries with availability) and `complete(request, signal)`.
- **Packages:** [turns](../../packages/plugins/turns/README.md),
  [agent-workers](../../packages/plugins/agent-workers/README.md),
  [agent-runtime-core](../../packages/agent-runtime-core/README.md),
  [agent-runtimes](../../packages/plugins/agent-runtimes/README.md),
  [runtime-claude-agent-sdk](../../packages/plugins/runtime-claude-agent-sdk/README.md),
  [runtime-codex-sdk](../../packages/plugins/runtime-codex-sdk/README.md),
  [runtime-acp](../../packages/plugins/runtime-acp/README.md),
  [models-core](../../packages/models-core/README.md),
  [models](../../packages/plugins/models/README.md).

## Routing

- **Owns:** the registry of Worker sources, fail-closed admission, the deterministic router,
  acceptance contracts, the egress policy (classification per Worker class and a credential
  scan of the actual payload, [INV-12](invariants.md#inv-12-data-egress-is-explicit)), and the
  resource ledger (what each configured pool has left and what every run consumed).
- **Worker:** an *opaque assignable executable unit with proven current capabilities*. A Worker
  answers only three questions:
  1. Can it accept this work now?
  2. How is it invoked or cancelled through its owning runtime?
  3. What result and evidence did it produce?
- **Does not own:** the internals of a Worker. Model, runtime, tools, and state are not
  normalized into a universal interface.
- **Contracts:** `workers.route(requirement, { restrict, exclude }) → AdmittedWorker` (with `tier` and
  `route` decisions) or `AdmissionFailure` (with an `admission` decision);
  `workers.accept(result, contract) → Acceptance` (with an `acceptance` decision);
  `workers.register(source)`, `workers.contract(id, check)`, `workers.source(name)`;
  `egress.check({ payload, classification, workerClass }) → allowed + egress decision`.
- **Gate and resource ledger:** `ctx.approvals` (provider `approvals`, on the store), the
  autonomy policy from configuration or from a change the operator approved in the queue (kept in
  the store while that configuration is unchanged), and the one batched approval queue, whose
  expiry denies, with the MCP tools `approvals_list`, `approvals_get`, `approvals_policy`, and the
  operator's `approvals_decide` and `approvals_policy_propose`, and the operator's queue and policy
  page on the web UI ([approvals](../design/approvals.md)); `ctx.resources` (provider
  `resources`, on the store), configured pools, limit readings, reservations before a run, and deduplicated usage after it,
  with the MCP tools `resources_pools` and `resources_usage`
  ([resources](../design/resources.md)). Contracts: `approvals.check / request / batch / decide /
  withdraw / sweep`, and from contract 1.1 `proposePolicy / policyChanges`; `resources.pools / observe / reserve / release / record / usage`.
- **Policy inputs:** proven capabilities, data locality, Worker state, tier, session
  affinity, and provider family, compared only for inequality. This is where the three [purposes](../requirements/purpose.md) become mechanics.
- **Design:** [routing](../design/routing.md).
- **Packages:** [workers-core](../../packages/workers-core/README.md),
  [workers](../../packages/plugins/workers/README.md),
  [egress](../../packages/plugins/egress/README.md),
  [approvals-core](../../packages/approvals-core/README.md),
  [approvals](../../packages/plugins/approvals/README.md),
  [resources-core](../../packages/resources-core/README.md),
  [resources](../../packages/plugins/resources/README.md).

## Orchestration

- **Workflow engine** (`ctx.workflow`): runs **all** multi-step work as an append-only DAG
  ([ADR-0012](../decisions/adr/0012-dag-execution-model.md)): templates, durable nodes,
  input-hash binding, routing every node by its requirement, acceptance, escalation, retries,
  graph growth from plans, plan approval gates, teams (proposals, sealed ballots, tally, bounded
  debate, tie votes; a review's source step, quote checks, and blocking-finding rule), exact-subject
  review and remediation cycles, wake-on-message, operator stop, continue, supersede, and
  delete, drain and resume ([workflow engine](../design/workflow-engine.md),
  [teams](../design/teams.md)). Every Worker execution it starts is given a `brief@1.1` it
  composes and records first: the node's instructions with every artifact by content id, the
  task it serves, its criteria, and the Worker's confinement
  ([briefs](../design/workflow-engine.md#briefs)). A run may serve one attempt of a board task: the engine is that
  run's owner on `ctx.board` (optional), which it reaches through the abstract `Board` only; a
  task's next attempt resumes the session of the one before it when its Worker can. Through the
  abstract `Approvals` (`ctx.approvals`, optional) a remediation fix's gate asks the approval
  queue, an approved deferred tool call's session is continued once, and a plain run that wrote
  records the policy's checks still pending ([remediation on the
  queue](../design/workflow-engine.md#remediation-on-the-approval-queue)).
- **Worker sessions** (`ctx.workerSessions`): durable sessions, each with its own `SessionId`,
  a binding to the native handle, groups, and a mailbox for direct peer messages under
  barriers ([sessions and messaging](../design/sessions-and-messaging.md)).
- **Board** (`ctx.board`): projects with charters and board tasks that outlive a run, stored as
  records with leases and expiring waits; it asks for approvals through `ctx.approvals`, serves
  the `board_*` MCP tools, and projects a project's board to `TASKS.md`
  ([board](../design/board.md)). Its bundle row is on; it is mounted only with `ctx.approvals`.
  Its holder and run-owner moves are made by the workflow run that serves an attempt, never by a
  `board_*` tool.
- **Digests** (`ctx.digests`, the digest family): a cited `digest@1.0` of raw artifacts, on
  request (MCP `digests_request`), written by a read-only Worker on the economy tier that
  `ctx.workers` routes to, and quote-checked before it is stored: a claim whose quote is not
  verbatim in the artifact it cites is dropped and recorded; when every claim fails, it is
  written once more on the standard tier, never higher. It fails open: a request no Worker
  serves is settled `bypassed` and recorded ([digests](../design/digests.md)). It depends on
  seam definitions only. The workflow engine asks for a digest of each board task's result once
  it reached the board, and sets it on the task through the board's `attachDigest`.
- **Profiles:** plugins that contribute templates through `ctx.workflow.template` (`research`,
  with its `deep` variant; `agent-review`, for the agent Workers, its row off by default) and acceptance
  contracts through `ctx.workers`. A profile never names a provider, browser, or account, and
  holds no engine code.
- **Does not own:** provider mechanics, Worker admission, or protocol framing.
- **Contracts:** `workflow.start / wait / get / approve / vote / stop / continue / supersede / delete /
  drain / resume / explain / usage`, `workflow.template(name, nodes)`;
  `workerSessions.join / send / inbox / ack / openBarrier / activate / settle`;
  `board.charter / propose / claim / renew / start / submit / accept / reconcileRun / block / answer /
  cancel / sweep / attachDigest`; MCP `board_*`, and `run` with `task`; `digests.request / get / wait`, MCP
  `digests_request`, `digests_get`.
- **Packages:** [workflow](../../packages/plugins/workflow/README.md),
  [worker-sessions](../../packages/plugins/worker-sessions/README.md),
  [profile-software-development](../../packages/plugins/profile-software-development/README.md),
  [profile-scientific-research](../../packages/plugins/profile-scientific-research/README.md),
  [board-core](../../packages/board-core/README.md), [board](../../packages/plugins/board/README.md),
  [digest-core](../../packages/digest-core/README.md), [digest](../../packages/plugins/digest/README.md).

## Host

- **Owns:** composition on **DSH core**. The `system` profile lists the `system` bundle first,
  which inserts the allow-listed DSH rows and the `system` plugins, with no `dsh-base`
  ([ADR-0019](../decisions/adr/0019-explicit-minimal-dsh-core.md)). The `system` CLI creates
  the profile and runs `dsh --profile system` with telemetry off. Cordis validates every
  plugin `Config` at startup, isolates failures per plugin, and runs disposers on shutdown
  ([ADR-0018](../decisions/adr/0018-build-on-dsh-core.md)). Every plugin package ships a
  manifest, generated from its code and checked against it in CI; the kernel's plugin host
  records each plugin's lifecycle state ([plugin host](../design/plugin-host.md)).
- **Does not own:** business logic. The host never wires layers by hand; dependencies are
  resolved through `inject`.
- **Packages:** [system-bundle](../../packages/system-bundle/README.md),
  [cli](../../packages/cli/README.md).

## Gateways

- **MCP server** (`ctx.mcp`): Streamable HTTP at `/mcp` behind the operator and client
  tokens. Plugins contribute tools for their lifetime, each declaring the scope that may call
  it ([MCP tools](../reference/mcp-tools.md),
  [ADR-0023](../decisions/adr/0023-scoped-control-credentials.md)).
- **Request guard** (in `gateway-core`): one set of transport checks for every client endpoint
  (MCP, both protocol gateways, the web UI): a loopback `Host`, no browser `Origin`, the bearer
  token in constant time, which decides the caller's scope, bounded JSON bodies, and no route on
  a plain-HTTP non-loopback bind. It also creates the owner-only scope token files.
- **Anthropic Messages gateway** (`/anthropic`) and **Responses gateway** (`/openai`): Claude
  Code and Codex use website Workers as their model. Both rows are off in the default
  composition, where Claude Code reaches `system` over MCP. Each request is an `ask` run on a thread
  bound to one persistent provider conversation; the client's tools travel through the text
  tool protocol and the client runs every call
  ([ADR-0022](../decisions/adr/0022-text-protocol-tool-calls-for-website-models.md)).
- **Gateway turns** (library): the text tool protocol and threads, shared by both
  client-protocol gateways. Each gateway owns only its wire format.
- **Web UI** (`/ui`) and **CLI**: the operator surface for runs, approvals, accounts, remote
  login, and maintenance. The CLI calls the MCP tools of the running profile. The web UI also
  shows the approval queue by batch and passes the operator's verdicts to `ctx.approvals`, when
  that is present ([web UI API](../reference/web-ui.md)).
- **Does not own:** orchestration state. Gateways translate protocols and enforce transport
  security only.
- **Design:** [gateways](../design/gateways.md); wire details in
  [reference](../reference/gateways.md).
- **Packages:** [mcp-server](../../packages/plugins/mcp-server/README.md),
  [gateway-core](../../packages/gateway-core/README.md),
  [gateway-turns](../../packages/gateway-turns/README.md),
  [gateway-anthropic](../../packages/plugins/gateway-anthropic/README.md),
  [gateway-responses](../../packages/plugins/gateway-responses/README.md),
  [web-ui](../../packages/plugins/web-ui/README.md), [cli](../../packages/cli/README.md).
