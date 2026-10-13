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
| **M4** Orchestration (Beta release) | mostly done | handoff envelopes; re-planning after a superseded input | [workflow](../../packages/plugins/workflow/README.md), [checklist](../validation/release-checklist.md) |
| **M5** Gateways (v1.0) | done, one item open | journaled client configuration edits (REQ-HOST-3), once `system` edits a client file; today `system claude-env` and `codex-env` only print commands | [gateway turns](../../packages/gateway-turns/README.md), [checklist](../validation/release-checklist.md) |
| **M6** Second domain | done | — | [scientific research](../../packages/plugins/profile-scientific-research/README.md), [operations](../operations/README.md) |
| **M6a** Security hardening (v1.0) | not started | scoped control credentials; agent Workers confined for reads; vault key custody; CI audit, secret scan, code scanning, dependency updates; Node floor | [PROP-0003](0003-production-readiness.md#m6a-security-hardening) |
| **M6b** Operability (v1.0) | not started | health report and `system health`; drift alerts; event queries; service unit and runbooks | [PROP-0003](0003-production-readiness.md#m6b-operability) |
| **M6c** Data lifecycle, upgrades, reliability (v1.0) | not started | bounded retention of runs, artifacts, and events; downgrade guard; upgrade suite; crash suite at every reconcile point | [PROP-0003](0003-production-readiness.md#m6c-data-lifecycle-upgrades-reliability) |
| **M6d** Supply chain and release (v1.0) | not started | lockstep versions, changelog, license, security policy; provenance-attested publication with SBOM and checksums; bundle publication | [PROP-0003](0003-production-readiness.md#m6d-supply-chain-and-release) |
| **M6e** API-first composition (v1.0) | not started | the economy-tier API or local-model provider (`ctx.models`); the `api-first` preset | [PROP-0003](0003-production-readiness.md#m6e-api-first-composition) |
| **v1.0** Production-ready release | not started | M6a to M6e, M7 unless PROP-0003 is accepted, and the open live items of the release checklist | [release scope](../requirements/release-scope.md#production-ready-exit-criteria), [checklist](../validation/release-checklist.md) |
| **M7** macOS | not started | `offscreen` display, visible login, read confinement through the platform sandbox; release scope lists it for v1.0, and PROP-0003 proposes moving it to 1.x | [PROP-0003](0003-production-readiness.md#release-gate-and-later-work) |

The operator web page stays the small `/ui` page in
[`web-ui`](../../packages/plugins/web-ui/README.md); `system` does not build a UI
inside the DSH web app.

## Refactors found by review

These change no behavior. Each lands with its tests unchanged:

- one durable-run lifecycle for website turns (`turns`) and agent runs
  (`agent-workers`): waiters, cancel, retries, and stop. The lease loop is
  already shared (`ctx.leases.hold`). Run bodies and recovery stay separate on
  purpose: a website turn is reconciled from its receipt, an agent run fails
  closed.

## Later candidates

Each needs its own proposal: an A2A gateway and runtime (cross-runtime peers), an
ACP client gateway for editors, sandboxed or SSH `exec` providers, more website
providers, and a desktop launcher.
