# Plugin model

> Target state. Decision: [ADR-0007](../decisions/adr/0007-everything-is-a-plugin.md).
> Invariants: [INV-10](invariants.md#inv-10-everything-is-a-plugin),
> [INV-11](invariants.md#inv-11-no-tool-lock-in).

`system` follows the **Everything Is A Plugin** philosophy of DeepSeek Harness,
and uses the same plugin runtime, [Cordis](../research/dsh-analysis.md). Every
part of the product is a plugin, including the store, the provider drivers, the
router, the workflow engine, and each gateway. There is no privileged core to
patch. You extend `system` by mounting a plugin beside the others, and every
registration is an effect that unwinds when its plugin unloads.

## Vocabulary

| Term | Meaning |
|---|---|
| **plugin** | a module with `apply(ctx, config)`, optional `inject`, and a validated `Config`, or a Cordis `Service` subclass |
| **service** | a stable `ctx.<key>` claimed by one plugin. Consumers find it by key, never by importing an implementation |
| **seam** | a swappable capability with three roles: a **definition** (an abstract `Service` class that owns the key and its vocabulary types), one or more **providers**, and one or more **consumers** |
| **library** | a plain module with no `apply` and no service, used for pure logic that has nothing to swap |
| **profile** | a named, ordered composition of bundles plus the operator's patch file |
| **bundle** | a distributable set of config rows and the plugins they mount |

## Seam catalog

Each architectural boundary in [components](components.md) is published as one or
more seams. The providers listed are the planned first implementations. Others
can be added without changing consumers.

| Layer | Seam (`ctx.*`) | Planned providers | Main consumers |
|---|---|---|---|
| Kernel | `store` | `store-sqlite` | every stateful plugin |
| Kernel | `blobs` | `blobs-fs` | workflow, website |
| Kernel | `events` | `events-store` | CLI, Web UI, observability |
| Kernel | `leases` | `leases-store` | scheduler, workflow |
| Provider runtime | `browser` | `browser-patchright` | provider drivers, remote login |
| Provider runtime | `display` | `display-headless`, `display-xvfb`, `display-visible` | browser, remote login |
| Provider runtime | `accounts` | `accounts-vault` | provider runtime, admission |
| Provider runtime | `providers` (driver registry) | `provider-chatgpt-web`, `provider-gemini-web` | website capability |
| Capabilities | `website` | `website-core` | Worker providers |
| Capabilities | `exec` | `exec-local`, later a sandboxed or SSH provider | local-tools Worker |
| Capabilities | `agentRuntimes` | `runtime-claude-agent-sdk`, `runtime-codex-sdk`, `runtime-acp` | Worker providers ([agent runtimes](../design/agent-runtimes.md)) |
| Routing | `workers` (registry, admission, router, acceptance) | `workers-core` | orchestration, gateways |
| Orchestration | `workflow` | `workflow-engine` | gateways, CLI |
| Orchestration | `teams` | `team-runner` | workflow |
| Orchestration | `profiles` (domain procedures) | `profile-software-development`, `profile-scientific-research` | workflow |
| Gateways | `clientProtocols` (shared turn broker) | `gateway-responses`, `gateway-anthropic-messages` | — (edge) |
| Gateways | — (consumers only) | `mcp-server`, `cli`, `web-ui` | — (edge) |

Gateways only consume services, so they are plain plugins with no seam of their
own. The exception is the shared turn broker that the two client-protocol
gateways use ([gateways](../design/gateways.md)).

## What is not a plugin

A plugin exists only when something can really be swapped or scoped. These stay
**libraries**: canonical JSON and hashing, the pure reconciliation decision
function, the failure-class taxonomy, the timeout and deadline primitives, and the
record schemas. These pieces have exactly one correct answer per process, and
turning them into services would make the kernel "know too much".

A plugin that registers only event listeners, such as a policy hook, is a plugin
but not a seam.

## Composition

The host is a Cordis root context with a loader. What runs is decided entirely by
configuration:

```text
empty entry list
  → profile's ordered bundles (e.g. base, browser-providers, gateways)
  → profile patch file
  → operator home patch
  → --patch overlays from the command line
```

A patch can insert rows, or target a row by `id` to replace its `config`, set
`disabled`, or change `inject` or `isolate`. A targeted patch replaces the whole
config of that row and does not deep-merge. Removing a capability means
disabling its row. Deleting code is never required.

Examples:

- To run only the gateways against a remote host, disable the provider bundle.
- To swap the browser engine, disable `browser-patchright` and insert another
  provider of `ctx.browser`.
- To give one workflow a sandboxed `exec`, use an `isolate` scope with a different
  `exec` provider. The parent scope is unaffected.

## Plugin rules

1. **Plugins, not core changes.** New behavior goes on a documented seam or event.
   A change to a seam definition updates this document and the seam's conformance
   suite.
2. **A seam is complete.** It is defined with all three roles: definition,
   provider, and consumer. A definition is an abstract `Service` class, not a bare
   TypeScript `interface`, so it can own its `ctx` key.
3. **Every registration has a disposer**, and disposal reaches quiescence. Nothing
   outlives its plugin.
4. **No hardcoded tunables.** Anything that varies by deployment is a validated
   `Config` field. Protocol constants, external specifications, and security
   invariants stay fixed in code.
5. **Events for interception and policy, service methods for direct calls.** An
   event's dispatch mode (`emit`, `waterfall`, `parallel`, `serial`, `bail`) is part
   of its public contract.
6. **Durable state lives in the store, not in service memory.** A plugin reload
   never loses committed state.
7. **Every seam ships a conformance suite.** Every provider, including fakes,
   passes the same suite ([testing](../engineering/testing.md)).

## Portability to other hosts

Because `system` plugins are standard Cordis plugins, they can be packaged as a
**DeepSeek Harness bundle**, and a DSH profile can mount them. This replaces a
hand-written DSH adapter. It is the plugin-level counterpart of the protocol
gateways that serve Codex and Claude Code
([INV-11](invariants.md#inv-11-no-tool-lock-in)).
