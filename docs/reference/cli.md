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
on `run`, `--repo`, `--ref`, and `--focus` only on `review` (`--ref` and `--focus` only with
`--repo`).

| Command | What it does |
|---|---|
| `system ask [--persist] [--session <id>] [--tier <t>] [--classification <c>] (<prompt…> \| -)` | ask the Worker the router admits: a website account, an API or local model, … (template `ask`) |
| `system research [--deep] [--classification <c>] (<question…> \| -)` | the research procedure: hypotheses, two cited reviews on two provider families, one evidence table, a critique on another family, conclusions (template `research`; `--deep`: its `deep` variant, whose reviews use Deep research) |
| `system brainstorm [--classification <c>] (<question…> \| -)` | decide a question as a team: proposals, sealed ballots, a debate on a split, a tie to you (template `brainstorm`, [teams](../design/teams.md)) |
| `system review [--repo <url> [--ref <r>] [--focus <glob>]…] [--classification <c>] (<criteria…> \| -)` | review as a team: the text given, or with `--repo` a public repository at one pinned commit (`--ref`: a branch, tag, or commit, default its HEAD; `--focus`: paths or globs to read first, repeatable); every finding's quote is checked, and a confirmed blocking finding decides `changes` (template `review`, [sources](../design/teams.md#sources)) |
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
| `system explain [--json] <runId\|artifact>` | the decision chain behind a run (egress, tier, route, acceptance), every attempt's in order, so a rejected answer and its escalation stay visible; each acceptance names the `result` it judged |
| `system artifact [--json] [--offset <n>] [--max <n>] <id>` | an artifact's header (kind, schema, classification, run, node, inputs) and a window of its body: an answer's text, else its JSON ([reading](../design/artifacts.md#reading)). One no longer stored prints as `expired` or `unknown` and exits 1 (operator; may be local-private) |
| `system evidence <id>` | the page outline a `ui.drift` event names: structure, never text (operator; local-private) |

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
| `system account clear-cooldown <id> [feature]` | end a site usage limit on the account early: one feature, or every one ([ADR-0034](../decisions/adr/0034-unsent-failover-to-a-sibling-account.md)); `system account list` shows each account's limits in force (`cooldowns`) |
| `system account probe <id>` | prove which website features the account offers (Deep research, Web search, …) |
| `system account verify <id>` | re-verify a reauth-required account from its saved state, sending nothing: ready again if it still signs in as the saved account (exit 0), else it stays marked (exit 1) |

`system account add` and `system account remove` are planned; accounts are configuration
([`accounts`](configuration.md#accounts)).

## Operations

| Command | What it does |
|---|---|
| `system backup <dir> [--include-key]` | snapshot the store and the encrypted vault into an empty directory (the key only with `--include-key`) |
| `system restore <dir> [--yes]` | preview, then restore a backup (the profile must be stopped; a manifest naming any file but the store and the vault is refused) |
| `system drain [--deadline <s>]` | admit no new runs and wait for running ones (default 600 s) |
| `system resume` | admit new runs again after a drain |
| `system shutdown [--deadline <s>]` | drain, then stop the running profile (unfinished runs resume on start); with no workflow engine running, stop it directly once `/proc` proves it is this home's host |
| `system check` | check the profile (its operator patch included) against this install's code before starting it; exit 1 names each problem |
| `system ui` | print the web UI link (runs, steps, decisions; approve, stop, continue; the approval queue's verdicts) |

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
