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
    declares, each plugin's lifecycle state, and what its manifest check found in each plugin a
    row mounts, every change a decision ([plugin host](../design/plugin-host.md));
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
- **Agent Workers** (`ctx.agentWorkers`): one Worker per enrolled account and role it is assigned
  (`agent:<accountId>/<role>`, derived from role templates and assignments), or per hand-named row
  until the operator moves them (`system account migrate`), held to a policy from
  configuration (workspace, sandbox, tool allow-list). Its row, `agent-runtimes`, and the Claude
  Code runtime's are on in the default composition, with no Worker until the operator names a
  repository ([agent Workers](../operations/runbooks.md#agent-workers)); the Codex, ACP, and Antigravity CLI rows
  are off. A Worker's capabilities are what its
  runtime's `probe()` proves now; a policy the runtime cannot enforce leaves it unavailable, and
  only a runtime that proves its commands confined (`executes`) gives a writable Worker `validate`.
  Runs are durable, one at a time per Worker and up to `maxConcurrentRunsPerAccount` per account,
  and a run that started is never rerun by itself. Before a run works in a workflow run's new
  worktree, it runs the repository's setup there (commands the policy allows, confined, offline;
  [a worktree's setup](../design/agent-runtimes.md#a-worktrees-setup)).
  It keeps each runtime's enrollment slots and the agent accounts in them, identified by a keyed
  hash of the verified login (the key in `ctx.credentials`), quarantines a missing, changed,
  ambiguous, duplicate, or unverified one, and offers the operator's `account_enroll`,
  `account_remove`, `account_agents`, and `account_migrate` tools on `ctx.mcp`
  ([agent accounts](../design/agent-runtimes.md#enrollment-and-quarantine),
  [account × role](../design/agent-runtimes.md#workers--account--role)).
  A read-only Worker configured `reviewMember` takes a `review` team member's steps, and only
  those, every tool call denied ([review members](../design/agent-runtimes.md#review-members)).
  The agent runs here but its model is remote, so each prompt passes the egress check first.
  Every tool call passes the run's gate, the autonomy policy through `ctx.approvals`, before it
  runs; a runtime that cannot ask a gate first is not admitted, and a call the policy asks
  about stops the run until the operator's verdict
  ([a Worker's tool calls](../design/approvals.md#a-workers-tool-calls)).
  A Worker configured with a resource pool is metered through `ctx.resources`: it reserves
  before a run, records one usage record from the runtime's own numbers after it, and records
  the runtime's limit observations ([agent runtimes](../design/agent-runtimes.md#metering)); a
  run the ledger counts nothing of is recorded as a `usage.unknown` fact in the event log
  ([usage the ledger cannot count](../design/resources.md#usage-the-ledger-cannot-count)).
  Each ready account with a declared pool also has its runtime's own usage report read into its
  pool after its runs and every `limitReadSeconds`, never opening a window a limit closed
  ([an account's usage report](../design/agent-runtimes.md#an-accounts-usage-report)).
  A Worker configured with `worktreePerRun` works, per workflow run, in that run's own git
  worktree of its repository, and the source removes the worktree, its changes committed on
  the run's branch, once the run has been idle past a retention
  ([workspaces](../design/agent-runtimes.md#workspaces)).
- **Agent runtimes** (`ctx.agentRuntimes`): providers for Claude Code (Claude Agent SDK), Codex
  (Codex SDK), ACP agents, and the Antigravity CLI (its installed `agy`, only on a version verified
  live, every tool call held by its PreToolUse hook, bridged to the run)
  ([agent runtimes](../design/agent-runtimes.md)). Each agent
  process starts without the daemon's credentials, in a home of its own, and cannot read host
  state (the DSH home, the session's runtime and temporary directories, registered secret
  paths, every agent's login): the registry owns the read confinement, applied with
  bubblewrap around every agent ([ADR-0024](../decisions/adr/0024-agent-workers-confined-for-reads.md)).
  Commands run in each runtime's own sandbox nested inside it: Codex's, or, for Claude Code, the
  Agent SDK's, writing only the workspace and with no network, proven on the host by the probe
  ([ADR-0038](../decisions/adr/0038-confined-commands-for-claude-code-workers.md)). Claude Code
  and Codex ask a run's tool gate through one PreToolUse hook; Codex's is a command that reaches
  the gate over a per-run socket, proven on the host by the probe against a scripted model
  ([ADR-0042](../decisions/adr/0042-codex-workers-ask-the-gate-through-a-hook-bridge.md)).
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
  optional `reserve` (an admission counted in the Worker's load until it starts), `sandbox` (the
  confinement a brief names), `affinity`, `siblings` (the Workers on its account), `handle`,
  `reset`, `release`, `cancel`. An agent runtime
  provides `kind`, `probe()` (`RuntimeEvidence`), and `run(spec, signal, onHandle)`, whose
  result may carry what the run consumed (`RunMetering`) and whose `spec.toolGate` it asks
  before each tool call (`allow`, `deny`, `defer`); for agent accounts, optionally its own `home`,
  `identity(home, key)`, and `loginCommand(home)`, and runs and probes in a named home
  (`spec.home`, `probe({ home })`) when its evidence reports `homes`. `ctx.models`
  provides `list()` (catalog entries with availability) and `complete(request, signal)`.
- **Packages:** [turns](../../packages/plugins/turns/README.md),
  [agent-workers](../../packages/plugins/agent-workers/README.md),
  [agent-runtime-core](../../packages/agent-runtime-core/README.md),
  [agent-runtimes](../../packages/plugins/agent-runtimes/README.md),
  [runtime-claude-agent-sdk](../../packages/plugins/runtime-claude-agent-sdk/README.md),
  [runtime-codex-sdk](../../packages/plugins/runtime-codex-sdk/README.md),
  [runtime-acp](../../packages/plugins/runtime-acp/README.md),
  [runtime-antigravity-cli](../../packages/plugins/runtime-antigravity-cli/README.md),
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
- **Contracts:** `workers.route(requirement, { restrict, excludeWorkers, exclude, input, assignment })
  → AdmittedWorker` (with `tier` and `route` decisions) or `AdmissionFailure` (with an `admission`
  decision; `limitUntil`, the earliest known reset, when every Worker refused only for its limit is
  on an assigned account);
  `workers.accept(result, contract) → Acceptance` (with an `acceptance` decision);
  `workers.register(source)`, `workers.contract(id, check)`, `workers.source(name)`;
  `egress.check({ payload, classification, workerClass }) → allowed + egress decision`.
- **Gate and resource ledger:** `ctx.approvals` (provider `approvals`, on the store), the
  autonomy policy from configuration or from a change the operator approved in the queue (kept in
  the store while that configuration is unchanged), and the one batched approval queue, whose
  expiry denies, with the MCP tools `approvals_list`, `approvals_get`, `approvals_policy`, and the
  operator's `approvals_decide` and `approvals_policy_propose`, and the operator's queue and policy
  page on the web UI ([approvals](../design/approvals.md)); the queue may also propose a policy
  change itself, never apply it, from repeated identical approvals, off unless configured
  ([the queue proposes a policy change](../design/approvals.md#the-queue-proposes-a-policy-change));
  `ctx.resources` (provider `resources`, on the store), configured pools and pools made from
  templates for the accounts a Worker source declares, limit readings, reservations before a run,
  and deduplicated usage after it, with the MCP tools `resources_pools` and `resources_usage`
  ([resources](../design/resources.md)). Contracts: `approvals.check / request / batch / decide /
  withdraw / sweep`, and from contract 1.1 `proposePolicy / policyChanges`; `resources.pools /
  observe / reserve / release / record / usage`, and from contract 1.1 `declare`.
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
  task's next attempt resumes the session of the one before it when its Worker can. Before each
  step of such a run it reserves the task's budget lines on `ctx.resources` (optional); a spent
  line starts no new step and blocks the task with a funding request, none on its last attempt
  ([a task's budget](../design/workflow-engine.md#a-tasks-budget)). A node refused only for
  assigned accounts' limits waits for the reset, bounded, spending no attempt
  ([waiting for an account's limit](../design/workflow-engine.md#waiting-for-an-accounts-limit)). Through the
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
  `board_*` tool; its project moves (pause, resume, close) are the operator's, by the
  operator-scope tools.
- **Digests** (`ctx.digests`, the digest family): a cited `digest@1.0` of raw artifacts, on
  request (MCP `digests_request`), written by a read-only Worker on the economy tier that
  `ctx.workers` routes to, and quote-checked before it is stored: a claim whose quote is not
  verbatim in the artifact it cites is dropped and recorded; when every claim fails, it is
  written once more on the standard tier, never higher. It fails open: a request no Worker
  serves is settled `bypassed` and recorded ([digests](../design/digests.md)). It depends on
  seam definitions only. The workflow engine asks for a digest of each board task's result once
  it reached the board, and sets it on the task through the board's `attachDigest`. Two providers,
  one running at a time: `digest` (its row on) gives its Worker the sources whole;
  `digest-extractive` (its row off, swapped in by configuration) gives it verbatim spans code
  selected first and fills each claim's quote from them
  ([extractive-first](../design/digests.md#extractive-first)).
- **Experiment registry** (`ctx.experiments`, [defined](plugin-model.md#seam-catalog)):
  hypotheses and pre-registered experiments with their exact identity and structured fingerprint;
  every registration answered EXACT_REPEAT, RELATED, CONTEXT_CHANGED, or NOVEL, and pre-registered
  or refused as a `registration` decision; each experiment's state while the evaluation engine
  runs it; and lessons, whose applicability is computed when they are read
  ([experiments](../design/experiments.md)).
- **Evaluation engine** (`ctx.evaluations`, [defined](plugin-model.md#seam-catalog)): a
  pre-registered experiment run offline under its pins and seals as paired trials, measured by
  collectors (the verification family, registered through `evaluations.collector`) and by the
  resource ledger, analysed once at the horizon, and classified by the deterministic verdict rule
  as a `verdict` decision; it decides no promotion, which always asks the operator
  ([evaluations](../design/evaluations.md)).
- **Statistics** (library): the intervals the verdict rule reads, pinned by version in each
  experiment; inference only, holding no threshold: the exact paired sign-flip test and the
  interval that inverts it, golden-tested against SciPy ([statistics](../design/statistics.md)).
- **Profiles:** plugins that contribute templates through `ctx.workflow.template` (`research`,
  with its `deep` variant; `agent-review` and `algorithm-development`, for the agent Workers, their row off by default) and acceptance
  contracts through `ctx.workers`. A profile never names a provider, browser, or account, and
  holds no engine code.
- **Does not own:** provider mechanics, Worker admission, or protocol framing.
- **Contracts:** `workflow.start / wait / get / approve / vote / stop / continue / supersede / delete /
  drain / resume / explain / usage`, `workflow.template(name, nodes)`;
  `workerSessions.join / send / inbox / ack / openBarrier / activate / settle`;
  `board.charter / propose / claim / renew / start / submit / accept / reconcileRun / block / answer /
  cancel / pause / resume / close / sweep / attachDigest`; MCP `board_*`, and `run` with `task`; `digests.request / get / wait`, MCP
  `digests_request`, `digests_get`; `experiments.lookup / register / get / list / link / begin / settle /
  close / recordLesson / lessons`; `evaluations.collector / start / sweep / get / list`.
- **Packages:** [workflow](../../packages/plugins/workflow/README.md),
  [worker-sessions](../../packages/plugins/worker-sessions/README.md),
  [profile-software-development](../../packages/plugins/profile-software-development/README.md),
  [profile-scientific-research](../../packages/plugins/profile-scientific-research/README.md),
  [board-core](../../packages/board-core/README.md), [board](../../packages/plugins/board/README.md),
  [digest-core](../../packages/digest-core/README.md), [digest](../../packages/plugins/digest/README.md),
  [digest-extractive](../../packages/plugins/digest-extractive/README.md),
  [experiments-core](../../packages/experiments-core/README.md),
  [evaluations-core](../../packages/evaluations-core/README.md),
  [statistics](../../packages/statistics/README.md).

## Host

- **Owns:** composition on **DSH core**. The `system` profile lists the `system` bundle first,
  which inserts the allow-listed DSH rows and the `system` plugins, with no `dsh-base`
  ([ADR-0019](../decisions/adr/0019-explicit-minimal-dsh-core.md)). The `system` CLI creates
  the profile and runs `dsh --profile system` with telemetry off. Cordis validates every
  plugin `Config` at startup, isolates failures per plugin, and runs disposers on shutdown
  ([ADR-0018](../decisions/adr/0018-build-on-dsh-core.md)). Every plugin package ships a
  manifest, generated from its code and checked against it in CI; the kernel's plugin host
  records each plugin's lifecycle state, and checks each plugin a row mounts against its manifest
  at start ([plugin host](../design/plugin-host.md)).
- **Does not own:** business logic. The host never wires layers by hand; dependencies are
  resolved through `inject`.
- **Packages:** [system-bundle](../../packages/system-bundle/README.md),
  [cli](../../packages/cli/README.md).

## Gateways

- **MCP server** (`ctx.mcp`): Streamable HTTP at `/mcp` behind the operator and client
  tokens. Plugins contribute tools for their lifetime, each declaring the scope that may call
  it ([MCP tools](../reference/mcp-tools.md),
  [ADR-0023](../decisions/adr/0023-scoped-control-credentials.md)). Its `status` tool gives the
  host's health, read from the mounted services, the resource ledger and the event log among them
  ([mcp-server](../../packages/plugins/mcp-server/README.md)).
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
  that is present, and the board's reviews and projects, with the operator's acceptance and
  project moves, when `ctx.board` is ([web UI API](../reference/web-ui.md)).
- **Roster** (in `gateway-core`): every Worker in one read model, projected on read from the
  Worker registry, the account and enrollment records, the resource ledger, the event log, the
  workflow runs, and the board, each fact it cannot read shown as unknown with why; no state of
  its own. Served as MCP `roster` (client scope), `system roster`, and the web UI's Workers tab
  ([roster](../design/roster.md)).
- **Report** (`report`): the baseline report of a period, for one project or every one, from
  recorded data only (the board, the approval queue, the resource ledger, the event log), as the
  MCP tool `report` and `system report`; by default the weekly investor report. It writes and
  decides nothing ([reports](../design/reports.md)).
- **Notifications** (`notify`, its row off): out-of-band notices to the operator, from recorded
  events only, of what needs them (an approval request opened or about to expire, a run failed for
  the operator or escalated, a step waiting for an account's limit, a pool closed, an agent account
  quarantined), on the desktop or, opt-in, to a webhook behind the egress gate. It reads the event
  log after its own cursor and decides nothing; its outcomes are events that health reads
  ([notifications](../design/notifications.md)).
- **Does not own:** orchestration state. Gateways translate protocols and enforce transport
  security only.
- **Design:** [gateways](../design/gateways.md), [reports](../design/reports.md), [roster](../design/roster.md),
  [notifications](../design/notifications.md); wire details in [reference](../reference/gateways.md).
- **Packages:** [mcp-server](../../packages/plugins/mcp-server/README.md),
  [gateway-core](../../packages/gateway-core/README.md),
  [gateway-turns](../../packages/gateway-turns/README.md),
  [gateway-anthropic](../../packages/plugins/gateway-anthropic/README.md),
  [gateway-responses](../../packages/plugins/gateway-responses/README.md),
  [web-ui](../../packages/plugins/web-ui/README.md), [report](../../packages/plugins/report/README.md),
  [notify](../../packages/plugins/notify/README.md), [cli](../../packages/cli/README.md).
