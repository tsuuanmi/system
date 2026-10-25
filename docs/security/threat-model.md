# Threat model

> Target state. Deployment assumption: a single operator on a single machine
> (CON-6).
>
> Not built yet (target only): turn tokens for MCP tool inversion (the gateways use the
> text tool protocol of
> [ADR-0022](../decisions/adr/0022-text-protocol-tool-calls-for-website-models.md))
> and `/admin/*` routes.
>
> Which rows the default composition mounts, and which it leaves off, is in the
> [bundle](../../packages/system-bundle/README.md). The agent threats (an agent
> process reading host state, or running commands) arise once the operator
> [adds a Worker](../operations/runbooks.md#agent-workers); the gateway threats (a gateway
> client, the model token in use) once the operator
> [turns a row on](../operations/runbooks.md#turn-an-off-row-back-on).

## Assets

- Provider account sessions: cookies, auth storage, and conversation history.
- The local workspace: files, shell, and VCS credentials reachable through tools.
- Local and private data: datasets, documents, and repository content that must not
  leave the machine without policy.
- Workflow state and results.
- Control credentials: the scoped bearer tokens the client endpoints accept
  (`operator.token`, `client.token`, and `model.token` under `<DSH_HOME>/system/`;
  [scopes](../../packages/plugins/mcp-server/README.md#scopes)), and, in the target,
  turn tokens for MCP tool inversion.
- Credentials in the daemon's environment: API keys, the model token a Codex Worker's model
  provider reads, and any other secret the operator exported.
- API keys of model routes, stored encrypted in the vault under the credential reference the
  route names (`system model key`); the configuration names only the reference.
- Agent accounts: each sign-in in a home of its own under the DSH home, and the per-install key
  in the vault that agent account ids are hashed with.

## Trust boundaries

| Zone | Who |
|---|---|
| trusted | the operator, the host process, the account vault, operator configuration, plugins the operator installed |
| semi-trusted | local clients (Codex, Claude Code, MCP agents), trusted for their own envelope, sandbox, and approvals; agent-runtime Workers (Claude Code, Codex, ACP agents, the Antigravity CLI), confined for reads by bubblewrap and for writes and commands by their own runtime's sandbox, each tool call judged by the run's gate, under the operator's policy |
| untrusted | provider websites, model output, tool output, repository content, web pages, other local processes, other users on the machine |

## Threats and controls

- **A web page in the operator's browser calls a loopback endpoint (DNS rebinding,
  cross-site requests).** Every client endpoint (MCP, both protocol gateways, the web
  UI) passes one request guard
  ([`gateway-core`](../../packages/gateway-core/README.md#the-request-guard)): a
  `Host` on the loopback allow-list (`421` otherwise), no browser `Origin` (`403`, no
  CORS; only the web UI accepts its own origin), then the bearer token compared in
  constant time with each scope's token the endpoint accepts (`401`). An empty
  token never matches, and `x-api-key` is accepted only by the model gateways
  (`/anthropic` and `/openai`), for the model token.
  What answers without the token carries no data: the gateways' `HEAD`, `GET /`
  (and `/healthz`), the MCP endpoint's `GET /healthz` (`ok`), and the web UI's
  static shell. Health details reach only the operator scope.
- **The bearer token crosses a network in clear text.** Every endpoint refuses to
  register its route on plain HTTP on a non-loopback host (`assertSafeBind`); a
  non-loopback bind needs TLS.
- **An oversized request body exhausts memory.** Every endpoint reads JSON bodies
  through one bounded reader (`413` past the limit, `400` for invalid JSON): 1 MiB
  for MCP, 16 MiB for a gateway, 16 KiB for the web UI
  ([INV-9](../architecture/invariants.md#inv-9-everything-is-bounded)).
- **A website model's answer proposes a harmful tool call through the Messages or
  Responses gateway.** The model only *proposes* calls. A tag becomes a native call
  (`tool_use`, `function_call`) only for a tool the client offered in that request,
  with object arguments, and the client runs it under its own sandbox and approvals
  ([ADR-0022](../decisions/adr/0022-text-protocol-tool-calls-for-website-models.md)).
  What the client sends is egress-checked at the gateway's configured
  classification.
- **Another local process drives the gateways or the operator's controls.** The
  scope tokens come from 0600 credential files, and the same guard protects MCP
  (whose operator tools include drain, resume, stop, and delete), both gateways,
  and the web UI. A process running as the operator's own user is not stopped by
  this (see the residual risk below). Target: `/admin/*` routes (not built) behind
  the operator token.
- **Another local process drives the logged-in browser through a debug port.** No
  remote-debugging port is exposed. Browser contexts are owned in-process by the
  provider runtime. If a port is ever needed, it is bound to loopback with a random
  port and an access token, and owned by the runtime.
- **Another local user connects to the invisible display and screenshots or drives
  the signed-in browser.** Every plugin-owned Xvfb runs with `-nolisten tcp` and
  `-auth` over a fresh owner-only Xauthority cookie (one FamilyWild record in a
  `0700` temp directory, removed when Xvfb exits); X clients get it through
  `XAUTHORITY`. Without the cookie the X handshake is refused (tested against a real
  Xvfb).
- **A remote model calls tools outside its turn, or tools the client did not
  offer.** A website model has no tool access of its own: through the gateways it
  can only propose a call in its answer, which becomes a native call only for a
  tool the client offered in that request, and the client runs it
  ([ADR-0022](../decisions/adr/0022-text-protocol-tool-calls-for-website-models.md)).
  Target, with MCP tool inversion (not built): turn-scoped random tokens, limited
  to the tools the current turn advertised.
- **Prompt injection claims authority, for example a fake `<environment_context>`.**
  Authority comes only from trusted envelopes
  ([INV-6](../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes)).
- **Prompt injection through tool output leads the model to destructive actions.**
  The client's own sandbox and approvals execute every tool; provider-side approval
  prompts fail closed unless explicitly enabled, and then only as "allow once".
- **Credential leakage to upper layers, logs, or the command line.** INV-8; secrets
  are never passed as process arguments; logs redact account state.
- **An agent-runtime Worker (or anything its model makes it run) reads the daemon's
  credentials from its environment.** Every agent process starts from DSH's own
  scrub of the daemon environment (`childEnvironment` in
  [`agent-runtime-core`](../../packages/agent-runtime-core/README.md)): names
  matching `KEY`, `PASSWORD`, `SECRET`, or `TOKEN`, and every `DSH_*` name, are
  removed, and so are the variables that lead to the operator's session (its message bus,
  key agents, and displays). A credential the agent needs is forwarded by name (`forwardEnv`), so its
  value never sits in configuration, and only the named variable reaches the agent.
- **Account state cross-contamination between accounts.** One browser process and
  context per account; state limited to the driver's `stateOrigins`; records `0600`
  in a `0700` vault ([browser runtime](../design/browser-runtime.md)).
- **Another login lands in an agent account's home (a re-login as someone else, or one login
  in two homes), so work and its transcripts go to an account the operator did not assign.**
  Each agent account is an enrollment slot: an owner-only home under the DSH home, hidden from
  every agent, and a run binds back only its own account's home. The account id is a keyed
  hash of the verified login (the key in the vault), never a name. The login is read again at
  each probe and before each run; a changed, missing, ambiguous, duplicate, or unverifiable
  identity is quarantined or signed out, recorded first, and only the operator's verify lifts
  it. A Worker derived from an account takes work only while the account is `ready`; hand-named
  Workers keep their earlier rule until the operator applies `system account migrate`
  ([enrollment and quarantine](../design/agent-runtimes.md#enrollment-and-quarantine),
  [ADR-0051](../decisions/adr/0051-agent-accounts-are-enrolled-slots-identified-by-their-login.md)).
- **Stolen password or TOTP secret.** Credentials encrypted at rest and decrypted
  only in memory; never logged or sent to models; TOTP computed locally, never sent
  to sites like 2fa.live; credential login runs only after sign-out evidence, with
  at most 2 attempts
  ([ADR-0017](../decisions/adr/0017-credential-login-and-linux-remote-browser.md)).
- **Remote-login page hijacking.** The VNC server listens only on an owner-only unix
  socket (no TCP port) on a private, X-authenticated Xvfb. The noVNC page and its
  WebSocket sit behind a random 256-bit URL token on loopback and check the Host
  header. Save and Cancel accept only POSTs from the page's own origin. Responses
  are `no-store`, `no-referrer`, and frame-denied. Access is over an SSH tunnel
  only, and the desktop expires (default 30 min).
- **Duplicate side effects after a crash (double PR, double message).** Receipts and
  reconciliation
  ([INV-4](../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay)).
- **Stale evidence approving a newer change.** Exact-subject binding
  ([INV-5](../architecture/invariants.md#inv-5-exact-subject-binding)). An
  approval names the plan the operator read (CLI `--plan`, MCP `plan`, the web UI
  sends the plan it shows); with several plans waiting, a verdict naming none is
  refused, so a plan that arrived later is never approved unseen. A verdict on the
  approval queue names the subject the operator was shown (the web UI sends each
  request's subject, MCP `approvals_decide` its `subject`); one for a changed subject
  is refused, and a batch verdict names its batch, so it never reaches a request
  outside it. A policy change is asked on the hash of the whole set it makes and applies only
  onto the set it was proposed on, so an approval never applies a set the operator was not shown.
- **The safety layer loosened by something other than the operator.** A new autonomy policy comes
  into force only by the operator: an approved `policy-change` request, proposed from `/ui` or
  MCP `approvals_policy_propose` (both operator only), or by the queue itself from repeated
  identical approvals of a command, which it only proposes (off by default,
  [ADR-0050](../decisions/adr/0050-the-queue-proposes-a-policy-change-from-repeated-approvals.md));
  or the configuration at a start, which no
  Worker can write ([ADR-0024](../decisions/adr/0024-agent-workers-confined-for-reads.md)). A
  stored set the configuration no longer matches is never used, nor dropped silently: the queue
  is refused until the operator chooses
  ([ADR-0041](../decisions/adr/0041-policy-changes-through-the-approval-queue.md)).
- **A review's repository read reaches an internal host, or is rebound to one (SSRF, DNS
  rebinding).** A repository read is an inbound read of public data: `system` fetches only what
  a public URL makes public, and sends only git's own requests
  ([sources](../design/teams.md#sources)).
  - **One reading of the URL.** It must be exactly its own parse, `https://<host>/<owner>/<repo>`
    (only the case of the scheme and host and the default port `:443` may differ), with no
    credentials, other port, query, fragment, whitespace, control characters, or backslash:
    a form that one parser reads as github.com and git as another host
    (`https://github.com\:x@127.0.0.1/…`), or as ssh (`https:github.com/…`), is refused. Git is
    given only the canonical URL rebuilt from the checked parts.
  - **An allowed, public host.** The host must be on the allow-list (workflow config
    `repositories.hosts`, default `github.com`), named rather than an address, and resolve to
    public addresses only: every non-public IPv4 range (private, loopback, link-local, shared,
    protocol, documentation, benchmarking, multicast, reserved) and IPv6 (unique-local,
    IPv4-compatible, site-local, link-local, multicast, mapped, translated, NAT64, 6to4, Teredo,
    documentation) is refused. Git is pinned to every
    address checked (`http.curloptResolve`), so it cannot resolve the host again to another. A git
    older than 2.37 cannot be pinned, and the read fails closed.
  - **A confined git.** Fixed arguments and no shell; `https` is the only protocol it may use
    (`protocol.allow=never`), with no redirects, hooks, credential helper, prompt, or ssh; no
    system, global, or ambient repository configuration (it runs in an empty repository of its
    own, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CEILING_DIRECTORIES`); a ref is a plain branch, tag,
    or commit name. Local repositories and a stub resolver are test seams of the reader's own
    package: the exported reader takes none, and an architecture rule refuses any other source that
    names them, so neither configuration nor code elsewhere can reach them.
  - **Bounds.** A blob over the per-file bound is never downloaded; files, bytes, tree entries,
    git output, every git call, and the whole read are bounded, and a stopped call kills its
    process group (its input pipe closing then is expected, never a crash). Focus globs are
    matched without backtracking within a step budget, and request words are capped.
- **Repository content injects instructions into a review.** Each file, its path included,
  reaches members marked as another party's data, between fence lines derived from a hash of
  its content, which its own text cannot close; so does the list of unread paths. Members only
  report findings; every quote is checked against the bytes they were shown, by code, and a
  model never confirms a finding
  ([INV-6](../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes)). A
  quote too short to identify one line confirms nothing, and a merged finding keeps each
  member's own report and shows its class and severity per report, so one member's quote never
  confirms, or appears to confirm, another's blocking claim. An agent Worker that is a member runs
  under the review-member profile: its gate denies every tool call, in an empty workspace outside
  any repository, so injected text cannot make it act
  ([ADR-0049](../decisions/adr/0049-read-only-agent-workers-as-review-members.md)).
- **A tampered backup writes outside the state directory on restore.** Restore
  accepts only `system.db`, `vault.enc`, and `vault.key` in a backup manifest; any
  other name (for example `../../.ssh/authorized_keys`) refuses the whole backup
  before anything is written.
- **A gateway client's conversation continues another client's.** Two clients with
  the same opening share a thread key, but a thread resumes only when the request's
  history matches the fingerprint of what the provider conversation saw (call ids
  are random per reply); otherwise a fresh conversation opens
  ([`gateway-turns`](../../packages/gateway-turns/README.md)).
- **An agent-runtime Worker acts outside its workspace or approvals.** The policy
  comes only from operator configuration (the `agent-workers` row: each Worker's or
  role's workspace, sandbox, and tools; INV-6). Each runtime enforces it with its own sandbox,
  exactly, or the run is refused before it starts (REQ-WRK-6):
  - Claude Code (`runtime-claude-agent-sdk`): only the listed built-in tools
    exist and are pre-approved, each file tool scoped to the workspace, reads
    included (`Read(./**)`, `Grep(./**)`, `Glob(./**)` for `read-only`;
    `workspace-write` adds `Edit(./**)`, `Write(./**)`, and `Bash`, whose
    commands run in the SDK's sandbox, below). A bare file rule reaches the
    whole disk, including the daemon's `vault.key` and token files.
    `permissionMode: dontAsk` denies anything else without a prompt;
    `settingSources: []` keeps the operator's own settings and hooks out; no
    MCP server is attached; it runs in its own home (`CLAUDE_CONFIG_DIR`),
    never the operator's `~/.claude`; the run's tool gate is its one PreToolUse
    hook, which asks the autonomy policy before every tool call: `deny` and
    `defer` hold in every permission mode, and an allowed call still meets the
    workspace-scoped pre-approvals (a hook's `allow` would skip them, so the
    gate never gives one)
    ([a Worker's tool calls](../design/approvals.md#a-workers-tool-calls)).
    Claude Code starts under the read confinement below, like Codex and ACP
    agents;
  - ACP agents cannot ask a tool gate before each tool call
    (`gatesToolCalls: false`), nor can the Antigravity CLI on an agy version not
    verified live, so they refuse a gated run and the `agents` source admits
    none of their Workers; the policies below hold for them still;
  - Codex (`runtime-codex-sdk`): its own `sandboxMode` (`read-only`, or
    `workspace-write` confined to the workspace) and working directory,
    approvals `never` (an escalated command is refused), network access and web
    search off, and the features that add tools no hook sees off (apps, plugins,
    subagents, image generation, browser and computer use). It runs in its own
    Codex home (`CODEX_HOME`), never the operator's `~/.codex`, which holds the
    `system` MCP server: Codex starts MCP servers outside its sandbox, so the
    probe and every run fail closed if that home configures any, and a `config`
    holding `mcp_servers` or `hooks` is refused. Codex's own sandbox confines
    writes, not reads, so Codex starts under the read confinement below. The
    run's tool gate is its one PreToolUse hook
    ([ADR-0042](../decisions/adr/0042-codex-workers-ask-the-gate-through-a-hook-bridge.md),
    [Codex's gate](../design/agent-runtimes.md#codexs-gate)), a command that
    reaches the gate over a per-run unix socket with a key Codex's commands
    never see. What remains, and how it is held:
    - Codex runs a tool when its hook fails, prints what it cannot read, or
      times out, and skips an untrusted hook silently. The hook blocks on every
      failure of its own; the probe proves, on the host, with the run's
      configuration, that the hook answers before a tool call and its deny
      holds, before any Codex Worker is admitted; and a tool item that no
      allowed call accounts for stops the run (detection after one call, inside
      Codex's sandbox).
    - `write_stdin` asks no hook: Codex runs with `/dev/ptmx` and `/dev/pts`
      hidden, so no command has a terminal to write to, and the operator's
      terminals are out of reach (no `TIOCSTI` into them); the probe proves no
      terminal session starts.
    - The hook sees an `exec_command`'s `command` only, not its `workdir` or
      `shell`: those act inside Codex's sandbox, which bounds every command, as
      a listed command such as `npm test` running code the run wrote does;
    - a process inside Codex's sandbox that could read the socket's path cannot
      present the key, and the gate only answers: no call runs because of it;
  - ACP agents (`runtime-acp`): the client side enforces the policy. Every
    permission request is rejected, file reads are served inside the workspace
    only, and no write or terminal capability or MCP server is offered. Because
    an ACP agent can still act on the disk without asking, `read-only` is
    offered only for an agent the operator vouches for (`honoursPermissions`),
    and the agent process runs under the read confinement below, so what it
    reads on its own cannot reach host state either. An aborted ACP agent that
    ignores the cancel gets SIGTERM, then SIGKILL; under the confinement the
    signal ends its whole PID namespace, children included, so it cannot hang a
    run or keep writing after it.
  - The Antigravity CLI (`runtime-antigravity-cli`): agy has no per-tool
    allow-list a headless run can be held to, so every tool call passes its
    PreToolUse hook, bridged to the run over a unix socket in an owner-only
    directory bound read-only into that run's confinement only, with a per-run
    token; any failure on the way is a deny. The runtime's own rules decide first
    (the sandbox's reading and file-editing tools only, no command, web, browser,
    subagent, or MCP tool; every location in a call inside the workspace, on
    disk; no customization root written), then the run's gate. It runs in its
    own home (`HOME`), never the operator's `~/.gemini` or
    `~/.config/antigravity`, with its auto-update off; a home or workspace that
    configures hooks, MCP servers, or plugins, which agy would run outside every
    gate, is refused. agy runs a tool when a hook exits 0 printing nothing, so
    the hook's command prints a deny itself whenever the run's hook gives no
    answer. That agy runs the hook before each tool call takes a model turn to
    show, so it offers a sandbox and gates only on a version a supervised live
    check verified (1.4.6,
    [ADR-0043](../decisions/adr/0043-antigravity-cli-workers-gated-on-a-version-verified-live.md)).
    An agy upgrade is unverified until checked the same way. Not covered: the
    version check trusts that one agy version runs its hooks the same on every
    host; the check covered `gemini-3.8-flash`'s file tools, and another
    model's tools are denied, not proven; and the token is no secret from the agent's own processes, which
    share the run's user and namespaces (they can reach only the gate's
    questions, never run a call).

  **Read confinement** ([ADR-0024](../decisions/adr/0024-agent-workers-confined-for-reads.md),
  [ADR-0038](../decisions/adr/0038-confined-commands-for-claude-code-workers.md)):
  every agent (Claude Code, Codex, ACP agents, the Antigravity CLI) starts under bubblewrap, in its own PID
  namespace and session. It hides the DSH home (vault, key, tokens, store, login profiles,
  DSH's own credentials); the session's runtime directory, so the user's message
  bus (which can start commands outside any sandbox) and key agents are out of
  reach; the temporary directories, which hold the browsers' live profiles, the
  display cookie, and the remote-login socket; the service's credentials; the
  usual credential stores in the home directory; and every secret path a plugin
  registered, wherever the operator keeps it. Only the operator's tools
  (read-only), the Worker's own home (its account's, so never another account's sign-in), and
  its workspace come back. The probe
  proves it positively on the host and the source checks it again before each
  run. Not covered: abstract Unix sockets (an X server's still needs the hidden
  cookie), and other files in the home directory, which an operator adds to the
  `agent-runtimes` row's `hide`.

  **Confined commands** (B3,
  [ADR-0038](../decisions/adr/0038-confined-commands-for-claude-code-workers.md)): a
  Claude Code Worker's shell runs only in `workspace-write` runs, each command
  inside the SDK's sandbox nested in the read confinement: the root read-only and
  only the run's workspace (a git worktree per writing task) writable, its own
  network namespace with no domain allowed (`strictAllowlist`), no command outside
  the sandbox (`allowUnsandboxedCommands: false`), and a run whose sandbox cannot
  start fails (`failIfUnavailable`). The probe proves both layers on the host (the
  read confinement, then a sandbox with no network started inside it) before the
  Worker may write or `validate`; the release checklist verifies the sandbox
  Claude Code itself starts, live. Each command still passes the tool gate by its
  exact argv, so a shell metacharacter is forbidden and an unlisted command asks
  the operator. What remains:
  - a kernel escape from the namespaces, which neither bubblewrap nor the
    sandbox runtime claims to stop;
  - reads inside the confinement: a command can read what Claude Code itself
    can, including its own home (its sign-in, and the transcripts of every
    Claude Code session run in that home: every role of its account) and the variables the operator
    forwards to it (`forwardEnv`). It cannot send them off the host (no
    network), but it can show them to the model or write them into the
    worktree; forward only what the Worker needs, and keep Workers of different
    classifications on different hosts or homes;
  - Claude Code's own process is not network-confined (its model is remote);
    its tools are bound by the pre-approvals and the gate, and `WebFetch` and
    `WebSearch` are not offered.

  A Worker whose runtime cannot enforce its configured sandbox, or cannot prove
  on this host that the host state is unreadable (`readsConfined`), is
  unavailable, and only read-only Workers prove `review`. The confinement is only
  as strong as each runtime's sandbox and bubblewrap.

  **Landing** ([ADR-0060](../decisions/adr/0060-an-accepted-result-lands-on-the-operators-merge-approval.md)):
  what a Worker wrote reaches the operator's checkout of the repository only by a
  merge of its run's branch the operator approved (or a policy set `merge` to
  `auto`), at the exact SHAs and with the `git diff --stat` the request showed.
  The commit is made only while the worktree is the tree that was reviewed and
  accepted, and git runs with hooks off and no global configuration, so nothing
  the Worker wrote runs during the commit or the merge. The merged files then sit
  in the checkout as any reviewed change does: a tool there that runs files
  automatically (a directory's environment file, a build step) runs what was
  merged. Nothing is pushed.

  **Carrying** ([ADR-0061](../decisions/adr/0061-a-tasks-next-attempt-starts-from-the-work-its-previous-attempt-left.md),
 accepted 2026-10-25, D59):
  a board task's next attempt may start from the tree its previous attempt's
  writer left, so content one agent run wrote is the starting point of the next
  run's worktree. It is carried only when no review or person judged it, only
  while it is exactly the tree that writer left (any later edit refuses it) and
  no run of it can still write it, and only onto the commit a fresh worktree
  would be cut from; the next attempt's review is shown and binds to the whole
  change, so carried content reaches a merge only through the same review and
  approval as any change. The worktree's setup (ADR-0058) then runs on that
  content: a repository's install scripts as the earlier agent left them run
  under the setup's confinement (the host read-only but the worktree, no
  network, a deadline), the same bounds as the agent's own commands, with read
  access to the package store's files a view shows read-only. A listed setup or
  validation command is allowed by its argv, never by what the repository's files
  make it run.
- **Local or private data leaks to a provider website or API through a prompt or
  attachment.** `ctx.egress` checks the **actual outgoing payload** inside the
  Worker source, after routing chose the Worker and before anything is sent
  ([INV-12](../architecture/invariants.md#inv-12-data-egress-is-explicit)). This
  holds for every Worker source: a website turn (class `website`), an agent run
  (class `agent`: the agent runs here, but its model is remote, so routing admitting
  a local Worker is not enough), and a model call (class `model` for an API model,
  `model-local` for a model on this machine, from the operator's catalog entry). The
  check combines two rules. First, the caller's classification must be permitted for
  the Worker class (by default `website`, `agent`, and `model` receive only `public`
  and `operator-shared`, so `local-private` is denied, `model-local` included; an
  operator whose agent model runs locally widens `agent`, and one whose model server
  runs here widens `model-local`). A catalog entry wrongly marked `local` alone sends
  no private data: widening the class is a second, explicit act. Second, a
  credential scan must find nothing (secretlint's recommended rules plus operator
  deny patterns). Every check is an `egress` decision, and findings keep rule ids
  and offsets, never the secret. A denial fails the turn, agent run, or model call as
  `egress_denied` (USER_ACTION) and nothing is sent. A scan cannot recognize every
  kind of private data, so classification remains the caller's statement.
  Client-scope `result` returns the requester's own answer text, which for a website
  Worker is a `local-private` provider answer
  ([artifacts](../design/artifacts.md#envelope)): INV-12 governs what is sent to
  Workers, not returning a caller its own result.
- **An AI client holding a control token triggers operator actions.** Each
  credential grants only its scope
  ([ADR-0023](../decisions/adr/0023-scoped-control-credentials.md),
  [scopes](../../packages/plugins/mcp-server/README.md#scopes)).
  MCP clients get the client token: `tools/list` shows them only the client
  tools, and a call to an operator tool (`approve`, `delete`, `drain`, the
  `account_*` tools) is refused with `403 insufficient_scope` before it runs. A
  tool that declares no scope is operator-only (fail closed). Model clients, and
  a Codex Worker on the Responses gateway, get the model token, which `/mcp` and
  `/ui` refuse (`401`). So only the operator token, which the CLI and the web UI
  use, reaches the credential tools (`account_set_credentials`,
  `account_relogin`, `account_code`). `account_list` returns secret-free views,
  and `account_save` only re-captures the operator's own login profile and
  returns no secrets. A credential relogin that signs in as a different account
  than the one saved is refused (`reauth_required`) and stores nothing, so a
  planted credential cannot redirect the account; only a manual Save at the
  remote login switches accounts.
  **Residual risk:** the token files are owner-only, so any process running as
  the operator's OS user can still read `operator.token`. Scopes limit what a
  handed-out credential can do; they do not isolate processes of the same user.
  The deployment is a single user on a single machine (CON-6), so that user's
  account is the boundary.
- **Login profiles leak sessions for every site the operator visited during login.**
  Profiles live in `<DSH_HOME>/system/login-profiles/<id>` (`0700`) and are used
  only for interactive login and Save. Only the driver's `stateOrigins` are captured
  into the encrypted vault. Chrome's own cookie protection without an OS keyring is
  weak, so the profile directory's permissions are the control. Operators should log
  in only to the provider site in that profile.
- **A tampered managed Chrome download.** `@puppeteer/browsers` downloads the pinned
  Chrome for Testing build from Google over TLS (no separate checksum is published
  per build). The pin is reviewed in `chrome.lock.json`. A recent system Chrome is
  preferred when present
  ([ADR-0020](../decisions/adr/0020-pinned-managed-chrome.md)).
- **A web page in the operator's browser reads or drives the operator UI.** The
  `/ui` shell carries no data. The token rides in the URL fragment (never sent to a
  server) and moves to session storage. `/ui/api` passes the shared guard: a
  loopback `Host`, no `Origin` but the UI's own, and the operator token (constant
  time; a client or model token gets `401`); actions take JSON bodies only. A
  strict CSP (`self` only, no frames, no forms) applies, and data is rendered with `textContent`, never parsed as HTML
  ([web UI](../../packages/plugins/web-ui/README.md)).
- **Client configs leaking a control token.** Claude Code gets the client token's
  header from `system mcp-headers` (`headersHelper`) on each connection; Codex runs
  the stdio shim `system mcp-stdio`, which reads the client token file itself. The
  model clients get the model token from `system mcp-token --scope model`, through
  Claude Code's `apiKeyHelper` or a subshell (`system claude-env`, `codex-env`).
  No client config holds a token, and neither token a client holds reaches an
  operator tool.
- **A prompt visible in the process list or shell history.** `system ask -` reads
  the prompt from stdin; MCP calls carry prompts in request bodies, never in
  arguments.
- **A peer message carries prompt injection or claims authority ("the operator
  approved this").** Peer messages are untrusted data; authority never comes from
  messages (INV-6); policy and egress are checked on every message; only `approval`
  artifacts from the operator grant approval.
- **Telemetry or data leaving through host defaults.** DSH telemetry rows disabled
  in the `system` profile; DeepSeek-specific defaults disabled unless configured
  ([ADR-0018](../decisions/adr/0018-build-on-dsh-core.md)).
- **A notification leaks what it is about, or its webhook's token.** The `notify` row is off;
  its notices are made by code from ids, classes, kinds, and times only, never a prompt, an
  answer, a request's summary or command, or a token (the `/ui` link carries none). Its webhook
  posts only after the egress gate permits the exact body for the `webhook` class, whose default
  lets nothing leave (INV-12), and follows no redirect; its URL is a credential in the vault,
  read at each delivery, never configuration, and never logged or recorded
  ([notifications](../design/notifications.md#sinks)). `notify-send` runs without a shell, with
  `--` before the text and only the environment the session bus needs.
- **Prompts kept indefinitely on disk.** The store is `0600`; finished turns, their
  prompt text, and their receipts are deleted after `retainDays` (default 30), in
  one transaction, while answers remain as artifacts holding the prompt hash only
  ([INV-9](../architecture/invariants.md#inv-9-everything-is-bounded)).
- **Local-private artifact bodies read from disk by another account or from a
  backup.** The store and everything else under `<DSH_HOME>/system/` are `0600` in
  `0700` directories; only credentials are encrypted at rest (vault). Full-disk or
  home-directory encryption is a **deployment precondition** for hosts holding
  private data: application-level encryption of the store would not help against
  the same user, who holds the key, and SQLCipher does not work with
  `node:sqlite` ([PROP-0003](../proposals/0003-production-readiness.md#m6a-security-hardening)).
- **The vault key read together with the vault.** By default the key sits beside
  the vault, so anyone who can read the account reads both. The key can live
  elsewhere (`keyFile`: another volume or a systemd credential); a key outside the
  state directory is never put in a backup, and agent Workers cannot read it
  ([key custody](../operations/runbooks.md#key-custody)).
- **A malicious or compromised plugin.** Plugins run in-process with full host
  trust, so only operator-installed plugins from the profile are loaded; there is no
  remote plugin installation; plugin packages are pinned in the lockfile.
- **A supply-chain change in the browser stack or SDKs.** Committed lockfile
  (installed with `--frozen-lockfile` in CI), one exact pinned DSH version, no
  vendored binaries. CI fails on any high or critical advisory in a production
  dependency (`pnpm audit:deps`, daily as well), scans every tracked file for
  credentials with the scan `egress` uses (`pnpm check:secrets`), and runs CodeQL.
  An advisory in a dependency of a dependency is lifted by an override, within every
  dependent's declared range ([overrides](../engineering/dependencies.md#overrides)).
  The clean `pnpm audit` that
  [production readiness](../requirements/release-scope.md#operational-readiness)
  requires is a [release check](../validation/release-checklist.md). Third-party Actions
  are pinned by commit, and Dependabot proposes dependency and Action updates,
  except DSH, whose pin is bumped by hand (CON-8)
  ([CI gates](../engineering/testing.md#ci-gates)).
- **Provider terms or abuse controls lead to account loss.** Bounded per-account
  concurrency; no evasion features; operator responsibility (CON-3). A provider's accounts,
  website and agent, are assigned by default: a limit on one makes its work wait instead of
  moving it to another account of that provider, and pooling them needs the operator's
  recorded `pooledTerms`
  ([ADR-0052 (proposed)](../decisions/adr/0052-accounts-are-assigned-unless-pooling-is-recorded.md)).

## Out of scope (until a requirement exists)

Multi-user isolation, network-exposed deployment, and a malicious operator.
