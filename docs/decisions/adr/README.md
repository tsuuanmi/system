# Architecture Decision Records

ADR numbers are never reused, and gaps in the numbering are expected. Use
[0000-template.md](0000-template.md) for new records.

Status values: `Proposed`, `Accepted`, `Rejected`, `Superseded by ADR-NNNN`,
`Superseded in part by ADR-NNNN`.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-standalone-host.md) | `system` is a standalone host; other harnesses are clients or adapters | Superseded in part by 0018 |
| [0002](0002-typescript-on-bun.md) | TypeScript on Bun, Node-compatible core | Superseded in part by 0018 (Node runtime) |
| [0003](0003-sqlite-durable-store.md) | SQLite (WAL) + content-addressed blobs as the durable store | Accepted |
| [0004](0004-single-workflow-runtime.md) | One workflow runtime combining DAG, input-hash durability, and lineage | Accepted |
| [0005](0005-provider-runtime-interface.md) | Provider drivers behind one `ProviderDriver` interface | Accepted |
| [0006](0006-protocol-introduction-gates.md) | Responses + Anthropic Messages + MCP now, ACP as Worker runtime, A2A deferred; no mirrored protocol objects | Accepted |
| [0007](0007-everything-is-a-plugin.md) | Everything is a plugin, on Cordis; seams + profiles/patches | Accepted |
| [0008](0008-tool-agnostic.md) | Tool-agnostic boundaries: no model, vendor, agent, client, or infra lock-in | Accepted |
| [0009](0009-claude-and-codex-first-class.md) | Claude Code and Codex first-class, as clients and as Workers | Accepted; amended 2026-10-16 (further agents: MCP client config, then ACP, then a native SDK on evidence) |
| [0010](0010-reuse-before-build.md) | Reuse or adapt existing tools before building; dependency register | Accepted; amended 2026-10-16 (the six-step reuse check) |
| [0011](0011-mvp-integration-via-mcp.md) | MVP integrates with Claude Code and Codex through MCP first; model gateways in v1.0 | Accepted; amended 2026-10-16 (MCP for any local agent; no second client protocol) |
| [0012](0012-dag-execution-model.md) | All multi-step work runs as an append-only DAG; agent loops live inside Workers | Accepted |
| [0013](0013-typed-artifacts-and-decision-records.md) | Typed, content-addressed artifacts; every decision recorded as an artifact | Accepted |
| [0014](0014-json-schema-contracts.md) | JSON Schema 2020-12 is the canonical contract for records and wire payloads | Accepted |
| [0015](0015-worker-sessions-and-peer-messaging.md) | Durable Worker sessions with own SessionId and direct peer messaging; A2A for cross-runtime peers, ACP for driving agents | Accepted |
| [0016](0016-invisible-headed-browser-and-portable-accounts.md) | Invisible headed system Chrome (never headless for provider turns); provider-agnostic multi-account vault | Accepted; amended by 0020; superseded in part by 0030 |
| [0017](0017-credential-login-and-linux-remote-browser.md) | Opt-in credential login (email, password, local TOTP) with remote-view fallback; Linux-first MVP; port internet's noVNC remote login | Accepted; drift disposition amended by 0021 |
| [0018](0018-build-on-dsh-core.md) | `system` is our own harness built on DSH core, reusing DSH plugins behind our seams; Node runtime; telemetry off | Accepted; superseded in part by 0019; amended 2026-10-14 (Node range) |
| [0019](0019-explicit-minimal-dsh-core.md) | Mount only the allow-listed DSH core rows; no `dsh-base` | Accepted |
| [0020](0020-pinned-managed-chrome.md) | A pinned Chrome for Testing, installed by `system init`, when the host has no recent Chrome | Accepted |
| [0021](0021-ui-operations-as-data.md) | Website UI operations are data (UI maps) resolved by a deterministic engine with bounded, verified self-healing | Accepted; amended 2026-10-19 (the overlay adds elements and error rules) |
| [0022](0022-text-protocol-tool-calls-for-website-models.md) | Website models reach a client's tools through a text protocol in the turn (MCP tool inversion stays the target) | Accepted |
| [0023](0023-scoped-control-credentials.md) | Scoped static control credentials (`operator`, `client`, `model`) on loopback; OAuth deferred until CON-6 changes | Accepted |
| [0024](0024-agent-workers-confined-for-reads.md) | Agent Workers are confined for reads; the DSH home is never readable (bubblewrap where a runtime's own sandbox does not confine reads) | Accepted |
| [0025](0025-api-first-composition.md) | An `api-first` preset in one bundle; website Workers and model gateways are opt-in there | Accepted |
| [0026](0026-versioned-releases-with-provenance.md) | Lockstep versioned releases with provenance and SBOM; SemVer covers `system`'s own contracts; supported Node range | Accepted |
| [0027](0027-provider-diversity-in-routing.md) | Routing may require a provider family different from a named node's; it compares opaque families for inequality and never names one | Accepted; superseded in part by 0029 |
| [0028](0028-local-lead-final-authority.md) | The calling agent is the Lead and decides; a team's outcome is advice bounded to the run, and authorizes no effect outside it | Accepted |
| [0029](0029-opt-in-same-family-fallback.md) | An operator may let work run on one provider family when no other is admitted (`allowSameFamily`), recorded as a same-family decision, never silent; members share a Worker in their own sessions | Accepted; amended 2026-10-16 (scope: any Worker source with sessions); superseded in part by 0035 |
| [0030](0030-session-bound-accounts-use-their-login-profile.md) | A session-bound website account (a driver capability) runs every operation as a tab of one persistent context on its own login profile, never from copied state | Accepted; amended 2026-10-17 (a session keeps its tab between its turns) |
| [0031](0031-model-worker-sessions-by-replay.md) | A model Worker keeps a session by replaying its transcript: a provider-neutral `history` on `ctx.models`, bounded, durable, and egress-checked | Accepted |
| [0032](0032-admission-refuses-input-longer-than-a-worker-takes.md) | A Worker declares the longest input it takes (`maxInputChars`); admission refuses longer input, measured as it will be sent | Accepted |
| [0033](0033-least-busy-routing.md) | Among equally ranked Workers routing prefers the least busy (running, queued, and pending admissions), under one routing lock, with load recorded in the decision | Accepted; amended 2026-10-19 (pending counted by the source per account; describe timeout) |
| [0034](0034-unsent-failover-to-a-sibling-account.md) | An unsent attempt that failed on an account's limit, challenge, sign-out, or site error moves to a sibling account; usage limits set cooldowns admission respects, never the account's status | Accepted |
| [0035](0035-one-family-teams-keep-distinct-accounts.md) | With one provider family, team members keep distinct accounts before sharing one (a middle step in ADR-0029's fallback) | Accepted |
| [0036](0036-guarantee-core-and-capability-plugins.md) | Seams are classed: guarantee seams form six core components with contracts changed only by ADR and failing closed; capability seams form eight replaceable plugin families that fail open | Accepted |
| [0037](0037-schema-and-protocol-first.md) | Every new seam ships with schemas for its records and payloads (MCP tools included), an abstract definition, a written protocol, and a conformance suite, from its first provider | Accepted |
| [0039](0039-base-guarantee-seam-contract-changes.md) | Base B3 to B5 extend four guarantee seams: `WorkerStart.runId`; workflow 1.2 serves board tasks through the board only; board and approvals (unreleased) amended to fail closed, with required checks bound at acceptance | Proposed |
