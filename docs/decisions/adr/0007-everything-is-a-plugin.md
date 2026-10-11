# ADR-0007: Everything is a plugin, on Cordis

- **Status:** Accepted
- **Date:** 2026-10-11
- **Related:** ADR-0001, ADR-0010, PROP-0001, INV-10

## Context

The maintainer wants `system` to follow the DeepSeek Harness (DSH) philosophy:
*everything is a plugin*. DSH puts it this way: "Every part of the product is a
plugin, including the model adapter, the tool registry, the session log, and the
agent loop itself, so each is replaceable from configuration. There is no
privileged core to patch." DSH implements this on **Cordis**, a plugin runtime
with contexts, services claimed by key, dependency injection (`inject`), scoped
isolation, typed events, and effects that are disposed when a plugin unloads
([analysis](../../research/dsh-analysis.md)).

[ADR-0001](0001-standalone-host.md) already decided that `system` is a standalone
host, not a DSH plugin. What remains open is what the host's composition root
is built on.

## Options

1. A hand-written composition root with constructor injection.
2. A generic dependency-injection container (InversifyJS, tsyringe, and similar).
3. **Cordis** as the plugin runtime, using DSH's seam pattern
   (definition, provider, consumer) and profile and patch composition.

## Decision

Option 3. The `system` host is a Cordis root context plus a loader. Every
architectural boundary is published as a seam
([plugin model](../../architecture/plugin-model.md)), and every feature is a
plugin. Profiles and patch files decide what runs. The package is
`@deepseek-ai/cordis` (MIT, published on npm), pinned to an exact version.

This does not contradict ADR-0001. Cordis is a plugin runtime, not an agent
framework, and `system` still owns its process, durable state, and lifecycle. It
does not depend on DSH packages.

## Consequences

- Any implementation can be replaced from configuration: browser engine,
  provider, store, agent runtime, or gateway. Scoped isolation lets one workflow
  use a different provider than another.
- `system` plugins can be shipped as a DSH bundle, which replaces a custom DSH
  adapter.
- Risks: the upstream Cordis is a release candidate, and DSH's build carries local
  modifications. Mitigations:
  1. pin an exact version;
  2. use only the stable primitives (plugin, inject, service, effect, isolate,
     events, loader);
  3. cover those primitives with a small conformance suite in M0;
  4. (Superseded: the runtime is Node, per
     [ADR-0018](0018-build-on-dsh-core.md).)
- Pure logic stays in libraries, not services, so the kernel does not grow
  unnecessary indirection.
- Revisit if Cordis becomes unmaintained or incompatible with Node. The
  seam definitions are plain classes, so a replacement runtime would affect only
  the composition root and the base class of each seam definition.
