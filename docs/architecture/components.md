# Components and boundaries

> Target state. Layer placement is defined in the [layer map](README.md#layer-map); the packages
> of each layer and their dependencies are generated in [packages](packages.md). Mechanisms are
> linked to [design](../design/README.md). What each package does now is in its own `README.md`.

Each boundary below states what it **owns**, what it **does not own**, and its **contracts** to
the layers above. Each contract is published as one or more Cordis seams
([seam catalog](plugin-model.md#seam-catalog)).

## Kernel

- **Owns:**
  - the durable store: SQLite in WAL mode, per-plugin migrations, transactions, and
    `afterCommit` hooks ([ADR-0003](../decisions/adr/0003-sqlite-durable-store.md));
  - artifacts: immutable, content-addressed, schema-validated envelopes with lineage, including
    decision records ([artifacts](../design/artifacts.md));
  - the append-only event log, written in the same transaction as the change it reports;
  - leases with generations, and fencing of writes by a stale owner;
  - the encrypted credential vault behind DSH `ctx.credentials`;
  - the libraries: canonical JSON hashing, the schema registry, durable owner-only files.
- **Does not own:** domain semantics. The kernel stores receipts and decisions, but it does not
  know what a workflow, a turn, or a Worker is.
- **Contracts:** `store.transaction / afterCommit / migrate`;
  `artifacts.put / get / list / recordDecision / explain`; `eventLog.append / query`;
  `leases.acquire / renew / release / fence / current`; DSH `credentials.resolve / set`.
- **Packages:** [store](../../packages/plugins/store/README.md),
  [artifacts](../../packages/plugins/artifacts/README.md),
  [event-log](../../packages/plugins/event-log/README.md),
  [leases](../../packages/plugins/leases/README.md),
  [credentials-vault](../../packages/plugins/credentials-vault/README.md),
  [libs](../../packages/libs/README.md).

## Provider runtime

- **Owns:**
  - the display (`ctx.display`): a private, X-authenticated Xvfb; never headless for turns;
  - the browser (`ctx.browser`): one headed Chrome context per account, opened from its
    portable state, and filtered capture of refreshed state;
  - accounts (`ctx.accounts`): records, revisioned portable auth state, credentials, and proven
    features, as encrypted grants in `ctx.credentials`;
  - login (`ctx.login`): login profiles, Save, the remote login desktop, and credential
    sign-in;
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
  and reconciliation after a restart. Persistent sessions stay on their account.
- **Agent Workers** (`ctx.agentWorkers`): one Worker per configured agent, held to a policy from
  configuration (workspace, sandbox, tool allow-list). A Worker's capabilities are what its
  runtime's `probe()` proves now; a policy the runtime cannot enforce leaves it unavailable.
  Runs are durable, one at a time per Worker, and a run that started is never rerun by itself.
  The agent runs here but its model is remote, so each prompt passes the egress check first.
- **Agent runtimes** (`ctx.agentRuntimes`): providers for Claude Code (Claude Agent SDK), Codex
  (Codex SDK), and ACP agents ([agent runtimes](../design/agent-runtimes.md)). Each agent
  process starts without the daemon's credentials, and cannot read the DSH home: the
  registry owns the read confinement, applied with bubblewrap where a runtime's own sandbox
  does not confine reads ([ADR-0024](../decisions/adr/0024-agent-workers-confined-for-reads.md)).
- **Models** (`ctx.models`, planned): API and local models for `economy`-tier jobs
  ([purpose P4](../requirements/purpose.md#p4-cheap-models-do-low-level-work-strong-models-do-hard-work)).
- **Does not own:** routing decisions, acceptance, or the steps of a workflow.
- **Contracts:** the `WorkerSource` interface in `@tsuuanmi/system-workers-core`:
  `describe` (capability descriptors with evidence), `start` (durable at once, idempotent by
  `key`), `get`, `wait`, and optional `affinity`, `handle`, `reset`, `cancel`. An agent runtime
  provides `kind`, `probe()` (`RuntimeEvidence`), and `run(spec, signal, onHandle)`.
- **Packages:** [turns](../../packages/plugins/turns/README.md),
  [agent-workers](../../packages/plugins/agent-workers/README.md),
  [agent-runtime-core](../../packages/agent-runtime-core/README.md),
  [agent-runtimes](../../packages/plugins/agent-runtimes/README.md),
  [runtime-claude-agent-sdk](../../packages/plugins/runtime-claude-agent-sdk/README.md),
  [runtime-codex-sdk](../../packages/plugins/runtime-codex-sdk/README.md),
  [runtime-acp](../../packages/plugins/runtime-acp/README.md).

## Routing

- **Owns:** the registry of Worker sources, fail-closed admission, the deterministic router,
  acceptance contracts, and the egress policy (classification per Worker class and a credential
  scan of the actual payload, [INV-12](invariants.md#inv-12-data-egress-is-explicit)).
- **Worker:** an *opaque assignable executable unit with proven current capabilities*. A Worker
  answers only three questions:
  1. Can it accept this work now?
  2. How is it invoked or cancelled through its owning runtime?
  3. What result and evidence did it produce?
- **Does not own:** the internals of a Worker. Model, runtime, tools, and state are not
  normalized into a universal interface.
- **Contracts:** `workers.route(requirement, { restrict }) → AdmittedWorker` (with `tier` and
  `route` decisions) or `AdmissionFailure` (with an `admission` decision);
  `workers.accept(result, contract) → Acceptance` (with an `acceptance` decision);
  `workers.register(source)`, `workers.contract(id, check)`, `workers.source(name)`;
  `egress.check({ payload, classification, workerClass }) → allowed + egress decision`.
- **Policy inputs:** proven capabilities, data locality, Worker state, tier, and session
  affinity. This is where the three [purposes](../requirements/purpose.md) become mechanics.
- **Design:** [routing](../design/routing.md).
- **Packages:** [workers-core](../../packages/workers-core/README.md),
  [workers](../../packages/plugins/workers/README.md),
  [egress](../../packages/plugins/egress/README.md).

## Orchestration

- **Workflow engine** (`ctx.workflow`): runs **all** multi-step work as an append-only DAG
  ([ADR-0012](../decisions/adr/0012-dag-execution-model.md)): templates, durable nodes,
  input-hash binding, routing every node by its requirement, acceptance, escalation, retries,
  graph growth from plans, plan approval gates, teams (rounds, barrier, leads), exact-subject
  review and remediation cycles, wake-on-message, operator stop, continue, supersede, and
  delete, drain and resume ([workflow engine](../design/workflow-engine.md),
  [teams](../design/teams.md)).
- **Worker sessions** (`ctx.workerSessions`): durable sessions, each with its own `SessionId`,
  a binding to the native handle, groups, and a mailbox for direct peer messages under
  barriers ([sessions and messaging](../design/sessions-and-messaging.md)).
- **Profiles:** plugins that contribute templates through `ctx.workflow.template` (`develop`;
  `research`, `research-deep`) and acceptance contracts through `ctx.workers`. A profile never
  names a provider, browser, or account, and holds no engine code.
- **Does not own:** provider mechanics, Worker admission, or protocol framing.
- **Contracts:** `workflow.start / wait / get / approve / stop / continue / supersede / delete /
  drain / resume / explain / usage`, `workflow.template(name, nodes)`;
  `workerSessions.join / send / inbox / ack / openBarrier / activate / settle`.
- **Packages:** [workflow](../../packages/plugins/workflow/README.md),
  [worker-sessions](../../packages/plugins/worker-sessions/README.md),
  [profile-software-development](../../packages/plugins/profile-software-development/README.md),
  [profile-scientific-research](../../packages/plugins/profile-scientific-research/README.md).

## Host

- **Owns:** composition on **DSH core**. The `system` profile lists the `system` bundle first,
  which inserts the allow-listed DSH rows and the `system` plugins, with no `dsh-base`
  ([ADR-0019](../decisions/adr/0019-explicit-minimal-dsh-core.md)). The `system` CLI creates
  the profile and runs `dsh --profile system` with telemetry off. Cordis validates every
  plugin `Config` at startup, isolates failures per plugin, and runs disposers on shutdown
  ([ADR-0018](../decisions/adr/0018-build-on-dsh-core.md)).
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
  Code and Codex use website Workers as their model. Each request is an `ask` run on a thread
  bound to one persistent provider conversation; the client's tools travel through the text
  tool protocol and the client runs every call
  ([ADR-0022](../decisions/adr/0022-text-protocol-tool-calls-for-website-models.md)).
- **Gateway turns** (library): the text tool protocol and threads, shared by both
  client-protocol gateways. Each gateway owns only its wire format.
- **Web UI** (`/ui`) and **CLI**: the operator surface for runs, approvals, accounts, remote
  login, and maintenance. The CLI calls the MCP tools of the running profile.
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
