# Software Requirements Specification

> Target state. Terms such as Worker, capability, receipt, and lease are defined
> where they are first used in [architecture](../architecture/README.md).

## Families

| Prefix | Family |
|---|---|
| `REQ-ACC` | provider accounts and login |
| `REQ-PRV` | provider turns |
| `REQ-WRK` | Worker admission, routing, and acceptance |
| `REQ-TEAM` | multi-member teams |
| `REQ-WF` | durable workflows |
| `REQ-ART` | artifacts, decision records, schemas |
| `REQ-SES` | Worker sessions, direct messaging, long-running work |
| `REQ-GW` | client gateways |
| `REQ-HOST` | host lifecycle |

## Provider accounts (`REQ-ACC`)

- **REQ-ACC-1** Accounts are named semantic identities, for example
  `chatgpt-thinker` and `chatgpt-writer`. Each declares a provider, a role, and
  capabilities. The account catalog is configuration, not code.
- **REQ-ACC-2** A caller always names an account, or a capability that admission
  resolves to an account. A provider name alone never selects an account.
- **REQ-ACC-3** An operator can sign in an account interactively from a remote
  machine without installing client software. A browser and an SSH tunnel are
  enough.
- **REQ-ACC-4** Automated turns use only the account's portable authenticated
  state, never the interactive login profile. The one exception is a
  session-bound account: its driver declares that the site ties a session to the
  profile that signed in. Every operation of such an account runs in its own login
  profile, never from a copy, and never while the operator's login holds the
  profile ([ADR-0030](../decisions/adr/0030-session-bound-accounts-use-their-login-profile.md)).
- **REQ-ACC-5** When an account loses authentication, it is marked
  `reauth-required`, and its queued and running work fails closed with a
  user-action error. Only positive signed-out evidence triggers this state.
- **REQ-ACC-6** Provider turns run in a headed, genuine system Chrome that the
  operator does not see: an Xvfb virtual display on Linux, an off-screen window on
  macOS and Windows. Headless mode is never used for provider turns.
- **REQ-ACC-7** The account vault is provider-agnostic and supports any number of
  accounts per provider. Each account's state is saved, isolated (own browser
  process, scheduler, and bindings), and survives restarts. Accounts that resolve
  to the same identity are flagged.
- **REQ-ACC-8** An account may opt in to credential login with email, password,
  and TOTP. It runs only after positive sign-out evidence. TOTP codes are
  computed locally and never obtained from a third party. Anything it cannot
  satisfy (an email code without an opted-in provider, a challenge, an unknown
  page, or a second failure) falls back to interactive login on the same profile.
- **REQ-ACC-9** Credentials are encrypted at rest and decrypted only in memory.
  They never appear in logs, prompts, artifacts, or process arguments.

## Provider turns (`REQ-PRV`)

- **REQ-PRV-1** Every turn submitted with a logical request id is idempotent.
  Retrying the same request id never sends a second prompt when the first one was
  accepted by the provider.
- **REQ-PRV-2** After a crash or restart, an in-flight turn is reconciled against
  the provider's observable state before any resubmission.
- **REQ-PRV-3** The selected model and reasoning effort are verified before
  submission. On a mismatch the turn fails. It never runs on a different model.
- **REQ-PRV-4** A turn ends either on stable completion or on one of two
  deadlines, a hard limit and a no-progress stall limit, each reported distinctly.
- **REQ-PRV-5** Provider responses are returned as Markdown that matches the text
  that was streamed.
- **REQ-PRV-6** Provider-native deep research is available as a distinct
  capability (purpose P2).
- **REQ-PRV-7** Website-native features enabled on an account, such as web search
  and connectors, apps, or plugins, are exposed as named capabilities. Each is
  proven by a feature probe on that account (purpose P2).
- **REQ-PRV-8** Every website conversation `system` creates is recorded. When the
  run that owns it is deleted or expires, it is deleted on its site, and only
  it: a chat the operator started is never touched, and a temporary chat is
  left to the site (PROP-0004).

## Workers (`REQ-WRK`)

- **REQ-WRK-1** A Worker is admitted for a piece of work only when its current
  composition proves every required capability. Admission fails closed.
- **REQ-WRK-2** Routing among admitted Workers is deterministic for a given
  configuration and input. The Workers' load is part of that input, and the route decision
  records it ([ADR-0033](../decisions/adr/0033-least-busy-routing.md)).
- **REQ-WRK-3** A provider reaching its terminal state does not make the work
  accepted. Acceptance is a separate check against the work's acceptance contract.
- **REQ-WRK-4** Work can be cancelled. Cancellation reaches the owning runtime,
  and its outcome is reported.
- **REQ-WRK-5** Claude Code and Codex can be used as Workers, and any
  ACP-speaking agent can be added through configuration.
