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
  (Messages)     │   own harness on DSH core (Cordis),    │──▶ ACP agents
  MCP clients ──▶│   single operator                      │──▶ API / local models
  CLI / Web UI ─▶│                                        │──▶ local tools / shell / git
                 └────────────────────────────────────────┘
                        │ durable state (SQLite + blobs)
                        ▼
                    <DSH_HOME>/system/
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
│               ctx.mcp (tools contributed by plugins) · CLI · Web UI       │
├───────────────────────────────────────────────────────────────────────────┤
│ Orchestration ctx.workflow (semantic DAG, durable nodes) · ctx.teams ·    │
│               ctx.workerSessions (SessionIds, direct messaging) ·         │
│               ctx.profiles                                                │
├───────────────────────────────────────────────────────────────────────────┤
│ Routing       ctx.workers: registry · admission · deterministic router ·  │
│               acceptance                                                  │
├───────────────────────────────────────────────────────────────────────────┤
│ Capabilities  ctx.website (Website Core) · ctx.exec (local tools) ·       │
│               ctx.agentRuntimes (Claude Agent SDK, Codex SDK, ACP) ·      │
│               ctx.models (API / local models, economy tier)               │
├───────────────────────────────────────────────────────────────────────────┤
│ Provider      ctx.turns (ask/research runtime) · ctx.turnReceipts ·       │
│ runtime       ctx.browser · ctx.display · ctx.accounts · ctx.login ·      │
│               ctx.providers (chatgpt-web driver) · UI engine (ui-ops) ·   │
│               scheduler · remote login                                    │
├───────────────────────────────────────────────────────────────────────────┤
│ Kernel        ctx.store (SQLite/WAL) · ctx.blobs · ctx.eventLog ·         │
│               ctx.leases · libraries: hashing, clock, schemas             │
╞═══════════════════════════════════════════════════════════════════════════╡
│ Host          DSH core (allow-listed rows) + system bundle · Cordis loader│
│               startup validation · drain                                  │
└───────────────────────────────────────────────────────────────────────────┘
```

The **host** is not a layer that contains business logic. It is **DSH core** on
Cordis: only the allow-listed DSH rows, with no `dsh-base`, plus the `system`
bundle, launched as the `system` profile
([ADR-0018](../decisions/adr/0018-build-on-dsh-core.md),
[ADR-0019](../decisions/adr/0019-explicit-minimal-dsh-core.md)). DSH
packages provide several seams, such as storage, attachments, credentials,
approvals, exec, and LLM adapters. The
[DSH core reuse map](plugin-model.md#dsh-core-reuse-map) lists which. Which providers run, and
whether a gateway is enabled at all, is decided by configuration.

## Where the ideas come from

Each layer combines the strongest ideas from the reference systems and removes
their known weaknesses. The full analysis lives in [research](../research/README.md).

| Concern | Primary source | Weakness removed |
|---|---|---|
| Host, plugin runtime, seams, composition, reusable plugins | DeepSeek Harness core / Cordis | used through `system` seams with pinned versions, so there is no lock-in ([ADR-0018](../decisions/adr/0018-build-on-dsh-core.md)) |
| Routing, teams | AgentOS | bound to an experimental harness API |
| Provider runtime, workflow durability | internet | no provider interface, lock-free JSON stores, two runtimes |
| Gateways | codex-chatgpt-web | Codex-only, unauthenticated control surfaces, monolithic modules |
