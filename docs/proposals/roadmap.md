# Roadmap

Non-normative. This is the ordered queue of milestones for
[PROP-0001](0001-unified-system-architecture.md) and, from M6a,
[PROP-0003](0003-production-readiness.md). What each release stage must
deliver, and its exit criteria, are defined in
[release scope](../requirements/release-scope.md). This file only orders the work
and says what remains. What a package does now is in its own `README.md`; what was
verified on live accounts, and when, is in the
[release checklist](../validation/release-checklist.md)
([status ownership](../README.md#status-ownership)).

## Milestones

| Milestone | State | What remains | Evidence |
|---|---|---|---|
| **M0** Host on DSH core, kernel, engineering (MVP) | done | — | [spike](../research/m0-dsh-core-spike.md), [e2e test](../../packages/cli/tests/profile.e2e.ts) |
| **M1** Provider runtime and ChatGPT Web (MVP) | done, one check open | credential re-login past the email page (needs the operator) | [checklist](../validation/release-checklist.md), [login](../../packages/plugins/login/README.md) |
| **M1.5** First usable: `ask` and `research` (MVP slice 1) | done | — | [checklist](../validation/release-checklist.md) |
| **M2** Routing, DAG core, MCP, CLI (MVP release) | done | — | [traceability](../validation/traceability.md) |
| **M3** Workers (Beta) | mostly done | connectors as capabilities (`connector:<name>`); Gemini Deep research through `ask`, and a new persistent Gemini chat (both verified on the fake site only, by operator choice) | [agent Workers](../../packages/plugins/agent-workers/README.md), [Gemini Web](../../packages/plugins/provider-gemini-web/README.md) |
| **M4** Orchestration (Beta release) | mostly done | handoff envelopes | [workflow](../../packages/plugins/workflow/README.md), [checklist](../validation/release-checklist.md) |
| **M5** Gateways (v1.0) | done, one item open | journaled client configuration edits (REQ-HOST-3), once `system` edits a client file; today `system claude-env` and `codex-env` only print commands | [gateway turns](../../packages/gateway-turns/README.md), [checklist](../validation/release-checklist.md) |
| **M6** Second domain | done | — | [scientific research](../../packages/plugins/profile-scientific-research/README.md), [operations](../operations/README.md) |
| **M6a** Security hardening (v1.0) | started | scoped control credentials | [PROP-0003](0003-production-readiness.md#m6a-security-hardening) |
| **M6b** Operability (v1.0) | started | `/ui` health banner; scheduled account probes; health of each plugin and the DSH pin; a host whose required service refuses to start exits non-zero | [PROP-0003](0003-production-readiness.md#m6b-operability) |
| **M6c** Data lifecycle, upgrades, reliability (v1.0) | started | crash suite at every reconcile point | [PROP-0003](0003-production-readiness.md#m6c-data-lifecycle-upgrades-reliability) |
| **M6d** Supply chain and release (v1.0) | not started | lockstep versions, changelog, license, security policy; provenance-attested publication with SBOM and checksums; bundle publication | [PROP-0003](0003-production-readiness.md#m6d-supply-chain-and-release) |
| **M6e** API-first composition (v1.0) | done, live checks open | an API model Worker and a local model Worker, each verified live | [models](../design/models.md), [ADR-0025](../decisions/adr/0025-api-first-composition.md), [api-first e2e](../../packages/cli/tests/api-first.e2e.ts), [checklist](../validation/release-checklist.md) |
| **v1.0** Production-ready release | not started | M6a to M6e, M7 unless PROP-0003 is accepted, and the open live items of the release checklist | [release scope](../requirements/release-scope.md#production-ready-exit-criteria), [checklist](../validation/release-checklist.md) |
| **M7** macOS | not started | `offscreen` display, visible login, read confinement through the platform sandbox; release scope lists it for v1.0, and PROP-0003 proposes moving it to 1.x | [PROP-0003](0003-production-readiness.md#release-gate-and-later-work) |

The operator web page stays the small `/ui` page in
[`web-ui`](../../packages/plugins/web-ui/README.md); `system` does not build a UI
inside the DSH web app.

## Refactors found by review

These change no behavior. Each lands with its tests unchanged:

- one durable-run lifecycle for website turns (`turns`), agent runs
  (`agent-workers`), and model calls (`models`): waiters, cancel, retries, and
  stop. The lease loop is already shared (`ctx.leases.hold`). Run bodies and
  recovery stay separate on purpose: a website turn is reconciled from its
  receipt, an agent run fails closed, a model call is sent once more.

## Later candidates

Each needs its own proposal: an A2A gateway and runtime (cross-runtime peers), an
ACP client gateway for editors, sandboxed or SSH `exec` providers, more website
providers, and a desktop launcher.
