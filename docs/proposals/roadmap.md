# Roadmap

Non-normative. This is an ordered queue of milestones for
[PROP-0001](0001-unified-system-architecture.md). What each stage must deliver,
and its exit criteria, are defined canonically in
[release scope](../requirements/release-scope.md). This file only orders the
work. Each milestone ends with working, tested software and updated canonical docs.

| Stage | Milestone | Scope |
|---|---|---|
| **MVP** | **M0 Host on DSH core + kernel + engineering** | pnpm workspace on Node, CI, doc and schema checks; `system` bundle + profile with only allow-listed DSH core rows (no `dsh-base`, [ADR-0019](../decisions/adr/0019-explicit-minimal-dsh-core.md)) and the `system` CLI wrapper; **spike** for ADR-0018's verification points (resident profile without web-app, MCP over HTTP on the DSH webserver, `node:sqlite` revisions, credential encryption); kernel adapters (store, blobs on DSH) and own seams (events, leases, artifacts with schema validation) |
| **MVP** | **M1 Provider runtime + ChatGPT Web** | invisible headed browser (Xvfb / off-screen), remote login, provider-agnostic multi-account vault, scheduler, receipts, `chatgpt-web` driver with `reason`, `web-search`, `deep-research`, and mode-to-tier mapping |
| **MVP** | **M1.5 First usable: `ask` + `research`** | MCP tools and CLI for `ask`/`research`/`status`/`result`, invisible headed browser, multi-account vault and login, receipts, minimal routing, one-node DAGs. **Slice 1** ([release scope](../requirements/release-scope.md#delivery-order-slice-1-first)) |
| **MVP** | **M2 Routing + DAG core + MCP + CLI** | Website Core, `workers-core` (admission, tiers, egress policy, quota exclusion, decision artifacts), the workflow-engine subset (static DAG) running research → compact, MCP server, CLI with `explain`. **MVP release** |
| **Beta** | **M3 Workers** | agent runtimes (Claude Agent SDK, Codex SDK, ACP), Gemini Web driver, connectors as capabilities, economy-tier API or local model provider |
| **Beta** | **M4 Orchestration** | full workflow engine (graph growth, `plan` artifacts, lineage invalidation), sessions with direct messaging and long-running mechanics, team runner, `software-development` profile, Web UI. **Beta release** |
| **v1.0** | **M5 Gateways** | Responses and Anthropic Messages gateways, shared turn broker, journaled client configuration, drain |
| **v1.0** | **M6 Second domain + readiness** | `scientific-research` profile, operations, validation, and reference docs, hardening, packaging, bundle publication, Web UI on DSH web app. **Production-ready release** |

**Progress (2026-10-11).** M0 is in progress on branch `m0/dsh-core-spike`.

- Done: the DSH core spike, `system-store`, `system-blobs`, `system-event-log`,
  `system-leases`, `system-artifacts`, `system-credentials-vault`,
  `system-mcp-server` (`status` live), the `system-bundle` profile, the `system`
  CLI, CI, and an e2e test through `dsh`.
- **M0 is complete pending review.** Both review rounds were addressed TDD-first.
- M1 is in progress on branch `m1/provider-runtime`, which is stacked on M0. Done so far: `provider-core` (scheduler, two-clock completion, reconciliation, failure taxonomy, the `Display` seam, `PortableState`), `turn-receipts`, `accounts`, `display-virtual` (Xvfb), and `browser-patchright` (headed Chrome per account, fresh context per turn, filtered capture), all mounted in the bundle. Also done: the pinned managed Chrome (`system init`, ADR-0020) and the UI engine `ui-ops` (UI maps as data, verified resolution, passive network signals, bounded self-heal; ADR-0021). The ChatGPT Web driver (`chatgpt-web.ui.yaml`, a fake-site fixture built from the live accessibility tree, Temporary and persistent conversations, the Chat-mode guard) is verified live. Also done: the `ctx.providers` registry, `ctx.mcp` tool contributions, and the Save flow (`ctx.login`, `system account save`). M1.5: `ask` and `research` work end to end through MCP (`ctx.turns`) and `system ask`, with model/tier presets, Deep research, ownership leases, restart reconciliation, audited self-heal, and X-authenticated displays. Since then, Deep research has been verified live (the report comes from its frame), along with state write-back, `system account login` (noVNC over `ssh -L`), and credential login with local TOTP (fixtures; the auth steps after the email page are not verified live). Claude Code is connected through MCP (`headersHelper`, with no token in its config) and verified end to end: Claude Code → `ask` → ChatGPT → answer. Codex connects through the `system mcp-stdio` shim. M2 so far: `ctx.egress` (classification policy and credential scan of the actual payload), abstract seam definitions with conformance suites (`display`, `browser`, `providers`, `mcp`, `workers`), and `ctx.workers` (Worker sources, fail-closed admission, a deterministic router with `tier`, `route`, and `admission` decisions), which now routes every turn. M2 also has the workflow engine's MVP subset (`ctx.workflow`): `ask` is a one-node run, and `research` is Deep research on `frontier` → a cited compaction on `economy`. It has durable node records, input-hash receipts, acceptance contracts (`acceptance` decisions), bounded retries, and recovery. MCP and the CLI serve `ask`, `research`, `result`, `usage` (which quota class and tier served each step), and `explain` (each step's decision chain). Verified live on 2026-10-12: `research` ran Deep research on `frontier`, then compacted it on `economy` into a synthesis citing the specification. `explain` showed egress, tier, route, and acceptance for both steps, and `usage` showed the quota class and tier of each. The same live runs found the Deep research layout drift and an unsafe restart snapshot; both are fixed, and a restart then recovered the run without resending. Open MVP checks that need the operator: a Codex model run, and credential login past the email page. M3 (Workers) has started:
- The engine now routes every node by capability across Worker sources.
- `ctx.agentRuntimes`, the `agents` Worker source, and a read-only Claude Agent SDK provider make Claude Code a Worker as well as a client.
- Verified live on 2026-10-12: a `review` run went to `agent:claude-review` on agent-plan quota. The Worker session had exactly `Read`, `Grep`, and `Glob`, no MCP servers, and no prompts.
- The live runs also found two defects, both fixed with tests: an omitted tool list became "no tools", and a stalled run had no deadline.

- Claude Code Workers now also have a confined `workspace-write` (verified live), so they prove `develop`.
- `runtime-acp` runs any ACP agent with a client-enforced policy, for agents the operator vouches for.

Next in M3, all of which need the operator: `runtime-codex-sdk` (a Codex CLI login), the Gemini Web driver (a Gemini account), connectors as capabilities, and an economy-tier model provider (an API key). Meanwhile, M4 orchestration continues: tier escalation, graph growth, and plan artifacts.

Later candidates, each needing its own proposal: A2A gateway and runtime
(cross-runtime peers), an ACP client gateway for editors, sandboxed or SSH `exec`
providers, additional website providers, and a desktop launcher.
