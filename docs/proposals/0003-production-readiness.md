---
id: PROP-0003
type: proposal
status: draft
owners: [tsuuanmi]
created: 2026-10-14
related-requirements: [QA-5, QA-6, QA-7, QA-11, REQ-ACC-9, REQ-ART-3, REQ-HOST-2, REQ-WRK-6, REQ-WRK-8, CON-2, CON-6, CON-8]
related-decisions: [ADR-0006, ADR-0010, ADR-0013, ADR-0018, ADR-0019, ADR-0023, ADR-0024, ADR-0025, ADR-0026]
implementation: []
---

# Proposal: Production readiness for a hardened per-user deployment

## Problem

The correctness core of `system` is in place: turn receipts and reconciliation,
leases with generations, decision artifacts, egress checks, an encrypted vault,
seam conformance suites, and requirement traceability. The
[production-ready bar](../requirements/release-scope.md#production-ready-v10) asks
for more than that, and an organization that lets each engineer run `system`
needs more still. A review of the source on 2026-10-13 found these gaps:

- **One control credential for everything.** `mcp-server`, `web-ui`, and
  `gateway-turns` all accept the single `<DSH_HOME>/system/mcp.token`. Any MCP
  client can call the credential tools and `delete`. A Codex Worker that forwards
  the token to reach the Responses gateway can also call every `/mcp` tool.
- **Agent Workers can read daemon state.** Codex's sandbox confines writes, not
  reads. A Codex Worker can read `vault.key`, the token, the store, and the login
  profiles ([threat model](../security/threat-model.md#threats-and-controls)).
- **The vault key sits beside the vault** by default.
- **No supply-chain gates.** CI had no dependency audit, code scanning, or update
  automation (M6a item 5 adds them). Nothing is versioned or published. There is no license, security
  policy, changelog, SBOM, or provenance.
- **The runtime floor carries a known defect.** `node:sqlite` truncates text at an
  embedded NUL and has CVE-2026-58041. Both are fixed in Node 24.18.1 and 26.5.1;
  the state of the Node 22 line is not yet confirmed.
- **Little operability.** There are a handful of log calls, `/healthz` exists only
  on the Responses gateway, and nothing reports per-account or per-Worker health or
  alerts on provider UI drift.
- **Unbounded data.** Turns and run prompts expire, but artifacts and events never
  do (against [INV-9](../architecture/invariants.md#inv-9-everything-is-bounded)).
- **No upgrade safety.** Store migrations are forward-only, nothing refuses a store
  that newer code has already migrated, and there is no upgrade test.
- **Partial crash coverage.** The crash suite kills the host at the four turn
  reconcile points only. The bar is every reconcile point.
- **Website-only defaults.** The default Workers drive consumer websites (CON-3),
  and the planned `ctx.models` provider for API and local models is not built. An
  organization that cannot accept website automation has no supported composition.

## Goals

1. Close every control the [threat model](../security/threat-model.md) lists as
   not built, plus the Codex read gap.
2. Meet each row of
   [operational readiness](../requirements/release-scope.md#operational-readiness)
   with tests or validation evidence, for Linux x64.
3. Publish versioned, provenance-attested releases with an upgrade path that is
   tested.
4. Offer an `api-first` deployment preset in which website Workers and model
   gateways are opt-in, so the system is usable where website automation is not
   allowed.

## Non-goals

- **Multi-user or networked deployment.** "Enterprise" here means many
  single-user instances, one per engineer. CON-6 stays. Fleet configuration is
  the organization's own tooling over the profile patch.
- **OAuth for MCP.** The MCP authorization spec builds on OAuth 2.1 for remote
  servers. A loopback daemon with one user gains nothing from it; it returns with
  any requirement that changes CON-6 ([ADR-0023](../decisions/adr/0023-scoped-control-credentials.md)).
- **OpenTelemetry export and a metrics endpoint.** No requirement asks for them,
  and the GenAI semantic conventions are still in Development status.
- **An in-app scheduler or notifier.** systemd timers and `OnFailure=` units do
  this already.
- **Application-level encryption of the store.** SQLCipher does not work with
  `node:sqlite`, and a process running as the operator holds the key anyway.
- **macOS in v1.0.** It moves to a 1.x milestone (M7).
- **Changes the review rejected:** per-node leases, and blocking (instead of
  failing) on a scheduler exception. The [recovery design](../design/workflow-engine.md#recovery)
  stands.

## Evidence and research

- Repository review, 2026-10-13: the shared token is read in
  `packages/plugins/mcp-server`, `packages/plugins/web-ui`, and
  `packages/gateway-turns`, and checked by `guardRequest` in
  `packages/gateway-core/src/guard.ts`; only `turns` and `workflow` purge data;
  `Store.migrate()` has no newer-version check; the crash suite has four kill
  points, all in website turns.
- The `workers` row already orders quota classes (`quotaPreference`), the
  `egress` row already maps Worker classes to classifications (`workerClasses`),
  and the `credentials` row already takes a `keyFile`. The API-first preset and
  key custody need configuration, not new mechanisms.
- The DSH packages `dsh-llm`, `dsh-llm-pi-ai`, and `dsh-llm-retry` are already in
  the lockfile at the pinned DSH version
  ([reuse map](../architecture/plugin-model.md#dsh-core-reuse-map)).
- MCP authorization: OAuth 2.1 with PKCE, protected-resource metadata, and
  incremental scopes answered with `403 insufficient_scope`
  ([specification](https://modelcontextprotocol.io/specification)). The scoped
  tokens of M6a reuse that error shape.
- Codex on Linux: the default Landlock backend confines writes only; the
  bubblewrap backend (feature `use_linux_sandbox_bwrap`) supports restricted
  readable roots ([openai/codex `linux-sandbox`](https://github.com/openai/codex)).
- `node:sqlite`: CVE-2026-58041 and the NUL-truncation defect, fixed in Node
  24.18.1 and 26.5.1 ([Node.js security releases](https://nodejs.org/en/blog/vulnerability)).
- Supply chain: npm trusted publishing with provenance
  ([npm docs](https://docs.npmjs.com/generating-provenance-statements)), GitHub
  artifact attestations, and CycloneDX SBOMs ([cyclonedx.org](https://cyclonedx.org/)).
- OS keyrings on Linux go through the Secret Service over a D-Bus session bus,
  which a headless or service host often lacks.

## Proposed design

Five milestones replace the open "hardening" item of M6 on the
[roadmap](roadmap.md). They are ordered by risk; M6d and M6e can start once M6a
lands. Each item names the requirement it closes and the test that proves it.

### M6a Security hardening

1. **Scoped control credentials**
   ([ADR-0023](../decisions/adr/0023-scoped-control-credentials.md)). Three
   owner-only token files replace `mcp.token`:
   - `operator`: every operator action (`approve`, `stop`, `continue`, `delete`,
     `supersede`, `drain`, `resume`, the `account_*` tools) and `/ui`;
   - `client`: `ask`, `research`, `run`, `result`, `status`, `explain`, `usage`,
     `session_send`, `session_inbox`;
   - `model`: the `/anthropic` and `/openai` gateways only.

   `guardRequest` maps the presented token to its scope. Every MCP tool
   registration declares a scope; `tools/list` returns only the caller's tools, and
   a call outside the scope is refused with `403 insufficient_scope`. The CLI uses
   the operator scope, `mcp-config` hands out the client scope, and `claude-env` /
   `codex-env` the model scope. Rotation is "delete the file, restart"
   ([runbooks](../operations/runbooks.md)). Tests: a guard matrix of every scope
   against every tool and route, the `mcp` conformance suite, and an e2e check that
   a client token can neither list nor call `approve` or `account_set_credentials`.
2. **Agent Workers confined for reads**
   ([ADR-0024](../decisions/adr/0024-agent-workers-confined-for-reads.md)).
   Runtime evidence gains `readsConfined`. Daemon state (`<DSH_HOME>/system/**`
   and the vault key path) must be unreadable to every agent Worker; a runtime that
   cannot prove it is unavailable
   ([INV-2](../architecture/invariants.md#inv-2-fail-closed)). A spike first tries
   Codex's own bubblewrap backend with restricted readable roots; if that cannot
   express the policy, `agent-runtime-core` wraps the child in `bwrap` itself. The
   spike also checks the AppArmor restriction on unprivileged user namespaces in
   current Ubuntu releases. Tests: a conformance case "a read outside the workspace
   is denied", and a real-`bwrap` test that CI requires the way it requires Xvfb.
   This replaces the "re-verify the Codex Worker" item of the
   [release checklist](../validation/release-checklist.md).
3. **Vault key custody.** No new mechanism: the operator runbook makes a `keyFile`
   outside `DSH_HOME` (a systemd credential or a separate volume) the documented
   default, and health (M6b) reports a key stored beside the vault as degraded.
   OS keyrings are rejected on Linux (see Evidence) and revisited for macOS.
4. **Data at rest.** Full-disk or home-directory encryption becomes a stated
   deployment precondition in the threat model and runbooks. Answers, the store,
   and login profiles stay protected by owner-only permissions under it.
5. **CI security gates.** `pnpm audit --prod --audit-level high`; a repository
   secret scan with the secretlint rules `egress` already uses; CodeQL; Dependabot
   for npm and Actions, ignoring `@deepseek-ai/*` because DSH bumps stay manual
   (CON-8); third-party Actions pinned by commit SHA.
6. **Runtime floor.** Confirm which Node 22 release, if any, carries the
   `node:sqlite` fixes; then narrow `engines`, the CI matrix, and the start-up
   check (REQ-HOST-2) to fixed releases. A store test round-trips text containing
   `\0`.

### M6b Operability

1. **Health.** The `status` tool grows a health report: each account's state, each
   Worker's availability, plugin state, a store integrity check, free space under
   `DSH_HOME`, vault key placement, the Node version, and the DSH pin. `system
   health [--json]` exits 0 (healthy), 1 (degraded), or 2 (down). A liveness-only
   `/healthz` with no data moves from `gateway-responses` to `mcp-server`. `/ui`
   shows a degraded banner.
2. **Drift alerts.** Health turns degraded on a `ui.drift` event or a failed probe.
   An optional, bounded `account probe` schedule (off by default, sends no prompt,
   CON-3) proves the UI maps between runs. Notification is the operator's: a
   systemd `OnFailure=` unit or a timer around `system health`.
3. **Event queries.** `system events --run|--node|--turn|--lease [--since]` and an
   operator-scope `events` tool over the event log (QA-7).
4. **Logs.** Standard error goes to the journal under a per-user systemd unit. A
   test asserts that no credential reaches logger output during a credential login
   (REQ-ACC-9).
5. **Runbooks.** A per-user service unit, token rotation, key custody, health
   monitoring, and scheduled backups with a systemd timer that runs
   `system backup`.

### M6c Data lifecycle, upgrades, reliability

1. **Split the workflow engine first.** The existing refactor of
   `packages/plugins/workflow/src/index.ts`, with tests unchanged, so the retention
   work lands in a reviewable module.
2. **Bounded retention.** Finished runs expire after a configured `retainRunsDays`.
   Artifacts that no retained record references are collected, using the
   reachability rule already in [artifact storage](../design/artifacts.md#storage).
   Events are trimmed by age. `explain` reports a collected input as `expired`
   with its hash.
3. **Downgrade guard.** `Store.migrate()` refuses a store whose recorded migration
   version is newer than the code knows, and names the plugin and both versions
   (REQ-HOST-2).
4. **Upgrade suite.** Each release publishes a seeded store fixture. An e2e suite
   migrates every fixture to the current code, boots it, and checks that old runs
   still `explain` and every record validates
   ([INV-14](../architecture/invariants.md#inv-14-every-record-has-a-versioned-schema)).
5. **Crash suite at every reconcile point.** An effect register (each external
   effect, its [INV-4](../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay)
   class, and its crash test) joins [restart](../architecture/data-flow.md#restart).
   New kill points: an agent run after start, a node commit, graph growth, peer
   message delivery, a lease takeover, a gateway request mid-stream, and a backup.
   A scheduled workflow runs the suite repeatedly.
6. **Traceability.** An architecture test for
   [INV-7](../architecture/invariants.md#inv-7-no-mirrored-protocol-objects): no
   gateway imports another protocol's types. QA-11 is covered by the Linux-only
   rewording below.

### M6d Supply chain and release

[ADR-0026](../decisions/adr/0026-versioned-releases-with-provenance.md).

- A license (the owner chooses), `SECURITY.md`, and Changesets with one lockstep
  version group, which also writes `CHANGELOG.md`.
- Packages leave `private`, declare `files` and `publishConfig.provenance`; the
  bundle carries the `dsh-plugin` keyword.
- A tag-triggered release workflow runs every gate, publishes through npm trusted
  publishing (no stored token), generates a CycloneDX SBOM, attests the build,
  attaches checksums to the GitHub release, and emits the upgrade fixture for M6c.
- The release checklist gains the Claude Agent SDK terms review the
  [dependency register](../engineering/dependencies.md) already requires, and an
  `npm audit signatures` check on a clean install.

### M6e API-first composition

[ADR-0025](../decisions/adr/0025-api-first-composition.md).

1. **The `models` seam.** A new plugin provides the planned `ctx.models` over the
   DSH `llm`, `llm-pi-ai`, and `llm-retry` rows and registers a `models` Worker
   source with `ctx.workers`, as `turns` and `agent-workers` do. The model catalog
   is operator configuration (model reference, tiers, quota class `metered` or
   `local`). A new egress Worker class, `model`, receives `public` and
   `operator-shared` by default; an operator whose model runs locally widens it.
   Egress is checked on the actual payload
   ([INV-12](../architecture/invariants.md#inv-12-data-egress-is-explicit)),
   retries and tokens are bounded, and usage is recorded as `metered`. A
   conformance suite runs against a fake model
   ([INV-11](../architecture/invariants.md#inv-11-no-tool-lock-in)). The spike
   confirms that the rows pull in no telemetry or vendor default rows and decides
   how API keys reach the provider (the vault through `ctx.credentials`, or
   forwarded by name).
2. **The `api-first` preset.** A bundle overlay disables the website rows
   (display, browser, providers, website drivers, login, accounts, turns, turn
   receipts) and both model gateways, and sets
   `quotaPreference: [local, metered, agent-plan, subscription-chat]`. `system init
   --preset api-first` writes it and skips the Chrome and Xvfb checks. It names no
   vendor or model. The composition e2e test asserts the exact row set for each
   preset. Templates that need `web-search` or `deep-research` fail admission with
   a clear "no Worker proves …" error under this preset, which the
   [templates reference](../reference/workflow-templates.md) documents.

### Release gate and later work

v1.0 needs M6a through M6e and the remaining live items of the
[release checklist](../validation/release-checklist.md). macOS (an `offscreen`
display, a visible login window, and read confinement through the platform
sandbox) is milestone M7, in a 1.x release.

### Requirement deltas on acceptance

These change when the proposal is accepted, together with their tests, and the
traceability page is regenerated then.

| Id | Change |
|---|---|
| QA-14 (new) | Every control surface authorizes by scope; a credential grants only its scope's actions. |
| REQ-HOST-6 (new) | The host reports the health of each account, Worker, and plugin, and turns degraded on provider UI drift. |
| REQ-HOST-7 (new) | Every release upgrades a store from each earlier release, and a store migrated by newer code is refused. |
| REQ-WRK-10 (new) | API and local models are Workers behind `ctx.models`, routed, egress-checked, and bounded like other Workers. |
| REQ-WRK-6 | Adds: the sandbox confines reads as well as writes; host state is never readable. |
| REQ-WRK-8 | The quota order is configuration; the default composition prefers subscription-chat. |
| REQ-ART-3 | "why" holds within retention; past it, `explain` reports the expired hash. |
| CON-2 | The Node range is narrowed to releases with the `node:sqlite` fixes. |
| QA-11, release scope | v1.0 is Linux x64; macOS and Windows move to 1.x. |
| [Purpose](../requirements/purpose.md) | A note: the `api-first` preset serves P3 and P4; P1 and P2 need website Workers. |

### Where current documents and this proposal meet

| Document | Resolution |
|---|---|
| ADR-0018 "telemetry off", ADR-0019 "never inserted: telemetry" | Unchanged. A dated amendment to ADR-0018 with M6b states that telemetry means data sent to a vendor; local logs, health, and events are not telemetry. |
| REQ-GW-1, REQ-GW-5, v1.0 exit criterion 2 | Still met by the default composition; the release checklist records each preset. |
| CON-3 | Unchanged; the `api-first` preset removes the exposure where it is not acceptable. |
| CON-6 | Unchanged (see Non-goals). |
| CON-8 and a stable version promise | ADR-0026: SemVer covers the contracts `system` owns (MCP tools, CLI, configuration, schemas), not DSH's. |
| [Workflow retention](../design/workflow-engine.md#retention) "cleanup is operator-only" | Rewritten with M6c; an ADR-0013 amendment only if review reads "immutable" as "kept forever". |

## Alternatives considered

- **A shared team server** (OIDC, roles, per-tenant vaults, a networked daemon).
  Rejected for now: it changes CON-6, INV-1 per tenant, and the whole threat model,
  and no requirement asks for it. The scoped credentials of M6a are the first step
  if one appears.
- **OAuth 2.1 on loopback.** Rejected: an authorization server for one local user
  adds a component and no protection ([ADR-0023](../decisions/adr/0023-scoped-control-credentials.md)).
- **Keep website Workers as the only default.** Rejected: some organizations cannot
  accept consumer-site automation (CON-3), and P3/P4 do not need it.
- **Removing website Workers from enterprise builds.** Rejected: one bundle and
  presets keep a single implementation (INV-1, REQ-HOST-4).
- **OpenTelemetry and Prometheus now.** Deferred: no requirement, unstable
  conventions, and the health report plus event queries cover the operator.
- **Encrypting the store in the application.** Rejected (see Non-goals).

## Validation plan

- Every new or reworded id in the table above gets a citing test, and
  `pnpm check:traceability` stays green.
- Security: the scope matrix, the read-confinement conformance case and real
  `bwrap` test, the redaction test, and the CI audit, secret-scan, and CodeQL jobs.
- Data: retention with a fake clock, the downgrade guard, and the upgrade suite
  over every published fixture.
- Reliability: the crash suite at every point in the effect register, repeated on
  a schedule with zero duplicate effects.
- Composition: exact row sets for the default and `api-first` presets, and the
  `models` conformance suite against a fake.
- Live: the release checklist, extended with an API provider, a local model, and
  each preset.

## Rollout and rollback

- Every milestone lands behind the existing composition: each feature is a plugin
  row or a configuration field, so it can be disabled without code changes
  (REQ-HOST-4).
- Scoped tokens replace `mcp.token` in one release. `system init` and the
  `*-env` / `mcp-config` helpers re-issue client configuration. There is no
  compatibility path for the old token: clients take the new one at their next
  connection, through the helpers that already read the token file.
- Retention is off until configured in the release that introduces it; the next
  release sets the default.
- A failed upgrade is rolled back by `system restore` from the backup that the
  upgrade runbook takes first; the downgrade guard stops an older binary from
  opening the migrated store.

## Observability and operations

M6b is this section: the health report, drift alerts, event queries, journal logs,
and runbooks. Each new runbook or playbook lands in
[operations](../operations/README.md) with the code it documents.

## Security and privacy

M6a closes the threat-model items that are not built and the Codex read gap. New
trust-boundary effects:

- the `model` scope reaches only the gateways, so a token forwarded into a Worker
  no longer controls the host;
- the `models` Worker class sends payloads to API providers, under the same egress
  check as website and agent Workers;
- the release pipeline gains an identity (OIDC) that can publish packages; it is
  limited to tag builds.

## Compatibility and migration

No compatibility layer is kept. The token change needs the client helpers to run
once; the store change is forward migrations plus the new downgrade guard. From
the first published release, upgrades from every earlier release are tested.

## Decision

Pending review. ADR-0023 to ADR-0026 are proposed alongside this proposal.

## Implementation

None yet.
