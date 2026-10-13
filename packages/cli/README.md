# @tsuuanmi/system-cli

The `system` command: a thin wrapper around the pinned `dsh` launcher, which is
the supported way to run a DSH harness
([ADR-0018](../../docs/decisions/adr/0018-build-on-dsh-core.md)).

| Command | Does |
|---|---|
| `system init` | writes `<DSH_HOME>/profiles/system` with **only** `@tsuuanmi/system-bundle` (no `dsh-base`, [ADR-0019](../../docs/decisions/adr/0019-explicit-minimal-dsh-core.md)), then runs `dsh plugin install`, keeps a usable Chrome (installing the pinned managed build when none exists, [ADR-0020](../../docs/decisions/adr/0020-pinned-managed-chrome.md)), and reports a missing Xvfb |
| `system ask [--persist] [--session <id>] [--tier <t>] [--classification <c>] (<prompt> \| -)` | asks through the running profile's MCP `ask`, then polls `result` with the `runId` until the answer arrives; prints the answer (and the session id for persistent asks) |
| `system research [--classification <c>] (<question> \| -)` | starts the `research` run (the research profile: hypotheses, a cited literature review, an evidence table, an independent critique, conclusions per hypothesis), prints step progress to stderr, and prints the conclusions. `system run deep-research` runs Deep research, then a cited compaction |
| `system run <template> [flags] (<input> \| -)` | starts any workflow template through MCP `run`, for example `review` on a local agent Worker, and prints the answer |
| `system approve <runId> [--plan <id>] [--reject] [note]` | the operator's verdict on the plan a run waits on (MCP `approve`), bound to that exact plan; `--plan` names the plan read, and is required when several plans wait (a run waiting for approval prints the command with its plan id). Approving then waits for the run |
| `system drain [--deadline <s>]`, `system resume`, `system shutdown [--deadline <s>]` | host drain (REQ-HOST-1). `drain` stops admitting new runs and waits until nothing is executing, or until the deadline (default 600 s); `resume` admits runs again; `shutdown` drains, then sends SIGTERM to the running profile and waits for it to exit. Runs still executing at the deadline resume on the next start |
| `system stop <runId> [reason]`, `system continue <runId> [nodeId]`, `system delete <runId> [--yes]` | operator control of runs (REQ-WF-7): stop cancels running work and resends nothing; continue reopens the failed node as a new attempt; delete previews, then deletes on the exact version (artifacts stay) |
| `system supersede <runId> <nodeId> (<text> \| -)` | replaces a completed step's result with a corrected one (MCP `supersede`); everything downstream runs again |
| `system ui` | prints the operator web UI link (`/ui/#token=…`, the operator token in the fragment only): runs, steps, decision chains, approve, stop, continue |
| `system result <runId>` | waits for a run and prints its answer |
| `system usage [<limit>]` | recent runs: per step, the Worker, tier, and quota class that served it (usage report) |
| `system explain <runId\|artifact>` | a run's decision chain per step (egress, tier, route or admission, acceptance), or any artifact's input tree |
| `system account login <id>` | opens the remote login desktop through the running profile (`account_login`). Prints the `ssh -L` command and URL, then waits until Save has stored the account (its revision increases) |
| `system account list` / `system account save <id>` | call the running profile's `account_list` / `account_save` MCP tools, authenticated from the discovery file. Save runs after an interactive login |
| `system browser install` | installs the managed Chrome pinned in `chrome.lock.json` under `<DSH_HOME>/system/browsers` |
| `system start [dsh args]` | runs `dsh --profile system …` with `DSH_TELEMETRY_DISABLED=1`. Like `init`, it first refuses a Node runtime outside [CON-2](../../docs/requirements/constraints.md) (the range and a `node:sqlite` NUL round trip) with the reason and exit 1, before writing or spawning anything |
| `system mcp-config claude\|codex` | prints the client configuration from the running profile's discovery file. For Claude Code it is a `claude mcp add-json --scope user` command whose `headersHelper` runs `system mcp-headers`, so the token never sits in Claude Code's config. For Codex it is a `[mcp_servers.system]` block that runs `system mcp-stdio`. The token is never printed into the command |
| `system claude-env` | prints a command that runs Claude Code on the Messages gateway (`ANTHROPIC_BASE_URL=…/anthropic`), with website Workers as its model. Its `apiKeyHelper` runs `system mcp-token --scope model`, so the model token is never printed or written to Claude Code's settings |
| `system codex-env` | prints a command that runs Codex with a `system` model provider on the Responses gateway (`…/openai/v1`). The model token reaches Codex only through `env_key`, set in a subshell from `system mcp-token --scope model`. Codex's retries are off, so a failure never resends a website turn |
| `system backup <dir> [--include-key]`, `system restore <dir> [--yes]` | back up the store (a `VACUUM INTO` snapshot, safe while running) and the encrypted vault, with a manifest of hashes. The vault key is included only with `--include-key`. Restore refuses a manifest that names any file but `system.db`, `vault.enc`, and `vault.key` (such as `../../.ssh/authorized_keys`), verifies the backup, previews it, refuses while the profile runs, and keeps the replaced store aside ([runbook](../../docs/operations/runbooks.md#backup-and-restore)) |
| `system account probe <id>` | proves which website features the account offers now (Deep research, Web search, Create image), reading the site without sending anything. Routing uses only proven features (REQ-PRV-7) |
| `system tools [--markdown]` | lists every MCP tool the running profile serves (`tools/list` as the operator). With `--markdown`, it prints the [reference page](../../docs/reference/mcp-tools.md), with a `Scope:` line per tool |
| `system mcp-token --scope model` | prints only the model token, for example `export SYSTEM_MCP_TOKEN="$(system mcp-token --scope model)"` (a Codex Worker on the Responses gateway). No other scope is printed: the CLI keeps the operator token to itself, and `mcp-headers` / `mcp-stdio` read the client token on each connection |
| `system mcp-stdio` | an MCP server on stdio that forwards tool listing and calls to the running profile, authenticating with the client token. Codex (and any client without a header helper) runs it as a local server, so no token sits in its config or environment |
| `system mcp-headers` | prints `{"Authorization": "Bearer …"}` with the client token for Claude Code's `headersHelper`, read from its `0600` token file on every connection |

The commands that call MCP tools (`ask`, `approve`, `stop`, `drain`, `tools`, and
the others) act for the operator, so they authenticate with the operator token. The
client helpers hand out narrower scopes
([scopes](../plugins/mcp-server/README.md#scopes)).

The e2e test [`tests/profile.e2e.ts`](tests/profile.e2e.ts) boots the real
profile, asserts the exact row set, and calls MCP.
