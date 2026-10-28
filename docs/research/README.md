# Research

Research is **non-normative**. It records evidence and the analysis of external
systems that informed [PROP-0001](../proposals/0001-unified-system-architecture.md) and later proposals.
Nothing here changes `system` behavior until it is promoted into requirements,
decisions, architecture, or design.

| Document | Subject | Analysed revision |
|---|---|---|
| [agentos-analysis.md](agentos-analysis.md) | [tsuuanmi/AgentOS](https://github.com/tsuuanmi/AgentOS): Worker/Team semantic model | `main` @ 2026-10-11 |
| [internet-analysis.md](internet-analysis.md) | [tsuuanmi/internet](https://github.com/tsuuanmi/internet): browser providers + durable workflow | `main` @ 2026-10-11 |
| [dsh-analysis.md](dsh-analysis.md) | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness): Everything Is A Plugin, Cordis, seams | `main` @ 2026-10-11 |
| [jev-decision-model.md](jev-decision-model.md) | TypeSafe Jev decision model: routing decisions, prior art, brainstorm D1–D8 | 2026-10-11 (early access) |
| [efficient-system-inputs-2026-10-25.md](efficient-system-inputs-2026-10-25.md) | System's own research, brainstorm and audit runs on quota-aware assignment, Worker strengths, operator communication, handoffs, and Jev (inputs to PROP-0015) | 2026-10-25 |
| [reference-architectures.md](reference-architectures.md) | Claude (Anthropic), ChatGPT/OpenAI, Devin (Cognition): agent architecture patterns and verdicts | 2026-10-11 |
| [agent-protocols-a2a-acp.md](agent-protocols-a2a-acp.md) | A2A 1.0 vs ACP (Agent Client Protocol) vs native mailbox for direct Worker messaging and long-running work | 2026-10-11 |
| [chatgpt-login-and-remote-browser.md](chatgpt-login-and-remote-browser.md) | existing projects for ChatGPT email/password/TOTP login; remote browser components for Linux (noVNC over SSH) | 2026-10-11 |
| [m0-dsh-core-spike.md](m0-dsh-core-spike.md) | M0 spike: DSH profile residency, MCP over HTTP on `ctx.webServer`, `node:sqlite` revisions, credential storage, telemetry | 2026-10-11 |
| [dsh-community-plugins-review.md](dsh-community-plugins-review.md) | reuse review of DSH community plugins (MCP server, ChatGPT Web, credentials, DAG, A2A, teams) | 2026-10-11 |
| [browser-interaction-and-self-healing.md](browser-interaction-and-self-healing.md) | how drivers operate fast-changing website UIs: AgentOS, internet, codex-chatgpt-web, BrowserSkill, Stagehand, Playwright ARIA snapshots and healer, MCP browser servers, Healenium | 2026-10-11 |
| [codex-chatgpt-web-analysis.md](codex-chatgpt-web-analysis.md) | [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web): Codex ↔ ChatGPT Web bridge | v6.1.8 |
| [design-review-2026-10-22.md](design-review-2026-10-22.md) | review of the current design; production multi-agent lessons (Anthropic, Cognition, Manus, MAST); neighbouring projects (PAL MCP, claude-code-router, RouteLLM, LiteLLM…); token economics and optimization plugins (RTK, context-mode, Serena, caveman) | 2026-10-22 |
| [ecosystem-for-base-2026-10-22.md](ecosystem-for-base-2026-10-22.md) | existing projects, Claude Code primitives, and open standards for each core component of the Base version: adopt, adapt, or avoid (Agent SDK usage and hooks, sandbox-runtime, ccusage, Backlog.md, A2A, DBOS, OTel GenAI, MCP manifests) | 2026-10-22 |
| [provider-context-and-caching.md](provider-context-and-caching.md) | how context windows, prompt caching, and thinking tokens work at Claude, OpenAI, and Gemini, and the rules for `system` | 2026-10-22 |
| [quota-builtins-2026-10-24.md](quota-builtins-2026-10-24.md) | per-account quota from each provider's own readings: Claude Code's `rate_limit_event` and `get_usage`, the status line, the Codex app server's rate limits, agy's `/usage`, the websites and the Gemini API, local log reconstruction; why the five-hour share is unknown live | 2026-10-24 |
| [statistics-tooling-2026-10-23.md](statistics-tooling-2026-10-23.md) | statistics and experiment tooling for the feedback loop (SciPy, statsmodels, GrowthBook `gbstats`, MLflow, Optuna, Ax/BoTorch, PyMC): what PROP-0011's F2 reuses and builds | 2026-10-23 |
| [production-readiness-2026-10-28.md](production-readiness-2026-10-28.md) | what System should change next to be production-ready, ranked by value over cost, from the incidents of 2026-10-26..28, ahead of the DNA pilot | 2026-10-28 |

Each analysis ends with **Adopted** and **Not adopted** lists. Once its findings
are fully promoted, an analysis may be pruned, because git history keeps it.
