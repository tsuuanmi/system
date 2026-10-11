---
id: PROP-0001
type: proposal
status: proposed
owners: [tsuuanmi]
created: 2026-10-11
related-requirements: [REQ-ACC, REQ-PRV, REQ-WRK, REQ-TEAM, REQ-WF, REQ-GW, REQ-HOST]
related-decisions: [ADR-0001, ADR-0002, ADR-0003, ADR-0004, ADR-0005, ADR-0006, ADR-0007, ADR-0008, ADR-0009, ADR-0010, ADR-0011, ADR-0012, ADR-0013, ADR-0014, ADR-0015]
implementation: []
---

# Proposal: Unified system architecture

## Problem

The purpose of `system` is stated canonically in
[requirements/purpose.md](../requirements/purpose.md): saving tokens by using
separate website quota (P1), reusing website-native capabilities such as Deep
Research and connectors (P2), putting the right Worker on each job while local
data stays local (P3), and letting cheap models do the low-level work (P4).
Release stages, from MVP to production-ready, are defined in
[release scope](../requirements/release-scope.md). This proposal is about how to build it.

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

Today each improvement has to be made three times, none of the systems has all
three strengths, and each one is locked into a specific host, client, or provider.

The maintainer's guiding decisions for the unified system are:

1. **Tool-agnostic:** no lock-in to any single tool
   ([ADR-0008](../decisions/adr/0008-tool-agnostic.md)).
2. **Everything is a plugin,** following the DeepSeek Harness philosophy
   ([ADR-0007](../decisions/adr/0007-everything-is-a-plugin.md)).
3. **Claude Code and Codex can both use it,** and it can use them
   ([ADR-0009](../decisions/adr/0009-claude-and-codex-first-class.md)).
4. **Reuse or adapt existing tools** wherever they already do the job well
   ([ADR-0010](../decisions/adr/0010-reuse-before-build.md)).

## Goals

1. One standalone host that implements the layered architecture in
   [architecture](../architecture/README.md) and the invariants in
   [invariants](../architecture/invariants.md).
2. Browser-backed providers behind a driver interface with receipt-based
   idempotency (REQ-PRV).
3. Deterministic, fail-closed Worker routing and acceptance (REQ-WRK).
4. One durable workflow engine that runs a software-development profile and a
   scientific-research profile without engine changes (REQ-WF-9).
5. Responses, Anthropic Messages, and MCP gateways, so Codex, Claude Code, and
   MCP agents can use `system` Workers (REQ-GW).
6. Claude Code, Codex, and ACP agents usable as Workers (REQ-WRK-5..6).
7. Every feature is a plugin composed from configuration, with no tool lock-in
   (REQ-HOST-4..5, INV-10, INV-11).
8. Quota-aware, locality-aware, tier-aware routing that realizes purposes
   P1–P4 (REQ-WRK-7..9, REQ-PRV-7, INV-12).

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
- [DeepSeek Harness analysis](../research/dsh-analysis.md) (plugin philosophy)

## Proposed design

- Structure: [architecture README](../architecture/README.md),
  [components](../architecture/components.md), [data flow](../architecture/data-flow.md).
- Plugins and seams: [plugin model](../architecture/plugin-model.md).
- Mechanisms: [provider turns](../design/provider-turns.md),
  [scheduling and leases](../design/scheduling-and-leases.md),
  [workflow engine](../design/workflow-engine.md), [teams](../design/teams.md),
  [agent runtimes](../design/agent-runtimes.md), [gateways](../design/gateways.md).
- Durable choices: ADR-0001 through ADR-0015.
- Exact contracts: [`schemas/`](../../schemas/README.md) and [reference](../reference/README.md).

Planned package layout (Bun workspaces). Each seam has a definition package, and
each provider is its own plugin package. Dependencies follow the layer map:

```text
packages/
  host/                      Cordis root + loader, profiles, drain
  libs/                      hashing, clock/timeout, schemas, reconcile decisions (libraries)
  seams/                     seam definitions only (abstract Service classes + vocabulary types)
    store/ blobs/ events/ leases/ browser/ display/ accounts/ providers/
    website/ exec/ agent-runtimes/ workers/ workflow/ teams/ profiles/ client-protocols/
  plugins/                   providers and consumers
    store-sqlite/ blobs-fs/ events-store/ leases-store/
    browser-patchright/ display-xvfb/ display-headless/ accounts-vault/ remote-login/
    provider-chatgpt-web/ provider-gemini-web/
    website-core/ exec-local/
    runtime-claude-agent-sdk/ runtime-codex-sdk/ runtime-acp/
    workers-core/ workflow-engine/ team-runner/
    profile-software-development/ profile-scientific-research/
    gateway-responses/ gateway-anthropic-messages/ mcp-server/ cli/ web-ui/
  bundles/                   base, browser-providers, agent-runtimes, gateways, dev-fakes, dsh
```

## Alternatives considered

- **Extend internet into the unified system.** Rejected. It is tied to DSH, its
  two runtimes would have to be merged anyway, and its provider abstraction would
  need rewriting.
- **Implement AgentOS on DSH as designed.** Rejected
  ([ADR-0001](../decisions/adr/0001-standalone-host.md)). Its central team
  mechanism depends on an experimental API that only in-process providers satisfy.
- **A custom composition root or a generic DI container instead of Cordis.**
  Rejected ([ADR-0007](../decisions/adr/0007-everything-is-a-plugin.md)). It
  would rebuild lifecycle, scoping, and configuration-driven composition that
  Cordis already provides.
- **Fork codex-chatgpt-web.** Rejected. It is a single-purpose bridge with no
  workflow or team layer, and much of its complexity is tied to Codex internals.

## Validation plan

- Unit and contract tests per package, with fakes at every seam (QA-10).
- Provider drivers tested against recorded DOM fixtures.
- Crash and restart scenarios for every reconcile-before-repeat effect:
  `SUBMITTED` receipts, `RUNNING` nodes, stale lease commits.
- Smoke tests against the real Codex and Claude Code binaries and a real MCP
  client, driven by a scripted provider adapter. Agent-runtime smoke tests for
  the Claude Agent SDK and Codex SDK Workers.
- Composition tests: every shipped profile loads and disposes cleanly, and every
  seam's conformance suite passes for each of its providers and fakes.
- A manual, account-bound release checklist for sign-in, a live provider turn, a
  tool round trip, and a full workflow cycle. A skipped item blocks the release.
- The architecture test: the scientific-research profile runs with zero engine
  changes.

## Rollout and rollback

Delivered in three stages defined in [release scope](../requirements/release-scope.md):

- **MVP:** MCP tools usable from Claude Code and Codex.
- **Beta:** workflows, teams, and agent-runtime Workers.
- **Production-ready:** gateways, a second domain, and operational readiness.

The milestones are ordered in the [roadmap](roadmap.md). Each stage is a profile,
so moving forward adds plugins and never rewrites earlier ones. The reference
repos stay usable throughout. Client configuration edits are journaled and
reversible (REQ-HOST-3).

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
