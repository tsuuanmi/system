# @tsuuanmi/system-runtime-claude-agent-sdk

Agent runtime provider **`claude-agent-sdk`**: Claude Code as a Worker, through
the official Claude Agent SDK. It runs the operator's installed `claude`
(config `executable`, or found on PATH). The SDK's bundled builds are not
installed.

- **Probe:** `claude --version`; it never runs a task. It offers `read-only`,
  `workspace-write`, and `resume`. It reports `executes: false` (no Bash), so its
  Workers never prove `validate`.
- **Policy, exactly or refused:**
  - only the listed built-in tools exist (`tools`) and are pre-approved
    (`allowedTools`). The defaults are `Read`, `Grep`, `Glob` for `read-only`;
    `workspace-write` adds `Edit` and `Write`. Any other tool is refused before
    starting;
  - `Edit` and `Write` are pre-approved only as `Edit(./**)` and `Write(./**)`,
    scoped to the workspace. On 2026-10-12, a bare `Write` rule let a live
    session write outside its workspace. The scoped rules held against `..`
    traversal, a symlink out of the workspace, and a home path, and a live
    develop run edited inside while its outside write was denied;
  - `permissionMode: dontAsk` with no approval surface, so anything else is
    denied without a prompt;
  - `settingSources: []`: the operator's own Claude Code settings and hooks
    never widen a Worker;
  - no MCP server at all (`strictMcpConfig` with none given). Without this, the
    live check of 2026-10-12 showed the account's claude.ai connectors attached;
  - **no daemon credentials** (INV-8): Claude Code starts with
    `childEnvironment` (agent-runtime-core), so credential-shaped and `DSH_*`
    variables are scrubbed. Its own sign-in in `~/.claude` keeps working. An API
    key or OAuth token it should take from the environment must be forwarded by
    name (`forwardEnv`);
- **Run:**
  - the SDK's session id is reported as the native handle as soon as it appears,
    and `resume` continues it;
  - terminal errors map to the failure taxonomy: `error_max_turns` → `timeout`,
    `error_max_budget_usd` → `quota_exhausted`, anything else →
    `session_broken`; an abort → `aborted`.
- **Config:** `executable` (default: `claude` on PATH); `forwardEnv`, daemon
  variables passed by name; `env`, explicit values, never a secret.
- **License:** the SDK is © Anthropic, under Anthropic's legal agreements
  ([dependency register](../../../docs/engineering/dependencies.md)).
- **Injects:** `agentRuntimes`.
