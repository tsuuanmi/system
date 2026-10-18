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
| **M6a** Security hardening (v1.0) | done, live checks open | a signed-in Codex Worker run with reads confined and the model token ([checklist](../validation/release-checklist.md)) | [PROP-0003](0003-production-readiness.md#m6a-security-hardening), [ADR-0023](../decisions/adr/0023-scoped-control-credentials.md) |
| **M6b** Operability (v1.0) | started | `/ui` health banner; scheduled account probes; health of each plugin and the DSH pin; a host whose required service refuses to start exits non-zero | [PROP-0003](0003-production-readiness.md#m6b-operability) |
| **M6c** Data lifecycle, upgrades, reliability (v1.0) | started | crash suite at every reconcile point | [PROP-0003](0003-production-readiness.md#m6c-data-lifecycle-upgrades-reliability) |
| **M6d** Supply chain and release (v1.0) | done | the first tagged release; npm publication and a license are deferred by the owner ([ADR-0026](../decisions/adr/0026-versioned-releases-with-provenance.md)) | [releasing](../engineering/releasing.md) |
| **M6e** API-first composition (v1.0) | done, live checks open | an API model Worker and a local model Worker, each verified live | [models](../design/models.md), [ADR-0025](../decisions/adr/0025-api-first-composition.md), [api-first e2e](../../packages/cli/tests/api-first.e2e.ts), [checklist](../validation/release-checklist.md) |
| **PROP-0004** Phase 1: removals and switch-offs | in progress | Phase 1's checks: the composition's row set, old runs of removed templates still explained after an upgrade, the crash suite | [templates](../reference/workflow-templates.md), [turn a row on](../operations/runbooks.md#turn-an-off-row-back-on) |
| **v1.0** Production-ready release | not started | M6a to M6e and the open live items of the release checklist | [release scope](../requirements/release-scope.md#production-ready-exit-criteria), [checklist](../validation/release-checklist.md) |
| **M7** macOS | out of scope (PROP-0004: Linux only) | — (was: `offscreen` display, visible login, read confinement through the platform sandbox) | [PROP-0003](0003-production-readiness.md#release-gate-and-later-work) |

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

## Follow-ups from the reliability review

The review of 2026-10-16 fixed the confirmed liveness defects it found in the
workflow engine, with regression tests (see the changesets). It left these, by
priority:

| Priority | Item | Why it waits |
|---|---|---|
| P1 | **Agent Worker workspace isolation and remediation approval.** Superseding a remediation fix leaves later cycles live; they then fail the run with a duplicate node id, because each cycle records the original review as its grower. Remediation also appends a writing step without an approval ([ADR-0028](../decisions/adr/0028-local-lead-final-authority.md), INV-15). The agent runtime's always-hidden paths name one agent's directory, not every agent's credential directory. | Reachable only with agent Worker rows on, which are off in the website-only MVP. Fix all three before agent Workers serve real work. |
| P2 | **Two tabs of one Gemini profile.** Concurrent turns per account are back at 2 (2026-10-18), checked live on ChatGPT: two turns in two tabs of its profile, in different modes, did not change each other's. Check the same on Gemini with its next two-member run. | It comes with the next Gemini team run. |
| P1 | **Per-Worker input limits.** A website's composer can drop an over-long prompt. The Gemini driver now refuses a prompt over its `maxPromptChars` (30,000 characters, observed) before sending. A review shows its members at most `repositories.maxSourceChars` of source (24,000 by default), so its prompt fits. Next, a Worker descriptor declares its largest input, and admission refuses a Worker below the prompt's size (a capability check, never a vendor name). | The limit is observed, not published. |
| P2 | **One bounded resend after a site's own error.** A site that answers with its own error (`answer.site-error`) fails the turn as `overloaded`, unsent again. One resend in the same conversation, when the page positively shows our prompt followed by a recognized site error, would be a new row of the reconciliation table ([provider turns](../design/provider-turns.md#reconciliation)), counted against `maxResubmits`. | A reconciliation rule change: decided on its own. |
| P2 | **Provider diversity.** A family's value comes from the live descriptor, and one vendor reached through several Worker sources counts as several families ([ADR-0027](../decisions/adr/0027-provider-diversity-in-routing.md#consequences)). Record the family at routing, and allow an operator override per account. | The MVP has website Workers only. |
| P2 | **Evidence-backed review approval.** Today a review returns accepted results, a majority, and verified quotes. Approval stays with the Lead ([ADR-0028](../decisions/adr/0028-local-lead-final-authority.md)). A gate that requires verified findings before a run reports `pass` is a separate design. | Scope. |
| P3 | **Teams of 5 to 10 members, and ranked choice.** Contracts exist for 2 to 5 members. Larger teams need more provider families than the MVP has. | No requirement yet. |
| P3 | **Engine details.** Only the first tie gets a deadline timer. Two concurrent `stop`s each record a decision. The session record labels a model Worker's runtime `local-tool`. The runtime vocabulary in `worker-sessions` names agent runtimes, so the INV-11 architecture rule does not cover it yet. | Low impact; each is a small change with its own test. |
| P3 | **A crashed host's remote-login display.** When the daemon dies with a remote login open, its login browser is stopped the next time the profile is used (it carries `--system-owned-profile`). Its private Xvfb and VNC server cannot carry that mark, so they stay until the host restarts. They hold no profile and no port, only a display number and an owner-only socket directory. Reap them by a recorded pid file at start. | Harmless: nothing waits on them. |
| P3 | **Website-only composition.** The default already serves only website Workers. The mounted `llm`, `llm-pi-ai`, and `models` rows are inert until a model catalog is configured. A `website-only` preset would turn them off, and `web-ui` optionally too. | It saves little and adds a preset to keep in step. |

## Later candidates

Each needs its own proposal: an A2A gateway and runtime (cross-runtime peers), an
ACP client gateway for editors, sandboxed or SSH `exec` providers, more website
providers, and a desktop launcher.
