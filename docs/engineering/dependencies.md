# Dependency register

> Planned. Policy: [ADR-0010](../decisions/adr/0010-reuse-before-build.md).
> Every external tool sits behind a seam ([plugin model](../architecture/plugin-model.md)).

This file is the canonical list of what `system` reuses, adapts, or builds, and on
which rung of the reuse ladder. Every PR that adds a runtime dependency or ports
code updates this table.

| Concern | Choice | Rung | Seam / home | Notes |
|---|---|---|---|---|
| Plugin runtime, DI, lifecycle | `@deepseek-ai/cordis` + loader | library | host | MIT; exact pin; primitives covered by a conformance suite ([ADR-0007](../decisions/adr/0007-everything-is-a-plugin.md)) |
| Config validation | Schemastery (Cordis-native) | library | every plugin `Config` | keeps one schema system across plugins |
| Durable records | `bun:sqlite` (Node: `better-sqlite3`) | library | `ctx.store` | [ADR-0003](../decisions/adr/0003-sqlite-durable-store.md); hand-written versioned migrations, no ORM |
| Browser automation | `patchright-core` + system Chrome | library | `ctx.browser` | proven in internet |
| Remote login display | Xvfb + x11vnc + noVNC | library / system tool | `ctx.display` | taken from system packages, not vendored |
| HTML → Markdown | `turndown` | library | provider drivers | |
| Token budgets | `tiktoken` | library | provider runtime, gateways | |
| MCP | `@modelcontextprotocol/sdk` | protocol SDK | `mcp-server` | |
| Claude Code as Worker | Claude Agent SDK | protocol SDK | `ctx.agentRuntimes` | check its license terms before release |
| Codex as Worker | `@openai/codex-sdk` | protocol SDK | `ctx.agentRuntimes` | Apache-2.0 |
| Other agents as Workers | `@agentclientprotocol/sdk` | protocol SDK | `ctx.agentRuntimes` | Apache-2.0 |
| Provider receipts, scheduler, account vault, remote login | port from internet | port | provider runtime | same maintainer; restructure into seams |
| Responses emulation, turn broker, completion fence, drain | port from codex-chatgpt-web | port | gateways | MIT; keep attribution in `THIRD_PARTY_NOTICES` |
| Local exec (shell, fs, sandbox) | evaluate DSH seam providers (`dsh-shell`, `dsh-fs`, `dsh-sandbox`) | adapt (candidate) | `ctx.exec` | adopt only if they mount outside DSH without DSH host packages; otherwise write a thin provider |
| Workflow durability | own engine | build | `ctx.workflow` | [ADR-0004](../decisions/adr/0004-single-workflow-runtime.md); Temporal and similar rejected until a concrete gap appears |
| Worker admission and routing, team policy | own | build | `ctx.workers`, `ctx.teams` | the semantic remainder: no existing tool provides these contracts |
