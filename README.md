# system

`system` is a standalone, local-first host for **capability-routed AI Workers and durable
multi-agent workflows**. It runs AI Workers through browser-backed web providers,
API providers, and local tools. It drives them through durable, reconcilable
workflows, and serves the result to clients such as Codex, MCP-capable agents, and
a CLI.

> Right Worker, right job. Every effect reconciled, never blindly replayed.

## Status

**Design phase.** The repository holds documentation only. The architecture is
proposed in [PROP-0001](docs/proposals/0001-unified-system-architecture.md), and
implementation follows the [roadmap](docs/proposals/roadmap.md).

## Simplest use case (target)

```text
codex  ──Responses API──▶  system gateway  ──▶  Worker router  ──▶  ChatGPT Web account
                                 ▲                                        │
                                 └──── MCP tool calls run locally ◀───────┘
```

1. Sign in a provider account once through the remote-login page.
2. Point a client (Codex, an MCP agent, or the `system` CLI) at the loopback gateway.
3. Run a single turn, or start a durable workflow such as research → implement →
   validate → review.

## Build / run / test

There is no code yet. The planned toolchain and commands are in
[engineering](docs/engineering/README.md).

## Read next

- Humans and agents: [docs/README.md](docs/README.md) is the knowledge router.
- Coding agents: [AGENTS.md](AGENTS.md).
- Architecture at a glance: [docs/architecture/README.md](docs/architecture/README.md).
