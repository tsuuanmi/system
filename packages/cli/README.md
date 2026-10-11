# @tsuuanmi/system-cli

The `system` command: a thin wrapper around the pinned `dsh` launcher, which is
the supported way to run a DSH harness
([ADR-0018](../../docs/decisions/adr/0018-build-on-dsh-core.md)).

| Command | Does |
|---|---|
| `system init` | writes `<DSH_HOME>/profiles/system` with **only** `@tsuuanmi/system-bundle` (no `dsh-base`, [ADR-0019](../../docs/decisions/adr/0019-explicit-minimal-dsh-core.md)), then runs `dsh plugin install`, keeps a usable Chrome (installing the pinned managed build when none exists, [ADR-0020](../../docs/decisions/adr/0020-pinned-managed-chrome.md)), and reports a missing Xvfb |
| `system ask [--persist] [--session <id>] [--tier <t>] [--classification <c>] (<prompt> \| -)` | asks through the running profile's MCP `ask`, then polls `result` with the `runId` until the answer arrives; prints the answer (and the session id for persistent asks) |
| `system research [--session <id>] [--classification <c>] (<question> \| -)` | starts the `research` run (Deep research, then a cited compaction), prints step progress to stderr, and prints the compacted synthesis |
| `system result <runId>` | waits for a run and prints its answer |
| `system usage [<limit>]` | recent runs: per step, the Worker, tier, and quota class that served it (usage report) |
| `system explain <runId\|artifact>` | a run's decision chain per step (egress, tier, route or admission, acceptance), or any artifact's input tree |
| `system account login <id>` | opens the remote login desktop through the running profile (`account_login`). Prints the `ssh -L` command and URL, then waits until Save has stored the account (its revision increases) |
| `system account list` / `system account save <id>` | call the running profile's `account_list` / `account_save` MCP tools, authenticated from the discovery file. Save runs after an interactive login |
| `system browser install` | installs the managed Chrome pinned in `chrome.lock.json` under `<DSH_HOME>/system/browsers` |
| `system start [dsh args]` | runs `dsh --profile system …` with `DSH_TELEMETRY_DISABLED=1` |
| `system mcp-config claude\|codex` | prints the client configuration from the running profile's discovery file. For Claude Code it is a `claude mcp add-json --scope user` command whose `headersHelper` runs `system mcp-headers`, so the token never sits in Claude Code's config. For Codex it is a `[mcp_servers.system]` block that runs `system mcp-stdio`. The token is never printed into the command |
| `system mcp-token` | prints only the bearer token, for `export SYSTEM_MCP_TOKEN="$(system mcp-token)"` (Codex) |
| `system mcp-stdio` | an MCP server on stdio that forwards tool listing and calls to the running profile, authenticating from the token file. Codex (and any client without a header helper) runs it as a local server, so no token sits in its config or environment |
| `system mcp-headers` | prints `{"Authorization": "Bearer …"}` for Claude Code's `headersHelper`, read from the `0600` token file on every connection |

The e2e test [`tests/profile.e2e.ts`](tests/profile.e2e.ts) boots the real
profile, asserts the exact row set, and calls MCP.
