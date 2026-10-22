# Roadmap

Non-normative. This is the ordered queue of milestones for
[PROP-0001](0001-unified-system-architecture.md), from M6a
[PROP-0003](0003-production-readiness.md), and from B1
[PROP-0010](0010-base-version.md). What each release stage must
deliver, and its exit criteria, are defined in
[release scope](../requirements/release-scope.md). This file only orders the work
and says what remains. What a package does now is in its own `README.md`; what was
verified on live accounts, and when, is in the
[release checklist](../validation/release-checklist.md)
([status ownership](../README.md#status-ownership)).

## Priorities

Set by the operator on 2026-10-22 ([PROP-0010](0010-base-version.md)):

1. **The core and the Claude Code Worker first.** The next release is Base (v0.8), milestones
   B1 to B8 below.
2. **Everything has a schema and a clear protocol**
   ([ADR-0037](../decisions/adr/0037-schema-and-protocol-first.md)).
3. **Website Workers and API or local model Workers after Base.** Their open items wait; their
   conformance suites keep running.
4. **Deep Research is future work** ([below](#future-work)).

## Next: Base (v0.8)

What Base must deliver, and its exit criteria, are in
[release scope](../requirements/release-scope.md#base-v08).

| Milestone | State | Delivers | Depends on |
|---|---|---|---|
| **B1** Specification | done | schemas for the new records (`project`, `board-task`, `approval-request`, `autonomy-policy`, `usage-record`, `limit-state`, `plugin-manifest`, `brief`, `digest`) and for MCP tool input and output; seam definitions and protocol documents; conformance suites for the existing guarantee seams | — |
| **B2** Resource ledger and metering | mostly done | `ctx.resources`; `agent-result@1.2` with token usage; Claude Max windows; usage and limit reports | B1 |
| **B3** Claude Code Worker first-class | started | agent rows on by default (Claude Code only); the P1 follow-up fixed (a workspace per writing task, remediation through approval, every agent's credential directories hidden); confined commands for `validate`, with its own ADR | B1 |
| **B4** Board and charter | not started | `ctx.board`: projects with charters, board tasks across runs, `board_*` MCP tools, `TASKS.md` projection; resume of a blocked task from a brief | B2, B3 |
| **B5** Approval queue | not started | `ctx.approvals`: autonomy policy, one batched queue, expiry fails closed; remediation moved onto it | B4 |
| **B6** Brief and digest | not started | `brief@1.0` for every Worker run; `digest@1.0` by a read-only Claude Code Worker, quote-checked | B5 |
| **B7** Plugin manifest | not started | a manifest per plugin with its seams, versions, and lifecycle state; a lifecycle change recorded as a decision | B6 |
| **B8** Pilot and baseline | not started | the `algorithm-development` template; one project of at least five working days; the baseline report | B7 |

## Done and open milestones

| Milestone | State | What remains | Evidence |
|---|---|---|---|
| **M0** Host on DSH core, kernel, engineering (MVP) | done | — | [spike](../research/m0-dsh-core-spike.md), [e2e test](../../packages/cli/tests/profile.e2e.ts) |
| **M1** Provider runtime and ChatGPT Web (MVP) | done, one check open | credential re-login past the email page (needs the operator) | [checklist](../validation/release-checklist.md), [login](../../packages/plugins/login/README.md) |
| **M1.5** First usable: `ask` and `research` (MVP slice 1) | done | — | [checklist](../validation/release-checklist.md) |
| **M2** Routing, DAG core, MCP, CLI (MVP release) | done | — | [traceability](../validation/traceability.md) |
| **M3** Workers (Beta) | mostly done | after Base: connectors as capabilities (`connector:<name>`) and a new persistent Gemini chat (verified on the fake site only, by operator choice); Gemini Deep research through `ask` is [future work](#future-work) | [agent Workers](../../packages/plugins/agent-workers/README.md), [Gemini Web](../../packages/plugins/provider-gemini-web/README.md) |
| **M4** Orchestration (Beta release) | mostly done | handoff envelopes | [workflow](../../packages/plugins/workflow/README.md), [checklist](../validation/release-checklist.md) |
| **M5** Gateways (v1.0) | done, one item open | journaled client configuration edits (REQ-HOST-3), once `system` edits a client file; today `system claude-env` and `codex-env` only print commands | [gateway turns](../../packages/gateway-turns/README.md), [checklist](../validation/release-checklist.md) |
| **M6** Second domain | done | — | [scientific research](../../packages/plugins/profile-scientific-research/README.md), [operations](../operations/README.md) |
| **M6a** Security hardening (v1.0) | done, live checks open | a signed-in Codex Worker run with reads confined and the model token ([checklist](../validation/release-checklist.md)) | [PROP-0003](0003-production-readiness.md#m6a-security-hardening), [ADR-0023](../decisions/adr/0023-scoped-control-credentials.md) |
| **M6b** Operability (v1.0) | started | `/ui` health banner; scheduled account probes; health of each plugin and the DSH pin; a host whose required service refuses to start exits non-zero | [PROP-0003](0003-production-readiness.md#m6b-operability) |
| **M6c** Data lifecycle, upgrades, reliability (v1.0) | started | crash suite at every reconcile point (moved into Base, B1 to B5) | [PROP-0003](0003-production-readiness.md#m6c-data-lifecycle-upgrades-reliability) |
| **M6d** Supply chain and release (v1.0) | done | the first tagged release; npm publication and a license are deferred by the owner ([ADR-0026](../decisions/adr/0026-versioned-releases-with-provenance.md)) | [releasing](../engineering/releasing.md) |
| **M6e** API-first composition (v1.0) | done, live checks open | after Base: an API model Worker and a local model Worker, each verified live | [models](../design/models.md), [ADR-0025](../decisions/adr/0025-api-first-composition.md), [api-first e2e](../../packages/cli/tests/api-first.e2e.ts), [checklist](../validation/release-checklist.md) |
| **PROP-0007** Account pools (up to 5 accounts of one provider) | done, live checks open | after Base: a second account of one provider: two concurrent `ask`s on two accounts, a two-member team on two accounts, a failover; limit rules once a site's limit text is seen | [PROP-0007](0007-account-pools.md) |
| **PROP-0004** Phase 1: removals and switch-offs | in progress | Phase 1's checks: the composition's row set, old runs of removed templates still explained after an upgrade, the crash suite | [templates](../reference/workflow-templates.md), [turn a row on](../operations/runbooks.md#turn-an-off-row-back-on) |
| **v1.0** Production-ready release | after Base | M6a to M6e and the open live items of the release checklist, except Deep Research | [release scope](../requirements/release-scope.md#production-ready-exit-criteria), [checklist](../validation/release-checklist.md) |
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
| P1 | **Agent Worker workspace isolation and remediation approval.** Fixed in B3: a remediation cycle is grown by the review that asked for it (superseding an earlier fix retires the later cycles), the fix waits for the operator's approval of its exact plan, every coding agent's login and the operator's credential stores are hidden from every agent child, and a workspace per writing task: with `worktreePerRun`, each workflow run's agent runs work in that run's own git worktree, on branch `system/run/<runId>`, reviewers included, and the worktree is removed, its changes committed on the branch, once the run has been idle past the retention ([agent Workers](../../packages/plugins/agent-workers/README.md)). | Done. |
| P2 | **Two tabs of one Gemini profile.** Concurrent turns per account are back at 2 (2026-10-18), checked live on ChatGPT: two turns in two tabs of its profile, in different modes, did not change each other's. Check the same on Gemini with its next two-member run. | It comes with the next Gemini team run. |
| P2 | **One bounded resend after a site's own error.** A site that answers with its own error (`answer.site-error`) fails the turn as `overloaded`, unsent again. One resend in the same conversation, when the page positively shows our prompt followed by a recognized site error, would be a new row of the reconciliation table ([provider turns](../design/provider-turns.md#reconciliation)), counted against `maxResubmits`. | A reconciliation rule change: decided on its own. |
| P2 | **Provider diversity.** A family's value comes from the live descriptor, and one vendor reached through several Worker sources counts as several families ([ADR-0027](../decisions/adr/0027-provider-diversity-in-routing.md#consequences)). Record the family at routing, and allow an operator override per account. | The MVP has website Workers only. |
| P2 | **Evidence-backed review approval.** Today a review returns accepted results, a majority, and verified quotes. Approval stays with the Lead ([ADR-0028](../decisions/adr/0028-local-lead-final-authority.md)). A gate that requires verified findings before a run reports `pass` is a separate design. | Scope. |
| P3 | **Teams of 5 to 10 members, and ranked choice.** Contracts exist for 2 to 5 members. Larger teams need more provider families than the MVP has. | No requirement yet. |
| P3 | **Engine details.** Only the first tie gets a deadline timer. Two concurrent `stop`s each record a decision. The session record labels a model Worker's runtime `local-tool`. The runtime vocabulary in `worker-sessions` names agent runtimes, so the INV-11 architecture rule does not cover it yet. | Low impact; each is a small change with its own test. |
| P3 | **A crashed host's remote-login display.** When the daemon dies with a remote login open, its login browser is stopped the next time the profile is used (it carries `--system-owned-profile`). Its private Xvfb and VNC server cannot carry that mark, so they stay until the host restarts. They hold no profile and no port, only a display number and an owner-only socket directory. Reap them by a recorded pid file at start. | Harmless: nothing waits on them. |
| P3 | **Website-only composition.** The default already serves only website Workers. The mounted `llm`, `llm-pi-ai`, and `models` rows are inert until a model catalog is configured. A `website-only` preset would turn them off, and `web-ui` optionally too. | It saves little and adds a preset to keep in step. |

## Future work

Not scheduled; each needs the operator's go-ahead:

- **Deep Research** on ChatGPT and Gemini: the `research --deep` check on two providers, and
  Gemini Deep research through `ask` ([release checklist](../validation/release-checklist.md)).
  The code stays and keeps its fake-site tests; live runs take tens of minutes each and do not
  serve the core.
- **After Base:** new work on website Workers (connectors, Gemini chat, the P2 items above),
  live checks of API and local model Workers, Codex and ACP agent Workers.

## Later candidates

Each needs its own proposal: an A2A gateway and runtime (cross-runtime peers), an
ACP client gateway for editors, sandboxed or SSH `exec` providers, more website
providers, and a desktop launcher.
