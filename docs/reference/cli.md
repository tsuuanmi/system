# CLI

> Hand-written from the `USAGE` text and the command handlers in
> [`packages/cli/src/bin.ts`](../../packages/cli/src/bin.ts) (`system --help` prints the usage);
> no generator checks it. Update it with any command change. Most commands talk to the running
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
Each command refuses a flag it does not take: `--deep` only on `research`, `--variant` and
`--task` (with `--holder` and `--generation`) only on `run`, `--repo`, `--ref`, and `--focus`
only on `review` (`--ref` and `--focus` only with `--repo`).

| Command | What it does |
|---|---|
| `system ask [--persist] [--session <id>] [--tier <t>] [--classification <c>] (<prompt…> \| -)` | ask the Worker the router admits: a website account, an API or local model, … (template `ask`) |
| `system research [--deep] [--classification <c>] (<question…> \| -)` | the research procedure: hypotheses, two cited reviews on two provider families, one evidence table, a critique on another family, conclusions (template `research`; `--deep`: its `deep` variant, whose reviews use Deep research) |
| `system brainstorm [--classification <c>] (<question…> \| -)` | decide a question as a team: proposals, sealed ballots, a debate on a split, a tie to you (template `brainstorm`, [teams](../design/teams.md)) |
| `system review [--repo <url> [--ref <r>] [--focus <glob>]…] [--classification <c>] (<criteria…> \| -)` | review as a team: the text given, or with `--repo` a public repository at one pinned commit (`--ref`: a branch, tag, or commit, default its HEAD; `--focus`: paths or globs to read first, repeatable); every finding's quote is checked, and a confirmed blocking finding decides `changes` (template `review`, [sources](../design/teams.md#sources)) |
| `system run <template> [--variant <v>] [--session <id>] [--persist] [--tier <t>] [--classification <c>] [--task <taskId> [--holder <owner> --generation <n>]] (<input…> \| -)` | start any [workflow template](workflow-templates.md), or one of its variants (a team: `brainstorm`, `review`). With `--task`, the run serves one attempt of that [board task](../design/workflow-engine.md#board-tasks), as MCP `run`'s `task` does: it claims the ready task, or takes the claim `board_claim` gave `--holder` at `--generation` (both or neither); a task not ready, or a stale claim, refuses it with nothing started |
| `system approve <runId> [--plan <id>] [--reject] [note…]` | approve (or reject) the plan a run is waiting on, bound to that exact plan (name it with `--plan` when several wait) |
| `system vote <runId> --decision <id> <option\|inconclusive> <rationale…>` | break a team's tie: the deciding vote, bound to that exact tie decision ([teams](../design/teams.md#tie)) |
| `system result <runId>` | wait for a run and print its answer; when it waits on a plan or a tie, print the `approve` or `vote` command to run and return (for a plan put to the approval queue, where to decide it: `system ui` or MCP `approvals_decide`) |
| `system watch <runId>` | the same as `result` |
| `system stop <runId> [reason]` | stop a run: running work is cancelled, nothing is resent. An agent run that started and that no process holds (between two liveness looks) gets a verdict first: found gone it ends, otherwise it ends held, for `system free` ([restart and liveness](../design/agent-runtimes.md#restart-and-liveness)) |
| `system free <agentRun> --agent-gone [--commit-worktree] [note…]` | free the session and worktree an agent run holds because it ended with its liveness unknown (MCP `agent_run_free`), on your word that its agent is gone: recorded first as your `reconciliation` decision, the note as its rationale. Refused, changing nothing, while its liveness is still being looked at, another started run of its session or worktree has not finished, a process holds it, or its holder or agent process is present on this host. A worktree is removed only when it holds nothing uncommitted, or with `--commit-worktree` once its changes are committed on its branch; the branch stays, and a dirty one otherwise stays for the retention. Without `--agent-gone` nothing is asked ([runbook](../operations/runbooks.md#a-runs-liveness-is-unknown)) |
| `system worktrees [--json]` | the workflow runs' worktrees not removed yet (MCP `agent_worktrees`), oldest first, at most 100: each run's state (`in-use`, `held`, `finished`), what its worktree holds (`clean`, `uncommitted`, `gone`, `not-intact`), its path and branch, and when the retention removes it ([runbook](../operations/runbooks.md#remove-finished-run-worktrees)) |
| `system worktrees remove [--run <runId>] [--commit-changes] [note…]` | remove the finished run worktrees now instead of waiting for the retention (MCP `agent_worktrees_remove`), every one or one workflow run's, at most 50 a call: recorded first as your `retention` decision, the note as its rationale. A worktree is removed only when no agent run of its workflow run is unfinished or held, and only when it holds nothing uncommitted, or with `--commit-changes` once its changes are committed on its branch; nothing is discarded, and the branch stays. Each one kept says why ([runbook](../operations/runbooks.md#remove-finished-run-worktrees)) |
| `system continue <runId> [nodeId]` | reopen a failed run's failed node as a new attempt |
| `system delete <runId> [--yes]` | preview, then delete a finished run (artifacts stay) |
| `system supersede <runId> <nodeId> (<text…> \| -)` | replace a completed step's result; everything downstream runs again, and a planner downstream plans again (a planner's replacement must be a valid plan; what an old plan grew is retired) |
| `system usage [<limit>]` | the 10 most recent runs, or `<limit>` of them (at most 500): per step, the Worker, tier, and quota class used, a model Worker's tokens, and `usage unknown (<why>)` for a step whose usage the resource ledger could not count, which a cap counts as 0 ([resources](../design/resources.md#usage-the-ledger-cannot-count)) |
| `system report [--project <id>] [--since <time> \| --days <n>] [--until <time>] [--json]` | the baseline report, from recorded data only, of one project or every one: progress on the board, results and their reviews, what asked for you and how long you took, usage per pool, and cost per accepted result. The period is `--since` (inclusive) or the `--days` (default 7) before `--until` (exclusive, default now), at most 366 days: with no flag, the weekly investor report. `--json` prints the report itself ([reports](../design/reports.md), MCP `report`) |
| `system explain [--json] <runId\|artifact\|agentRun>` | the decision chain behind a run: first the decisions no step holds (`run`: for a board task's run, how it took the task, the session it resumed or not, a lost holder, the result's subject and acceptance, the report to the board, a funding gate, the digest), then each step's (egress, tier, route, acceptance), every attempt's in order, so a rejected answer and its escalation stay visible; each acceptance names the `result` it judged. Then its executions whose liveness needs a look (stalled, looked at, or ended not known to be gone): the verdict and its looks, each signal, what it holds, and what to do; an agent run `system health` lists is explained by its own id. For any other artifact, its input tree (`--json`: the tool's answer as it is) |
| `system artifact [--json] [--offset <n>] [--max <n>] <id>` | an artifact's header (kind, schema, classification, run, node, inputs) and a window of its body: an answer's text, else its JSON ([reading](../design/artifacts.md#reading)). One no longer stored prints as `expired` or `unknown` and exits 1 (operator; may be local-private) |
| `system evidence <id>` | the page outline a `ui.drift` event names: structure, never text (operator; local-private) |

## Models

| Command | What it does |
|---|---|
| `system model key <NAME>` | store a model route's API key from stdin, encrypted, under the credential reference its `apiKeyEnv` names ([runbook](../operations/runbooks.md#api-and-local-models)) |

## Notifications

| Command | What it does |
|---|---|
| `system notify webhook` | store the notification webhook's URL from stdin (never an argument), encrypted, under the credential reference the `notify` row names (`webhook.credential`, default `SYSTEM_NOTIFY_WEBHOOK_URL`); https, or http to this machine. Nothing is printed back. Refused while the `notify` row is off ([get notified](../operations/runbooks.md#get-notified)) |

## Accounts

| Command | What it does |
|---|---|
| `system account list` | list provider accounts and their status; agent accounts beside them (`kind: agent`: id, runtime, slot, status and why, masked hint, home, the reader and runtime version that verified it, the Workers that run there) |
| `system account login <id>` | open a remote login desktop (noVNC over `ssh -L`); Save stores the account |
| `system account login <runtime> [--slot <n>]` | enroll an agent account ([ADR-0051](../decisions/adr/0051-agent-accounts-are-enrolled-slots-identified-by-their-login.md)): take the runtime's lowest free slot (or that one; a taken slot is signed in again), run the runtime's own sign-in in the slot's home in this terminal without D-Bus, then verify who signed in; exit 0 when the account is `ready`. A slot 1 that just adopted the runtime's existing home is verified as it is ([runbook](../operations/runbooks.md#enroll-an-agent-account)) |
| `system account login <accountId>` | sign an agent account in again in its own home; a different principal quarantines it (`changed`) |
| `system account verify <accountId \| runtime --slot <n>> [--accept]` | read who is signed in to an agent account's home again and record it; `--accept` takes a `changed` slot's new principal as a new account (exit 0 when `ready`) |
| `system account remove <accountId \| runtime --slot <n>>` | free an agent account's slot; its home and the sign-in in it are kept |
| `system account migrate [--apply \| --rollback] [--stop <runtime>]…` | the move from hand-named agent Workers to Workers derived as account × role (PROP-0012 phase F, MCP `account_migrate`): print what each becomes, what stops the move (exit 1), and the new `agent-workers` row (and `resources` templates) as YAML; nothing changes. `--apply` applies it, refused while something stops the move or a run of a hand-named Worker is queued or running: an `enrollment` decision per Worker and for the cutover, each Worker's sessions and runs moved to its new id, and from then on the hand-named rows are refused at load. `--rollback` undoes it, refused while a run of a Worker it moved to is queued or running. `--stop <runtime>` (not with `--rollback`): that runtime's Workers stop at the cutover, its account not ready ([runbook](../operations/runbooks.md#migrate-agent-workers-to-accounts--roles)) |
| `system account credentials <id>` | store login credentials from stdin as JSON `{"email","password","totpSecret"?}` |
| `system account relogin <id>` | sign in again with the stored credentials (TOTP computed locally) |
| `system account code <id> <code>` | supply a one-time code a running sign-in is waiting for |
| `system account save <id>` | after an interactive login: capture, verify, store encrypted |
| `system account clear-cooldown <id> [feature]` | end a site usage limit on the account early: one feature, or every one ([ADR-0034](../decisions/adr/0034-unsent-failover-to-a-sibling-account.md)); `system account list` shows each account's limits in force (`cooldowns`) |
| `system account probe <id>` | prove which website features the account offers (Deep research, Web search, …) |
| `system account verify <id>` | re-verify a reauth-required account from its saved state, sending nothing: ready again if it still signs in as the saved account (exit 0), else it stays marked (exit 1) |

An agent account is named by its id (`<runtime>:<16 hex>`, with a `:`) or by its runtime; any
other name is a website account. `system account add`, and `remove` for website accounts, are
planned; website accounts are configuration ([`accounts`](configuration.md#accounts)).

## Operations

| Command | What it does |
|---|---|
| `system backup <dir> [--include-key]` | snapshot the store and the encrypted vault into an empty directory (the key only with `--include-key`) |
| `system restore <dir> [--yes] [--key <path>]` | preview, then restore a backup (the profile must be stopped; a manifest naming any file but the store and the vault is refused). A backup without the vault key needs one on this host: in the state directory, or at `--key` when the credentials row keeps it outside |
| `system drain [--deadline <s>]` | admit no new runs and wait for running ones (default 600 s) |
| `system resume` | admit new runs again after a drain |
| `system shutdown [--deadline <s>]` | drain, then stop the running profile (unfinished runs resume on start); with no workflow engine running, stop it directly once `/proc` proves it is this home's host |
| `system check [--env-file <file>]` | check the profile (its operator patch included) against this install's code before starting it; exit 1 names each problem. A plugin the install ships that cannot be resolved or loaded is a problem; only a row whose package the install does not ship (DSH's own, a third party's) is passed over. `--env-file` also checks the daemon unit's environment file ([below](#the-daemons-environment)); it prints names, never values |
| `system health [--json]` | each health check (plugins, manifests, configured templates, runtime, store, disk, vault key, website and agent accounts, Workers and the sources that describe them, run liveness (an agent run stalled, being looked at, or holding its session and worktree for want of a verdict, named), usage the resource ledger could not count, website conversations not deleted, login profiles, UI drift, retention, notifications that failed) and what to do; exit 0 healthy, 1 degraded, 2 down or not running |
| `system roster [--json]` | every Worker, from MCP `roster` ([roster](../design/roster.md)): its display name (`name`, such as `Claude Code · science · develop [code]`, [display names](../design/roster.md#display-names)), what it is for (its description, else a line marked derived), its availability (ready, busy N of M, resting at a limit until its reset, unavailable with why, quarantined with what its reading found), its account (id, label, and its enrolled or quarantined state), role, tier, quota class, family, load, the steps and board tasks it serves now (each in one sentence, with for how long), and its account's pools with each window's used share and reset and the runs whose usage the ledger could not count, and its runs whose liveness needs a look, each in one sentence; a fact it could not read shows `unknown (why)`. `--json` prints the record (`mcp-roster@1.5`). Exit 1 when the profile does not answer or refuses |
| `system plugins [--json]` | every plugin of the composition: its recorded lifecycle state (`default`, `candidate`, `retired`), whether a row runs it, its version and class, its rows, why its manifest is absent or refused, and each finding of the manifest check with the decision that recorded it ([plugin host](../design/plugin-host.md#the-manifest-check)) |
| `system ui` | print the web UI link, with the operator token in its fragment ([web UI API](web-ui.md)). The page: Home (what waits for you, the Workers at a glance, the latest runs), the approval queue (approve or deny one request or a whole batch; a `policy-change` request shows its diff), the reviews of board tasks (accept or reject the result shown), and the runs, their steps, and decision chains (approve or reject a plan, vote on a tie, stop, continue); the Board page's projects (pause, resume, or close one, each after a confirmation); the Workers tab (every Worker, as `system roster` shows it, one card each); and the Autonomy policy page (the set in force, the effective modes, and a proposed change, which applies only once approved in the queue) |

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

## The daemon's environment

The daemon runs under its user unit, `system.service`, whose `EnvironmentFile=`
(`~/.config/system/daemon.env`) declares every variable it reads
([Run as a service](../operations/runbooks.md#run-as-a-service)). `system check --env-file <file>`
refuses a file that others can read or that you do not own, a line that is not `NAME=VALUE` (or a
comment), a name set twice, a missing required name, a refused or unknown name, and a path that is
not absolute (systemd expands no variable or `~` there). The list is `DAEMON_ENV` in
[`packages/cli/src/index.ts`](../../packages/cli/src/index.ts).

| Name | Role |
|---|---|
| `PATH` | **required**: absolute directories where the daemon finds git, Xvfb, bwrap, the VNC server and websockify (remote login), and an agent runtime named without a path |
| `DSH_HOME` | **required**: the harness home, named so the unit never falls back to a default |
| `DSH_AGENTS_HOME` | DSH's agents directory (default `~/.agents`) |
| `CHROME_PATH` | a Chrome to use instead of the discovered or managed one |
| `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS` | the daemon's Node options; an extra CA bundle (a TLS-inspecting proxy) |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (and lowercase) | an egress proxy; agent runtimes keep it |
| `LANG`, `LC_ALL`, `TZ`, `TMPDIR` | locale, time zone, temporary directory |
| a row's `forwardEnv` names | a value an agent runtime forwards to its Workers by name, for example `SYSTEM_MCP_TOKEN` for a Codex Worker on the Responses gateway. A forwarded name the file lacks is a note: its Workers start without it |
| a row's `apiKeyEnv` | a credential reference: allowed, with a note. Set in the environment it shadows the vault, and `system model key` refuses it; keep keys in the vault |

Refused: `HOME`, `USER`, `LOGNAME`, `XDG_RUNTIME_DIR`, `CREDENTIALS_DIRECTORY` (systemd sets them);
`DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `SSH_AUTH_SOCK`,
`GPG_AGENT_INFO` (a login session's: a service shows nothing, and an invisible display is the
daemon's own Xvfb); `SYSTEM_CODEX_GATE_SOCKET`, `SYSTEM_CODEX_GATE_KEY` (the Codex runtime sets them
for its tool gate); `DSH_TELEMETRY_DISABLED` (`system start` sets it).
