# Release checklist

Checks on live accounts and real clients, which fixtures cannot prove
([production-ready exit criteria](../requirements/release-scope.md#production-ready-exit-criteria)).
Record the date and the result of each check for a release. **A skipped item
blocks the release.**

| Check | How | Last verified |
|---|---|---|
| Remote login and Save | `system account login <id>`, then Save | 2026-10-11 |
| Ask in a Temporary chat (Chat mode, never Work) | `system ask "…"` | 2026-10-12 |
| Continue a persistent conversation | `system ask --persist`, then `--session` | 2026-10-12 |
| Deep research, then a compaction | `system run deep-research "…"`; `system explain` shows both steps | 2026-10-12 |
| Graph growth (`investigate`) | `system run investigate "…"` | 2026-10-12 |
| Claude Code over MCP | `system mcp-config claude`, then `ask` from Claude Code | 2026-10-12 |
| Claude Code through the Messages gateway: a read and edit loop | `system claude-env`, then a task that reads and edits a file | 2026-10-12 |
| Codex through the Responses gateway: a read and edit loop, with indentation intact | `system codex-env`, then `codex exec` on a task that edits a file | 2026-10-12 |
| A local agent review Worker | `system run review "…"` | 2026-10-12 |
| `develop`: approval, implementation, exact-subject review, report | `system run develop "…"`, `system approve` | 2026-10-12 |
| `research`: hypotheses, review, evidence, critique, conclusions | `system research "…"` | 2026-10-12 |
| Drain, refusal, resume, and shutdown | `system drain`, an `ask` during the drain, `system resume`, `system shutdown` | 2026-10-12 |
| Web UI: approve, stop, continue | `system ui` | 2026-10-12 |
| Backup while the profile runs, and a verified restore preview | `system backup`, `system restore` | 2026-10-12 |
| Restart while a turn runs: reconciled, never resent | start an ask, `system shutdown`, `system start` | 2026-10-12 |
| A panel on two distinct accounts | `system run panel "…"` | 2026-10-12 |
| A team lead closing early; wake-on-message after a panel | a template with `team.lead` in `workflow.templates`; `session_send` to a member | 2026-10-12 |
| A Codex Worker | an `agent-workers` row with runtime `codex-sdk`, then a run routed to it | 2026-10-12 |
| Gemini: a Temporary-chat ask on the Chat tab, with the tier's model and thinking level read back | `system ask --tier economy\|frontier "…"` routed to a Gemini account | 2026-10-12 |
| Credential re-login past the email page (local TOTP) | `system account relogin <id>` | **not yet** (needs the operator) |
| An economy-tier API provider | | **not built** (needs an API key) |
