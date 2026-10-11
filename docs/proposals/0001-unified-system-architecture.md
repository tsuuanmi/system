---
id: PROP-0001
type: proposal
status: proposed
owners: [tsuuanmi]
created: 2026-10-11
related-requirements: [REQ-ACC, REQ-PRV, REQ-WRK, REQ-TEAM, REQ-WF, REQ-GW, REQ-HOST]
related-decisions: [ADR-0001, ADR-0002, ADR-0003, ADR-0004, ADR-0005, ADR-0006]
implementation: []
---

# Proposal: Unified system architecture

## Problem

Three related projects each solve part of one problem: getting reliable,
reconcilable work out of AI Workers, many of which are browser-backed, across
single turns, teams, and long-running workflows.

- **AgentOS** has the clearest *semantic* model: opaque Workers, fail-closed
  admission, completion boundaries, and Team Model A. It has no code, and it is
  bound to an experimental host API.
- **internet** has the most mature *reliability* machinery: provider turn
  receipts, schedulers with fenced leases, and durable input-hash workflow nodes.
  It hard-codes its providers and accounts, uses single-process JSON stores, and
  carries two workflow runtimes.
- **codex-chatgpt-web** has the best *client integration*: a Responses API
  gateway, MCP tool inversion, turn tokens, and drain. It is specific to Codex and
  ChatGPT, and it leaves control surfaces unauthenticated.

Today each improvement has to be made three times, and none of the systems has all
three strengths.

## Goals

1. One standalone host that implements the layered architecture in
   [architecture](../architecture/README.md) and the invariants in
   [invariants](../architecture/invariants.md).
2. Browser-backed providers behind a driver interface with receipt-based
   idempotency (REQ-PRV).
3. Deterministic, fail-closed Worker routing and acceptance (REQ-WRK).
4. One durable workflow engine that runs a software-development profile and a
   scientific-research profile without engine changes (REQ-WF-9).
5. Responses and MCP gateways so Codex and MCP agents can use `system` Workers
   (REQ-GW).

## Non-goals

- Multi-user or networked deployment (CON-6).
- Replacing the reference repos in place. They stay as they are, and `system` is a
  new codebase.
- A2A, or a universal internal protocol model
  ([ADR-0006](../decisions/adr/0006-protocol-introduction-gates.md)).
- A desktop launcher or installer. The CLI and the loopback Web UI come first.
- An AI router. Routing is deterministic policy.

## Evidence and research

- [AgentOS analysis](../research/agentos-analysis.md)
- [internet analysis](../research/internet-analysis.md)
- [codex-chatgpt-web analysis](../research/codex-chatgpt-web-analysis.md)

## Proposed design

- Structure: [architecture README](../architecture/README.md),
  [components](../architecture/components.md), [data flow](../architecture/data-flow.md).
- Mechanisms: [provider turns](../design/provider-turns.md),
  [scheduling and leases](../design/scheduling-and-leases.md),
  [workflow engine](../design/workflow-engine.md), [teams](../design/teams.md),
  [gateways](../design/gateways.md).
- Durable choices: ADR-0001 through ADR-0006.

Planned package layout (Bun workspaces). Dependencies follow the layer map:

```text
packages/
  kernel/            store, blobs, events, leases, hashing, clock
  provider-runtime/  BrowserPort, scheduler, receipts, vault, remote login
  providers/
    chatgpt-web/     ProviderDriver
    gemini-web/      ProviderDriver
  capabilities/      website core, local exec, api provider
  routing/           registry, admission, router, acceptance
  orchestration/     workflow engine, team runner, profiles
  host/              composition root, config, drain
  gateways/
    responses/       Responses API + turn broker
    mcp/             MCP server
    cli/             operator CLI
    web-ui/          loopback operator UI (remote login, status)
```

## Alternatives considered

- **Extend internet into the unified system.** Rejected. It is tied to DSH, its
  two runtimes would have to be merged anyway, and its provider abstraction would
  need rewriting.
- **Implement AgentOS on DSH as designed.** Rejected
  ([ADR-0001](../decisions/adr/0001-standalone-host.md)). Its central team
  mechanism depends on an experimental API that only in-process providers satisfy.
- **Fork codex-chatgpt-web.** Rejected. It is a single-purpose bridge with no
  workflow or team layer, and much of its complexity is tied to Codex internals.

## Validation plan

- Unit and contract tests per package, with fakes at every seam (QA-10).
- Provider drivers tested against recorded DOM fixtures.
- Crash and restart scenarios for every reconcile-before-repeat effect:
  `SUBMITTED` receipts, `RUNNING` nodes, stale lease commits.
- Smoke tests against the real Codex binary and a real MCP client, driven by a
  scripted provider adapter.
- A manual, account-bound release checklist for sign-in, a live provider turn, a
  tool round trip, and a full workflow cycle. A skipped item blocks the release.
- The architecture test: the scientific-research profile runs with zero engine
  changes.

## Rollout and rollback

Delivered in milestones ([roadmap](roadmap.md)). Each milestone is usable on its
own, and the reference repos stay usable throughout. The gateways ship last, and
client configuration edits are journaled and reversible (REQ-HOST-3).

## Observability and operations

The event log (QA-7) records turns, node executions, leases, and reconciliation
decisions. The CLI provides `status`, `watch`, and `events`. Runbooks and
playbooks will be added under `docs/operations/` once there is a running system
to support.

## Security and privacy

See the [threat model](../security/threat-model.md). Key changes from the
reference repos: authenticated Responses and control routes, no
browser-debugging port exposed outside the provider runtime, and credentials
confined to the account vault (INV-8).

## Compatibility and migration

None required. `system` is a new codebase, and existing internet or
codex-chatgpt-web state is not migrated. Accounts are signed in again.

## Decision

Pending review.

## Implementation

Not started.
