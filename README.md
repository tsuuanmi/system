# system

`system` is a standalone, local-first, **tool-agnostic** host for capability-routed
AI Workers and durable multi-agent workflows. Every part of it is a plugin.

- **Workers:** browser-backed web providers (ChatGPT Web, Gemini Web), Claude
  Code, Codex, ACP agents, API providers, and local tools.
- **Workflows:** durable and reconcilable, built from Workers and teams.
- **Clients:** Codex (Responses API), Claude Code (Anthropic Messages API), any
  MCP client, and a CLI.

> Right Worker, right job. Every effect reconciled, never blindly replayed.

## Status

**Design phase.** The repository holds documentation only. The architecture is
proposed in [PROP-0001](docs/proposals/0001-unified-system-architecture.md), and
implementation follows the [roadmap](docs/proposals/roadmap.md).

## Simplest use case (target)

```text
Codex ──────── Responses ──┐                                  ┌──▶ ChatGPT Web account
                           ├──▶ system gateway ──▶ Worker ───┼──▶ Claude Code / Codex
Claude Code ── Messages ───┘          ▲              router   └──▶ ACP agents, APIs, …
                                      │                          │
                                      └─ remote tool calls run ◀─┘
                                         in the client (MCP)
```

1. Sign in a provider account once through the remote-login page.
2. Point a client (Codex, Claude Code, an MCP agent, or the `system` CLI) at the
   loopback gateway.
3. Run a single turn, or start a durable workflow such as research → implement →
   validate → review.

## Build / run / test

There is no code yet. The planned toolchain and commands are in
[engineering](docs/engineering/README.md).

## Read next

- Humans and agents: [docs/README.md](docs/README.md) is the knowledge router.
- Coding agents: [AGENTS.md](AGENTS.md).
- Architecture at a glance: [docs/architecture/README.md](docs/architecture/README.md).
- Plugin model: [docs/architecture/plugin-model.md](docs/architecture/plugin-model.md).
