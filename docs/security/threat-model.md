# Threat model

> Target state. Deployment assumption: a single operator on a single machine
> (CON-6).
>
> Not built yet (target only): turn tokens for MCP tool inversion (the gateways use the
> text tool protocol of
> [ADR-0022](../decisions/adr/0022-text-protocol-tool-calls-for-website-models.md))
> and `/admin/*` routes.

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

## Trust boundaries

| Zone | Who |
|---|---|
| trusted | the operator, the host process, the account vault, operator configuration, plugins the operator installed |
| semi-trusted | local clients (Codex, Claude Code, MCP agents), trusted for their own envelope, sandbox, and approvals; agent-runtime Workers (Claude Code, Codex, ACP agents), confined by their own runtime's sandbox under the operator's policy |
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
  (and `/healthz`), and the web UI's static shell.
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
  removed. A credential the agent needs is forwarded by name (`forwardEnv`), so its
  value never sits in configuration, and only the named variable reaches the agent.
- **Account state cross-contamination between accounts.** One browser process and
  context per account; state limited to the driver's `stateOrigins`; records `0600`
  in a `0700` vault ([browser runtime](../design/browser-runtime.md)).
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
  refused, so a plan that arrived later is never approved unseen.
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
  comes only from operator configuration (each `agent-workers` row's workspace,
  sandbox, and tools; INV-6). Each runtime enforces it with its own sandbox,
  exactly, or the run is refused before it starts (REQ-WRK-6):
  - Claude Code (`runtime-claude-agent-sdk`): only the listed built-in tools
    exist and are pre-approved, each scoped to the workspace, reads included
    (`Read(./**)`, `Grep(./**)`, `Glob(./**)` for `read-only`; `workspace-write`
    adds `Edit(./**)` and `Write(./**)`). A bare rule reaches the whole disk,
    including the daemon's `vault.key` and token files. `permissionMode: dontAsk`
    denies anything else without a prompt; `settingSources: []` keeps the
    operator's own settings and hooks out; no MCP server is attached;
  - Codex (`runtime-codex-sdk`): its own `sandboxMode` (`read-only`, or
    `workspace-write` confined to the workspace) and working directory,
    approvals `never`, network access and web search off. It runs in its own
    Codex home (`CODEX_HOME`), never the operator's `~/.codex`, which holds the
    `system` MCP server: Codex starts MCP servers outside its sandbox, so the
    probe and every run fail closed if that home configures any, and a `config`
    holding `mcp_servers` is refused. Codex's own sandbox confines writes, not
    reads, so Codex starts under bubblewrap, which hides the whole DSH home (the
    vault, its key, the tokens, the store, the login profiles, DSH's own
    credentials) and the service's credentials directory, binding back only the
    operator's tools read-only and the Worker's own home
    ([ADR-0024](../decisions/adr/0024-agent-workers-confined-for-reads.md));
  - ACP agents (`runtime-acp`): the client side enforces the policy. Every
    permission request is rejected, file reads are served inside the workspace
    only, and no write or terminal capability or MCP server is offered. Because
    an ACP agent can still act on the disk without asking, `read-only` is
    offered only for an agent the operator vouches for (`honoursPermissions`),
    and the agent process runs under the same bubblewrap confinement as Codex,
    so what it reads on its own cannot reach host state either.
    An aborted ACP agent that ignores the cancel gets SIGTERM, then SIGKILL, so
    it cannot hang a run.

  A Worker whose runtime cannot enforce its configured sandbox, or cannot prove
  on this host that the host state is unreadable (`readsConfined`), is
  unavailable, and only read-only Workers prove `review`. The confinement is only
  as strong as each runtime's sandbox and bubblewrap.
- **Local or private data leaks to a provider website or API through a prompt or
  attachment.** `ctx.egress` checks the **actual outgoing payload** inside the
  Worker source, after routing chose the Worker and before anything is sent
  ([INV-12](../architecture/invariants.md#inv-12-data-egress-is-explicit)). This
  holds for both Worker sources: a website turn (class `website`) and an agent run
  (class `agent`: the agent runs here, but its model is remote, so routing admitting
  a local Worker is not enough). The check combines two rules. First, the caller's
  classification must be permitted for the Worker class (by default `website` and
  `agent` receive only `public` and `operator-shared`, so `local-private` is
  denied; an operator whose agent model runs locally widens `agent`). Second, a
  credential scan must find nothing (secretlint's recommended rules plus operator
  deny patterns). Every check is an `egress` decision, and findings keep rule ids
  and offsets, never the secret. A denial fails the turn or agent run as
  `egress_denied` (USER_ACTION) and nothing is sent. A scan cannot recognize every
  kind of private data, so classification remains the caller's statement.
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
- **Prompts kept indefinitely on disk.** The store is `0600`; finished turns, their
  prompt text, and their receipts are deleted after `retainDays` (default 30), in
  one transaction, while answers remain as artifacts holding the prompt hash only
  ([INV-9](../architecture/invariants.md#inv-9-everything-is-bounded)).
- **Local-private artifact bodies read from disk by another account or from a
  backup.** The store and everything else under `<DSH_HOME>/system/` are `0600` in
  `0700` directories; only credentials are encrypted at rest (vault). Full-disk or
  home-directory encryption is recommended for hosts holding private data.
- **A malicious or compromised plugin.** Plugins run in-process with full host
  trust, so only operator-installed plugins from the profile are loaded; there is no
  remote plugin installation; plugin packages are pinned in the lockfile.
- **A supply-chain change in the browser stack or SDKs.** Committed lockfile
  (installed with `--frozen-lockfile` in CI), one exact pinned DSH version, no
  vendored binaries. CI fails on any high or critical advisory in a production
  dependency (`pnpm audit:deps`, daily as well), scans every tracked file for
  credentials with the scan `egress` uses (`pnpm check:secrets`), and runs CodeQL.
  The clean `pnpm audit` that
  [production readiness](../requirements/release-scope.md#operational-readiness)
  requires is a [release check](../validation/release-checklist.md). Third-party Actions
  are pinned by commit, and Dependabot proposes dependency and Action updates,
  except DSH, whose pin is bumped by hand (CON-8)
  ([CI gates](../engineering/testing.md#ci-gates)).
- **Provider terms or abuse controls lead to account loss.** Bounded per-account
  concurrency; no evasion features; operator responsibility (CON-3).

## Out of scope (until a requirement exists)

Multi-user isolation, network-exposed deployment, and a malicious operator.
