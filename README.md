# system

`system` is a local-first, **tool-agnostic** harness for capability-routed AI
Workers and durable multi-agent workflows. It is built **on DSH core** as its own
DSH bundle and profile, reusing DSH plugins without being locked in. Every part of
it is a plugin.

- **Workers:** browser-backed web providers (ChatGPT Web, Gemini Web), Claude
  Code, Codex, ACP agents, API providers, and local tools.
- **Workflows:** durable and reconcilable, built from Workers and teams.
- **Clients:** Codex (Responses API), Claude Code (Anthropic Messages API), any
  MCP client, and a CLI.

> Right Worker, right job. Every effect reconciled, never blindly replayed.

## Why

1. **Save tokens.** Website chat quota (ChatGPT, Gemini) is counted separately
   from API and coding-agent quota. Research and reasoning go there.
2. **Use what the websites already have.** That includes Deep Research, web
   search, and the connectors, apps, and plugins enabled on the account.
3. **Right Worker, right job.** Website Workers search and synthesize. Local
   Workers (Claude Code, Codex, local tools) work on local code and data, which
   stays local.
4. **Right model, right job.** Cheap models handle low-level work such as triage,
   extraction, summaries, and formatting. Strong models are kept for hard
   reasoning and final synthesis.

Full statement: [docs/requirements/purpose.md](docs/requirements/purpose.md).

## Status

**M1.5 (MVP slice 1 in progress).** `ask` and `research` run end to end
through MCP and the `system` CLI against ChatGPT Web, with a saved account, an
invisible headed Chrome, receipts, and reconciliation. The architecture is
accepted in [PROP-0001](docs/proposals/0001-unified-system-architecture.md), and
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

```sh
pnpm install && pnpm check && pnpm test
```

Implementation has started with the M0 spike. The toolchain and commands are in
[engineering](docs/engineering/development.md).

## Read next

- Humans and agents: [docs/README.md](docs/README.md) is the knowledge router.
- Coding agents: [AGENTS.md](AGENTS.md).
- Architecture at a glance: [docs/architecture/README.md](docs/architecture/README.md).
- Plugin model: [docs/architecture/plugin-model.md](docs/architecture/plugin-model.md).
