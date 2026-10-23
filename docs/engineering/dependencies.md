# Dependency register

Policy: [ADR-0010](../decisions/adr/0010-reuse-before-build.md). Every external tool
sits behind a seam ([plugin model](../architecture/plugin-model.md)).

This file is the canonical list of what `system` reuses, adapts, or builds, on
which rung of the reuse ladder, and what was compared. Every change that adds a
runtime dependency or ports code updates this table. Exact versions are in each
package's `package.json`. **Status** is one of **in use**, **planned**, or
**dropped**.

## Reused and adapted

| Concern | Choice | Rung | Home | Status | Why, and what was compared |
|---|---|---|---|---|---|
| Host, plugin runtime | **DSH core**: only the allow-listed `@deepseek-ai/*` rows on Cordis, no `dsh-base` | library | host; [reuse map](../architecture/plugin-model.md#dsh-core-reuse-map) | in use | one exact pin, telemetry off ([ADR-0018](../decisions/adr/0018-build-on-dsh-core.md), [ADR-0019](../decisions/adr/0019-explicit-minimal-dsh-core.md)) |
| DSH launcher | `@deepseek-ai/dsh` | library | `cli` | in use | the supported way to run a DSH harness |
| Config validation | Schemastery (Cordis-native) | library | every plugin `Config` | in use | one schema system across plugins |
| Record and wire schemas | JSON Schema 2020-12, `ajv`, `ajv-formats` | spec + library | `libs`, `schemas/` | in use | strict mode ([ADR-0014](../decisions/adr/0014-json-schema-contracts.md)) |
| MCP server | `@modelcontextprotocol/sdk` (stateless Streamable HTTP) on DSH `ctx.webServer`, `zod` for tool schemas | protocol SDK | `mcp-server` | in use | DSH has only an MCP client ([review](../research/dsh-community-plugins-review.md)) |
| Cross-process writer lock | DSH `@deepseek-ai/dsh-atomic-write` `withFileLock` | library (DSH) | `credentials-vault` | in use | its `writeFileAtomic` skips fsync, so `libs` keeps `writeFileDurable` |
| DSH home path | `@deepseek-ai/dsh-home-paths` `resolveDshHome()` | library (DSH) | `libs` (`dshHome()`) | in use | DSH's own rule (a blank `$DSH_HOME` ignored, a relative one made absolute), so the CLI and the daemon agree on the home |
| Browser automation | `patchright-core` and a system Chrome, headed | library | `browser-patchright`, `ui-ops` | in use | removes automation leaks ([ADR-0016](../decisions/adr/0016-invisible-headed-browser-and-portable-accounts.md)); `@anweat/dsh-browser` is headless with no IndexedDB ([review](../research/dsh-community-plugins-review.md#browser-runtime-second-pass-2026-10-11)) |
| Managed Chrome download | `@puppeteer/browsers`, the build pinned in `chrome.lock.json` | library | `browser-patchright`, `system init` | in use | only when the host has no recent Chrome ([ADR-0020](../decisions/adr/0020-pinned-managed-chrome.md)) |
| Invisible display | Xvfb from system packages; own manager ported from internet | system tool + port | `display-virtual` | in use | uses `-displayfd` and X auth; `xvfb-run -a` and `@cypress/xvfb` guess display numbers |
| Agent read confinement | bubblewrap (`bwrap`) from system packages | system tool | `agent-runtime-core`, `agent-runtimes`, `runtime-claude-agent-sdk`, `runtime-codex-sdk`, `runtime-acp`, `runtime-antigravity-cli` | in use | unprivileged, already what Codex's own Linux sandbox and Flatpak use; Codex's permission profiles (schema changes between releases), Landlock through a native addon, and encrypting the state directory compared ([ADR-0024](../decisions/adr/0024-agent-workers-confined-for-reads.md)) |
| Remote login desktop | `@novnc/novnc`, `ws`; TigerVNC `x0vncserver` or `x11vnc` from system packages | library + system tool | `login` | in use | owner-only VNC unix socket, token, Host and origin checks, no Python; websockify, neko, and Kasm compared ([login](../../packages/plugins/login/README.md)) |
| TOTP codes | `otpauth` | library | `login` | in use | computed locally, never by a third-party site |
| UI maps | `yaml` | library | `ui-ops` | in use | maps are data ([ADR-0021](../decisions/adr/0021-ui-operations-as-data.md)) |
| Credential scan for egress | `@secretlint/core`, `@secretlint/secretlint-rule-preset-recommend` | library | `egress`, the repository secrets audit (`scripts/check-secrets.ts`, through `egress`'s `scan.ts`) | in use | a thin policy layer over secretlint; gitleaks (Go), detect-secrets (Python), and Presidio need another runtime |
| Exact git subjects and repository snapshots | the installed `git`, read-only, fixed arguments; 2.37 or later for snapshots (`http.curloptResolve` pins a connection to the checked address) | system tool | `libs` | in use | a review subject, and a review's files at a pinned commit, must match what git sees; isomorphic-git would reimplement it |
| Claude Code as a Worker | `@anthropic-ai/claude-agent-sdk`, running the operator's `claude` | protocol SDK | `runtime-claude-agent-sdk` | in use | exact tool list, `settingSources: []`, resume; © Anthropic, review the terms before a release |
| Claude Code Workers' confined commands | the Agent SDK's `sandbox` option: Anthropic's sandbox runtime as Claude Code ships it (bubblewrap and a `socat` network proxy on Linux; Apache-2.0) | protocol SDK feature, with `socat` from system packages | `runtime-claude-agent-sdk` | in use | nested in the host's read confinement; no new dependency: `@anthropic-ai/sandbox-runtime` directly would duplicate what the SDK ships ([ADR-0038](../decisions/adr/0038-confined-commands-for-claude-code-workers.md)) |
| Codex as a Worker | `@openai/codex-sdk`, running the operator's `codex` | protocol SDK | `runtime-codex-sdk` | in use | exact sandbox mode, resume; the run's tool gate through Codex's own PreToolUse hooks (CLI 0.164 behaviour, proven by the probe on each host), no new dependency ([runtime](../../packages/plugins/runtime-codex-sdk/README.md), [ADR-0042](../decisions/adr/0042-codex-workers-ask-the-gate-through-a-hook-bridge.md)) |
| ACP agents as Workers | `@agentclientprotocol/sdk`, client side over stdio | protocol SDK | `runtime-acp` | in use | client-enforced policy ([runtime](../../packages/plugins/runtime-acp/README.md)) |
| The Antigravity CLI as a Worker | the operator's installed `agy`, in print mode (`--output-format stream-json`), with one command hook (`hooks.json`) bridged to the run over a unix socket | system tool (CLI) | `runtime-antigravity-cli` | in use (row off by default) | agy publishes no SDK, and `agy --help` shows no ACP or server mode: print mode, stream-json, and the hook contract are its documented interface (agy 1.4.6). Nothing is depended on or vendored; the hook script is a small Node file of our own, shipped with the plugin ([runtime](../../packages/plugins/runtime-antigravity-cli/README.md)) |
| Agent child environment | DSH `@deepseek-ai/dsh-subprocess` `scrubbedParentEnv()`, with its peer `@deepseek-ai/dsh-http-proxy` (proxy variables) | library (DSH) | `agent-runtime-core` (`childEnvironment`) | in use | DSH's own scrub of credential-shaped and `DSH_*` names (INV-8); operator variables are forwarded by name on top. Hand-filtering `process.env` would duplicate it |
| Local exec (shell, fs, sandbox) | DSH `dsh-shell`, `dsh-fs`, `dsh-sandbox`, `dsh-subprocess` | library (DSH) | `ctx.exec` | planned | no seam is mounted |
| API and local models | DSH `dsh-llm` (`ctx.llm`) and `dsh-llm-pi-ai` (provider routes over `@earendil-works/pi-ai`, whose `pi-telemetry` dependency is contracts only, with no exporter) | library (DSH) | `models` (rows `llm`, `llm-pi-ai`) | in use | the allow-listed DSH rows; they need only `ctx.credentials` and resolve a route's key by reference through the vault. `dsh-llm-retry` is not mounted (it needs the agent loop and session log); `models` bounds its own re-attempts. A minimal own OpenAI-compatible client was the fallback, not needed ([models](../design/models.md)) |
| Versions and changelogs | Changesets (`@changesets/cli`), one `fixed` group | dev tool | repository root | in use | release-please and semantic-release derive versions from commit messages; Changesets records the bump with the change ([releasing](releasing.md)) |
| SBOM | `pnpm sbom` (CycloneDX), built into the package manager | dev tool | `scripts/release-artifacts.ts` | in use | `@cyclonedx/cdxgen` and `@cyclonedx/cyclonedx-npm` add a dependency; the package manager already resolves the exact production tree |
| Build provenance | `actions/attest-build-provenance`, pinned by SHA | CI action | `release` workflow | in use | SLSA provenance stored by GitHub, verified with `gh attestation verify`; no signing key to keep |

## Built, with what was compared

Each of these is built because nothing fits; the comparison is the reason.

| Concern | Ours | Home | Status | Compared and rejected |
|---|---|---|---|---|
| Durable records | tables on `node:sqlite` (WAL, `BEGIN IMMEDIATE`, revisions, migrations) | `store` | in use | DSH `dsh-storage`, `-domain`, `-json` are key-value only; relational records need transactions ([ADR-0003](../decisions/adr/0003-sqlite-durable-store.md)) |
| Event log | `ctx.eventLog` | `event-log` | in use | DSH `dsh-chunked-list`; `dsh-otel` is telemetry (banned). Ours commits in the same SQLite transaction (`afterCommit`) |
| Leases | `ctx.leases`, adapted from `@gm-hz/agent-dag-workflow` | `leases` | in use | proper-lockfile, redlock, DSH `withFileLock`; ours adds a generation fence ([scheduling](../design/scheduling-and-leases.md)) |
| Artifacts | `ctx.artifacts` | `artifacts` | in use | nothing in DSH; in-toto and W3C PROV are formats only. Decision artifacts (INV-13) |
| Credential encryption at rest | AES-256-GCM via `node:crypto`, `0600` key file; provides DSH `ctx.credentials` | `credentials-vault` | in use | DSH `dsh-credentials-local` is plain YAML; keytar needs a desktop keyring; sops and age are external tools |
| Provider runtime | scheduler, two-clock completion, reconciliation, failure taxonomy, ported from internet | `provider-core` | in use | p-queue, p-limit, DSH `dsh-jobs`; ours adds per-account capacity, fences, and generations ([ADR-0017](../decisions/adr/0017-credential-login-and-linux-remote-browser.md)) |
| Website UI operations | UI maps as data; audited, fail-closed self-heal | `ui-ops` | in use | Stagehand, Midscene, browser-use, Skyvern, Healenium, the Playwright healer need a debugging endpoint or their own browser, or are LLM-first ([research](../research/browser-interaction-and-self-healing.md)) |
| Accounts | `ctx.accounts`, an encrypted multi-account vault | `accounts` | in use | stored through DSH `ctx.credentials`, which holds secrets but has no accounts, tiers, or portable browser state |
| Website turns | durable turns, receipts before send, reconciliation | `turns`, `turn-receipts` | in use | DSH `dsh-jobs` is process-local, with no leases or receipts |
| ChatGPT Web driver | UI map, mode read-back | `provider-chatgpt-web` | in use | `@wlv-zedd/dsh-chatgpt-web` and miuuyy/codex-chatgpt-web read for patterns only |
| Gemini Web driver | UI map, mode read-back, Node | `provider-gemini-web` | in use | HanaokaYuzu/Gemini-API, Gemini-FastAPI, `gemi`: all Python, on private endpoints with raw cookies |
| Worker admission and routing | `ctx.workers`, fail-closed admission, decision artifacts | `workers`, `workers-core` | in use | DSH `ctx.subagents` picks a provider by name; Composio, claw-orchestrator, vibe-kanban dispatch without capability evidence |
| Model Workers | `ctx.models` over DSH `ctx.llm`, the `models` Worker source (durable calls, egress, bounds) | `models-core`, `models` | in use | DSH has the model call but no durable, routed, egress-checked Worker; `dsh-llm-retry` retries only agent-loop steps |
| Agent Workers | `ctx.agentRuntimes` providers, the `agents` Worker source | `agent-runtimes`, `agent-workers` | in use | DSH `dsh-subagent-claude-code`, `-codex`, `-acp`: one-shot, no resume or probe; Claude settings, hooks, and MCP servers apply; Codex sandbox left at its default |
| Workflow durability | one engine modelled on `@gm-hz/agent-dag-workflow` | `workflow` | in use | DSH `dsh-workflow`, `-ptc` (no journal or resume); Temporal, Restate, Inngest, Trigger.dev (need a server); DBOS TS (Postgres); Mastra and LangGraph.js lack lease generations, input-hash receipts, the never-resend rule, decision artifacts, and exact-subject gates ([ADR-0004](../decisions/adr/0004-single-workflow-runtime.md)) |
| Worker sessions | `ctx.workerSessions`: sessions, groups, mailboxes, barrier, decision artifacts | `worker-sessions` | in use | DSH `dsh-experimental-agent-team` is experimental and in-process ([ADR-0019](../decisions/adr/0019-explicit-minimal-dsh-core.md)) |
| Model gateways | `/anthropic` and `/openai` on the `gateway-turns` library | `gateway-anthropic`, `gateway-responses` | in use | claude-code-router, claude-code-proxy, LiteLLM, claudex translate API to API; ours drives web chat through durable, receipted runs ([ADR-0022](../decisions/adr/0022-text-protocol-tool-calls-for-website-models.md)). Nothing was ported from codex-chatgpt-web |
| Operator web UI | the small `/ui` page | `web-ui` | in use | DSH `dsh-web-app` needs `dsh-base` (ADR-0019); operator decision |
| CLI | the `system` binary with a stdio MCP shim | `cli` | in use | commander, citty; mcp-remote and supergateway would put the token in client config |

## Dropped

| Concern | Choice | Why |
|---|---|---|
| Blob store | own `blobs` plugin | no plugin consumed it ([ADR-0003 amendment](../decisions/adr/0003-sqlite-durable-store.md#amendment-2026-10-12-no-blob-store-until-a-consumer-exists)). DSH `dsh-attachment-local` was not adopted: it depends on the native `sharp`, requires a display name, and is not an allow-listed row (it already stores files by SHA-256 and verifies on read) |
| HTML to Markdown | `turndown` | drivers take Markdown from the site's own Copy |
| Token budgets | `tiktoken` | no package counts tokens |
| Types from schemas | `json-schema-to-typescript` | no package generates types; records are validated at runtime with Ajv |
| Approvals, user questions | DSH `dsh-user-approval`, `dsh-user-questions` | not mounted: plan approval is the engine's own (`approval.v1.json`) |
