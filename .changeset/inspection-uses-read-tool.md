---
"@tsuuanmi/system-agent-runtime-core": minor
"@tsuuanmi/system-runtime-claude-agent-sdk": minor
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-libs": minor
---

A shell inspection command is denied at once, naming the reading tool to use, and never asked (T222; operator 2026-10-26: the lead's approval filter was hard-coded and fragile). Since T198 every `Bash` call is a `command`, so a Worker's `cat`, `ls`, `wc -l`, `head`, `tail`, `grep`, `rg`, `find`, or `sed -n` opened an approval request and waited (the lead approved dozens by pattern; T199 denied them after 10 minutes).
- agent-runtime-core: new `RuntimeEvidence.readTools`, the runtime's own reading tools its agent has; the Claude Code runtime reports `Read`, `Grep`, `Glob`.
- agent-workers: the gate gets the run's reading tools (`GateRun.readTools`, `readToolsOf`: the evidence's `readTools` as far as the Worker's `tools` list keeps them, and the workspace reads server's `read_file`, `list_dir`, `search` where the runtime reports `workspaceReads`). A `Bash` inspection command, recognised by its first word after the gate's own split (`cat`, `head`, `tail`, `sed -n`, `wc`, `grep`, `rg`, `ls`, `find`; a `sed` only as `sed -n <a>[,<b>]p <path>…`, so one that edits in place, takes a `-e` or `-f` script, or writes a file or runs a command is none, and a `find` with an action is none), whose reading tool the agent has is refused with the new stable reason `use-read-tool`, its reason naming the tool (`Read`/`read_file` for cat, head, tail, sed -n, and wc; `Grep`/`search` for grep and rg; `Glob`/`list_dir` for ls and find); it opens no request. Under a runtime that gives no reading tool for it, it stays a `command`, asked as before; under one with clean shells, an inspection the gate takes for a read still runs unasked. The Worker's Tools section says so, naming the tool for each form.
- libs, schemas: `agent-tool-event@1.1` adds the reason `use-read-tool` (additive; `AGENT_TOOL_EVENT_SCHEMA` is `agent-tool-event@1.1`).
