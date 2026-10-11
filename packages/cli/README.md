# @tsuuanmi/system-cli

The `system` command: a thin wrapper around the pinned `dsh` launcher, which is
the supported way to run a DSH harness
([ADR-0018](../../docs/decisions/adr/0018-build-on-dsh-core.md)).

| Command | Does |
|---|---|
| `system init` | writes `<DSH_HOME>/profiles/system` with **only** `@tsuuanmi/system-bundle` (no `dsh-base`, [ADR-0019](../../docs/decisions/adr/0019-explicit-minimal-dsh-core.md)), then runs `dsh plugin install`, keeps a usable Chrome (installing the pinned managed build when none exists, [ADR-0020](../../docs/decisions/adr/0020-pinned-managed-chrome.md)), and reports a missing Xvfb |
| `system ask [--persist] [--session <id>] <prompt>` | asks through the running profile's MCP `ask`, then polls `result` until the answer arrives; prints the answer (and the session id for persistent asks) |
| `system account login <id>` | opens the remote login desktop through the running profile (`account_login`). Prints the `ssh -L` command and URL, then waits until Save has stored the account (its revision increases) |
| `system account list` / `system account save <id>` | call the running profile's `account_list` / `account_save` MCP tools, authenticated from the discovery file. Save runs after an interactive login |
| `system browser install` | installs the managed Chrome pinned in `chrome.lock.json` under `<DSH_HOME>/system/browsers` |
| `system start [dsh args]` | runs `dsh --profile system …` with `DSH_TELEMETRY_DISABLED=1` |
| `system mcp-config claude\|codex` | prints the client configuration from the running profile's discovery file. The token is read from `$SYSTEM_MCP_TOKEN` and never printed into the command |
| `system mcp-token` | prints only the bearer token, for `export SYSTEM_MCP_TOKEN="$(system mcp-token)"` |

The e2e test [`tests/profile.e2e.ts`](tests/profile.e2e.ts) boots the real
profile, asserts the exact row set, and calls MCP.
