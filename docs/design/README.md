# Design

This area owns **how mechanisms work**: algorithms, state machines, and protocols inside the
boundaries defined by [architecture](../architecture/README.md). It does not restate structure
or invariants. It links to them.

Each document describes the **target** mechanism and says so. It names its implementation in
one line, "Implemented in [package]; differs from target: …". The package READMEs own the
current state, and the [release checklist](../validation/release-checklist.md) owns what was
verified live.

| Document | Mechanism | Boundary |
|---|---|---|
| [browser-runtime.md](browser-runtime.md) | invisible headed browser (Xvfb), anti-leak launch, provider-agnostic multi-account vault, login flows | provider runtime |
| [ui-operations.md](ui-operations.md) | UI maps as data, deterministic resolution, passive network signals, bounded self-heal with local overlay | provider runtime |
| [provider-turns.md](provider-turns.md) | driver contract, turn receipts, reconciliation, two-clock completion, the turn path | provider runtime |
| [scheduling-and-leases.md](scheduling-and-leases.md) | per-account scheduler, exclusive fence, lease generations | provider runtime, kernel |
| [workflow-engine.md](workflow-engine.md) | DAG, durable nodes, briefs, graph growth, remediation, exact-subject gates, recovery, lineage | orchestration |
| [artifacts.md](artifacts.md) | artifact envelope, kinds, decision records, lineage, explain | kernel, orchestration |
| [routing.md](routing.md) | capability vocabulary, admission, data locality, intelligence tiers, quota-aware deterministic routing | routing |
| [board.md](board.md) | projects with charters, board tasks across runs, their states, leases, and fail-closed waits | orchestration (work state machine) |
| [approvals.md](approvals.md) | the autonomy policy and the one batched approval queue; expiry denies | routing (gate) |
| [digests.md](digests.md) | cited digests of raw artifacts on request: a read-only Worker on the economy tier, the quote check, failing open | orchestration (digest family) |
| [plugin-host.md](plugin-host.md) | plugin manifests generated from the code and checked against it; the composition's plugins and their lifecycle states, every change a decision | kernel (plugin host) |
| [resources.md](resources.md) | configured pools, limit readings, reservations before a run, deduplicated usage after it | routing (resource ledger) |
| [sessions-and-messaging.md](sessions-and-messaging.md) | Worker sessions (SessionId), direct peer messaging, long-running mechanics, A2A alignment | orchestration |
| [teams.md](teams.md) | the `team` option on a workflow node: Model A members, independent proposals, sealed ballots, tally, bounded debate, tie votes | orchestration |
| [agent-runtimes.md](agent-runtimes.md) | Claude Code, Codex, ACP agents as Workers | capabilities |
| [models.md](models.md) | API and local models as Workers: the model catalog, keys by reference, egress, bounds, restart; the `api-first` preset | capabilities |
| [gateways.md](gateways.md) | Messages and Responses gateways, the text tool protocol, threads, drain; MCP inversion as target | gateways |
| [reports.md](reports.md) | the baseline report: what a period recorded, per project or for every one, counted by code; the weekly investor report | gateways (surface) |
