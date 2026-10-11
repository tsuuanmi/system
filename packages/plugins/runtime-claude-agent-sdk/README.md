# @tsuuanmi/system-runtime-claude-agent-sdk

Agent runtime provider **`claude-agent-sdk`**: Claude Code as a Worker, through
the official Claude Agent SDK. It runs the operator's installed `claude`
(config `executable`, or found on PATH). The SDK's bundled builds are not
installed.

- **Probe:** `claude --version`; it never runs a task. It offers `read-only` and
  `resume`.
- **Policy, exactly or refused:**
  - only the listed built-in tools exist (`tools`) and are pre-approved
    (`allowedTools`). The default is `Read`, `Grep`, `Glob`; anything else in a
    read-only run is refused before starting;
  - `permissionMode: dontAsk` with no approval surface, so anything else is
    denied without a prompt;
  - `settingSources: []`: the operator's own Claude Code settings and hooks
    never widen a Worker;
  - no MCP server at all (`strictMcpConfig` with none given). Without this, the
    live check of 2026-10-12 showed the account's claude.ai connectors attached;
  - `workspace-write` is refused until confining writes to the workspace is
    verified.
- **Run:**
  - the SDK's session id is reported as the native handle as soon as it appears,
    and `resume` continues it;
  - terminal errors map to the failure taxonomy: `error_max_turns` → `timeout`,
    `error_max_budget_usd` → `quota_exhausted`, anything else →
    `session_broken`; an abort → `aborted`.
- **License:** the SDK is © Anthropic, under Anthropic's legal agreements
  ([dependency register](../../../docs/engineering/dependencies.md)).
- **Injects:** `agentRuntimes`.
