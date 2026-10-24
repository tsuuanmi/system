# @tsuuanmi/system-runtime-antigravity-cli

Agent runtime provider **`antigravity-cli`**: the Antigravity CLI (`agy`) as a
Worker, in print mode (`agy --print=<prompt> --output-format stream-json
--disable-slash-commands [--model=<model>]`). It runs the operator's installed
`agy` (config `executable`, or found on PATH); nothing is vendored or depended on.

**It runs only an agy version verified live** (fail closed, INV-2;
[ADR-0043](../../../docs/decisions/adr/0043-antigravity-cli-workers-gated-on-a-version-verified-live.md)).
Antigravity has no per-tool allow-list or workspace-scoped permission a headless
run can be held to, so its PreToolUse hook is the only place a policy can hold.
The probe proves the hook's path on the host (below); that agy runs the hook
before each tool call takes a model turn to show, which a probe never runs. So
the runtime offers its sandboxes and reports `gatesToolCalls` only on a version
in `VERIFIED_HOOK_VERSIONS`, which a supervised live check verified: **1.4.6**
(2026-10-23, `gemini-3.8-flash-low`; the recorded hook inputs and outcomes are
[`tests/fixtures/agy-1.4.6-hook-inputs.json`](tests/fixtures/agy-1.4.6-hook-inputs.json),
replayed through the bridge in the tests). On any other version it offers no
sandbox (as an ACP agent offers none unless vouched for), and every run is
refused (`config_error`). The `agents` source's gate classifies agy's tools
([approvals](../../../docs/design/approvals.md#how-a-call-is-classified)).

What turns it on is in the [runbook](../../../docs/operations/runbooks.md#antigravity-cli-workers).

- **Its own home**, and no other: a run naming one (`RunSpec.home`, one
  account's home, ADR-0051) is refused (`config_error`) before anything runs.
  agy keeps everything under `$HOME` (its sign-in,
  `~/.gemini/antigravity-cli`; its global customizations, `~/.gemini/config`;
  its plugins' secrets, `~/.config/antigravity`; seen with agy 1.4.6, which has
  no flag or variable for a config directory). So agy runs with `HOME` set to
  the Workers' Antigravity home (config `home`, absolute; default
  `<DSH_HOME>/system/antigravity-home`, created owner-only), the XDG directories
  inside it, `AGY_CLI_DISABLE_AUTO_UPDATE=true` (the updater otherwise replaces
  the operator's `agy` from inside a run), and no D-Bus (so its sign-in is the
  file in its home, never the operator's keyring). The operator's `~/.gemini`
  and `~/.config/antigravity` are hidden by the read confinement. Sign in there
  once; nothing else belongs in that home.
- **Accounts** (ADR-0051): its own home is `home` on the provider, which slot 1
  of its accounts adopts, and `loginCommand(home)` is `agy` with that home as
  its `HOME` (the XDG directories inside it, auto-update off). It has no
  `identity`: no file or command was shown to name the signed-in Google account
  without reading its token (PROP-0012 open question 1; a supervised check on a
  signed-in throwaway home, field names only, is still owed), so the `agents`
  source takes no slot for it (`system account login antigravity-cli` is
  refused before its home is adopted, and its hand-named Workers run on), and
  a slot taken before reads `unverified`; none is routed until a reader is
  verified. Its title, shown in the roster's display names, is `Antigravity CLI`.
- **Nothing outside the gate:** the home must configure no MCP server
  (`.gemini/config/mcp_config.json`), enable no plugin (`agy plugin list
  --json`), and hold no `hooks.json` but the runtime's own; any of them makes
  the runtime unavailable (probe) or refuses the run (`config_error`), never
  ignored or overwritten. A workspace whose customization roots (`.agents/`,
  `.agent/`, `_agents/`, `_agent/`, from the workspace up to its repository
  root; the workspace alone outside a repository) hold `hooks.json`,
  `mcp_config.json`, `plugins.json`, or `plugins/` is refused: agy loads them in
  print mode without asking, and would run them outside every gate.
- **Read confinement**
  ([ADR-0024](../../../docs/decisions/adr/0024-agent-workers-confined-for-reads.md)):
  agy starts under `ctx.agentRuntimes`' bubblewrap confinement; its home comes
  back writable, the workspace as the sandbox allows (read-only, or writable),
  and the run's gate directory read-only. A bind that would expose a hidden path
  is refused before anything starts.
- **The hook, bridged to the run** (`bridge.ts`): the home holds one
  `hooks.json`, written by the runtime, with one `PreToolUse` hook on every tool
  (`*`, timeout 60 s). agy runs it before each tool step, in that file's
  directory, with agy's own environment (seen live with 1.4.6). Its command
  (`sh -c`) starts the run's own hook, which the run names in agy's environment
  (`SYSTEM_ANTIGRAVITY_GATE_HOOK`), and always prints a decision itself: the
  hook's answer only when it exits 0 with one, a deny otherwise, and a deny when
  no hook is named, so a session in that home no run started (the operator
  signing in) runs no tool. agy 1.4.6 blocks the tool on a non-zero exit, a
  timeout, output it cannot read, `{}`, or an unknown decision, but runs it when
  a hook exits 0 printing nothing: the command never leaves that to agy. Per run:
  - an owner-only directory under `<DSH_HOME>/system/run` (hidden from every
    agent; bound back read-only into this run's confinement only) holds a unix
    socket (`gate.sock`, 0600), a copy of the shipped hook script
    (`hook/gate-hook.mjs`, plain Node, no dependency), and its launcher; it is
    removed when the run ends;
  - the hook sends agy's input and the run's token
    (`SYSTEM_ANTIGRAVITY_GATE_TOKEN`, 256 random bits) and prints the answer.
    No token, no socket, an answer that is late (45 s), malformed, or one the
    hook does not define, any error: a deny. The channel denies a request
    without the run's token, malformed, over 1 MiB, past 40 s, or beyond 16 at
    once, before anything is asked. The token keeps a stale or misrouted hook
    from being answered; it is no secret from the agent, whose processes share
    the run's user and namespaces;
  - a variable of the same name configured (`env`) or forwarded (`forwardEnv`)
    is dropped: only the run sets them.
- **Policy, exactly or refused** (`policy.ts`, before the gate): tool names are
  as agy's hook names them, the name the model calls (not the lowercased step
  type agy's hooks guide describes). The live check recorded
  `gemini-3.8-flash`'s file tools: a `read-only` run offers `read_file` (`Path`,
  `StartLine`, `EndLine`, `ByteOffset`); `workspace-write` adds `write_file`
  (`Path`, `Content`, `Append`, `Overwrite`) and `edit_file` (`Path`, `Target`,
  `Replacement`); a configured `tools` narrows that and may not widen it. That
  model has no tool that lists or searches a directory. No command
  (`run_command`), browser, web, subagent, MCP, or scheduling tool is offered in
  any run, nor another model's tools, which are not verified. Every string in a
  call's input, at any depth, except the fields known to hold text (a file's
  content, an edit's target and replacement), is read as a location and must be
  inside the workspace, as written and on disk (symlinks followed): an absolute
  path, a `file:` URI, or a relative path; `~`, a `..` segment, and any other
  URI are not. A file edit never touches a customization root. So an input the
  runtime does not know is held to the workspace or denied, and so are agy's
  own artifacts (task lists and plans it writes into its home's `brain/`
  through the same tools): the agent works without them.
- **The run's tool gate** (`RunSpec.toolGate`): asked after the runtime's rules, with the tool, its input, and
  `<conversation id>:<step>` as the call id, bounded by `askToolGate` (30 s;
  a throw or an undefined verdict is a deny). The hook answers `allow` only when
  both allow: the rules are this runtime's policy, so nothing is left to agy's
  own permission prompts, which a headless run cannot show. `deny` is the
  hook's deny, with the reason. `defer` is denied too (agy cannot wait on a
  call): the run stops there (agy is ended), every later call is denied without
  asking, and the run fails as `config_error` naming the request, whatever agy
  reported. Continuing that conversation later is not offered (`resume`, below).
- **Probe** (never runs a task):
  1. `agy --version` (not installed, or failing: unavailable);
  2. the home: its `hooks.json` kept, no MCP server or foreign hooks
     (unavailable otherwise);
  3. `proveConfinement` with the home bound back (not proven, or no
     confinement: `readsConfined: false`, no sandbox);
  4. `agy models` under the confinement: a failure (`Please sign in…`) is
     unavailable, naming the home to sign in to;
  5. `agy plugin list --json` under the confinement: an enabled plugin is
     unavailable;
  6. the hook layer: the bridge's self-test runs the command in `hooks.json`
     as agy runs it (`sh -c` in the home's config directory, with the run's
     environment) inside the confinement, against a channel of its own: it must
     print that channel's answer, and a wrong token must be denied before the
     channel is asked. Proven on this host with the real bubblewrap (the socket
     is reached through the read-only bind under the hidden DSH home). With the
     agy version in `VERIFIED_HOOK_VERSIONS` as well: both sandboxes and
     `gatesToolCalls`; otherwise neither, with the reason.

  `executes` is always false (commands are never offered; agy's terminal
  sandbox, `--sandbox`, has no model-free proof, and agy's own changelog shows
  it turned off, not failing, where it cannot run), and so is `resume` (continuing a
  conversation by id, `--conversation`, is not proven; a run that asks for it is
  refused rather than starting a new one).
- **Run:** refused before agy starts (`config_error`, nothing run) for a
  relative workspace, a tool outside the sandbox, `maxTurns` (agy has no turn
  limit), `resume`, an agy version not verified live, a home
  or workspace that configures what would run outside the gate, a confinement
  that cannot be built, or a hook layer that is not proven again for this run
  (the self-test against the run's own channel, inside the run's own
  confinement). A prompt over 100,000 bytes is refused (`invalid_input`): it is
  agy's argument. The conversation id is reported as the native handle as soon
  as an event carries it. An abort ends agy (SIGTERM, then SIGKILL after 5 s;
  the confinement's PID namespace dies with it): `aborted`. A failure maps by
  agy's own words: a sign-in (`reauth_required`), a quota or rate limit
  (`quota_exhausted`), model capacity (`overloaded`), else `session_broken`; a
  run without a `result` event, with `status: ERROR`, an `error`, or a non-zero
  exit fails.
- **Metering** (from agy's own `result`, never the model's text; a failed or
  aborted run attaches the same to its error): `turns` (`num_turns`), the main
  `model` when an event names one, and `usage` from `input_tokens`,
  `output_tokens`, `thinking_tokens`, `cache_read_tokens`, and `total_tokens`.
  Which count includes which is not documented, so the total decides: input
  includes the cache read or not, output includes the thinking or not, and the
  one reading whose sum is the total is reported (input including the cache
  read, output the thinking); no total with a cache read or thinking to place,
  or no reading that fits, reports no usage (a missing number stays missing).
  No per-model split or cost is read.
- **A quota's reset** (`limits.ts`,
  [limit readings](../../../docs/design/agent-runtimes.md#limit-readings)): agy's
  stream and its quota errors name no reset, but print mode answers `/usage`
  itself, without an agent turn. After a run that failed `quota_exhausted`, on
  an agy version in `VERIFIED_LIMIT_VERSIONS` (1.4.6, from its binary's type
  descriptors and changelog), the runtime runs `agy --print=/usage
  --output-format json` (`USAGE_ARGS`) under the home's confinement, with agy's
  environment and no gate, and reads its `command.data`: groups of buckets,
  each with an `id`, `remaining_fraction`, `remaining_amount`, and `reset_time`
  (RFC 3339, UTC). Each bucket that is not `disabled` and says what is left is
  an observation of the window its `id` names: `rejected` when nothing is left,
  else `allowed`, with `usedPercentage` from the fraction and `resetsAt` from the
  reset (dropped when it does not parse, is more than 400 days away, or, for a
  rejection, is not ahead of now). A rejected bucket without an `id` is window
  `*`, which closes the pool as a whole; a bucket that says nothing of what is
  left is no reading, never `allowed`. The observations go on the run's error
  (`withMetering`). A report not in the 1.4.6 shape (any field of another type,
  a fraction outside 0 to 1), one that fails, and any other agy version give
  none, and the error says why (`its reset time is not read: …`); on another
  version `/usage` is never sent, since an agy that stopped answering it itself
  would pass it to the model as a prompt. The `agents` source then closes the
  pool for the Worker's cooldown, never opens it.
- **Config:** `executable`; `home` (absolute); `forwardEnv`, daemon variables
  passed by name (an API key agy should use); `env`, explicit values, never a
  secret (`HOME`, the XDG directories, and the hook's variables there are
  ignored).
- **Host:** bubblewrap, and `node` reachable inside the confinement (the
  daemon's own, `process.execPath`; keep it outside the hidden paths).
- **Bundle:** row `runtime-antigravity-cli`, off by default like Codex and ACP,
  on in the `api-first` preset; it registers the runtime and starts nothing
  until a Worker names it.
- **Dependencies:** `agent-runtime-core` (`askToolGate`, `childEnvironment`,
  `confinedCommand`, `proveConfinement`, `withMetering`), `system-libs`
  (`dshHome`, `ensurePrivateDir`, `writeFileDurable`), `provider-core`.
- **Injects:** `agentRuntimes`.
