# Components and boundaries

> Target state. Layer placement is defined in the [layer map](README.md#layer-map).
> Mechanisms are linked to [design](../design/README.md).

Each boundary below states what it **owns**, what it **does not own**, and its
**contract** to the layer above. Each contract is published as one or more Cordis
seams ([plugin model](plugin-model.md#seam-catalog)). When code exists, each seam
definition and each provider becomes a package with a colocated `README.md` that
routes back here.

## Kernel

- **Owns:** the durable store (SQLite in WAL mode,
  [ADR-0003](../decisions/adr/0003-sqlite-durable-store.md)), content-addressed
  blobs, the append-only event log, leases with generations, canonical JSON
  hashing, and the injectable clock.
- **Does not own:** domain semantics. The kernel stores receipts, but it does not
  know what a workflow is.
- **Contract:** typed repositories with optimistic revision checks, `lease.acquire
  / renew / fence`, `blob.put / get` by SHA-256, and `events.append / query`.

## Provider runtime

- **Owns:** `BrowserPort` (patchright/Chrome contexts), the display backends
  (headless, visible, Xvfb), remote login, the account vault (portable auth
  state, revisioned), conversation bindings, the per-account scheduler, provider
  turn receipts, and one **provider driver** per website.
- **Does not own:** prompts, team or workflow semantics, or Worker admission.
- **Contract:** the `ProviderDriver` interface
  ([ADR-0005](../decisions/adr/0005-provider-runtime-interface.md)) wrapped by
  `ProviderRuntime.turn(account, request) → TurnOutcome`. Credentials never cross
  upward ([INV-8](invariants.md#inv-8-credentials-never-cross-upward)).
- **Design:** [provider-turns](../design/provider-turns.md),
  [scheduling-and-leases](../design/scheduling-and-leases.md).

## Capabilities

- **Website capability.** **Website Core** owns logical request identity,
  retained-result idempotency, fail-closed handling of conflicting reuse, result
  projection, and cancellation. It calls the `WebsiteProviderRuntime` seam, which
  is implemented by the provider runtime above, or later by an API or remote backend.
- **Local execution capability.** Runs shell, file, patch, and git tools under an
  explicit sandbox policy from a trusted envelope
  ([INV-6](invariants.md#inv-6-authority-comes-from-trusted-envelopes)).
- **Agent runtime capability** (`ctx.agentRuntimes`). Drives external coding
  agents (Claude Code through the Claude Agent SDK, Codex through the Codex SDK,
  any ACP agent) as Workers. See [agent runtimes](../design/agent-runtimes.md).
- **Model capability** (`ctx.models`). API and local model providers. They mainly
  serve `economy`-tier jobs such as triage, extraction, and compaction
  ([purpose P4](../requirements/purpose.md#p4-cheap-models-do-low-level-work-strong-models-do-hard-work)).
- **Does not own:** routing decisions or acceptance.
- **Contract:** each capability publishes a descriptor with its name, side-effect
  class (`none | idempotent | reconcilable | irreversible`), and input and output
  schemas.

## Routing

- **Owns:** the Worker registry, admission predicates, deterministic routing
  policy, cancellation, and acceptance.
- **Worker:** an *opaque assignable executable unit with proven current
  capabilities*. A Worker answers only three questions:
  1. Can it accept this work now?
  2. How is it invoked or cancelled through its owning runtime?
  3. What result and evidence did it produce?
- **Does not own:** the internals of a Worker. Model, runtime, tools, and state are
  not normalized into a universal interface.
- **Contract:** `route(workRequirement) → AdmittedWorker | AdmissionFailure`, and
  `accept(result, contract) → Accepted | Rejected(reasons)`.
- **Policy inputs:** proven capabilities, data locality and egress policy, and
  quota class and account readiness. This is where the three
  [purposes](../requirements/purpose.md) become mechanics.
- **Design:** [routing](../design/routing.md).

## Orchestration

- **Workflow engine:** semantic DAG definitions, durable node state, input-hash
  result reuse, handoffs, exact-subject gates, recovery, admission with
  provenance, artifact lineage, and convergence.
  See [workflow-engine](../design/workflow-engine.md).
- **Team runner:** Model A membership, the independent-first barrier, peer
  exchange rounds, synthesis, and phase acceptance.
  See [teams](../design/teams.md).
- **Profiles:** declarative domain procedures (`software-development`,
  `scientific-research`) built from node objectives and capability requirements.
  A profile never names a provider, browser, or account.
- **Does not own:** provider mechanics or protocol framing.

## Host

- **Owns:** the Cordis root context and loader. It composes the plugins named by
  the active profile and patches, validates every plugin `Config` at startup,
  isolates failures per plugin, and runs drain and shutdown.
- **Does not own:** business logic. The host never wires layers by hand.
  Dependencies are resolved through `inject`.

## Gateways

- **Responses gateway:** an OpenAI Responses-compatible endpoint (SSE) so Codex and
  other Responses clients can select `system` Workers as models.
- **Anthropic Messages gateway:** an Anthropic Messages-compatible endpoint (SSE) so
  Claude Code and other Messages clients can do the same. It shares the turn broker
  with the Responses gateway.
- **MCP server:** exposes `system` capabilities and the per-turn tool bridge.
- **CLI and Web UI:** the operator surface for turns, workflows, accounts, remote
  login, and maintenance.
- **DSH bundle:** `system` plugins packaged as a DeepSeek Harness bundle, so a
  DSH profile can mount them. Because both sides use Cordis, no adapter code is
  needed ([plugin model](plugin-model.md#portability-to-other-hosts)).
- **Does not own:** orchestration state. Gateways translate protocols and enforce
  transport-level security only.
- **Design:** [gateways](../design/gateways.md).
