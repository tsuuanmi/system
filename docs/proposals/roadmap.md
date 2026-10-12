# Roadmap

Non-normative. This is the ordered queue of milestones for
[PROP-0001](0001-unified-system-architecture.md). What each release stage must
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
| **M3** Workers (Beta) | mostly done | an economy-tier API or local-model provider (`ctx.models`); connectors as capabilities (`connector:<name>`); Gemini Deep research through `ask`, and a new persistent Gemini chat (both verified on the fake site only, by operator choice) | [agent Workers](../../packages/plugins/agent-workers/README.md), [Gemini Web](../../packages/plugins/provider-gemini-web/README.md) |
| **M4** Orchestration (Beta release) | mostly done | handoff envelopes; re-planning after a superseded input | [workflow](../../packages/plugins/workflow/README.md), [checklist](../validation/release-checklist.md) |
| **M5** Gateways (v1.0) | done, one item open | journaled client configuration edits (REQ-HOST-3), once `system` edits a client file; today `system claude-env` and `codex-env` only print commands | [gateway turns](../../packages/gateway-turns/README.md), [checklist](../validation/release-checklist.md) |
| **M6** Second domain and readiness (production-ready release) | started | hardening, packaging and bundle publication, macOS; the refactors below | [scientific research](../../packages/plugins/profile-scientific-research/README.md), [operations](../operations/README.md) |

The operator web page stays the small `/ui` page in
[`web-ui`](../../packages/plugins/web-ui/README.md); `system` does not build a UI
inside the DSH web app.

## Refactors found by review

These change no behavior. Each lands with its tests unchanged:

- split `packages/plugins/workflow/src/index.ts` into modules by mechanism;
- a shared driver kit for `provider-chatgpt-web` and `provider-gemini-web`;
- one durable-run mechanism for website turns (`turns`) and agent runs
  (`agent-workers`);
- replace `dshHome()` in `libs` with `resolveDshHome()` from
  `@deepseek-ai/dsh-home-paths`;
- remove dead exports.

## Later candidates

Each needs its own proposal: an A2A gateway and runtime (cross-runtime peers), an
ACP client gateway for editors, sandboxed or SSH `exec` providers, more website
providers, and a desktop launcher.
