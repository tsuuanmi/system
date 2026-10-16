# CLI

> Hand-written from the `USAGE` text in
> [`packages/cli/src/bin.ts`](../../packages/cli/src/bin.ts) (`system --help` prints it); no
> generator checks it. Update it with any command change. Most commands talk to the running
> profile through its MCP endpoint, so the profile must be running (`system start`).

## Setup

| Command | What it does |
|---|---|
| `system init [--preset default\|api-first]` | create or refresh the `system` DSH profile (a preset is kept until changed, [ADR-0025](../decisions/adr/0025-api-first-composition.md)); ensure Chrome and Xvfb when the browser row is mounted |
| `system browser install` | install the managed Chrome pinned in `chrome.lock.json` |
| `system start [dsh args…]` | boot the profile (for example `--patch ./overlay.yml`) |

## Work

`-` in place of the text reads it from stdin. `--classification` is `public`,
`operator-shared`, or `local-private`; `--tier` is `economy`, `standard`, or `frontier`.
Each command refuses a flag it does not take: `--deep` only on `research`, `--variant` only
on `run`.

| Command | What it does |
|---|---|
| `system ask [--persist] [--session <id>] [--tier <t>] [--classification <c>] (<prompt…> \| -)` | ask the Worker the router admits: a website account, an API or local model, … (template `ask`) |
| `system research [--deep] [--classification <c>] (<question…> \| -)` | the research procedure: hypotheses, two cited reviews on two provider families, one evidence table, a critique on another family, conclusions (template `research`; `--deep`: its `deep` variant, whose reviews use Deep research) |
| `system run <template> [--variant <v>] [--session <id>] [--persist] [--tier <t>] [--classification <c>] (<input…> \| -)` | start any [workflow template](workflow-templates.md), or one of its variants (a team: `brainstorm`, `review`) |
| `system approve <runId> [--plan <id>] [--reject] [note…]` | approve (or reject) the plan a run is waiting on, bound to that exact plan (name it with `--plan` when several wait) |
| `system vote <runId> --decision <id> <option\|inconclusive> <rationale…>` | break a team's tie: the deciding vote, bound to that exact tie decision ([teams](../design/teams.md#tie)) |
| `system result <runId>` | wait for a run and print its answer; when it waits on a plan or a tie, print the `approve` or `vote` command to run and return |
| `system watch <runId>` | the same as `result` |
| `system stop <runId> [reason]` | stop a run: running work is cancelled, nothing is resent |
| `system continue <runId> [nodeId]` | reopen a failed run's failed node as a new attempt |
| `system delete <runId> [--yes]` | preview, then delete a finished run (artifacts stay) |
| `system supersede <runId> <nodeId> (<text…> \| -)` | replace a completed step's result; everything downstream runs again, and a planner downstream plans again (a planner's replacement must be a valid plan; what an old plan grew is retired) |
| `system usage [<limit>]` | recent runs: per step, the Worker, tier, and quota class used, and a model Worker's tokens |
| `system explain <runId\|artifact>` | the decision chain behind a run (egress, tier, route, acceptance) |

## Models

| Command | What it does |
|---|---|
| `system model key <NAME>` | store a model route's API key from stdin, encrypted, under the credential reference its `apiKeyEnv` names ([runbook](../operations/runbooks.md#api-and-local-models)) |

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
| `system restore <dir> [--yes]` | preview, then restore a backup (the profile must be stopped; a manifest naming any file but the store and the vault is refused) |
| `system drain [--deadline <s>]` | admit no new runs and wait for running ones (default 600 s) |
| `system resume` | admit new runs again after a drain |
| `system shutdown [--deadline <s>]` | drain, then stop the running profile (unfinished runs resume on start) |
| `system ui` | print the web UI link (runs, steps, decisions; approve, stop, continue) |

## Clients

| Command | What it does |
|---|---|
| `system mcp-config <claude\|codex>` | print client configuration for the running MCP server |
| `system mcp-stdio` | serve the running profile's client-scope MCP tools on stdio (Codex and other clients) |
| `system mcp-token --scope model` | print the model gateways' token, for a model client's environment variable. Only the model scope is printed: the CLI uses the operator token itself, and the client helpers read the client token on each connection ([scopes](../../packages/plugins/mcp-server/README.md#scopes)). Refused while both gateway rows are off |
| `system mcp-headers` | print the `Authorization` header with the client token as JSON (Claude Code `headersHelper`) |
| `system claude-env` | print a command that runs Claude Code with website Workers as its model ([gateways](../design/gateways.md)). Refused while the `gateway-anthropic` row is off |
| `system codex-env` | print a command that runs Codex with website Workers as its model. Refused while the `gateway-responses` row is off |
| `system tools [--markdown]` | list the MCP tools the running profile serves (`--markdown`: the [MCP tools](mcp-tools.md) page) |

Both gateway rows are off in the default composition (PROP-0004); Claude Code reaches `system`
over MCP (`mcp-config`). A refused helper names the row and how to
[turn it back on](../operations/runbooks.md#turn-an-off-row-back-on).
