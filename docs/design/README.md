# Design

This area owns **how current mechanisms work**: algorithms, state machines, and
protocols inside the boundaries defined by [architecture](../architecture/README.md).
It does not restate structure or invariants. It links to them.

> Target state: these documents specify the mechanisms
> [PROP-0001](../proposals/0001-unified-system-architecture.md) will implement.
> Each becomes current-state design when its code lands.

| Document | Mechanism | Boundary |
|---|---|---|
| [provider-turns.md](provider-turns.md) | turn receipts, reconciliation, two-clock completion | provider runtime |
| [scheduling-and-leases.md](scheduling-and-leases.md) | per-account scheduler, exclusive fence, lease generations | provider runtime, kernel |
| [workflow-engine.md](workflow-engine.md) | DAG, durable nodes, handoffs, exact-subject gates, recovery, lineage | orchestration |
| [teams.md](teams.md) | Model A members, independent-first barrier, synthesis | orchestration |
| [gateways.md](gateways.md) | Responses emulation, MCP inversion, turn tokens, drain | gateways |
