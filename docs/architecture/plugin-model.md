# Plugin model

> Target state. Decisions: [ADR-0007](../decisions/adr/0007-everything-is-a-plugin.md),
> [ADR-0018](../decisions/adr/0018-build-on-dsh-core.md) (build on DSH core).
> Invariants: [INV-10](invariants.md#inv-10-everything-is-a-plugin),
> [INV-11](invariants.md#inv-11-no-tool-lock-in).

`system` follows the **Everything Is A Plugin** philosophy of DeepSeek Harness,
and is built **on DSH core**. `system` is its own harness: a DSH bundle and
profile layered on `dsh-base`, running on the same plugin runtime,
[Cordis](../research/dsh-analysis.md). Every part of the product is a plugin, including the store, the provider drivers, the
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
| Kernel | `store` | **DSH** `ctx.storage` + `ctx.storageDomain` (sqlite provider), behind a `system` adapter | every stateful plugin |
| Kernel | `blobs` | **DSH** `ctx.attachments` (local provider), behind a `system` adapter | workflow, website |
| Kernel | `artifacts` (envelope, ids, lineage, schema validation, explain) | `artifacts-store` | every producer of results or decisions |
| Kernel | `events` | `events-store` | CLI, Web UI, observability |
| Kernel | `leases` | `leases-store` | scheduler, workflow |
| Provider runtime | `browser` | `browser-patchright` | provider drivers, remote login |
| Provider runtime | `display` | `display-virtual` (Xvfb), `display-offscreen`, `display-visible` (headless only in `dev` fakes) | browser, remote login ([browser runtime](../design/browser-runtime.md)) |
| Provider runtime | `accounts` | `accounts-vault` (secrets through **DSH** `ctx.credentials`) | provider runtime, admission |
| Provider runtime | `providers` (driver registry) | `provider-chatgpt-web`, `provider-gemini-web` | website capability |
| Capabilities | `website` | `website-core` | Worker providers |
| Capabilities | `exec` | **DSH** `ctx.shell` / `ctx.fs` / `ctx.sandbox` / `ctx.subprocess` (local, sandbox, SSH) | local-tools Worker |
| Capabilities | `models` (API and local model providers) | **DSH** `ctx.llm` (`llm-pi-ai`: OpenAI-compatible and others) | Worker providers, especially `economy`-tier jobs ([purpose P4](../requirements/purpose.md#p4-cheap-models-do-low-level-work-strong-models-do-hard-work)) |
| Capabilities | `agentRuntimes` | `runtime-claude-agent-sdk`, `runtime-codex-sdk`, `runtime-acp` | Worker providers ([agent runtimes](../design/agent-runtimes.md)) |
| Routing | `workers` (registry, admission, router, acceptance) | `workers-core` | orchestration, gateways |
| Orchestration | `workflow` | `workflow-engine` | gateways, CLI |
| Orchestration | `workerSessions` (Worker sessions, bindings, mailbox, wake, budgets) | `worker-sessions-store` | team runner, session nodes, MCP session tools ([design](../design/sessions-and-messaging.md)) |
| Orchestration | `teams` | `team-runner` | workflow |
| Orchestration | `profiles` (domain procedures) | `profile-software-development`, `profile-scientific-research` | workflow |
| Gateways | `clientProtocols` (shared turn broker) | `gateway-responses`, `gateway-anthropic-messages` | — (edge) |
| Gateways | — (consumers only) | `mcp-server` (own; DSH has only an MCP client), `cli` (wrapper around `dsh --profile system`), `web-ui` (on **DSH** web app), later `gateway-a2a` | — (edge) |

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

## DSH core reuse map

This table is the canonical record of what `system` reuses from DSH and what it
builds ([ADR-0018](../decisions/adr/0018-build-on-dsh-core.md)). DSH services
reach `system` domain plugins only through `system` seams or `system-dsh-*`
adapter plugins (lock-in safeguard 1).

| Concern | DSH package(s) | Use in `system` | Risk |
|---|---|---|---|
| plugin runtime, loader, profiles, patches, HMR, plugin manager, config editor | Cordis + `dsh-base` infrastructure rows | host, used as is | low |
| storage | `dsh-storage`, `dsh-storage-sqlite`, `dsh-storage-domain` | provider behind `ctx.store` | low–medium |
| attachments, spill | `dsh-attachment(-local)`, `dsh-spill(-local)` | provider behind `ctx.blobs`; spill for large tool output | medium |
| credentials, human-guided sign-in | `dsh-credentials(-local)`, `dsh-authorization` | secrets for `ctx.accounts`; encryption at rest verified in M0 | medium |
| approvals, questions | `dsh-user-approval`, `dsh-user-questions`, `dsh-permission-presets` | plan-approval gate (REQ-WF-11), `NEEDS_HUMAN`, `INPUT_REQUIRED` | low–medium |
| exec | `dsh-shell`, `dsh-fs`, `dsh-sandbox`, `dsh-subprocess` (+ SSH variants) | `ctx.exec` | low–medium |
| LLM adapters | `dsh-llm`, `dsh-llm-pi-ai`, `dsh-llm-retry` | `ctx.models`, the economy tier (P4) | low |
| compaction | `dsh-compaction-*` | reference for engine-owned summaries | low |
| skills, MCP client, web search and fetch | `dsh-skill*`, `dsh-mcp-client`, `dsh-web*` | available to DSH agents and local Workers | low |
| agent loop, tools, subagents (one-shot Claude Code / Codex / ACP) | `dsh-agent*`, `dsh-tools`, `dsh-subagent*` | optional local Worker and operator console; one-shot jobs | medium |
| webserver, API gateway | `dsh-host-webserver`, `dsh-api-gateway` | hosts the MCP Streamable HTTP endpoint and admin API (verified in M0) | medium |
| Web UI | `dsh-web-app`, `dsh-client-ui-*` | v1.0 operator UI with `system` UI plugins | high (churn) |
| ACP server | `dsh-acp` | optional editor client gateway | medium |
| **not provided by DSH; `system` builds it** | — | durable DAG engine, artifacts and decision records, leases, Worker routing, Worker sessions and mailbox, resumable agent runtimes, provider runtime (browser, display, accounts vault, drivers, receipts), MCP server, Responses and Messages gateways | — |
| **avoided in the MVP** (experimental) | agent teams, hook bridges, browser-use and computer-use providers, webhooks | — | high |

Defaults in the `system` profile: **telemetry disabled**, and DeepSeek-specific
rows (default models, account platform) disabled unless configured. One exact DSH
version is pinned.

## Composition

`system` is launched as a DSH profile, through the `system` CLI wrapper, which
runs `dsh --profile system`. What runs is decided entirely by configuration:

```text
empty entry list
  → dsh-base (DSH core)
  → @tsuuanmi/system-bundle (system plugins; disables unneeded or telemetry rows)
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

## Portability and exit path

`system` *is* a DSH bundle, so a DSH user can also mount `system` plugins in
their own profile. Moving off DSH is still possible, because every seam is
defined by `system` and the runtime is Cordis. It means replacing the
`system-dsh-*` adapters and the composition root, while domain plugins stay
unchanged. Claude Code and Codex reach `system` through protocols (MCP now, and
the Responses and Messages gateways later), so they are unaffected by the host
choice ([INV-11](invariants.md#inv-11-no-tool-lock-in)).
