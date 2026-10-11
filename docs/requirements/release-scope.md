# Release scope: MVP → Beta → Production-ready

This document is the canonical definition of **what each release stage must
deliver** and how its exit is judged. The order of the work lives in the
[roadmap](../proposals/roadmap.md). The full target architecture, which is what
production-ready means, lives in [architecture](../architecture/README.md).

Because everything is a plugin, each stage is a **profile**: a set of plugins
from the [seam catalog](../architecture/plugin-model.md#seam-catalog). Moving to
the next stage adds plugins. It does not rewrite the earlier ones.

## Overview

| Stage | One-line goal | How clients use it |
|---|---|---|
| **MVP** (v0.1) | prove the four [purposes](purpose.md) end to end with the thinnest durable slice | Claude Code and Codex call `system` **tools over MCP**; operator CLI |
| **Beta** (v0.5) | durable multi-Worker workflows and teams; Claude Code and Codex also as Workers | MCP + CLI + Web UI |
| **Production-ready** (v1.0) | the full target architecture, operated, hardened, and validated | Responses and Anthropic Messages gateways + MCP + CLI + Web UI + DSH bundle |

## MVP (v0.1)

### Goal

A single operator, working inside **Claude Code or Codex**, can delegate research
and reasoning to ChatGPT Web. The delegated work runs on the website's separate
quota (P1), uses Deep Research and web search (P2), never ships local data
without permission (P3), and runs cheap steps on a cheap tier (P4). All of this
is crash-safe.

### Why MCP first

MCP is the one integration that **both** Claude Code and Codex already support.
It satisfies ADR-0009 (both clients) and ADR-0008 (tool-agnostic) at the lowest
cost. The local agent stays the local Worker for code and data, which gives P3
for free. The Responses and Messages gateways, which make `system` look like a
*model*, are the more complex integration and are deferred to production-ready.

### Included plugins

```text
host, libs
kernel:        store-sqlite, blobs-fs, events-store, leases-store
provider:      browser-patchright, display-headless, display-xvfb, remote-login,
               accounts-vault, provider-chatgpt-web (+ scheduler, receipts)
capabilities:  website-core
routing:       workers-core (capabilities, tiers, egress policy, quota exclusion)
edge:          mcp-server, cli
```

### Included requirements

| Area | Requirements |
|---|---|
| Accounts | REQ-ACC-1..5 (ChatGPT Web accounts only) |
| Provider turns | REQ-PRV-1..6 (`reason`, `web-search`, `deep-research`) |
| Routing | REQ-WRK-1..4, REQ-WRK-7 (egress), REQ-WRK-8 (quota exclusion), REQ-WRK-9 (tiers: website modes as `economy`, `standard`, and `frontier`) |
| Gateways | REQ-GW-3 (MCP tools: `ask`, `research`, `status`), REQ-GW-4 (CLI: login, status, ask, research) |
| Host | REQ-HOST-1, REQ-HOST-2, REQ-HOST-4, REQ-HOST-5 |

The MVP workflow is a **fixed pipeline**, not the general engine:

```text
research (frontier or deep-research) → compact handoff (economy) → return
```

Each step is a durable record with a receipt, so retries and restarts never
resend or recompute a completed step.

### Explicitly out of MVP

Gemini, teams, the general workflow engine and profiles, agent-runtime Workers,
connectors (`connector:*`), API and local model providers, the Responses and
Messages gateways, the Web UI, the DSH bundle, and packaged installers.

### MVP exit criteria

1. From **both** Claude Code and Codex, the MCP `research` tool returns a cited,
   compacted synthesis produced by ChatGPT Web Deep Research.
2. Killing the host at every reconcile point (before submit, after submit, during
   generation, after completion) never produces a duplicate provider turn. Every
   case resolves to WAIT, RECOVER, RESUBMIT, or AMBIGUOUS.
3. An egress test shows that a request referencing `local-private` artifacts is
   refused for the website Worker unless policy permits it.
4. The compaction step runs on the `economy` tier, and the research step on
   `frontier`. Both are visible in the event log.
5. A usage report shows, per request, which quota class and tier served it.
6. The `dev` profile, with fake providers, passes every seam conformance suite in
   CI. The account-bound checklist passes manually.

## Beta (v0.5)

Adds, as plugins:

- **Orchestration:** `workflow-engine`, `team-runner`, `profile-software-development`
  (REQ-WF-1..8, REQ-TEAM-1..4).
- **Workers:** `runtime-claude-agent-sdk`, `runtime-codex-sdk`, `runtime-acp`
  (REQ-WRK-5..6). Claude Code and Codex become Workers as well as clients.
- **Providers:** `provider-gemini-web`, connectors as capabilities (REQ-PRV-7), and
  an economy-tier model provider for API or local models (P4).
- **Edge:** `web-ui` (status, watch, remote login).

Beta exit criteria:

1. The full software-development cycle (research team → local implementation →
   validation → exact-head review → bounded remediation) runs across mixed
   Workers. Killing the host mid-workflow never repeats a completed node.
2. A two-member team uses two distinct accounts, and the independent-first
   barrier is proven by test.
3. Agent-runtime Workers pass probe, run, resume, cancel, and sandbox-enforcement
   smoke tests.

## Production-ready (v1.0)

Production-ready means **the complete target architecture**
([layer map](../architecture/README.md#layer-map)) with every requirement in the
[SRS](SRS.md) and every [quality attribute](quality-attributes.md) met, plus
operational readiness.

### Functional additions

- `gateway-responses` and `gateway-anthropic-messages` with the shared turn
  broker (REQ-GW-1, REQ-GW-2, REQ-GW-5). Codex and Claude Code can select
  `system` Workers *as models*. Client configuration edits are journaled
  (REQ-HOST-3).
- `profile-scientific-research` with typed artifacts and invalidation, running
  with zero engine changes. This is the architecture test (REQ-WF-9).
- A DSH bundle, so `system` plugins mount in a DeepSeek Harness profile.

### Operational readiness

| Concern | Requirement for v1.0 |
|---|---|
| Observability | event log queryable by turn, node, and lease; usage and tier reports; health of each account and plugin; alerts for provider UI drift (fixture or live probe failure) |
| Operations docs | `docs/operations/` with runbooks (login, account re-auth, backup and restore, upgrade with drain, retention cleanup) and playbooks (stuck turn, AMBIGUOUS reconciliation, quota exhaustion, provider UI change) |
| Data safety | store backup and restore tested; versioned, tested migrations; upgrade path from every v0.x release |
| Security | every control in the [threat model](../security/threat-model.md) implemented and tested; secrets audit; `bun audit` clean; egress policy covered by tests |
| Validation | `docs/validation/` with acceptance criteria per requirement, traceability from requirement to test, and the recorded manual release checklist |
| Reference | `docs/reference/` with the MCP tool contracts, gateway compatibility notes, configuration catalog generated from plugin `Config` schemas, and the seam definitions |
| Reliability | crash-injection suite across every reconcile point passes repeatedly with zero duplicate effects; every bound in INV-9 configured and tested |
| Platforms | Linux and macOS supported; remote login on Linux; packaged distribution with checksum-verified artifacts |

### Production-ready exit criteria

1. Every REQ, QA, and INV has linked test or validation evidence.
2. Both gateways pass smoke tests against real Codex and Claude Code binaries:
   streaming, tool round trip, cancel, interrupt, and drain.
3. The scientific-research profile ships without any change to engine packages.
4. The manual release checklist passes on live accounts, and a skipped item
   blocks the release.
