# ADR-0023: Scoped static control credentials on loopback; OAuth deferred

- **Status:** Proposed
- **Date:** 2026-10-14
- **Related:** [PROP-0003](../../proposals/0003-production-readiness.md#m6a-security-hardening),
  [threat model](../../security/threat-model.md#threats-and-controls), QA-5,
  [INV-6](../../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes)

## Context

Every client endpoint (`/mcp`, `/anthropic`, `/openai`, `/ui`) accepts one bearer
token, `<DSH_HOME>/system/mcp.token`, checked by `guardRequest` in
`packages/gateway-core`. Whoever holds it can call every MCP tool: the credential
tools (`account_set_credentials`, `account_relogin`, `account_code`), `approve`,
`delete`, and `drain`. The threat model lists a separate operator scope as not
built.

Holders differ in trust. The operator's CLI and `/ui` act for the operator. An AI
client such as Claude Code or Codex should ask for work and read results, not
approve its own plans or handle passwords. A Codex Worker whose model provider is
the Responses gateway is given the token (`forwardEnv: ['SYSTEM_MCP_TOKEN']`),
so a Worker that `system` runs can drive `system` itself.

The MCP authorization specification uses OAuth 2.1 (PKCE, protected-resource
metadata, incremental scopes answered with `403 insufficient_scope`). It targets
remote servers with many users. `system` binds to loopback for one user (CON-6).

## Options

1. Keep one token and rely on clients to behave.
2. **Static tokens per scope.** One owner-only token file per scope; the guard
   maps the presented token to its scope; each tool and route declares the scope
   it needs.
3. OAuth 2.1 with a local authorization server and per-client registration.

## Decision

Option 2, with three scopes:

| Scope | Grants |
|---|---|
| `operator` | every operator action: `approve`, `stop`, `continue`, `delete`, `supersede`, `drain`, `resume`, the `account_*` tools, and `/ui` |
| `client` | `ask`, `research`, `run`, `result`, `status`, `explain`, `usage`, `session_send`, `session_inbox` |
| `model` | the `/anthropic` and `/openai` gateways, nothing on `/mcp` |

- Each token is a separate owner-only file under `<DSH_HOME>/system/`, read with
  the existing secret-file rules. `mcp.token` is retired: nothing reads it, and
  the upgrade runbook deletes it.
- `guardRequest` returns the matched scope. A tool registration declares its
  scope as part of the `mcp` seam, and the conformance suite checks it.
- `tools/list` returns only the caller's tools. A call outside the caller's scope
  is refused with `403` and `insufficient_scope`, the error shape the MCP
  specification uses.
- The CLI uses the operator scope. `system mcp-config` and the stdio shim hand out
  the client scope; `system claude-env` and `codex-env` hand out the model scope.
- A token is rotated by deleting its file and restarting.
- New tools default to the `operator` scope (fail closed).
- A handler is told the caller's scope, and what it records names that caller:
  a `session_send` with a client token is from `client`, never from `operator`
  (INV-13).

OAuth is deferred until a requirement changes CON-6. The scope names and the
`insufficient_scope` response are chosen so that OAuth scopes can map onto them
then.

## Consequences

- A leaked client or model token can no longer approve plans, handle
  credentials, delete runs, or reach the operator page.
- A Worker given the model token can call only the model gateways with it. It
  can still read the other token files until agent Workers are confined for reads
  ([ADR-0024](0024-agent-workers-confined-for-reads.md)).
- Clients configured with the old token must re-run the helpers once; there is no
  compatibility path for `mcp.token`.
- The threat model's "separate operator token scope" moves from target to
  control when this is built, with QA-14 (proposed) as its requirement.
- Revisit if `system` is ever exposed beyond loopback or to more than one user.
