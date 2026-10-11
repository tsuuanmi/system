# DeepSeek Harness analysis (plugin philosophy)

Non-normative. Source:
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
(`docs/architecture.md`, `docs/cordis-primer.md`, `docs/capability-seams.md`,
`docs/glossary.md`), analysed on 2026-10-11. DSH is in developer preview, and its
README warns of compatibility-breaking changes.

## Everything is a plugin

> "Every part of the product is a plugin, including the model adapter, the tool
> registry, the session log, and the agent loop itself, so each is replaceable
> from configuration. There is no privileged core to patch: you extend dsh by
> mounting a plugin beside the others, and registrations are effects that unwind
> when their plugin unloads."

The rules stated in the repository:

- "Plugins, not loop changes": new behavior goes on documented extension points.
- A capability seam has **Service Definition / Service Provider / Consumer**
  roles. It is "complete, never one role".
- "No hardcoded tunables in plugins". Deployment-varying choices are validated
  `Config` fields. Protocol constants, external specifications, and security
  invariants stay fixed.
- "Every registration should have a disposer", and "dispose must reach
  quiescence".
- "Prefer events for interception and policy; prefer service methods for direct
  capability calls." The dispatch mode is part of the event's contract.
- "Model-visible means logged."

## Cordis primitives

- **Context:** a repository of services. `extend`, `isolate`, and `intercept`
  create scoped children without mutating the parent.
- **Plugin:** a function or object with `apply(ctx)`, optional `inject`, and a
  Schemastery `Config`, or a `Service` subclass.
- **Service:** claims a stable `ctx.<key>`. Consumers find it by key. Load order
  comes from `inject`.
- **Fiber:** one loaded plugin instance, with its state, config, and effects.
  Effects are disposed in reverse order when it unloads. Hot reload is supported.
- **Events:** dispatched with `emit`, `waterfall`, `parallel`, `serial`, or
  `bail`.
- **Isolation:** `ctx.isolate(name)` provides a different implementation to a
  subtree only.

Cordis runs standalone, with a root context and a loader that reads `cordis.yml`,
and has few dependencies. The upstream is `cordis` 4.0.0-rc. DSH vendors a fork
with logged local modifications and publishes it as `@deepseek-ai/cordis`.

## Seams and composition

Example seams with several providers:

- `ctx.shell`: bash-local, bash-sandbox, pwsh-local;
- `ctx.fs`: local, sandbox, ssh;
- `ctx.web`: several search providers;
- `ctx.llm`: several model adapters;
- `ctx.subagents`: in-process, ACP, Codex, Claude Code, DSH SDK.

A host is composed from **profiles** made of ordered **bundles**, then a profile
patch, a home patch, and `--patch` overlays. Patches either `insert` rows or
target a row by `id` to replace its fields, including `disabled`. Things that are
*not* plugins: pure libraries with one answer per process, such as transport
policy and timeout primitives ("rejected on microkernel grounds").

## Protocols

- DSH exposes **ACP** (stdio JSON-RPC) and an SDK JSON-RPC interface.
- It consumes MCP as a client.
- It does not serve OpenAI- or Anthropic-compatible endpoints.
- Claude Code and Codex are reached as **one-shot subagent providers** ("they do
  not gain multiple turns").

## Adopted

| Idea | Where in `system` |
|---|---|
| Everything is a plugin; Cordis as runtime | [ADR-0007](../decisions/adr/0007-everything-is-a-plugin.md), [plugin model](../architecture/plugin-model.md) |
| Three-role seams; plugin vs library rule | [plugin model](../architecture/plugin-model.md#what-is-not-a-plugin) |
| Profiles, bundles, patch composition | [plugin model](../architecture/plugin-model.md#composition) |
| No hardcoded tunables; disposers; events vs methods | [plugin rules](../architecture/plugin-model.md#plugin-rules) |

## Not adopted

- DSH itself as the host ([ADR-0001](../decisions/adr/0001-standalone-host.md)).
- One-shot-only Claude Code and Codex bridges. `system` uses the official SDKs
  with resume ([ADR-0009](../decisions/adr/0009-claude-and-codex-first-class.md)).
