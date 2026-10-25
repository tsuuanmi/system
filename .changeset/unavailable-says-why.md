---
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-gateway-core": minor
"@tsuuanmi/system-plugin-host": minor
"@tsuuanmi/system-cli": patch
---

An unavailable Worker says why (T214, from the live incident of 2026-10-26, when all four Codex Workers were `unavailable` for about 40 minutes and nothing said why).
- `capability-descriptor@1.9` adds the optional `unavailableReason`: plain text on one line, at most 300 characters, only with state `unavailable`; for people only, routing never reads it.
- The agent Workers' source sets it: a failed probe's detail (`its <runtime> probe failed: …`), what the runtime's evidence misses (host state not kept unreadable, no gate before each tool call, its sandbox not enforced), a workspace that cannot hold a worktree per run, or the account's or pool's gate (a pool the ledger does not configure, or one that cannot be read, with the ledger's error).
- The roster shows it as the Worker's reason when its account gives none, so capacity, health, and the Workers page say why instead of "its Worker source gives no reason".
- The daemon's warnings reach its log: DSH gave the plugins' logger no sink but its memory, so a warning reached no file. The plugin host now writes what every plugin logs, errors, info and warnings, to the daemon's stderr (`daemon.log` under the systemd unit), one line each with its time, severity, and plugin.
- The CLI's JSON is not cut at 64 KiB: it exited before a pipe had taken all of its output; it now exits once stdout and stderr have written everything.
