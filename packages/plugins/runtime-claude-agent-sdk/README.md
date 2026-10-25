# @tsuuanmi/system-runtime-claude-agent-sdk

Agent runtime provider **`claude-agent-sdk`** (title `Claude Code`, shown in
the roster's display names): Claude Code as a Worker, through
the official Claude Agent SDK. It runs the operator's installed `claude`
(config `executable`, or found on PATH). The SDK's bundled builds are not
installed.

- **Two confinements**
  ([ADR-0038](../../../docs/decisions/adr/0038-confined-commands-for-claude-code-workers.md)):
  - **reads, by the host:** Claude Code starts under the read confinement of
    `ctx.agentRuntimes`
    ([ADR-0024](../../../docs/decisions/adr/0024-agent-workers-confined-for-reads.md)),
    as Codex and ACP agents do: bubblewrap, through the SDK's
    `spawnClaudeCodeProcess`, wraps the SDK's own command line. The DSH home,
    the temporary and runtime directories, every credential store, and every
    coding agent's login (the operator's `~/.claude` included) are hidden; only
    the operator's tools (read-only), its home (writable), and the run's
    workspace (as the run's sandbox allows) come back. A bind that would expose
    a hidden path is refused before anything starts (`config_error`). The
    confinement's outermost process is the run's agent process: its pid is
    reported to the run's observer (`onProcess`), and each SDK message as
    activity (`onActivity`), for the source's liveness verdict (PROP-0013);
  - **commands, by the SDK's sandbox:** a `workspace-write` run offers `Bash`
    and enables the SDK's sandbox (Anthropic's sandbox runtime: bubblewrap and
    a network proxy on Linux) with exactly `enabled: true`,
    `failIfUnavailable: true` (a run whose sandbox cannot start fails, never
    runs a command unconfined), `allowUnsandboxedCommands: false`,
    `filesystem.allowWrite`: the run's workspace only, and
    `network.allowedDomains: []`, with `strictAllowlist: true` so any host is
    refused by the sandbox itself rather than asked about. A `read-only` run
    has no `Bash` and no sandbox. The sandbox bounds where a command acts; the
    run's tool gate decides whether it runs at all, by its exact argv;
  - **its own home:** `CLAUDE_CONFIG_DIR` is the Workers' Claude Code home
    (config `home`, default `<DSH_HOME>/system/claude-home`, created
    owner-only), never the operator's `~/.claude`, which the confinement hides.
    Sign in there once (`CLAUDE_CONFIG_DIR=<home> claude`, then `/login`), or
    forward an API key or OAuth token by name (`forwardEnv`). Its sessions, and
    so `resume`, live there. A run or probe may name another home
    (`RunSpec.home`, `probe({ home })`: one account's, ADR-0051; its probe
    reports `homes`), which must already be an owner-only directory of this
    user, never made by a run, else it is refused (`config_error`) before
    anything runs. Its own home is `home` on the provider, which slot 1 of its
    accounts adopts.
  - **Who is signed in** (`identity(home, key)`, reader `claude-state-file`, on
    `VERIFIED_IDENTITY_VERSIONS`, Claude Code 2.1.308, 2.1.309, and 2.1.310:
    the later two checked from their binaries against 2.1.308, the code the
    reader relies on unchanged but for minified names, and their `--version` and
    signed-out `auth status` in a throwaway home,
    `tests/fixtures/claude-auth-status.json`; any other version is
    `unverified`, its reason naming the version found, the executable, and the
    versions admitted, `found Claude Code 2.1.311 (<executable>); its identity
    reader admits only 2.1.308, 2.1.309, 2.1.310`, which the account's quarantine carries as its
    detail; a configured executable that is no longer there, which Claude
    Code's updater does to old versions under `~/.local/share/claude/versions`,
    is named as such, here and in the probe, with where to keep a checked copy:
    [runbook](../../../docs/operations/runbooks.md#keep-claude-codes-pinned-version)): `claude auth status` in that home, confined and with none of
    the forwarded variables, must say `"loggedIn": true` (false or failing:
    `missing`; unreadable: `ambiguous`); the home must keep that sign-in in its
    own `.credentials.json` (only its existence is checked; a sign-in kept
    elsewhere is `unverified`); then `oauthAccount.accountUuid` and
    `oauthAccount.organizationUuid` of the home's `.claude.json`, both whole, or
    `ambiguous` (never the email alone), hashed with the install's key; the
    hint is `emailAddress`, masked. The fields were seen on this host; phase A's
    supervised check on real accounts is still owed. `loginCommand(home)` is
    `CLAUDE_CONFIG_DIR=<home> claude` (then `/login`).
- **Probe:** it never runs a task.
  1. `claude --version` (not installed, or failing: unavailable);
  2. `proveConfinement` on this host, with its home bound back
     (`readsConfined`; no confinement configured, or not proven:
     `readsConfined: false`, so its Workers are unavailable);
  3. `claude auth status` under the confinement: only an exit 0 that reports
     `"loggedIn": true` is a sign-in; a non-zero exit, `"loggedIn": false`, or
     output that says neither is unavailable, naming the home to sign in to;
  4. a nested sandbox start: bubblewrap, found on Claude Code's own PATH as the
     SDK's sandbox finds it, runs a namespaced `true` with no network
     (`--unshare-net`, `--unshare-pid`, a read-only root) inside the
     confinement. Proven: `executes: true` and both `read-only` and
     `workspace-write`. Not proven: `executes: false` and `read-only` only,
     the reason in `detail` (INV-2), so its Workers never prove `develop` or
     `validate` on this host.

  It offers `resume` and reports `gatesToolCalls: true`: a run's tool gate is a
  PreToolUse hook on every tool. A `workspace-write` run starts the nested
  sandbox again first and is refused (`config_error`, nothing run) if it does
  not start; the SDK's `failIfUnavailable` then guards the sandbox Claude Code
  itself starts.
- **Policy, exactly or refused:**
  - only the listed built-in tools exist (`tools`) and are pre-approved
    (`allowedTools`). The defaults are `Read`, `Grep`, `Glob` for `read-only`;
    `workspace-write` adds `Edit`, `Write`, and `Bash`. Any other tool is
    refused before starting, and so is `Bash` in a `read-only` run;
  - every file tool's pre-approval is scoped to the workspace, reads included:
    `Read(./**)`, `Grep(./**)`, `Glob(./**)`, `Edit(./**)`, `Write(./**)`. A
    bare rule reaches the whole disk: live sessions wrote (`Write`) and read and
    grepped (`Read`, `Grep`) outside their workspace, which would expose the
    daemon's own state (`vault.key`, the token files). The scoped rules held
    against `..` traversal, a symlink out of the workspace, and a home path; outside
    reads and writes are denied while the workspace stays readable and writable
    ([release checklist](../../../docs/validation/release-checklist.md)).
    `Bash` is pre-approved whole: the sandbox bounds every command;
  - `permissionMode: dontAsk` with no approval surface, so anything else is
    denied without a prompt;
  - `settingSources: []`: the operator's own Claude Code settings and hooks
    never widen a Worker;
  - **the run's tool gate** (`RunSpec.toolGate`,
    [approvals](../../../docs/design/approvals.md#a-workers-tool-calls)) is the
    one PreToolUse hook, with no matcher, so every tool call, subagents'
    included, is asked first with its tool name, input, and `tool_use_id`.
    `deny` and `defer` are the hook's `permissionDecision`, with the reason;
    `allow` returns no decision, because a hook's `allow` would skip the
    workspace-scoped pre-approvals above, and with them the workspace bound. A
    gate that throws, answers an unknown verdict, or takes longer than 30 s
    (`askToolGate`, agent-runtime-core; the hook's own timeout is 60 s) is a
    deny. After a `defer`, every later call is
    denied, and the run rejects with a `config_error` naming the request,
    whatever the result says (a headless query ends with `terminal_reason:
    tool_deferred`); a result that reports a deferred call the gate never
    deferred fails the same way. On resume, the hook runs again on the deferred
    call. `canUseTool` is never set: a pre-approved tool never reaches it, so it
    cannot be the gate. Without a gate, no hook is registered;
  - no MCP server at all (`strictMcpConfig` with none given). Without this, the
    live check of 2026-10-12 showed the account's claude.ai connectors attached;
  - **no daemon credentials** (INV-8): Claude Code starts with
    `childEnvironment` (agent-runtime-core), so credential-shaped and `DSH_*`
    variables are scrubbed. Its own sign-in lives in its home. An API key or
    OAuth token it should take from the environment must be forwarded by name
    (`forwardEnv`);
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
  - a run that ends without a result message (stopped, past its timeout,
    drained at the host's stop, at a deferred call, or a stream that broke)
    reports what its `assistant` messages streamed instead, marked `partial`
    with why: each message id once, at its largest counts (the SDK sends one
    message per content block, each with its response's usage so far),
    normalized as above and summed per model, subagents' included; `turns` is
    the main loop's messages (no `parent_tool_use_id`). A message without an
    id, a model, or whole input and output counts is skipped. It leaves out the
    response in flight, so it is a lower bound, never an estimate; with no
    message streamed, no number is reported. A run with a result is counted
    from it alone;
  - `limits` from each `rate_limit_event`: the window is the SDK's
    `rateLimitType` (for example `five_hour`), kept opaque; `allowed_warning`
    → `warning`; `resetsAt` is Unix time in **seconds** (the CLI fills it from
    the `anthropic-ratelimit-unified-reset` header and compares it with
    `Date.now() / 1000`, Claude Code 2.1.308), reported in ISO time and
    dropped when it is more than 400 days from now; `utilization` is a
    fraction, reported as `usedPercentage`. An event without a
    `rateLimitType` names no window and is not reported, except a rejection:
    it is reported as window `*`, which no configuration maps, so the ledger
    closes every window of the pool. Overage fields are not read.
- **An account's usage report** (`limits({ home }, signal)`,
  [ADR-0059](../../../docs/decisions/adr/0059-quota-readings-from-each-accounts-own-usage-report.md),
  `src/limits.ts`): the SDK's `get_usage` control request
  (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`),
  only on a Claude Code version whose answer was checked
  (`VERIFIED_LIMIT_VERSIONS`: 2.1.308, 2.1.309, 2.1.310, from their binaries:
  the handler, the shaping of its answer, and the window schema the same but for
  minified names; any other is `unreadable`, naming it, and nothing starts). The
  CLI answers from the account's usage endpoint, or from its own snapshot under a
  minute old (kept in the home's `.claude.json`), with no transcript written and
  no model request. Claude Code starts as a run's does (the read confinement with its home
  bound back writable, the run's environment, the home as its directory) in a
  session that is sent no message: streaming input that never yields, so no
  model turn starts; no tool (`tools: []`), no settings, no MCP server, no hook,
  and no session written (`persistSession: false`). The answer is read, the
  session closed. Read: `rate_limits_available: true` with `rate_limits` an
  object; a window of it is told by its shape, an object with a `utilization`
  (the endpoint's body adds entries without a new Claude Code version, T111):
  arrays (`model_scoped`, `limits`), objects without one (`spend`), booleans
  (`member_dashboard_available`), strings, nulls (`pace`), and `extra_usage` are
  skipped. Each window that is `{ utilization, resets_at }` (more fields
  ignored, as `limit_dollars`) with a numeric
  `utilization` (0 to 100) is an observation of its name (`five_hour`,
  `seven_day`, `seven_day_oauth_apps`, and the per-model weekly windows: the
  names a `rate_limit_event` uses), `usedPercentage` its utilization (above 100
  read as 100), `rejected` at 100 or more, else `allowed`, with `resetsAt` when
  `resets_at` is an ISO time within 400 days (and ahead, for a rejection). A
  window whose utilization is null is no reading. `rate_limits_available: false`
  (an API key, a third-party provider) is `unreadable`; so is any window not in
  that shape (an entry that is a number, a reset as Unix seconds, a share as
  text, a negative share): nothing in such an answer is believed. Not read:
  `session`, `subscription_type`, `behaviors`. A window at 100 % closes even
  when the account's extra usage could pay past it. Fixtures:
  `tests/fixtures/claude-get-usage.json` and `claude-get-usage-live.json` (a
  live answer's shape of 2026-10-24); the provider passes the usage report
  suite.
- **Config:** `executable` (default: `claude` on PATH; keep it outside the
  hidden paths, `~/.claude/local` among them; to pin a version its reader
  admits, point it at a checked copy under `~/.dsh/system/tools/claude/<version>/`,
  which the updater does not prune and every agent sees read-only); `home`, the Workers' Claude Code
  home (absolute; default `<DSH_HOME>/system/claude-home`); `forwardEnv`,
  daemon variables passed by name; `env`, explicit values, never a secret
  (`CLAUDE_CONFIG_DIR` there is ignored: the home wins).
- **Host:** bubblewrap for both layers, and `socat`, which the SDK's sandbox
  uses for its network proxy on Linux; a missing `socat` fails each
  `workspace-write` run at start (`failIfUnavailable`), never runs it
  unconfined ([runbook](../../../docs/operations/runbooks.md#agent-workers)).
- **Bundle:** on by default, with `agent-runtimes` and `agent-workers`
  (PROP-0010 B3); it registers the runtime and starts nothing until a Worker
  names it. A host without Claude Code, or where it is not signed in, still
  boots: the probe reports why, and its Workers are unavailable.
- **License:** the SDK is © Anthropic, under Anthropic's legal agreements
  ([dependency register](../../../docs/engineering/dependencies.md)). Its
  sandbox ships in Claude Code itself; nothing new is depended on.
- **Dependencies:** `@anthropic-ai/claude-agent-sdk`, `agent-runtime-core`
  (`askToolGate`, `childEnvironment`, `confinedCommand`, `proveConfinement`,
  `withMetering`, and for a named home and its identity `homeProblem`,
  `identityHmac`, `maskEmail`, `readHomeJson`), `system-libs`
  (`dshHome`, `ensurePrivateDir`), `provider-core`.
- **Injects:** `agentRuntimes`.
