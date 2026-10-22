# @tsuuanmi/system-runtime-claude-agent-sdk

Agent runtime provider **`claude-agent-sdk`**: Claude Code as a Worker, through
the official Claude Agent SDK. It runs the operator's installed `claude`
(config `executable`, or found on PATH). The SDK's bundled builds are not
installed.

- **Probe:** `claude --version`; it never runs a task. It offers `read-only`,
  `workspace-write`, and `resume`. It reports `executes: false` (no Bash), so its
  Workers never prove `validate`. It reports `readsConfined: true` without a
  wrapper: every pre-approved tool is scoped to the workspace, reads included,
  and nothing else is allowed
  ([ADR-0024](../../../docs/decisions/adr/0024-agent-workers-confined-for-reads.md)).
- **Policy, exactly or refused:**
  - only the listed built-in tools exist (`tools`) and are pre-approved
    (`allowedTools`). The defaults are `Read`, `Grep`, `Glob` for `read-only`;
    `workspace-write` adds `Edit` and `Write`. Any other tool is refused before
    starting;
  - every pre-approval is scoped to the workspace, reads included:
    `Read(./**)`, `Grep(./**)`, `Glob(./**)`, `Edit(./**)`, `Write(./**)`. A
    bare rule reaches the whole disk: live sessions wrote (`Write`) and read and
    grepped (`Read`, `Grep`) outside their workspace, which would expose the
    daemon's own state (`vault.key`, the token files). The scoped rules held
    against `..` traversal, a symlink out of the workspace, and a home path; outside
    reads and writes are denied while the workspace stays readable and writable
    ([release checklist](../../../docs/validation/release-checklist.md));
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
    `session_broken`; an abort → `aborted`. A run that failed after a
    `rate_limit_event` with status `rejected` fails as `quota_exhausted`, so it
    is never retried on the same account.
- **Metering** (`RunMetering`, from the SDK's own messages, never the model's
  text; a failed or aborted run attaches the same to its error):
  - `usage` and `models` from the result's `modelUsage`, which covers every
    model and subagent (the result's own `usage` covers the main loop only and
    is not read). The SDK's `inputTokens` excludes cached input, so each
    model's `inputTokens` is the SDK's `inputTokens` + `cacheReadInputTokens` +
    `cacheCreationInputTokens`; `usage` is the sum over models, and each
    model keeps its `costUSD` as `costUsd`. If any entry lacks whole input and
    output counts, no usage is reported (a partial sum would undercount);
  - `model`: the main loop's, as the session's `system`/`init` message names it
    (the result message has no model field); without one, the model with the
    most output tokens;
  - `turns` (`num_turns`), `costUsd` (`total_cost_usd`), and `resultId`
    (`<session_id>:<uuid>` of the result message);
  - `limits` from each `rate_limit_event`: the window is the SDK's
    `rateLimitType` (for example `five_hour`), kept opaque; `allowed_warning`
    → `warning`; `resetsAt` is Unix time in **seconds** (the CLI fills it from
    the `anthropic-ratelimit-unified-reset` header and compares it with
    `Date.now() / 1000`, Claude Code 2.1.308), reported in ISO time and
    dropped when it is more than 400 days from now; `utilization` is a
    fraction, reported as `usedPercentage`. An event without a
    `rateLimitType` names no window and is not reported; overage fields are
    not read.
- **Config:** `executable` (default: `claude` on PATH); `forwardEnv`, daemon
  variables passed by name; `env`, explicit values, never a secret.
- **License:** the SDK is © Anthropic, under Anthropic's legal agreements
  ([dependency register](../../../docs/engineering/dependencies.md)).
- **Injects:** `agentRuntimes`.
