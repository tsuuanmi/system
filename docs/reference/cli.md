# CLI

> Hand-written from the `USAGE` text in
> [`packages/cli/src/bin.ts`](../../packages/cli/src/bin.ts) (`system --help` prints it); no
> generator checks it. Update it with any command change. Most commands talk to the running
> profile through its MCP endpoint, so the profile must be running (`system start`).

## Setup

| Command | What it does |
|---|---|
| `system init` | create or refresh the `system` DSH profile; ensure Chrome and Xvfb |
| `system browser install` | install the managed Chrome pinned in `chrome.lock.json` |
| `system start [dsh args…]` | boot the profile (for example `--patch ./overlay.yml`) |

## Work

`-` in place of the text reads it from stdin. `--classification` is `public`,
`operator-shared`, or `local-private`; `--tier` is `economy`, `standard`, or `frontier`.

| Command | What it does |
|---|---|
| `system ask [--persist] [--session <id>] [--tier <t>] [--classification <c>] (<prompt…> \| -)` | ask a website model through a saved account (template `ask`) |
| `system research [--classification <c>] (<question…> \| -)` | the research procedure: hypotheses, a cited review, evidence, critique, conclusions (template `research`) |
| `system run <template> [--session <id>] [--persist] [--tier <t>] [--classification <c>] (<input…> \| -)` | start any [workflow template](workflow-templates.md) |
| `system approve <runId> [--reject] [note…]` | approve (or reject) the plan a run is waiting on, bound to that exact plan |
| `system result <runId>` | wait for a run and print its answer |
| `system watch <runId>` | the same as `result` |
| `system stop <runId> [reason]` | stop a run: running work is cancelled, nothing is resent |
| `system continue <runId> [nodeId]` | reopen a failed run's failed node as a new attempt |
| `system delete <runId> [--yes]` | preview, then delete a finished run (artifacts stay) |
| `system supersede <runId> <nodeId> (<text…> \| -)` | replace a completed step's result; everything downstream runs again |
| `system usage [<limit>]` | recent runs: per step, the Worker, tier, and quota class used |
| `system explain <runId\|artifact>` | the decision chain behind a run (egress, tier, route, acceptance) |

## Accounts

| Command | What it does |
|---|---|
| `system account list` | list provider accounts and their status |
| `system account login <id>` | open a remote login desktop (noVNC over `ssh -L`); Save stores the account |
| `system account credentials <id>` | store login credentials from stdin as JSON `{"email","password","totpSecret"?}` |
| `system account relogin <id>` | sign in again with the stored credentials (TOTP computed locally) |
| `system account code <id> <code>` | supply a one-time code a running sign-in is waiting for |
| `system account save <id>` | after an interactive login: capture, verify, store encrypted |
| `system account probe <id>` | prove which website features the account offers (Deep research, Web search, …) |

`system account add` and `system account remove` are planned; accounts are configuration
([`accounts`](configuration.md#accounts)).

## Operations

| Command | What it does |
|---|---|
| `system backup <dir> [--include-key]` | snapshot the store and the encrypted vault into an empty directory (the key only with `--include-key`) |
| `system restore <dir> [--yes]` | preview, then restore a backup (the profile must be stopped) |
| `system drain [--deadline <s>]` | admit no new runs and wait for running ones (default 600 s) |
| `system resume` | admit new runs again after a drain |
| `system shutdown [--deadline <s>]` | drain, then stop the running profile (unfinished runs resume on start) |
| `system ui` | print the web UI link (runs, steps, decisions; approve, stop, continue) |

## Clients

| Command | What it does |
|---|---|
| `system mcp-config <claude\|codex>` | print client configuration for the running MCP server |
| `system mcp-stdio` | serve the running profile's MCP tools on stdio (Codex and other clients) |
| `system mcp-token` | print the bearer token (for an environment variable) |
| `system mcp-headers` | print the `Authorization` header as JSON (Claude Code `headersHelper`) |
| `system claude-env` | print a command that runs Claude Code with website Workers as its model ([gateways](../design/gateways.md)) |
| `system codex-env` | print a command that runs Codex with website Workers as its model |
| `system tools [--markdown]` | list the MCP tools the running profile serves (`--markdown`: the [MCP tools](mcp-tools.md) page) |
