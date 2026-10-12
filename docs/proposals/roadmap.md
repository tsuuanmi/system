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

- `runtime-codex-sdk` makes Codex a Worker; verified live with a review on a read-only Codex Worker.
- The Gemini Web driver serves Temporary-chat turns on the Chat tab, with each tier's model and thinking level read back; verified live on 2026-10-12. Its persistent conversations and Deep research are not proven yet.

Next in M3, both of which need the operator: connectors as capabilities (`connector:<name>`), and an economy-tier model provider (an API key). M4 orchestration has started:
- Bounded tier escalation after a rejected result.
- Graph growth from validated `plan` artifacts, behind a plan approval gate for writing steps.
- Verified live on 2026-10-12: `investigate` planned a step, ran it, and synthesised an answer with its sources. An earlier live plan that named an unknown capability was refused (fail closed).
- Panel teams: independent first answers behind a barrier, critique rounds, and a cited synthesis. Members are persistent sessions, held to distinct accounts.

- Worker sessions with mailboxes and direct peer messaging (`ctx.workerSessions`), used by panel teams. Operator `stop`, `continue`, `delete`, and `supersede` (lineage invalidation).

- An operator web UI at `/ui` (`system ui`): runs, steps, decision chains, approve, stop, continue.

- The `develop` template, the software-development profile in MVP form: plan, the approval gate, local agents implement, a fresh-session review, and a report.

- Exact-head review: a review of an agent's change binds to the working tree's git subject, and its `assessment` is stored only if the subject still holds (an exact-subject gate). Only read-only Workers prove `review`. Verified live on 2026-10-12.

- Remediation cycles: a review that requests changes with blocking findings appends a fix and a re-review of the new subject, bounded at three reviews.
- Team leads: an optional lead after each round decides whether the members have converged, and later rounds then carry each member's last answer without sending anything. Verified live on 2026-10-12 on two ChatGPT accounts.

M4 is complete apart from handoff envelopes and re-planning after a superseded input. Its live checks (a panel on two accounts, the lead, wake-on-message) passed on 2026-10-12. The first wake check found that a team closed by its lead kept its barrier shut; this is fixed, with a test.

- Wake-on-message: an idle Worker session with unread mail takes one turn on its own Worker, and its reply goes to the peers who wrote, as an answer that wakes nobody. Verified live on 2026-10-12.

M6 has started:
- The `profiles` seam: `ctx.workflow.template` lets a profile plugin contribute templates. `develop` moved into `profile-software-development`.
- `profile-scientific-research` (`research`, `research-deep`; the earlier Deep research → compaction template is now `deep-research`): hypotheses, a cited review, an evidence table, an independent critique, and conclusions citing evidence. It has typed artifacts and invalidation, and was added with no engine change, which passes the architecture test (REQ-WF-9). Verified live on 2026-10-12.

- Long-running sessions: budgets on turns, lifetime, and idle time; `INPUT_REQUIRED`; checkpoints; and compaction into a handoff the session continues from in a new conversation (REQ-SES-6, REQ-SES-7). Structured results checked against their schema (REQ-ART-5), verified live.
- Website answers as Markdown, from the answer's Copy, checked against the render, with code blocks' lines from the page (REQ-PRV-5). Account features proven by a probe that sends nothing, and Web search turns (REQ-PRV-7). Both verified live.
- Codex as a Worker (`runtime-codex-sdk`, REQ-WRK-5): held to its own sandbox, and verified live with ChatGPT Web through the Responses gateway as its model.
- Readiness:
  - reference docs: a configuration catalog generated from every plugin's `Config`, MCP tool contracts from `system tools`, and gateway compatibility;
  - validation: traceability generated from test titles, and a release checklist on live accounts;
  - operations: runbooks and playbooks;
  - `system backup` and `system restore`.

M5 gateways have started:
- The Anthropic Messages gateway (`system claude-env`) lets Claude Code use website Workers as its model. Its tools go through a text protocol ([ADR-0022](../decisions/adr/0022-text-protocol-tool-calls-for-website-models.md)).
- Verified live on 2026-10-12: Claude Code ran a `Read` → `Edit` → answer loop on ChatGPT.
- The same runs found two issues, both fixed: ChatGPT hides tool-call-shaped JSON at the end of a reply, and it sometimes refuses until it is nudged.

- The Responses gateway (`system codex-env`) does the same for Codex. Both gateways share `gateway-turns`: the protocol, conversation threads, and the guard.
- Verified live on 2026-10-12: Codex fixed a bug through the gateway, with its indentation intact. That run found that ChatGPT's renderer collapses spaces outside code blocks, so tool calls now go in a code block (ADR-0022 amendment). Claude Code was rerun on the same protocol.

- Codex compacts locally for a custom provider, and the gateway follows it: the summary request continues the conversation, and the compacted history opens a new one.
- Host drain (REQ-HOST-1): the engine admits no new run while draining. `system drain`, `resume`, and `shutdown` wait for executing runs, then stop. Verified live on 2026-10-12.

M5 is complete apart from the journaled client configuration edits (REQ-HOST-3). `system claude-env` and `system codex-env` print commands rather than edit client files, so there is nothing to journal yet.

Later candidates, each needing its own proposal: A2A gateway and runtime
(cross-runtime peers), an ACP client gateway for editors, sandboxed or SSH `exec`
providers, additional website providers, and a desktop launcher.
