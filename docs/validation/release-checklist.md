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
| A Codex Worker | an `agent-workers` row with runtime `codex-sdk` (with `forwardEnv: ['SYSTEM_MCP_TOKEN']` when its model provider is the Responses gateway), running in its own Codex home (`<DSH_HOME>/system/codex-home`, no MCP server; `CODEX_HOME=<home> codex login` for an OpenAI or ChatGPT login), then a run routed to it | **re-verify**: verified 2026-10-12 before agent children started without the daemon's credentials, before the dedicated Codex home, and before read confinement |
| A Codex Worker's reads confined: the DSH home hidden, its own sandbox still confining writes | probe the `codex-sdk` runtime (`readsConfined`); through its launcher, `codex sandbox -- ls -A ~/.dsh/system` and a write outside the workspace | 2026-10-14: probe `readsConfined: true`; the state directory showed only `tools`; the write failed (read-only file system). A run on a signed-in Worker is the row above |
| A Claude Code Worker's reads confined to its workspace | a `read-only` `claude-agent-sdk` Worker asked to read and grep a file outside its workspace, and one inside | 2026-10-13: with bare `Read`/`Grep` rules the outside file was read and grepped; with the scoped rules (`Read(./**)`, `Grep(./**)`, `Glob(./**)`) both were denied and the inside file was read |
| Gemini: a Temporary-chat ask on the Chat tab, with the tier's model and thinking level read back | `system ask --tier economy\|frontier "…"` routed to a Gemini account | 2026-10-12 |
| Gemini: a persistent turn continuing a bound conversation, read back by `snapshot` | `ask` with the conversation's binding | 2026-10-12 (a new persistent conversation is verified on the fake site only) |
| Gemini: Deep research proven by the probe; a run's report and sources read back by the driver from its reopened conversation | `system account probe <id>`; `snapshot` of a finished run's conversation | 2026-10-12 (the run itself was driven by a recording script with the map's steps; a run through `ask` is not yet verified) |
| Credential re-login past the email page (local TOTP) | `system account relogin <id>` | **not yet** (needs the operator) |
| An API model Worker | an `llm-pi-ai` route and a `models` catalog entry ([runbook](../operations/runbooks.md#api-and-local-models)), `system model key <NAME>`, then `system ask --tier economy "…"` routed to `model:<id>`; `system usage` shows its tokens | **not yet verified** (needs an API key; the path is tested against a fake server only) |
| A local model Worker | a route to a model server on this machine, a catalog entry with `locality: local` and `quotaClass: local`, then a `local-private` ask routed to it | **not yet verified** (the path is tested against a fake server only) |
| The `api-first` preset on a fresh profile | `system init --preset api-first`, `system start`, an ask on a model Worker, and `system run deep-research "…"` refused with the reason | **not yet verified** live (the composition e2e test boots it) |
| A full dependency audit: every severity, development dependencies included (CI gates only high and critical in production dependencies) | `pnpm audit` on the release commit | 2026-10-14: no known vulnerabilities |
| The release's files verify | `sha256sum -c SHA256SUMS` and `gh attestation verify <tarball> --repo tsuuanmi/system` on the downloaded release ([releasing](../engineering/releasing.md#verifying-a-release)) | **not yet** (no release) |
| The Claude Agent SDK terms still allow how `system` runs it | read the current terms of `@anthropic-ai/claude-agent-sdk` against the [dependency register](../engineering/dependencies.md) row | **not yet** (no release) |
