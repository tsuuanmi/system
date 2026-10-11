# Architecture

This area owns the **structure** of `system`: its context, layers, plugin seams,
dependency direction, data flow, and cross-cutting invariants. It says *where*
behavior lives and under which constraints. *How* each mechanism works belongs in
[design](../design/README.md).

> Target state: proposed in [PROP-0001](../proposals/0001-unified-system-architecture.md).

## Documents

| Document | Owns |
|---|---|
| this README | system context and the layer map (canonical diagrams) |
| [invariants.md](invariants.md) | system-wide invariants (binding on all code) |
| [plugin-model.md](plugin-model.md) | everything-is-a-plugin: seams catalog, composition, plugin rules |
| [components.md](components.md) | each boundary: what it owns, what it does not own, its contracts |
| [data-flow.md](data-flow.md) | end-to-end flows across boundaries |

## System context

```text
   clients                                                         Workers
                 ┌────────────────────────────────────────┐
  Codex ────────▶│                                        │──▶ ChatGPT Web / Gemini Web (browser)
  (Responses)    │                                        │──▶ Claude Code  (Claude Agent SDK)
  Claude Code ──▶│              system host               │──▶ Codex        (Codex SDK)
  (Messages)     │   Cordis plugin runtime, loopback,     │──▶ ACP agents
  MCP clients ──▶│   single operator                      │──▶ API / local models
  CLI / Web UI ─▶│                                        │──▶ local tools / shell / git
                 └────────────────────────────────────────┘
                        │ durable state (SQLite + blobs)
                        ▼
                    ~/.system/
```

The same agent can appear on both sides. Claude Code or Codex can *use* `system`
as a client and can *be used* by `system` as a Worker
([ADR-0009](../decisions/adr/0009-claude-and-codex-first-class.md)). No side is
tied to a particular tool ([INV-11](invariants.md#inv-11-no-tool-lock-in)).

The operator is trusted. Remote websites, tool output, repository content, model
text, and third-party plugins that the operator has not installed are not (see the
[threat model](../security/threat-model.md)).

## Layer map

Every box below is a **plugin**. Each layer publishes its boundary as Cordis
services, or *seams*, and the layer above consumes them by key
([plugin model](plugin-model.md)). Dependencies point **downward only**. A layer
uses lower layers only through their seams and never reaches into a provider's
internals.

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ Gateways      Responses (Codex) · Anthropic Messages (Claude Code) ·      │
│               MCP server · CLI · Web UI            [consumers only]       │
├───────────────────────────────────────────────────────────────────────────┤
│ Orchestration ctx.workflow (semantic DAG, durable nodes) · ctx.teams ·    │
│               ctx.sessions (SessionIds, direct messaging, long-running) · │
│               ctx.profiles                                                │
├───────────────────────────────────────────────────────────────────────────┤
│ Routing       ctx.workers: registry · admission · deterministic router ·  │
│               acceptance                                                  │
├───────────────────────────────────────────────────────────────────────────┤
│ Capabilities  ctx.website (Website Core) · ctx.exec (local tools) ·       │
│               ctx.agentRuntimes (Claude Agent SDK, Codex SDK, ACP) ·      │
│               ctx.models (API / local models, economy tier)               │
├───────────────────────────────────────────────────────────────────────────┤
│ Provider      ctx.browser · ctx.display · ctx.accounts ·                  │
│ runtime       ctx.providers (chatgpt-web, gemini-web drivers) ·           │
│               scheduler · turn receipts · remote login                    │
├───────────────────────────────────────────────────────────────────────────┤
│ Kernel        ctx.store (SQLite/WAL) · ctx.blobs · ctx.events ·           │
│               ctx.leases · libraries: hashing, clock, schemas             │
╞═══════════════════════════════════════════════════════════════════════════╡
│ Host          Cordis root context + loader · profiles · patches ·         │
│               startup validation · drain                                  │
└───────────────────────────────────────────────────────────────────────────┘
```

The **host** is not a layer that contains business logic. It is the Cordis root
that loads the plugins named by the active profile. Which providers run, and
whether a gateway is enabled at all, is decided by configuration.

## Where the ideas come from

Each layer combines the strongest ideas from the reference systems and removes
their known weaknesses. The full analysis lives in [research](../research/README.md).

| Concern | Primary source | Weakness removed |
|---|---|---|
| Plugin runtime, seams, composition | DeepSeek Harness / Cordis | — (adopted as a library, not as the host) |
| Routing, teams | AgentOS | bound to an experimental harness API |
| Provider runtime, workflow durability | internet | no provider interface, lock-free JSON stores, two runtimes |
| Gateways | codex-chatgpt-web | Codex-only, unauthenticated control surfaces, monolithic modules |
