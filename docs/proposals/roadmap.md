# Roadmap

Non-normative. This is an ordered queue of milestones for
[PROP-0001](0001-unified-system-architecture.md). What each stage must deliver,
and its exit criteria, are defined canonically in
[release scope](../requirements/release-scope.md). This file only orders the
work. Each milestone ends with working, tested software and updated canonical docs.

| Stage | Milestone | Scope |
|---|---|---|
| **MVP** | **M0 Host + kernel + engineering** | Bun workspace, CI, doc and schema checks; Cordis host, loader, profiles and patches; kernel seams (store, blobs, events, leases, artifacts with schema validation) and libraries; Cordis primitives conformance suite on Bun (Node as fallback) |
| **MVP** | **M1 Provider runtime + ChatGPT Web** | browser, display, remote login, account vault, scheduler, receipts, `chatgpt-web` driver with `reason`, `web-search`, `deep-research`, and mode-to-tier mapping |
| **MVP** | **M2 Routing + DAG core + MCP + CLI** | Website Core, `workers-core` (admission, tiers, egress policy, quota exclusion, decision artifacts), the workflow-engine subset (static DAG) running research → compact, MCP server, CLI with `explain`. **MVP release** |
| **Beta** | **M3 Workers** | agent runtimes (Claude Agent SDK, Codex SDK, ACP), Gemini Web driver, connectors as capabilities, economy-tier API or local model provider |
| **Beta** | **M4 Orchestration** | full workflow engine (graph growth, `plan` artifacts, lineage invalidation), team runner, `software-development` profile, Web UI. **Beta release** |
| **v1.0** | **M5 Gateways** | Responses and Anthropic Messages gateways, shared turn broker, journaled client configuration, drain |
| **v1.0** | **M6 Second domain + readiness** | `scientific-research` profile, operations, validation, and reference docs, hardening, packaging, DSH bundle. **Production-ready release** |

Later candidates, each needing its own proposal: sandboxed or SSH `exec`
providers, additional website providers, and a desktop launcher.
