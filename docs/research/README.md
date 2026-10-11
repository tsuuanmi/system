# Research

Research is **non-normative**. It records evidence and the analysis of external
systems that informed [PROP-0001](../proposals/0001-unified-system-architecture.md).
Nothing here changes `system` behavior until it is promoted into requirements,
decisions, architecture, or design.

| Document | Subject | Analysed revision |
|---|---|---|
| [agentos-analysis.md](agentos-analysis.md) | [tsuuanmi/AgentOS](https://github.com/tsuuanmi/AgentOS): Worker/Team semantic model | `main` @ 2026-10-11 |
| [internet-analysis.md](internet-analysis.md) | [tsuuanmi/internet](https://github.com/tsuuanmi/internet): browser providers + durable workflow | `main` @ 2026-10-11 |
| [dsh-analysis.md](dsh-analysis.md) | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness): Everything Is A Plugin, Cordis, seams | `main` @ 2026-10-11 |
| [jev-decision-model.md](jev-decision-model.md) | TypeSafe Jev decision model: routing decisions, prior art, brainstorm D1–D8 | 2026-10-11 (early access) |
| [reference-architectures.md](reference-architectures.md) | Claude (Anthropic), ChatGPT/OpenAI, Devin (Cognition): agent architecture patterns and verdicts | 2026-10-11 |
| [agent-protocols-a2a-acp.md](agent-protocols-a2a-acp.md) | A2A 1.0 vs ACP (Agent Client Protocol) vs native mailbox for direct Worker messaging and long-running work | 2026-10-11 |
| [chatgpt-login-and-remote-browser.md](chatgpt-login-and-remote-browser.md) | existing projects for ChatGPT email/password/TOTP login; remote browser components for Linux (noVNC over SSH) | 2026-10-11 |
| [m0-dsh-core-spike.md](m0-dsh-core-spike.md) | M0 spike: DSH profile residency, MCP over HTTP on `ctx.webServer`, `node:sqlite` revisions, credential storage, telemetry | 2026-10-11 |
| [dsh-community-plugins-review.md](dsh-community-plugins-review.md) | reuse review of DSH community plugins (MCP server, ChatGPT Web, credentials, DAG, A2A, teams) | 2026-10-11 |
| [codex-chatgpt-web-analysis.md](codex-chatgpt-web-analysis.md) | [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web): Codex ↔ ChatGPT Web bridge | v6.1.8 |

Each analysis ends with **Adopted** and **Not adopted** lists. Once its findings
are fully promoted, an analysis may be pruned, because git history keeps it.