- **REQ-WRK-6** An agent-runtime Worker runs under a workspace, sandbox, and
  approval policy taken from trusted envelopes. A policy the runtime cannot
  express exactly fails the run. The host's own state (credentials, keys, control
  tokens, the store) is never readable to the agent, and a runtime that cannot
  prove this on the host offers no Worker.
- **REQ-WRK-7** Work over `local-private` data runs only on local Workers. Content
  reaches a remote Worker only when an explicit egress policy permits that exact
  content for that Worker class (purpose P3).
- **REQ-WRK-8** The order in which routing prefers quota classes is
  configuration. The default composition prefers subscription-chat quota (website
  accounts) for reasoning, search, research, and review, and keeps agent-plan and
  metered quota for work only those Workers can do. Accounts whose quota is
  exhausted are excluded before admission (purpose P1).
- **REQ-WRK-9** Every work requirement declares a minimum intelligence tier
  (`economy`, `standard`, or `frontier`). Routing selects the lowest tier whose
  Workers prove the required capabilities. Escalation to a higher tier after an
  acceptance failure is bounded, configured, and recorded (purpose P4).
- **REQ-WRK-10** API and local models are Workers behind `ctx.models`, routed,
  egress-checked, and bounded like other Workers (purposes P3, P4).

## Teams (`REQ-TEAM`)

- **REQ-TEAM-1** A team runs members independently first. No member sees a
  peer's output until every member has produced its independent result.
- **REQ-TEAM-2** A team member keeps one collaboration identity, and one logical
  Worker, for the team's lifetime.
- **REQ-TEAM-3** *(retired 2026-10-16, PROP-0004: replaced by REQ-TEAM-6)* A
  synthesis step produces the strongest-supported result and cites the member
  evidence it relies on.
- **REQ-TEAM-4** Members of an independence-sensitive team are backed by distinct
  accounts. When the operator allows one provider family, members first keep distinct
  accounts of that family while there are enough; only when no other account is
  admitted do they share one Worker, each in its own session. The team's record says
  which ([ADR-0029](../decisions/adr/0029-opt-in-same-family-fallback.md),
  [ADR-0035](../decisions/adr/0035-one-family-teams-keep-distinct-accounts.md)).
- **REQ-TEAM-5** Reviewers receive the exact subject (for example a diff at a
  head SHA), the criteria, and the relevant decision artifacts, but not the
  producer's conversation. Review independence is structural.
- **REQ-TEAM-6** A team reaches its outcome by a strict-majority vote over sealed
  ballots, and every ballot is recorded. It debates only on a split vote, for a
  bounded number of rounds. The outcome is advice to the caller, who decides; it
  authorizes no effect outside the run.
- **REQ-TEAM-7** A tie is broken by the caller through `vote`, bound to the tie
  decision. A tie waits a bounded time, then ends inconclusive.

## Workflows (`REQ-WF`)

- **REQ-WF-1** A workflow is a semantic DAG of nodes, each with an objective, an
  executor kind, and dependencies. It is validated before activation.
- **REQ-WF-2** Activation requires an admitted, hashed specification. Each value
  in it records its provenance: user-explicit, interpreted, or policy default.
- **REQ-WF-3** A node whose input hash matches a stored result reuses that result
  and does not re-execute.
- **REQ-WF-4** Workflow state survives host restart, and running nodes are
  reconciled on startup.
- **REQ-WF-5** Evidence and approvals bind to an exact subject, such as a content
  hash or a VCS head SHA. Evidence about one subject never satisfies a gate for
  another.
- **REQ-WF-6** Failures are classified into a retry disposition: immediate,
  backoff, recreate session, user action, code fix, or none. Retries are bounded.
- **REQ-WF-7** An operator can list, watch, stop, continue (one failed node), and
  delete workflows.
- **REQ-WF-8** The workflow graph can grow at runtime, for example by adding a
  review cycle once a PR exists, up to configured bounds.
- **REQ-WF-9** At least two domain profiles, software development and scientific
  research, run on the same engine without engine changes.

- **REQ-WF-10** Every multi-step job, including the MVP research pipeline,
  runs as an append-only DAG on the single engine. Loops are unrolled into
  bounded new nodes. A planner may propose nodes only through a validated `plan`
  artifact.

- **REQ-WF-11** Before a subgraph that writes executes, its `plan` artifact is
  approved, either by the operator or automatically when policy allows it. Auto
  approval requires high confidence and only low-risk side-effect classes. The
  approval is an `approval` artifact bound to the exact plan.

## Artifacts and schemas (`REQ-ART`)

- **REQ-ART-1** Every decision (admission, route, tier, escalation, egress,
  acceptance, gate, reconciliation, graph growth, recovery, spec admission) is
  recorded as a decision artifact with its inputs, candidates and their reasons,
  decider and policy version, and outcome.
