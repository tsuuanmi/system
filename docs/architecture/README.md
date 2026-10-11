# Architecture

This area owns the **structure** of `system`: its context, layers, boundaries,
dependency direction, data flow, and cross-cutting invariants. It says *where*
behavior lives and under which constraints. *How* each mechanism works belongs in
[design](../design/README.md).

> Target state: proposed in [PROP-0001](../proposals/0001-unified-system-architecture.md).

## Documents

| Document | Owns |
|---|---|
| this README | system context and the layer map (canonical diagrams) |
| [invariants.md](invariants.md) | system-wide invariants (binding on all code) |
| [components.md](components.md) | each boundary: what it owns, what it does not own, its contracts |
| [data-flow.md](data-flow.md) | end-to-end flows across boundaries |

## System context

```text
                 ┌──────────────────────────────────────────────┐
  Codex ────────▶│                                              │──▶ ChatGPT Web / Gemini Web
  (Responses)    │                                              │    (real browser sessions)
  MCP agents ───▶│                 system host                  │──▶ API providers
  CLI / Web UI ─▶│      (loopback daemon, single operator)      │──▶ Local tools / shell / git
  DSH adapter ──▶│                                              │──▶ VCS hosting (via Workers)
                 └──────────────────────────────────────────────┘
                        │ durable state (SQLite + blobs)
                        ▼
                    ~/.system/
```

The operator is trusted. Remote websites, tool output, repository content, and
model text are not (see the [threat model](../security/threat-model.md)).

## Layer map

Dependencies point **downward only**. A layer may use the layers below it through
their published contract and never reaches past one into a lower layer's internals.

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ Gateways      CLI · Responses gateway · MCP server · DSH adapter · Web UI │
├───────────────────────────────────────────────────────────────────────────┤
│ Host          composition root: config, profiles, startup validation,     │
│               drain, failure isolation                                    │
├───────────────────────────────────────────────────────────────────────────┤
│ Orchestration Workflow engine (semantic DAG, durable nodes)               │
│               Team runner (Model A members, barrier, synthesis)           │
├───────────────────────────────────────────────────────────────────────────┤
│ Routing       Worker registry · admission predicates · deterministic      │
│               router · acceptance                                         │
├───────────────────────────────────────────────────────────────────────────┤
│ Capabilities  Website capability (Website Core + WebsiteProviderRuntime)  │
│               Local execution/tools · API provider capability             │
├───────────────────────────────────────────────────────────────────────────┤
│ Provider      BrowserPort (patchright) · provider drivers · account vault │
│ runtime       per-account scheduler · turn receipts · remote login        │
├───────────────────────────────────────────────────────────────────────────┤
│ Kernel        durable store (SQLite/WAL) · content-addressed blobs ·      │
│               event log · leases & fences · clock · canonical hashing     │
└───────────────────────────────────────────────────────────────────────────┘
```

The Host is the composition root. It *wires* every layer, but at runtime it sits
between Gateways and Orchestration: gateways ask the host for configured services
and never construct them.

## Where the ideas come from

The layer map combines three reference systems. Each layer adopts the strongest
mechanism from one of them and drops that system's known weakness. The full
analysis lives in [research](../research/README.md):

| Layer | Primary source | Weakness removed |
|---|---|---|
| Routing, Teams | AgentOS | bound to an experimental harness API |
| Provider runtime, Workflow durability | internet | no provider interface, lock-free JSON stores, two runtimes |
| Gateways | codex-chatgpt-web | unauthenticated control surfaces, monolithic modules |
