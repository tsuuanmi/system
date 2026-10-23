---
"@tsuuanmi/system-agent-runtime-core": minor
"@tsuuanmi/system-runtime-codex-sdk": minor
"@tsuuanmi/system-runtime-claude-agent-sdk": minor
"@tsuuanmi/system-runtime-antigravity-cli": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-mcp-server": minor
"@tsuuanmi/system-cli": minor
---

Agent accounts are enrolled and identified by their login (PROP-0012 phase E, ADR-0051):
- `system account login <runtime>` takes the runtime's lowest free enrollment slot (an owner-only home; slot 1 adopts the runtime's existing home where it is), runs the runtime's own sign-in there in your terminal without D-Bus, then reads who signed in. The account id is the runtime and a keyed hash of the login (`codex-sdk:04aa5c1e9b7d3f20`), the key kept in the vault; never a name. `system account login <accountId>`, `verify`, and `remove` follow; `system account list` shows agent accounts beside website accounts. MCP: `account_enroll`, `account_remove`, `account_agents` (operator scope, `mcp-agent-accounts@1.0`).
- Codex and Claude Code read who is signed in to a home (Codex's ChatGPT account id; Claude Code's account and organization ids), each on the version it was seen on (0.164.0, 2.1.308), and run and probe in a named home. The Antigravity CLI gives its sign-in command and reads no identity, so its accounts are `unverified`.
- An account that is signed out, or whose principal changed, cannot be read whole, is shared by two slots, or has no verified reader is not `ready`; health's new `agent-accounts` check names it, and every change is an `enrollment` decision. Each probe, and each run, reads the account again; that never lifts anything.
- Behaviour change only once you enroll a runtime's existing home: its configured Workers then run only while that account is `ready` (or `unverified` for want of a reader, as before). Until then nothing changes.
