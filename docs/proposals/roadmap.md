# Roadmap

Non-normative. This is an ordered queue of milestones for
[PROP-0001](0001-unified-system-architecture.md). What each stage must deliver,
and its exit criteria, are defined canonically in
[release scope](../requirements/release-scope.md). This file only orders the
work. Each milestone ends with working, tested software and updated canonical docs.

| Stage | Milestone | Scope |
|---|---|---|
| **MVP** | **M0 Host on DSH core + kernel + engineering** | pnpm workspace on Node, CI, doc and schema checks; `system` bundle + profile on a pinned `dsh-base` (telemetry off) and the `system` CLI wrapper; **spike** for ADR-0018's verification points (resident profile without web-app, MCP over HTTP on the DSH webserver, `node:sqlite` revisions, credential encryption); kernel adapters (store, blobs on DSH) and own seams (events, leases, artifacts with schema validation) |
| **MVP** | **M1 Provider runtime + ChatGPT Web** | invisible headed browser (Xvfb / off-screen), remote login, provider-agnostic multi-account vault, scheduler, receipts, `chatgpt-web` driver with `reason`, `web-search`, `deep-research`, and mode-to-tier mapping |
| **MVP** | **M1.5 First usable: `ask` + `research`** | MCP tools and CLI for `ask`/`research`/`status`/`result`, invisible headed browser, multi-account vault and login, receipts, minimal routing, one-node DAGs. **Slice 1** ([release scope](../requirements/release-scope.md#delivery-order-slice-1-first)) |
| **MVP** | **M2 Routing + DAG core + MCP + CLI** | Website Core, `workers-core` (admission, tiers, egress policy, quota exclusion, decision artifacts), the workflow-engine subset (static DAG) running research → compact, MCP server, CLI with `explain`. **MVP release** |
| **Beta** | **M3 Workers** | agent runtimes (Claude Agent SDK, Codex SDK, ACP), Gemini Web driver, connectors as capabilities, economy-tier API or local model provider |
| **Beta** | **M4 Orchestration** | full workflow engine (graph growth, `plan` artifacts, lineage invalidation), sessions with direct messaging and long-running mechanics, team runner, `software-development` profile, Web UI. **Beta release** |
| **v1.0** | **M5 Gateways** | Responses and Anthropic Messages gateways, shared turn broker, journaled client configuration, drain |
| **v1.0** | **M6 Second domain + readiness** | `scientific-research` profile, operations, validation, and reference docs, hardening, packaging, bundle publication, Web UI on DSH web app. **Production-ready release** |

Later candidates, each needing its own proposal: A2A gateway and runtime
(cross-runtime peers), an ACP client gateway for editors, sandboxed or SSH `exec`
providers, additional website providers, and a desktop launcher.
