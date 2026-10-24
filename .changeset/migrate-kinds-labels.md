---
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-agent-runtime-core": minor
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-gateway-core": minor
"@tsuuanmi/system-mcp-server": patch
"@tsuuanmi/system-web-ui": minor
"@tsuuanmi/system-cli": minor
"@tsuuanmi/system-runtime-claude-agent-sdk": minor
"@tsuuanmi/system-runtime-codex-sdk": patch
"@tsuuanmi/system-runtime-antigravity-cli": patch
---

`system account migrate` with kinds and descriptions, checked before anything moves; a label per agent account (T103):
- **Fixed:** `system account migrate` refused its own plan when a role had `kinds` (`data/plan/roles/1 must NOT have additional properties`). `mcp-agent-accounts@1.2` gives a plan's role `kinds` and `description`; the planner (rule `agent-workers.migration` version 3) keeps a role's description when all its rows give the same one.
- **Fail closed before acting:** every account tool that changes something (`--apply`, `--rollback`, a sign-in's slot, a verification, a removal) checks the output it would give before its change commits. A defect now refuses the call with nothing decided or moved (`… would make an output its schema refuses (a defect), so nothing changed`), where an apply used to commit first.
- **Labels:** an optional `label` per `agent-workers` assignment (such as `science`) is shown, never routed on: the roster gives each Worker a display `name` (`mcp-roster@1.2`), `Claude Code · science · develop [code]`, which heads its card on the Workers tab, and `system account list` shows the label. Ids do not change. Agent runtimes give a `title` for people (Claude Code, Codex, Antigravity CLI).
- **Why an account is quarantined:** a quarantine says what its reading found (`agent-account@1.1` `quarantine.detail`), for a Claude Code version the reader does not admit `found Claude Code 2.1.310 (…); its identity reader admits only 2.1.308`, in health, `system account list`, the roster, and a refused run; a pruned pinned executable is named as such. The runbook shows how to keep a checked copy under `~/.dsh/system/tools/claude/<version>/`.
- **Antigravity CLI:** `system account login antigravity-cli` is refused before its home is adopted (it has no identity reader), so it never holds the running agy Worker; `system account migrate` waits for a reader unless `--stop antigravity-cli`.