- **REQ-ART-2** Artifacts are immutable and content-addressed. Corrections are
  new artifacts that supersede old ones.
- **REQ-ART-3** An operator can ask *why* for any artifact, node, or turn, and
  get the chain of decisions and inputs that led to it, within retention; past
  it, an input that was collected is reported as expired, by its id.
- **REQ-ART-4** Every persisted record and wire payload validates against a
  versioned JSON Schema. Invalid records and unknown major versions are rejected.
- **REQ-ART-5** A Worker's structured result is validated against the schema
  named in its acceptance contract, and the schema is given to the Worker when
  its provider supports constrained output.

## Sessions and long-running work (`REQ-SES`)

- **REQ-SES-1** Every continuable Worker participation has a system-owned
  `SessionId`. It is stable across activations and host restarts, and it is bound
  to the Worker's native handle with a generation fence.
- **REQ-SES-2** Sessions in a group can address each other by `SessionId` and
  exchange messages directly. The engine records messages but does not relay or
  rewrite their content.
- **REQ-SES-3** Messages are durable `message` artifacts, delivered at least once,
  in order per mailbox, and deduplicated by `messageId`.
- **REQ-SES-4** The group policy (who may message whom, barriers, budgets) is
  enforced on every message, and egress on every delivery into the receiver's turn. A
  rejected message produces a decision artifact.
- **REQ-SES-5** An idle session is woken by an incoming message, cold-resumed
  when needed. Peers never poll each other.
- **REQ-SES-6** Long-running sessions emit checkpoint artifacts at bounded
  intervals. When context grows past a threshold, an engine-owned compaction
  writes a `handoff` summary, and the session continues from it.
- **REQ-SES-7** A session can enter `INPUT_REQUIRED` and resume when the operator
  or a peer supplies input. Lifetime, idle, turn, message, and token budgets are
  bounded, and exceeding one is a classified failure.
- **REQ-SES-8** Calls that start long work (MCP, CLI) return a `SessionId` or a
  turn or run id immediately, or within a bounded wait below client timeouts.
  Clients continue, poll, or stream by that id, and never block for the duration
  of the work.

## Gateways (`REQ-GW`)

- **REQ-GW-1** The host exposes an OpenAI Responses-compatible endpoint with SSE
  streaming. A Responses client such as Codex can select `system` Workers as models.
- **REQ-GW-2** Tool calls requested by a remote Worker are executed by the
  **client** under the client's own sandbox and approvals, and returned to the
  same remote turn.
- **REQ-GW-3** The host exposes its capabilities as an MCP server.
- **REQ-GW-4** A CLI offers turn, workflow, account, and maintenance commands.
- **REQ-GW-5** The host exposes an Anthropic Messages-compatible endpoint with SSE
  streaming, so that a Messages client such as Claude Code can select `system`
  Workers as models, with the same tool semantics as REQ-GW-2.

## Host (`REQ-HOST`)

- **REQ-HOST-1** The host drains before stop or upgrade. It accepts no new work
  and waits for in-flight requests and provider turns, or for a drain deadline.
- **REQ-HOST-2** Startup validates configuration, profiles, and stores, and fails
  with a precise error when any of them is invalid. A configured workflow
  template that fails its own check is refused alone, with its precise reason
  reported in health, and the rest starts. `system check` runs the same
  validation before a start.
- **REQ-HOST-3** Any change the host makes to a client's configuration is
  journaled and can be reversed byte for byte.
- **REQ-HOST-4** Every feature is composed from configuration (profiles and
  patches). Any feature can be disabled, or its implementation replaced, without
  code changes.
- **REQ-HOST-5** No deployment-varying value is hardcoded. Each one is a
  validated plugin configuration field.
- **REQ-HOST-6** The host reports its health: each check (runtime, store, disk,
  vault key custody, accounts, Workers, provider UI drift, usage the resource
  ledger could not count) as ok, degraded, or down with what to do, and the
  worst of them. Health is degraded while a provider UI change was seen
  recently, and while a resource pool has a run whose usage the ledger could
  not count, and has not counted since, in its current window.
- **REQ-HOST-7** Every plugin package and seam definition ships a manifest
  (`plugin-manifest@1.x`) that agrees with its code: the seams it provides,
  consumes, and defines, at their contract versions, and its core component or
  plugin family. The host lists every plugin of the composition with its
  manifest, and records each plugin's lifecycle state, every change as a
  decision before the state. It records the state the configuration gives and
  automates nothing. At start it checks each plugin a row mounts: one with no
  manifest its configuration allows, or that consumes a seam its providers'
  manifests do not satisfy, is recorded once as a decision, listed with what
  was found, and makes health down.
