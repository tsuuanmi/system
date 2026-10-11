# Threat model

> Target state. Deployment assumption: a single operator on a single machine
> (CON-6).

## Assets

- Provider account sessions: cookies, auth storage, and conversation history.
- The local workspace: files, shell, and VCS credentials reachable through tools.
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
| A remote model calls tools outside its turn, or tools the client did not offer | turn-scoped random tokens, limited to the tools the current turn advertised |
| Prompt injection claims authority, for example a fake `<environment_context>` | authority comes only from trusted envelopes ([INV-6](../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes)) |
| Prompt injection through tool output leads the model to destructive actions | the client's own sandbox and approvals execute every tool; provider-side approval prompts fail closed unless explicitly enabled, and then only as "allow once" |
| Credential leakage to upper layers, logs, or the command line | INV-8; secrets are never passed as process arguments; logs redact account state |
| Remote-login page hijacking | VNC is bound to localhost with a one-time password; the noVNC page sits behind a random token; access is over an SSH tunnel only |
| Duplicate side effects after a crash (double PR, double message) | receipts and reconciliation ([INV-4](../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay)) |
| Stale evidence approving a newer change | exact-subject binding ([INV-5](../architecture/invariants.md#inv-5-exact-subject-binding)) |
| An agent-runtime Worker acts outside its workspace or approvals | the policy comes from trusted envelopes and maps exactly onto the agent's sandbox and permission modes; a policy that cannot be expressed exactly fails the run (REQ-WRK-6) |
| A malicious or compromised plugin | plugins run in-process with full host trust, so only operator-installed plugins from the profile are loaded; there is no remote plugin installation; plugin packages are pinned in the lockfile |
| A supply-chain change in the browser stack or SDKs | committed lockfile, pinned versions, `bun audit` in CI, no vendored binaries |
| Provider terms or abuse controls lead to account loss | bounded per-account concurrency; no evasion features; operator responsibility (CON-3) |

## Out of scope (until a requirement exists)

Multi-user isolation, network-exposed deployment, and a malicious operator.
