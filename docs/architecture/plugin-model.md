# Plugin model

> Target state. Decisions: [ADR-0007](../decisions/adr/0007-everything-is-a-plugin.md),
> [ADR-0018](../decisions/adr/0018-build-on-dsh-core.md) (build on DSH core),
> [ADR-0019](../decisions/adr/0019-explicit-minimal-dsh-core.md) (only the DSH core rows we use).
> Invariants: [INV-10](invariants.md#inv-10-everything-is-a-plugin),
> [INV-11](invariants.md#inv-11-no-tool-lock-in).

`system` follows the **Everything Is A Plugin** philosophy of DeepSeek Harness,
and is built **on DSH core**. `system` is its own harness: a DSH bundle and
profile that mounts only the DSH core rows it uses (no `dsh-base`), running on
the same plugin runtime,
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
| Kernel | `store` | `@tsuuanmi/system-store` (`system` tables on `node:sqlite`) | every stateful plugin |
| Kernel | `blobs` | `@tsuuanmi/system-blobs` (DSH `ctx.attachments` is prompt-attachment oriented, so not reused) | workflow, website |
| Kernel | `artifacts` (envelope, ids, lineage, schema validation, explain) | `@tsuuanmi/system-artifacts` | every producer of results or decisions |
| Kernel | `eventLog` (named so because Cordis owns `ctx.events`) | `@tsuuanmi/system-event-log` | CLI, Web UI, observability |
| Kernel | `leases` | `@tsuuanmi/system-leases` | scheduler, workflow |
| Provider runtime | `browser` (`openTurn`, `capture`, `close`; ours to define, since DSH `ctx.browserUse` only names a model-facing tool provider) | `@tsuuanmi/system-browser-patchright` | provider drivers, remote login |
| Provider runtime | `display` (abstract `Display` in `@tsuuanmi/system-provider-core`; `prepare('invisible' \| 'visible')`, where `visible` is the operator's `DISPLAY` for every provider) | `@tsuuanmi/system-display-virtual` (Xvfb, Linux), `display-offscreen` (v1.0); never headless | browser ([browser runtime](../design/browser-runtime.md)) |
| Provider runtime | `login` (login profiles, Save) | `@tsuuanmi/system-login` | operators (`account_save`), remote login |
| Provider runtime | `accounts` | `@tsuuanmi/system-accounts` (records and credentials as encrypted grants in **DSH** `ctx.credentials`, provided by `@tsuuanmi/system-credentials-vault`) | provider runtime, admission |
| Routing | `egress` (INV-12: classification policy per Worker class + credential scan of the actual payload; `egress` decisions) | `@tsuuanmi/system-egress` | the turn runtime, before routing |
| Provider runtime | `turns` (the website Worker runtime: durable turns, the `website` Worker source that the engine starts work through, scheduling, receipts) | `@tsuuanmi/system-turns` | `ctx.workers` (as a source), so the workflow engine |
| Provider runtime | `turnReceipts` | `@tsuuanmi/system-turn-receipts` | provider drivers, recovery |
| Provider runtime | `providers` (driver registry) | `@tsuuanmi/system-providers` registry; drivers: `@tsuuanmi/system-provider-chatgpt-web`, `provider-gemini-web` | website capability |
| Capabilities | `website` | `website-core` | Worker providers |
| Capabilities | `exec` | **DSH** `ctx.shell` / `ctx.fs` / `ctx.sandbox` / `ctx.subprocess` (local, sandbox, SSH) | local-tools Worker |
| Capabilities | `models` (API and local model providers) | **DSH** `ctx.llm` (`llm-pi-ai`: OpenAI-compatible and others) | Worker providers, especially `economy`-tier jobs ([purpose P4](../requirements/purpose.md#p4-cheap-models-do-low-level-work-strong-models-do-hard-work)) |
| Capabilities | `agentRuntimes` (definition `AgentRuntimes` in `@tsuuanmi/system-agent-runtime-core`; registry `@tsuuanmi/system-agent-runtimes`) | `@tsuuanmi/system-runtime-claude-agent-sdk`, `@tsuuanmi/system-runtime-acp`; `runtime-codex-sdk` (planned) | `@tsuuanmi/system-agent-workers`, the `agents` Worker source ([agent runtimes](../design/agent-runtimes.md)) |
| Routing | `workers` (Worker sources, fail-closed admission, deterministic router, acceptance contracts; definition `Workers` in `@tsuuanmi/system-workers-core`) | `@tsuuanmi/system-workers` | the turn runtime (route), the workflow engine (accept) |
| Orchestration | `workflow` (MVP subset: static DAG templates, durable nodes, acceptance, retries, recovery; drain and resume (REQ-HOST-1); MCP `ask`, `research`, `result`, `usage`, `explain`) | `@tsuuanmi/system-workflow` | MCP clients, CLI |
| Orchestration | `workerSessions` (Worker sessions, groups, mailboxes, peer messages under policy and barriers; MCP `session_send`, `session_inbox`) | `@tsuuanmi/system-worker-sessions` | the workflow engine (panel teams), MCP clients ([design](../design/sessions-and-messaging.md)) |
| Orchestration | `teams` | `team-runner` | workflow |
| Orchestration | `profiles` (domain procedures; definition `ctx.workflow.template(name, nodes)` in `@tsuuanmi/system-workflow`, conformance `conformance/profiles.ts`) | `@tsuuanmi/system-profile-software-development` (`develop`), `@tsuuanmi/system-profile-scientific-research` (`study`, `study-deep`; built with no engine change, REQ-WF-9) | workflow |
| Gateways | `clientProtocols` (shared turn broker) | `@tsuuanmi/system-gateway-anthropic`, `@tsuuanmi/system-gateway-responses` (built without the broker; they share `@tsuuanmi/system-gateway-turns`, the text protocol of [ADR-0022](../decisions/adr/0022-text-protocol-tool-calls-for-website-models.md)) | — (edge) |
| Gateways | `mcp` (tools contributed by plugins for their lifetime; definition `McpTools` in `@tsuuanmi/system-gateway-core`) | `@tsuuanmi/system-mcp-server` (own; DSH has only an MCP client) | plugins that expose operations: `login` (`account_list`, `account_save`), `workflow` (`ask`, `research`, `result`, `usage`, `explain`) |
| Gateways | — (consumers only) | `cli` (wrapper around `dsh --profile system`), `@tsuuanmi/system-web-ui` (operator UI at `/ui` on the DSH webserver; the DSH web app is the v1.0 option), later `gateway-a2a` | — (edge) |

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

This table is the canonical **allow-list of DSH rows** that `system` mounts. The
`system` bundle inserts exactly these rows. It does **not** use `dsh-base`,
which mounts 94 rows ([ADR-0019](../decisions/adr/0019-explicit-minimal-dsh-core.md)).
DSH services reach `system` domain plugins only through `system` seams or
`system-dsh-*` adapter plugins (lock-in safeguard 1 of
[ADR-0018](../decisions/adr/0018-build-on-dsh-core.md)). Adding a row updates
this table and the composition test that asserts the exact row set.

| Stage | DSH row (package) | Serves | Risk |
|---|---|---|---|
| **slice 1** | `timer` (`@deepseek-ai/cordis-plugin-timer`) | deadlines, idle close, heartbeats | low |
| **slice 1** | `credentials` (`dsh-credentials` seam + a provider that encrypts at rest; `dsh-credentials-local` stores plain YAML, so it is used only in `dev`) | secrets for `ctx.accounts` | medium |
| **slice 1** | `webserver` (`dsh-host-webserver`, loopback) | MCP Streamable HTTP endpoint, admin API | medium |
| M2 | `approval`, `user-questions` (`dsh-user-approval`, `dsh-user-questions`) | plan-approval gate (REQ-WF-11), `NEEDS_HUMAN`, `INPUT_REQUIRED` | low–medium |
| Beta | `llm`, `llm-pi-ai`, `llm-retry` | `ctx.models`, the economy tier (P4) | low |
| Beta | `subprocess`, `sandbox`, `sandbox-policy`, `shell`/`fs` providers | `ctx.exec` for local-tool Workers | low–medium |
| Beta (optional) | `hmr` | development reloads | low |
| v1.0 | `dsh-web-app` rows, `dsh-client-ui-*` | operator Web UI | high (churn) |
| v1.0 (optional) | `dsh-acp` | ACP editor client gateway | medium |
| **never inserted** | telemetry (`otel`, `session-telemetry-otel`), DeepSeek account and default-model rows, agent loop, session log, tools, compaction, goals, skills, web search, plugin manager, config editor | not needed by `system`; inserted later only when a requirement asks for them | — |
| **not provided by DSH; `system` builds it** | — | durable DAG engine, artifacts and decision records, leases, Worker routing, Worker sessions and mailbox, resumable agent runtimes, provider runtime (browser, display, accounts vault, drivers, receipts), MCP server, Responses and Messages gateways, records on `node:sqlite` | — |
| **avoided** (experimental) | agent teams, hook bridges, browser-use and computer-use providers, webhooks | — | high |

One exact DSH version is pinned for every row.

## Composition

`system` is launched as a DSH profile, through the `system` CLI wrapper, which
runs `dsh --profile system`. What runs is decided entirely by configuration:

```text
empty entry list
  → @tsuuanmi/system-bundle (the allow-listed DSH core rows + system plugins; no dsh-base)
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

## Seam definitions and conformance

| Seam | Definition (abstract `Service`) | Conformance suite | Providers that run it |
|---|---|---|---|
| `display` | `Display` in `@tsuuanmi/system-provider-core` | `provider-core/conformance/display.ts` | `display-virtual` (real Xvfb), the test fake `KillableDisplay` |
| `browser` | `Browser<Page, Context>` in `@tsuuanmi/system-provider-core` (engine-neutral) | `provider-core/conformance/browser.ts` | `browser-patchright` |
| `providers` | `ProviderRegistry` in `@tsuuanmi/system-provider-core` | `provider-core/conformance/providers.ts` | `providers` |
| `mcp` | `McpTools` in `@tsuuanmi/system-gateway-core` | `gateway-core/conformance/mcp-tools.ts` | `mcp-server` (listed through a real MCP client) |
| `workers` | `Workers` in `@tsuuanmi/system-workers-core` | `workers-core/conformance/workers.ts` | `workers` |
| `agentRuntimes` | `AgentRuntimes` in `@tsuuanmi/system-agent-runtime-core`, plus a provider suite | `agent-runtime-core/conformance/agent-runtimes.ts` | `agent-runtimes` (registry); `runtime-claude-agent-sdk` (against a scripted SDK stream), `runtime-acp` (against a scripted ACP agent subprocess) |

Consumers depend on definitions only. `turns` and `login` no longer import the
browser, registry, or gateway implementations. The display suite found a defect
in the test fake (two Xvfbs for concurrent callers), which was then fixed.

## Known gaps (tracked)

- **Single-provider kernel and runtime seams.** `store`, `blobs`, `eventLog`,
  `leases`, `artifacts`, `accounts`, `turnReceipts`, `login`, `turns`, and
  `egress` are still concrete services with one provider each. They get an
  abstract definition and a suite when a second provider appears.
- **A scripted fake `ProviderDriver`** for testing the turn runtime without a
  browser is still to come; today the runtime is tested through a real browser on
  the fake site.
- **Agent runtimes, first slice.**
  - Only `runtime-claude-agent-sdk` exists. It offers `read-only` and
    `workspace-write`, with writes confined to the workspace (verified live).
    It runs no commands, so no agent Worker proves `validate` yet.
  - `runtime-acp` offers `read-only` only to agents the operator vouches for
    (`honoursPermissions`). The client cannot stop an agent's own direct
    effects.
  - `runtime-codex-sdk` is not built (no Codex CLI on the development host).
  - An agent run interrupted by a stop fails for the operator
    (`reconciliation_failed`); it is not resumed from its native session yet.
- **The workflow engine** has templates, plan-based graph growth, plan
  approval gates, panel teams, operator stop, continue, and delete, and lineage
  invalidation by `supersede`. Panel members talk through
  `ctx.workerSessions` mailboxes. It does not have profile growth rules, team
  leads, wake-on-message sessions outside rounds, or re-planning yet. The
  `develop` profile cannot yet bind a review to an exact git head: there is no
  confined command execution.
- **Capability evidence is declared, not probed.** A website Worker proves what its
  driver declares (`ProviderDriver.capabilities`, covered by the driver's tests).
  Per-account probes, for example whether an account's plan offers Deep research,
  come with P2. Quota exhaustion is not yet observed, so no Worker reports
  `quota-exhausted`.
