# codex-chatgpt-web analysis

Non-normative. Source:
[miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) v6.1.8,
analysed on 2026-10-11.

## What it is

codex-chatgpt-web is an Electron launcher plus a Bun loopback daemon. It lets
Codex use the ChatGPT **web** models on a user's plan. They appear as "(Web)"
entries in Codex's model picker. Setup points Codex's built-in provider at the
daemon, and that configuration edit is journaled and reversible. A "Full harness"
mode lets the web model use Codex's local tools through an OpenAI MCP tunnel and a
ChatGPT developer-mode connector.

## Strongest mechanisms

- **Responses API emulation** with SSE, compaction routes, and passthrough of
  non-web models to the native backend. WebSocket upgrades receive 426 so clients
  fall back to SSE, and non-GET requests carrying `Origin` are rejected.
- **MCP tool inversion:** the remote model calls an MCP tool, the broker queues it,
  the daemon ends the client response with `function_call` items, the client runs
  the tools under its own sandbox, and the results return inside the **same**
  remote turn.
- **Turn-scoped random tokens** embedded in the prompt are the only MCP
  capability, and they are limited to tools the current turn advertised.
- **Causal barrier and two-phase completion fence**, using a monotonic
  `activityRevision`.
- **Authority only from the native envelope** or the rollout file, never from
  prompt text.
- **Drain** waits for both the HTTP request count and the browser-session count to
  reach zero.
- **Tokenizer-measured budgets** with preflight, and **multipart transfer** with
  per-part SHA-256 acknowledgements.
- **Real-client smoke tests:** scripts drive the actual Codex binary against a
  scripted adapter.
- **Per-file SHA-256 runtime manifests**, a fully isolated DEV profile, and honest
  `simulated: true` tool receipts.
- **Fail closed:** no model, transport, or version fallback, and an accepted
  message is never resent.

## Weaknesses observed

- The Electron CDP port and the Responses route are unauthenticated to any process
  run by the same user.
- It depends on Codex internals: fake `encrypted_content` prefixes, the rollout
  format, and the interrupt-hook hash scheme.
- Files are monolithic: the browser worker is 5.9k lines, the turn broker 1.6k,
  and the launcher app 2.8k.
- Hard-coded measured limits drift with the website, and account-bound flows are
  validated only by hand.

## Adopted

| Idea | Where in `system` |
|---|---|
| Responses gateway, 426, Origin rejection, bounded response cache | [gateways](../design/gateways.md#responses-gateway) |
| MCP inversion, turn tokens, causal barrier, completion fence | [gateways](../design/gateways.md#mcp-tool-inversion) |
| Authority from native envelope | [INV-6](../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes) |
| Journaled reversible client config edits | REQ-HOST-3 |
| Drain protocol | REQ-HOST-1, [gateways](../design/gateways.md#drain) |
| Measured budgets, multipart hash-ack transfer | [provider-turns](../design/provider-turns.md#large-inputs) |
| Real-client smoke tests; manual release checklist | [testing](../engineering/testing.md) |

## Not adopted

- Unauthenticated control and CDP surfaces. `system` authenticates them
  ([threat model](../security/threat-model.md)).
- Dependence on private Codex formats beyond the public Responses contract.
- Electron launcher, for now (non-goal in PROP-0001).
