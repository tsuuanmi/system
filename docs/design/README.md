# Design

This area owns **how current mechanisms work**: algorithms, state machines, and
protocols inside the boundaries defined by [architecture](../architecture/README.md).
It does not restate structure or invariants. It links to them.

> Target state: these documents specify the mechanisms
> [PROP-0001](../proposals/0001-unified-system-architecture.md) will implement.
> Each becomes current-state design when its code lands.

| Document | Mechanism | Boundary |
|---|---|---|
| [browser-runtime.md](browser-runtime.md) | invisible headed browser (Xvfb / off-screen), anti-leak launch, provider-agnostic multi-account vault, login flows | provider runtime |
| [ui-operations.md](ui-operations.md) | UI maps as data, deterministic resolution, passive network signals, bounded self-heal with local overlay | provider runtime |
| [provider-turns.md](provider-turns.md) | turn receipts, reconciliation, two-clock completion | provider runtime |
| [scheduling-and-leases.md](scheduling-and-leases.md) | per-account scheduler, exclusive fence, lease generations | provider runtime, kernel |
| [workflow-engine.md](workflow-engine.md) | DAG, durable nodes, handoffs, exact-subject gates, recovery, lineage | orchestration |
| [artifacts.md](artifacts.md) | artifact envelope, kinds, decision records, lineage, explain | kernel, orchestration |
| [routing.md](routing.md) | capability vocabulary, admission, data locality, intelligence tiers, quota-aware deterministic routing | routing |
| [sessions-and-messaging.md](sessions-and-messaging.md) | Worker sessions (SessionId), direct peer messaging, long-running mechanics, A2A alignment | orchestration |
| [teams.md](teams.md) | Model A members, independent-first barrier, synthesis | orchestration |
| [agent-runtimes.md](agent-runtimes.md) | Claude Code, Codex, ACP agents as Workers | capabilities |
| [gateways.md](gateways.md) | Responses + Anthropic Messages emulation, MCP inversion, turn tokens, drain | gateways |
