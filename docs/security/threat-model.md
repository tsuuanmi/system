# Threat model

> Target state. Deployment assumption: a single operator on a single machine
> (CON-6).

## Assets

- Provider account sessions: cookies, auth storage, and conversation history.
- The local workspace: files, shell, and VCS credentials reachable through tools.
- Local and private data: datasets, documents, and repository content that must not leave the machine without policy.
- Workflow state and results.
- Control credentials: the gateway bearer token and turn tokens.

## Trust boundaries

```text
trusted:    operator · host process · account vault · operator configuration · plugins the operator installed
semi:       local client (Codex, Claude Code, MCP agent) — trusted for its own envelope, sandbox, approvals
            agent-runtime Workers (Claude Code, Codex, ACP agents) — run under policies set by system
untrusted:  provider websites · model output · tool output · repository content ·
            web pages · other local processes · other users on the machine
```

## Threats and controls

| Threat | Control |
|---|---|
| A web page in the operator's browser calls the loopback gateway | non-GET requests with `Origin` are rejected; the bearer token is required ([gateways](../design/gateways.md#responses-gateway-codex)) |
| Another local process drives the gateway or control routes | the bearer token comes from a 0600 credential file; `/admin/*` needs the same token |
| Another local process drives the logged-in browser through a debug port | no remote-debugging port is exposed. Browser contexts are owned in-process by the provider runtime. If a port is ever needed, it is bound to loopback with a random port and an access token, and owned by the runtime |
| Another local user connects to the invisible display and screenshots or drives the signed-in browser | every plugin-owned Xvfb runs with `-nolisten tcp` and `-auth` over a fresh owner-only Xauthority cookie (one FamilyWild record in a `0700` temp directory, removed when Xvfb exits); X clients get it through `XAUTHORITY`. Without the cookie the X handshake is refused (tested against a real Xvfb) |
| A remote model calls tools outside its turn, or tools the client did not offer | turn-scoped random tokens, limited to the tools the current turn advertised |
| Prompt injection claims authority, for example a fake `<environment_context>` | authority comes only from trusted envelopes ([INV-6](../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes)) |
| Prompt injection through tool output leads the model to destructive actions | the client's own sandbox and approvals execute every tool; provider-side approval prompts fail closed unless explicitly enabled, and then only as "allow once" |
| Credential leakage to upper layers, logs, or the command line | INV-8; secrets are never passed as process arguments; logs redact account state |
| Account state cross-contamination between accounts | one browser process and context per account; state limited to the driver's `stateOrigins`; records `0600` in a `0700` vault ([browser runtime](../design/browser-runtime.md)) |
| Stolen password or TOTP secret | credentials encrypted at rest and decrypted only in memory; never logged or sent to models; TOTP computed locally, never sent to sites like 2fa.live; credential login runs only after sign-out evidence, with at most 2 attempts ([ADR-0017](../decisions/adr/0017-credential-login-and-linux-remote-browser.md)) |
| Remote-login page hijacking | VNC is bound to localhost with a one-time password; the noVNC page sits behind a random token; access is over an SSH tunnel only |
| Duplicate side effects after a crash (double PR, double message) | receipts and reconciliation ([INV-4](../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay)) |
| Stale evidence approving a newer change | exact-subject binding ([INV-5](../architecture/invariants.md#inv-5-exact-subject-binding)) |
| An agent-runtime Worker acts outside its workspace or approvals | the policy comes from trusted envelopes and maps exactly onto the agent's sandbox and permission modes; a policy that cannot be expressed exactly fails the run (REQ-WRK-6) |
| Local or private data leaks to a provider website or API through a prompt or attachment | egress check on the actual outgoing payload against an explicit policy; `local-private` work admitted only to local Workers ([INV-12](../architecture/invariants.md#inv-12-data-egress-is-explicit)) |
| A peer message carries prompt injection or claims authority ("the operator approved this") | peer messages are untrusted data; authority never comes from messages (INV-6); policy and egress are checked on every message; only `approval` artifacts from the operator grant approval |
| Telemetry or data leaving through host defaults | DSH telemetry rows disabled in the `system` profile; DeepSeek-specific defaults disabled unless configured ([ADR-0018](../decisions/adr/0018-build-on-dsh-core.md)) |
| Prompts kept indefinitely on disk | the store is `0600`; finished turns and their prompt text are deleted after `retainDays` (default 30), while answers remain as artifacts holding the prompt hash only |
| Local-private artifact bodies read from disk by another account or from a backup | blobs and the store are `0600` in `0700` directories; only credentials are encrypted at rest (vault). Full-disk or home-directory encryption is recommended for hosts holding private data |
| A malicious or compromised plugin | plugins run in-process with full host trust, so only operator-installed plugins from the profile are loaded; there is no remote plugin installation; plugin packages are pinned in the lockfile |
| A supply-chain change in the browser stack or SDKs | committed lockfile, one exact pinned DSH version, `pnpm audit` in CI, no vendored binaries |
| Provider terms or abuse controls lead to account loss | bounded per-account concurrency; no evasion features; operator responsibility (CON-3) |

## Out of scope (until a requirement exists)

Multi-user isolation, network-exposed deployment, and a malicious operator.
