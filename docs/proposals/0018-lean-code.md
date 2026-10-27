---
id: PROP-0018
type: proposal
status: draft
owners: [operator]
created: 2026-10-27
summary: A lean-code review of the whole repository, read from the code and from line counts, not from memory. About 79,600 lines of source, 62,000 lines of test code, 10,700 of conformance suites and 9,500 of scripts. The cheap clean-up (unused exports, dead constants, stray dependencies) was already done in three areas (T245, T258, T289) and what is left of it is small, about 1,350 source lines in all and 650 of them without a decision. The real gains are structural, and are named here with their cost. One shared helper layer for the same few functions copied across 14 packages. One request engine for the two digest providers, which today repeat about 300 lines. One glob matcher where five exist. One removal that needs the operator's decision (the hand-named agent Worker rows and their cutover, about 700 source lines). Moving code that has one consumer next to it (the repository snapshot out of libs, the advisor providers and the scheduled review out of the engine). In-package splits for 25 files past 800 lines. A ranked list of 17 tasks, each one concern of at most about 1,500 changed lines, with what it removes and what guards it. A list of what stays. Nothing in this proposal changes code.
evidence: [operator request 2026-10-27, CLEANUP-RULES (lead, 2026-10-26), changesets cleanup-control-plane-t245, cleanup-agent-side-t258, cleanup-approvals-report-t289, docs/architecture/packages.md, docs/architecture/plugin-model.md]
related: [PROP-0009, PROP-0010, PROP-0012, PROP-0016, ADR-0036, ADR-0037, INV-1, INV-7, INV-10, INV-14, INV-15]
implementation: []
---

# Proposal: Lean code, where System can be smaller and cleaner with the same behaviour

## Problem

On 2026-10-27 the operator asked for "clean, production-ready code, fewer lines of code, the system
still works correctly or better". The source has grown with each increment: PROP-0014 to PROP-0017
added dispatch, advisors, landing, risk tiers, handbooks, and dossiers in five weeks. Three
clean-ups already ran on parts of it (the control plane T245, the agent side T258, approvals and
report T289). No one has read the rest as a whole for what can go.

This proposal is that reading. It is not normative until accepted, changes no code, and each task in
it is filed separately by the lead.

## Goals

- Say where lines can be removed with the same behaviour, with the evidence (file and line), the
  size, and the risk, so each can be checked rather than believed.
- Say where a boundary would make the code clearer, with the dependency direction after it and what it
  costs.
- Rank the work in small tasks with their order and the tests that guard them.
- Say what must not be removed.

## Non-goals

- No code, test, schema, or configuration change here.
- No new feature, and no change to an invariant (INV-1 to INV-15) or to an accepted ADR.
- No removal of a public contract, a schema, a store migration, a conformance suite, or a user-set
  configuration key, MCP tool, or CLI flag without the operator's decision. Those are listed in
  [section 2.4](#24-needs-the-operators-decision-a-public-surface) and in
  [what stays](#5-what-stays).

## 1. Measurements

### 1.1 How it was measured

`knip` is not installed in this repository and the run had no network, so it was not run. The
measurements are:

- **Lines**: a count of every line (`^`) in every file under `src/`, `tests/`, and `conformance/` of
  each package, per file, then added by hand per package. The tool's grand total for `src/` is
  **79,603 lines in 216 files**; the per-package sums below are added by hand and may differ from it
  by a few lines.
- **Exports used outside a package and dependencies**: the two inventories in
  [1.3](#13-dependencies-and-exports-used-outside-by-package), with the method and its limits stated
  there. Names that looked unused were then searched in every `packages/**` and `scripts/**` file.
- The list of names other packages import is given for every package; the comparison of that list
  with the package's full export list was made only for the packages where 1.3 names the exports
  nothing imports. The first task below (T1) adds a repeatable check so that later tasks prove their
  claims by running it. Where a number is an estimate and not a count, the text says so.

Two guards the search found nothing for: no skipped, todo, or `.only` test exists in `packages/` or
`scripts/` (only a doc comment in `scripts/gen-traceability.ts:61` names `it.skip`), and no commented-out
code was found in any `src/` (four hits of a search for a commented statement were prose).

### 1.2 Size by package

Source is `src/`; tests is `tests/` code and helpers, fixtures excluded (about 4,800 lines of JSON,
SQL and YAML fixtures sit beside them: `statistics` 2,427, `runtime-antigravity-cli` 1,346, `cli`
402, `runtime-claude-agent-sdk` 202, `runtime-codex-sdk` 123, `system-bundle` 339); conformance is the
seam's suite under `conformance/`. "Imported by" counts the workspace packages whose code imports it,
from the generated graph (a plugin used only through its seam is not an importer).

| Package | Source | Tests | Conformance | Imported by |
|---|---:|---:|---:|---|
| `workflow` | 18,130 | 12,426 | 1,715 | gateway-turns (type), profile-software-development |
| `agent-workers` | 11,723 | 10,946 | | none (its seam only) |
| `web-ui` | 3,985 | 4,735 | | none |
| `libs` | 3,046 | 2,314 | 81 | nearly every package |
| `agent-runtime-core` | 3,148 | 2,028 | 482 | agent-runtimes, agent-workers, 4 runtimes |
| `cli` | 2,882 | 2,394 | | none |
| `board` | 2,807 | 1,844 | | none |
| `report` | 1,869 | 1,158 | | none |
| `approvals` | 1,755 | 1,456 | | none |
| `runtime-codex-sdk` | 1,717 | 1,066 | | none |
| `turns` | 1,597 | 1,467 | | none |
| `gateway-core` | 1,560 | 1,072 | 56 | 19 packages |
| `ui-ops` | 1,353 | 473 | | chatgpt, gemini drivers |
| `mcp-server` | 1,237 | 1,272 | | cli (tests) |
| `runtime-antigravity-cli` | 1,227 | 821 | | none |
| `runtime-claude-agent-sdk` | 1,200 | 1,424 | | none |
| `browser-patchright` | 1,139 | 1,278 | | cli |
| `provider-core` | 1,130 | 462 | 330 | 18 packages |
| `workers-core` | 1,000 | 0 (suite) | 818 | 12 packages |
| `experiments-core` | 980 | 228 | 626 | evaluations-core only |
| `provider-gemini-web` | 925 | 910 | | none |
| `provider-chatgpt-web` | 958 | 750 | | none |
| `models` | 956 | 886 | | none |
| `workers` | 860 | 575 | | none |
| `resources` | 759 | 557 | | none |
| `approvals-core` | 773 | 241 | 703 | 7 packages |
| `notify` | 712 | 522 | | none |
| `login` | 657 | 311 | | none |
| `evaluations-core` | 654 | 186 | 683 | statistics (tests) |
| `digest-extractive` | 638 | 371 | | none |
| `board-core` | 573 | 30 | 1,577 | 4 packages |
| `plugin-host-core` | 521 | 183 | 369 | mcp-server, plugin-host |
| `artifacts` | 502 | 200 | 392 | none |
| `digest` | 443 | 249 | | none |
| `worker-sessions` | 431 | 184 | 250 | workflow |
| `digest-core` | 424 | 88 | 476 | 4 packages |
| `gateway-turns` | 330 | 126 | | gateway-anthropic, gateway-responses |
| `gateway-responses` | 311 | 179 | | none |
| `statistics` | 281 | 284 | | none (evaluations tests) |
| `display-virtual` | 287 | 339 | | login |
| `credentials-vault` | 275 | 171 | | none |
| `accounts` | 280 | 134 | | none |
| `runtime-acp` | 261 | 140 | | none |
| `gateway-anthropic` | 245 | 127 | | none |
| `plugin-host` | 242 | 319 | | none |
| `profile-software-development` | 242 | 1,552 | | none |
| `leases` | 226 | 114 | 268 | 7 packages |
| `turn-receipts` | 219 | 92 | 230 | none |
| `resources-core` | 219 | 28 | 442 | 5 packages |
| `decision-core` | 218 | 0 | 205 | workflow |
| `store` | 201 | 84 | 233 | none |
| `profile-scientific-research` | 199 | 421 | | none |
| `event-log` | 172 | 71 | 214 | none |
| `egress` | 176 | 72 | 172 | none |
| `landing-core` | 170 | 40 | 284 | workflow, landing-local |
| `agent-runtimes` | 141 | 121 | | none |
| `models-core` | 133 | 10 | 126 | models only |
| `landing-local` | 93 | 122 | | none |
| `providers` | 39 | 33 | 49 | none |

Beside the packages: **conformance suites 10,732 lines** (29 files), and **`scripts/` 9,540 lines**
(40 files, of which about 3,300 are experiment drivers and live-update checks, and about 3,600 are
specs).

Reading the table:

- Three packages hold 40 % of the source: `workflow` 18.1k, `agent-workers` 11.7k, `web-ui` 4.0k.
  `agent-workers` has the highest tests-to-source ratio (0.93), `web-ui` is above 1 (1.19).
- Tests are 78 % of the source's size. The tests are not the first thing to cut: they are the
  guard for each removal below, and a test goes only with the code it tests.
- `experiments-core`, `evaluations-core`, and `statistics` (1,915 source lines, 698 test lines, 1,309
  conformance lines, 2,427 fixture lines) have **no runtime consumer** (section 2.4).
- 25 files are past about 800 lines (rule Q2); they are listed in task T14.

### 1.3 Dependencies and exports used outside, by package

Two inventories, one row per package, both from the tree at this commit.

**How each was established.**

- *Dependencies*: the workspace dependencies of each `package.json`, split into `dependencies` (D)
  and `devDependencies` (dev), set against the packages whose code the package imports in `src/`
  (the generated [packages graph](../architecture/packages.md), whose "Imports" column
  `pnpm check:packages` keeps current). A declared package that the graph does not list is read as an
  import of types or of a `ctx.*` augmentation only (`import type {} from '...'`, which this
  repository uses on purpose; the search found each such line in the plugin's `src/`).
- *Exports used outside*: a multi-line search of every named import (`import { … } from
  '@tsuuanmi/system-<package>'`, type imports included) in every other package's `src/`, which gives the
  names below. Tests, conformance suites, and scripts were searched for the names that no other `src/`
  imports, and each is labelled by what still uses it. `import X from` and `import * as` forms, and a
  consumer outside `packages/` and `scripts/`, are not in the search.
- Limits, said plainly: the names are the ones imported, not the package's full export list, and the
  export list was compared with them only where a list is given as "no other `src/` imports". For
  `libs` (about 170 exports, nearly every package a consumer) the full comparison is not done: only
  the exports in 2.3 were checked one by one. T1 completes it for all packages by script.

**Inventory A, the library and definition packages** (the packages other packages import):

| Package | Declared (workspace) | Names other packages' `src/` import | Exports no other `src/` imports (and what still uses them) |
|---|---|---|---|
| `libs` | D: `system-schemas` (read by `require.resolve`, `libs/src/schemas.ts:112`); external `dsh-home-paths`, `ajv`, `ajv-formats` | nearly all of the 170 | not complete; see 2.3: `LIVENESS_VERDICTS`, `DRAW_STATES`, `USAGE_UNKNOWN_KINDS` (nothing); `appliesOf`, `lessonApplies`, `LESSONS_HEADING`, `AGENT_TOOL_EXPLANATION_MAX`, `agentToolDenialReasons` (tests); the 14 names of `repositories.ts` are imported by `workflow` only |
| `gateway-core` | D: `libs` | `outline`, `reply`, `ToolHandler`, `ToolSpec`, `ToolContext`, `ToolScope`, `McpTools`, `guardRequest`, `assertSafeBind`, `readJsonBody`, `LOOPBACK_HOSTS`, `tokenFile`, `scopeToken(s)`, `SCOPES`, `endpointUrl`, `leadId`, `LEAD_PROJECT`, `leadMayDecide`, `leadTokenFile`, `leadTokens`, `readRoster`, `formatRoster`, `Roster`, `RosterServices`, `canTakeStep`, `availabilityChanges`, `recordedAbility`, `EXCLUDED_REASONS`, `WORKER_AVAILABLE_EVENT`, `WORKER_UNAVAILABLE_EVENT` | `readCapacity`, `projectCapacity`, `formatCapacity`, `quotaPoolsOf`, `projectRoster`, `accountName`, `CAPACITY_BOUNDS`, `ROSTER_BOUNDS`, `ROSTER_SCHEMA`, `abilityOf`, `UNAVAILABLE_REASONS`, `hostName`, `tokenMatches`, `issueLeadToken`, `listLeads`, `revokeLeadToken`, `LEAD_RIGHTS`, `LEAD_QUEUE_CLASSES`: used inside the package (`roster.ts:12,768,798,846`) and by its tests; the README names `readCapacity` and `projectCapacity` as public surface (`README.md:108-119`); `cli` reaches the lead-token functions through `libs` |
| `provider-core` | D: `libs` | `ProviderError`, `ProviderErrorKind`, `toProviderError`, `ProviderDriver`, `ProviderRegistry`, `ProviderScheduler`, `ProviderFeature`, `ProviderMode`, `Display`, `PreparedDisplay`, `Browser`, `PortableState`, `ProfileState`, `OWNED_PROFILE_SWITCH`, `Tier`, `BrowserTurn`, `ConversationMode`, `Disposition`, `dispositionOf`, `promptOfStart`, `promptShown`, `boundaryMissing`, `TurnReceipt`, `TurnSnapshot`, `Reconciliation`, `reconcileTurn`, `responseHash`, `AskOptions`, `AskResult`, `AuthState`, `DeleteOptions`, `ResearchState`, `bindingReporter`, `completionOptions`, `modePresets`, `splitAfterLastFence`, `waitForReport`, `waitForStableCompletion`, `withSources`, `withMissingSources`, `compareWords`, `withoutTrackingLinks`, `abortReason` | not compared |
| `workers-core` | none; dev: `artifacts` | about 56 names: `Tier`, `TIERS`, `WORK_KIND`, `ArtifactRef`, `Classification`, `WorkRequirement`, `WorkerExecution`, `WorkerStart`, `WorkerState`, `CapabilityDescriptor`, `CapabilityOffer`, `TierOffer`, `ExecutionStatus`, `ExecutionInfrastructure`, the `Liveness*` set with `MAX_LIVENESS_RUNS` and `LIVENESS_STATES`, `RunLiveness`, `QuotaClass`, `WorkerSandbox`, `WorkScope`, `Acceptance`, `AcceptanceContract`, `ADMISSION_CHECKS`, `AdmissionCheck`, `AdmissionFailure`, `AdmittedWorker`, `Candidates`, `Carried`, `CarryStep`, `CarryRefusal`, `Checked`, `CheckStep`, `CheckResult`, `RunCheck`, `RUN_CHECKS`, `Landed`, `LandStep`, `LandRefusal`, `WorkChange`, `ChangedFile`, `CHANGE_BOUNDS`, `REBASE_FILES_MAX`, `REBASE_MOVED_MAX`, `RebasePhase`, `Regenerated`, `reviewRef`, `offeredTiers`, `provesFor`, `servedTier`, `takesKind`, `tiersWithin`, `Rejection`, `RouteOptions`, `WorkerSource`, `WorkerSourceRead`, `WorkerAccount`, `Workers` | not compared |
| `agent-runtime-core` | none | about 70 names: the provider and run types (`AgentRuntimeProvider`, `AgentRuntimes`, `RunSpec`, `RunResult`, `RunMetering`, `RunObserver`, `RuntimeEvidence`, `Confinement`, `SandboxMode`, `ToolGate`, `ToolCall`, `ToolVerdict`, `ToolResultSink`, `HostTool`, `ToolResult`, `LimitObservation`, `LimitReport`, `LimitsOptions`, `IdentityReading`, `LoginCommand`, `AgentHome`, `ModelUsage`, `ProbeOptions`, `TokenUsage`, `WorkspaceReadBounds`), and the functions and constants (`askToolGate`, `TOOL_GATE_MS`, `childEnvironment`, `confinedCommand`, `proveConfinement`, `withMetering`, `withRunReport`, `meteringOf`, `readLimits`, `probeIn`, `accountIdOf`, `titleOf`, `agentHome`, `agentShellEnvironment`, `homeProblem`, `hostToolsProblem`, `hostToolsServer`, `identityHmac`, `maskEmail`, `observe`, `readHomeJson`, `tailOf`, `writeLauncher`, `homeSocketDirectories`, `socketDirectories`, `socketCovers`, `SOCKET_ROOTS`, `writableUnixSockets`, `toolSandboxAllowances`, `WEB_RUN_TOOLS`, `WORKSPACE_READ_BOUNDS`, `workspaceReadBounds`, `workspaceReadArgs`, `WORKSPACE_READS_SERVER`, `WORKSPACE_READS_SCRIPT`, `WORKSPACE_READ_TOOLS`, `WORKSPACE_GIT_TOOLS`, `HOST_TOOLS_SERVER`, `COMMIT_ID`, `BROWSERS_DIR_VARIABLE`, `SHELL_CONFIG_DIRECTORIES`, `isShellStartupVariable`) | not compared (T258 unexported its module-private ones) |
| `approvals-core` | dev: `artifacts`, `libs`, `store` | `Action`, `ActionClass`, `ALWAYS_ASK`, `ApprovalRequest`, `Approvals`, `ApprovalsError`, `ArtifactRef`, `AutonomyPolicy`, `AutonomyVerdict`, `Check`, `Classification`, `ContentHash`, `Mode`, `ModeChange`, `MODES`, `NewRequest`, `POLICY_SET_REF`, `PolicyChange`, `PolicyChangeOrigin`, `PolicySetInForce`, `RequestState`, `Subject`, `Verdict`, `VerdictResult`, `riskTierMaps`, `tierByRiskMaps`, `applyingPolicies`, `waitSeconds`, `SHELL_METACHARACTER`, `riskMapProblems`, `tierByRiskProblems`, `webAccessOf`, `webAccessLines`, `webAccessProblems`, `WebTool`, `withinClassification`, `changeTier`, `tierReasons`, `RiskTier`, `RISK_TIERS`, `ChangePaths`, `ChangeTier`, `MapOf`, `StepTierByRisk`, `stepTierByRisk`, `TierByRiskOf`, `matchesPath`, `patternProblem` | `APPROVALS_CONTRACT` (conformance, tests), `DEFAULT_MAX_WEB_CALLS` (own module, tests), `pathTier` (`scripts/check-risk-tiers.ts:11`, tests); type-only: `TierByRiskMatch`, `WebAccessRule`, `WebAccessGrants`, `EffectiveWebAccess`, `WebAccessProfile`, `RiskTierRule`, `RiskTierMap`, `PathTier`, `IntelligenceTier`, `TierByRisk`, `Refusal`, `ApprovalsFailure`: none dead |
| `board-core` | D: `approvals-core`; dev: `artifacts`, `libs`, `store` | `Board`, `BoardError`, `BoardTask`, `Project`, `ProjectState`, `TaskInput`, `TaskState`, `Charter`, `CharterInput`, `Claim`, `Breaker`, `BREAKER_DEFAULT`, `BreakerLine`, `Escape`, `Defect`, `DefectBy`, `DEFECT_SHA`, `BudgetLine`, `fundingVersion`, `FREE_RETRIES_DEFAULT`, `FREE_RETRIES_MAX`, `freeRetriesOf`, `InfrastructureFailure`, `infrastructureProblem`, `REOPEN_REASON_MAX`, `Reopening`, `renderTasks`, `RunOutcome`, `TERMINAL`, `UNRELEASED_MAX`, `UnreleasedHold`, `unreleasedProblem`, `unreleasedText`, `WaitReason`, `Subject`, `Classification`, `ArtifactRef`, `ActionClass`, `Unit`, `CancelReason` | `BOARD_CONTRACT` (conformance); `INFRASTRUCTURE_KINDS` and `INFRASTRUCTURE_REASON_MAX` are used by `workflow/src/infrastructure.ts` and the board |
| `resources-core` | dev: `artifacts`, `libs`, `store` | `Resources`, `ResourcesError`, `templatePool`, `BudgetLine`, `DeclaredAccount`, `LimitState`, `PoolConfig`, `PoolState`, `PoolTemplate`, `QuotaSettings`, `Reservation`, `ReservationRequest`, `TokenUsage`, `Unit`, `UsageFilter`, `UsageRecord`, `UsageTotal`, `ArtifactRef` | `RESOURCES_CONTRACT` (conformance) |
| `digest-core` | D: `gateway-core`, `libs`; dev: `artifacts`, `store`, `workers-core` | `Digests`, `DigestError`, `DigestRequest`, `DigestState`, `DigestView`, `DIGEST_LIMITS`, `checkedRequest`, `quoteCheck`, `QuoteCheck`, `escalation`, `EscalationDecision`, `settlement`, `registerDigestTools`, `ArtifactRef` | `DIGEST_TOOLS`, `DIGEST_TOOL_INPUTS`, `digestToolHandlers`, `digestTool` (`digest-core/src/tools.ts` and the digest tests), `ESCALATION_TIER`, `DIGESTS_CONTRACT` (conformance) |
| `decision-core` | D: `libs` | `adviceProblem`, `Advice`, `Advisor`, `AdvisorCandidate`, `AdvisorCounts`, `AdvisorFeatures`, `AdvisorSignal`, `AdvisorWindow`, `advisorStop`, `ALIASES`, `CandidateAdvice`, `FEATURES_SCHEMA`, `MAX_CANDIDATES`, `messageOf`, `Question`, `QUESTION_SET`, `QUESTIONS` (all by `workflow/src/advisor.ts`) | `DISPATCH_ADVISOR_CONTRACT` (conformance) |
| `landing-core` | none | `Landing`, `Landed`, `LandingProvider`, `LandingRefusal`, `LandingRefusalCause`, `LandingStatus`, `LandingTarget`, `LandRequest`, `Prepared`, `sameSubject`, `SUBJECT_VERSION_MAX` | `LANDING_CONTRACT`, `LANDING_REFUSAL_CAUSES` (conformance) |
| `models-core` | D: `workers-core` | `Models`, `ModelError`, `ModelCompletion`, `ModelEntry`, `ModelFailure`, `ModelRequest`, `ModelStatus`, `ModelTurn`, `Unprocessed` (all by `models`) | none |
| `plugin-host-core` | D: `libs`; dev: `artifacts`, `store` | `PluginHost`, `PluginRecord`, `findPlugin`, `readManifest`, `pluginRecords`, `pluginsOf`, `reconcile`, `reconcileChecks`, `MANIFEST_FILE`, `MANIFEST_MAX_BYTES`, `CompositionRow`, `ManifestFinding`, `ManifestRead`, `RecordedCheck`, `RecordedLifecycle` | `PLUGIN_HOST_CONTRACT`, `LIFECYCLE_STATES`, `compositionHash`, `UNDECLARED_SEAM_VERSION`, `satisfies`, `checkComposition`, `checkHash` (`scripts/gen-manifests.ts`, the package's tests and conformance suite) |
| `gateway-turns` | D: `gateway-core`, `libs`, `store`, `workflow` (the last two are a type and an augmentation: `threads.ts:13-14`) | `guard`, `MAX_REQUEST_BYTES`, `modelTokenPath`, `Threads`, `renderOpening`, `estimateTokens`, `tierOf`, `Tier`, `Part`, `ToolCall`, `ToolSpec`, `Turn` (by the two gateways) | `renderTools`, `NUDGE`, `claimsNoAccess`, `renderSuffix`, `parseToolCalls`: used inside `protocol.ts` and `threads.ts` and by its tests |
| `ui-ops` | D: `libs`, `provider-core`; dev: `display-virtual`, `browser-patchright` | `UiEngine`, `UiMap`, `loadUiMap`, `unverifiedEntries`, `appendOverlay`, `outlineOf`, `UiOutline`, `driftData`, `evidenceData`, `copiedMarkdown`, `linksIn`, `preWrapText`, `toLocator`, `Condition`, and the event types (by the two website drivers) | `parseAiSnapshot`, `scoreNodes`, `choose` (`heal.ts`), `NetworkObserver`, `readbackDiff`, `candidateFromLocator`: used inside the package and by `ui-ops/tests`; some are re-exported by `ui-ops/src/index.ts` and are candidates to unexport (T1) |
| `experiments-core` | D: `libs`; dev: `artifacts`, `store` | `OUTCOMES`, `protocolHash`, `environmentHash`, and types, all by `evaluations-core` only | everything else (the package's 980 lines): tests and conformance only |
| `evaluations-core` | D: `experiments-core`, `libs`; dev: `artifacts`, `store` | none | all: tests and conformance only (see O2) |
| `statistics` | dev: `evaluations-core`, `experiments-core`, `libs` | none | all: its own tests only (see O2) |
| `cli` | D: `browser-patchright`, `system-bundle`, `libs`; dev: `mcp-server`, `store` | the bin; `browser-patchright`'s `CHROME_LOCK`, `discoverChrome`, `installManagedChrome`, `ChromeChoice`; `libs`' `drawFigureText`, `issueLeadToken`, `leadId`, `leadTokenFile`, `listLeads`, `revokeLeadToken`, `sqliteRuntimeProblem` | the package's public surface is its bin and `lib/index.js` (README) |
| `system-bundle` | D: 40 plugin packages (every bundle row's package) | rows only (YAML), no code | no `src/` |

**Inventory B, the plugin packages.** A plugin is reached through its `ctx.*` seam, so almost none
of its exports is imported. What other packages' `src/` import from a plugin package, by package:

| Plugin | Declared (workspace) | Imported from it by other `src/` |
|---|---|---|
| `leases` | D: `libs`, `store` | `Lease`, `LeaseLost`, `StaleGeneration`: `board`, `digest`, `digest-extractive`, `models`, `turns`, `agent-workers`, and 15 files of `workflow` |
| `worker-sessions` | D: `artifacts`, `gateway-core`, `libs`, `store` | `Delivered`, `EXTERNAL_SENDERS`, `Runtime`, `RUNTIMES`: `workflow` |
| `workflow` | D: 16 (`approvals-core`, `artifacts`, `board-core`, `decision-core`, `digest-core`, `egress`, `event-log`, `gateway-core`, `landing-core`, `leases`, `libs`, `provider-core`, `resources-core`, `store`, `worker-sessions`, `workers-core`); dev: 15 plugins for its tests | `NodeTemplate`, `SCHEDULED_REVIEW`, `SCHEDULED_REVIEW_NODES` (`profile-software-development`), `NodeTemplate` (`profile-scientific-research`), `RunView` (`gateway-turns`), `TaskLanding`, `TemplateStep` (`web-ui`) |
| `display-virtual` | D: `libs`, `provider-core` | `startXvfb`, `XvfbHandle`: `login` |
| `browser-patchright` | D: `libs`, `provider-core`; dev: `display-virtual` | `CHROME_LOCK`, `ChromeChoice`, `discoverChrome`, `installManagedChrome`: `cli` |
| `accounts` | D: `libs`, `provider-core`; dev: `credentials-vault` | `AccountStatus`, `AccountView` (types): `turns`, `login` |
| `egress` | D: `artifacts`, `libs`, `provider-core`; dev: `store` | `Classification` (type): `turns`, `models`, `agent-workers` |
| `artifacts` | D: `libs`, `store` | `Envelope`, `Decision` (types): `report`, `workflow`; `import type {}` augmentation in about 25 plugin files |
| `event-log` | D: `libs`, `store` | `SystemEvent` (type): `notify`; augmentation in about 14 plugin files |
| `store`, `credentials-vault`, `login`, `turn-receipts`, `workers`, `providers`, `agent-runtimes`, `resources`, `approvals`, `board`, `digest`, `digest-extractive`, `models`, `notify`, `report`, `mcp-server`, `landing-local`, `plugin-host`, `profile-*`, `runtime-*`, `provider-*-web`, `gateway-*`, `agent-workers`, `turns`, `web-ui` | see the declared lists below | nothing, except `import type {}` augmentation lines (a `ctx.*` key) |

Declared workspace dependencies of the plugins, `dependencies` (dev in brackets); every one not
shown as a code import in the packages graph is a type or augmentation import:

| Plugin | D (and dev) |
|---|---|
| `agent-runtimes` | `agent-runtime-core`, `libs` |
| `accounts` | `libs`, `provider-core` (dev `credentials-vault`) |
| `agent-workers` | `agent-runtime-core`, `approvals-core`, `artifacts`, `egress`, `event-log`, `gateway-core`, `leases`, `libs`, `provider-core`, `resources-core`, `store`, `workers-core` (dev: `agent-runtimes`, `approvals`, `board`, `credentials-vault`, `egress`, the two runtimes, `worker-sessions`, `workers`, `workflow`) |
| `approvals` | `approvals-core`, `artifacts`, `event-log`, `gateway-core`, `libs`, `store` (dev `board`, `board-core`, `leases`) |
| `artifacts` | `libs`, `store` |
| `board` | `approvals-core`, `artifacts`, `board-core`, `event-log`, `gateway-core`, `leases`, `libs`, `store` |
| `browser-patchright` | `libs`, `provider-core` (dev `display-virtual`) |
| `credentials-vault` | `libs` |
| `digest` | `artifacts`, `digest-core`, `event-log`, `gateway-core`, `leases`, `libs`, `store`, `workers-core` (dev `egress`, `mcp-server`, `workers`) |
| `digest-extractive` | the same eight (dev `workers`) |
| `display-virtual` | `libs`, `provider-core` |
| `egress` | `artifacts`, `libs`, `provider-core` (dev `store`) |
| `event-log` | `libs`, `store` |
| `gateway-anthropic`, `gateway-responses` | `gateway-core`, `gateway-turns`, `libs`, `store`, `workflow` |
| `landing-local` | `landing-core`, `workers-core` (dev `artifacts`, `store`, `workers`) |
| `leases` | `libs`, `store` |
| `login` | `accounts`, `display-virtual`, `gateway-core`, `libs`, `provider-core` (dev `browser-patchright`, `credentials-vault`, `mcp-server`, `provider-chatgpt-web`, `providers`) |
| `mcp-server` | `gateway-core`, `libs`, `plugin-host-core`, `resources-core` (dev `event-log`, `artifacts`, `store`) |
| `models` | `artifacts`, `egress`, `gateway-core`, `leases`, `libs`, `models-core`, `provider-core`, `store`, `workers-core` (dev 6 plugins) |
| `notify` | `egress`, `event-log`, `gateway-core`, `libs`, `store` (dev `approvals`, `approvals-core`, `artifacts`, `credentials-vault`) |
| `plugin-host` | `artifacts`, `plugin-host-core`, `store` (dev `libs`) |
| `profile-scientific-research` | `artifacts`, `event-log`, `libs`, `workers`, `workflow` |
| `profile-software-development` | `workers-core`, `workflow` |
| `provider-chatgpt-web` | `artifacts`, `event-log`, `libs`, `provider-core`, `ui-ops` (dev `browser-patchright`, `display-virtual`, `providers`, `store`) |
| `provider-gemini-web` | `artifacts`, `event-log`, `provider-core`, `ui-ops` (dev as chatgpt, without `libs`) |
| `providers` | `provider-core` |
| `report` | `approvals-core`, `artifacts`, `board-core`, `digest-core`, `event-log`, `gateway-core`, `libs`, `resources-core` |
| `resources` | `artifacts`, `event-log`, `gateway-core`, `libs`, `resources-core`, `store` |
| `runtime-acp` | `agent-runtime-core`, `provider-core` |
| `runtime-antigravity-cli`, `runtime-codex-sdk` | `agent-runtime-core`, `libs`, `provider-core` |
| `runtime-claude-agent-sdk` | the same three (dev `agent-runtimes`) |
| `store` | `libs` |
| `turn-receipts` | `artifacts`, `libs`, `provider-core`, `store` |
| `turns` | `accounts`, `artifacts`, `egress`, `event-log`, `gateway-core`, `leases`, `libs`, `login`, `provider-core`, `store`, `turn-receipts`, `workers-core` (dev 7 plugins) |
| `web-ui` | `approvals-core`, `artifacts`, `board-core`, `gateway-core`, `libs`, `workers-core`, `workflow` (dev 9 plugins) |
| `worker-sessions` | `artifacts`, `gateway-core`, `libs`, `store` |
| `workers` | `artifacts`, `libs`, `workers-core` (dev `store`) |
| `workflow` | see Inventory B above |

**What the two inventories show.**

- No workspace dependency was found that the code does not import at least as a type or an
  augmentation. The dependency lists are tidy already; there is no stray-dependency removal to file.
  The one check that remains is a per-file one (a declared package whose only use is a type that
  could be dropped), which T1 automates.
- Three dependency edges stand out and are used in 3 and 4 below: `gateway-turns` and the two
  gateways declare `workflow` for one type (`RunView`); `web-ui` declares `workflow` for two types;
  and `libs` carries `repositories.ts` for `workflow` alone.
- **No export is dead in `approvals-core`, `resources-core`, `models-core`, `landing-core`,
  `decision-core`, or `plugin-host-core`**: every export no other `src/` imports is used by a
  conformance suite, a test, or a script. Dead or test-only exports are in `libs` (2.3), and the
  unexport candidates are in `ui-ops`, `gateway-turns`, and `digest-core`, where the name is used
  inside the package or by its tests but is not part of what other packages import. Those are
  public-surface questions, not deletions: each is kept if its README or contract names it
  (as `gateway-core`'s capacity functions are), and T1 settles them.

## 2. What can go

Sizes are source lines removed unless a column says tests. **Counted** means the lines were read;
**estimate** means they were derived from a count of mentions and are to be measured by the task.

### 2.1 Duplicated logic across packages

| # | Duplicated thing | The places | Removes | Risk |
|---|---|---|---|---|
| D1 | `isObject` (a plain, non-array object), copied identically | `agent-runtime-core/src/index.ts`, `plugins/board/src/index.ts:245`, `plugins/resources/src/index.ts:155`, `plugins/approvals/src/index.ts:178`, `plugins/web-ui/src/index.ts:96`, `plugins/agent-workers/src/gate.ts:225`, `plugins/agent-workers/src/research.ts`, `plugins/runtime-claude-agent-sdk/src/limits.ts:51`, `plugins/runtime-codex-sdk/src/overrides.ts`, `.../rate-limits.ts:45`, `plugins/runtime-antigravity-cli/src/{limits.ts:41,bridge.ts,index.ts:493,policy.ts:47}` | 14 files, one copy each (the same search pattern, counted); ~13 lines | low |
| D2 | Code-point-aware truncation with `…` (`clamp`, `clampText`) | `digest-core/src/index.ts:161`, `plugins/board/src/index.ts:274`, `plugins/board/src/tools.ts:154`, `plugins/digest/src/index.ts:427`, `plugins/digest-extractive/src/index.ts:453`, `plugins/workflow/src/spec.ts:756` (`clampText`), a similar expression inline in 25 files (29 matches of a search, not all the same rule), and a different, code-unit version in `plugins/agent-workers/src/gate.ts:224` | ~25 to 40 lines (estimate) | low; the gate's own differs and stays unless its bound is characters on purpose |
| D3 | Abortable sleep | `ui-ops/src/engine.ts:211`, `plugins/models/src/workers.ts:622`, `plugins/models/src/llm.ts:184`, `provider-core/src/completion.ts:41` (`delay`) | ~20 lines | low |
| D4 | Canonical (sorted-key) JSON | `plugins/runtime-codex-sdk/src/gate.ts:60` (`canonical`) against `libs/src/canonical.ts:11` (`canonicalJson`) | 5 lines counted | low: libs' version also throws on a non-plain value; Codex's hook definition is plain, and its test pins the hash |
| D5 | `unique` (sorted set) | `experiments-core/src/registry.ts:36`, `experiments-core/src/keys.ts:20` | 1 line | none |
| D6 | **Two digest providers repeat one request engine** | `plugins/digest/src/index.ts:24-96, 427-443` and `plugins/digest-extractive/src/index.ts:29-114, 453-469`: the same `Row`, `Escalated`, `Outcome`, `CONTENT_ID`, `RANK`, `LEASE_TTL_MS`, `POLL_MS`, `PRODUCER`, `CAPABILITIES`, `now`, `view`, `aborted`, the same constructor bounds, the same `inject`, the same durable-request lifecycle; only `preamble`, the acceptance text, the extract step, and the answer shape differ | ~300 lines (estimate from the matching constants and method names; the two classes are 330 and 340 lines) | medium: restart idempotence (INV-4) and the lease handling must stay exactly the same |
| D7 | **Five glob or path matchers** | `approvals-core/src/risk-tiers.ts:49-84` (`matchesPath`, with `patternProblem` at :39), `libs/src/lessons.ts:49-54` (`pathMatches`), `libs/src/repositories.ts:309-368` (`globMatches`, with a step budget), `plugins/agent-workers/src/setup.ts:153-174` (`generatedPath` by regex, and its own `patternProblem`), `agent-runtime-core/src/workspace-reads.ts:205` (`globMatch` over tokens) | ~90 lines for the first four (estimate); the fifth is a confinement matcher and stays | medium: the four have slightly different rules (a trailing `/`, `**/dir/`), so each pattern's tests must pass on the one matcher, or the difference be named and kept |
| D8 | Website drivers' shared constants and the site-error and idle handling | `plugins/provider-chatgpt-web/src/driver.ts:16-82` and `plugins/provider-gemini-web/src/driver.ts:17-122` (`MAP_URL`, `CONVERSATION`, `shippedMap`, `DELETION_ENTRIES`, `PAGE_IDLE_WAIT_MS`, site-error handling), whose test files mirror each other (composer, deletion, conversations, pages, research, sign-in) | ~150 lines (estimate; to be measured first) | medium: each site's drift is its own |

Test-side duplicates of the same kind: the four stacks `workflow/tests/stack.ts` (153),
`agent-workers/tests/stack.ts` (171), `turns/tests/stack.ts` (226), and `web-ui/tests/store-backed.ts`
(121) build a store, a lease service, and a fake source the same way; `resources/tests/race-worker.ts`
(22) and `approvals/tests/race-worker.ts` (20) are the same helper. One shared test stack would remove
about 150 lines (estimate), with the risk that a shared helper hides a difference a test depends on.

### 2.2 Legacy and compatibility paths

For each: what reads it, whether a store still holds what it reads, and whether the current
specification needs it.

| # | Path | Evidence | Removes | Needed now? | Risk |
|---|---|---|---|---|---|
| L1 | `blocking`, `warning`, `info` accepted as severities in a new reviewer's answer and mapped to `important` and `nit` | `workflow/src/spec.ts:817` (`LEGACY_SEVERITY`), `:1009` (the lookup), `:825` (its doc), `review.ts:348` (comment); test `workflow/tests/review-severity.spec.ts:174` | ~6 source, ~6 tests | No: the reviewer's prompt (`spec.ts:923`) says `important`, `nit`, `pre-existing`. A reviewer that still answers the old words would be refused with "a finding needs a severity", which the engine already handles as a malformed assessment | low to medium: a changed answer path, though the prompt no longer asks for the old words |
| L2 | The same words **read back** from stored `assessment@1.0` | `spec.ts:895` (`RANK`), `web-ui/src/assets.ts:1090-1093` (`SEVERITY_RANK`, `findingBlocks`), `schemas/assessment.v1.json:78-82` | none | **Yes, while a stored 1.0 record exists** (INV-14: a record is never rewritten) | n/a: keep (section 5) |
| L3 | `research-deep` template accepted by the typed-result listener and the typed result's old schema | `profile-scientific-research/src/index.ts:180-181`, `:186-187`, README line 78, test `profile-scientific-research/tests/profile.spec.ts:391` (a run started before PROP-0004) | ~5 source, ~30 tests (estimate) | Only for runs of that template that exist in a store; ask the operator whether any (open question 2) | low |
| L4 | Refusal to continue or supersede a run of a removed team procedure (critique rounds, a lead, a synthesis; PROP-0004) | `workflow/src/operator.ts:56-59`, `:179-181`, `workflow/src/teams.ts:224-227` (`isRemovedTeamStep`) | ~12 source, tests unknown | It is a guard for stored runs, not a compatibility layer: without it the engine would try to run a node whose role it no longer knows. Remove only when a store migration marks or removes such runs | keep until then |
| L5 | `unrecorded` key for a tool denial recorded before it carried a reason code (T207) | `mcp-server/src/health.ts:136-137`, `:150` | ~2 | Yes while old events exist; the same code also covers a value that is no code, which stays needed | keep |
| L6 | The hand-named agent Worker rows, their cutover, and the `account_migrate` tool | section 2.4, item O1 | ~700 source, ~250 tests | decision | breaking |
| L7 | A run that cannot start its sandbox with socket masks falls back to one without them (`as before T265`) | `runtime-claude-agent-sdk/src/index.ts:358-371` | none | **Yes**: it is the current behaviour on hosts where masks cannot start (ADR-0038), not an old path. Only the comment's "as before T265" is stale | none |

Search for other markers (`legacy`, `deprecated`, `back-compat`, `TODO`, `FIXME`, `kept for`) in all
`src/` found **no `TODO` or `FIXME`** and the items above only. The repository's schemas are all
`*.v1.json` files whose older minor versions live inside the one file (for example
`assessment@1.0` inside `assessment.v1.json`), so no whole stale schema file exists to delete.

### 2.3 Dead code and exports

Sampled by name across `packages/**` and `scripts/**` (T258 already did this for the agent side):

| # | Symbol | Evidence | Status |
|---|---|---|---|
| X1 | `LIVENESS_VERDICTS` | defined `libs/src/liveness.ts:16`, re-exported `libs/src/index.ts:16`, imported nowhere | dead (the `LivenessVerdict` type stays) |
| X2 | `DRAW_STATES` | `libs/src/draws.ts:27`, `index.ts:32`, imported nowhere | dead |
| X3 | `USAGE_UNKNOWN_KINDS` | `libs/src/usage.ts:23`, `index.ts:26`, imported nowhere | dead |
| X4 | `appliesOf`, `lessonApplies`, `LESSONS_HEADING` | `libs/src/lessons.ts:42,57`, used by `agent-workers/tests/lessons.spec.ts` only; `lessonsSection` etc. use them inside the module | unexport from the package index (the module keeps them) |
| X5 | `AGENT_TOOL_EXPLANATION_MAX`, `agentToolDenialReasons` | `libs/src/tool-events.ts`, used by `agent-workers/tests/gate.spec.ts` only | unexport from the index, or test the schema instead |
| X6 | The 14 `import type {} from '@tsuuanmi/system-store'` style lines | e.g. `gateway-turns/src/threads.ts:13`, `digest-extractive/src/index.ts:17-23` | **not dead**: they pull in the `ctx.*` type augmentation; keep |

This list is a sample from `libs`, the package every other one imports. The sample deliberately
included names that looked dead and turned out used (`drawFigures`, `ADVICE_OUTCOME_EVENT`,
`MAX_DRAW_WINDOWS`): the lesson for the tasks is to prove with a script, not with a search by eye
(T1). Unaudited by T245, T258, and T289, and so the likeliest to hold more: `workflow` (every module
exports 10 to 25 names; `advisor.ts` alone exports 24), `board`, `web-ui`, `turns`, `models`,
`resources`, `notify`, `digest*`, `login`, `libs`.

No commented-out code and no skipped, todo, or `.only` test was found.

**Config options nothing reads.** None was found in the sample (the `workflow` row's
`maxSourceChars`, `approvalPollSeconds`, `tieTimeoutHours`, `maxLimitWaitHours`, `retainRunsDays`,
`autoApprovePlans`, and `deferredCommandMinutes` are each read in 1 to 13 places of its source). A
whole audit of every `Config` key is a script, not a read: `check:manifests` already compares each
declared key with the `Config` shape, and the same script can compare each key with a read of it
(T1).

**Tests.** The measurable test waste found is small: 72 test files hold `describe.runIf` or `skipIf`
(browser, display, and host-tool tests), which skip silently where the host has none; the five
`workflow/tests/replan*.spec.ts` files (48, 19, 22, 40, and a 33-line helper) test one feature in five
files; and `workflow/tests/recovery.spec.ts` (11), `session-runtime.spec.ts` (13),
`vote-record.spec.ts` (18) and `models-core/tests/models.spec.ts` (10) are each a real, small test of
one function, so they stay. No test was found that asserts nothing. The task for tests (T16) is an
audit by mutation of the oldest large files (`workflow/tests/board.spec.ts` 1,548 lines against
`plugins/board/tests/board.spec.ts` 1,808, and `agent-workers/tests/gate.spec.ts` 1,966), not a
removal list: any claim of duplicates beyond those would be a guess.

### 2.4 Needs the operator's decision (a public surface)

| # | Candidate | Evidence | Removes | Why it is the operator's |
|---|---|---|---|---|
| O1 | **The hand-named agent Worker shape and its cutover** (PROP-0012 phase F). The `workers` key of the `agent-workers` row, `planMigration` and `Cutover`, the MCP tool `account_migrate`, the CLI `system account migrate`, and the guards that refuse a hand-named row after a cutover | `agent-workers/src/migrate.ts` (386 lines), `agent-workers/src/index.ts:406-418`, `:517`, `:819-820`, `:1123-1240`, `agent-workers/src/tools.ts:143-195`, `cli/src/bin.ts` and `cli/src/index.ts` (7 mentions), README lines 173-206, `docs/operations/runbooks.md` (17 mentions); the bundle default is already `workers: []` (`system-bundle/cordis.patch.yml:124`), and the worker-agnosticism record says the live install ran `system account migrate --apply` (`docs/validation/experiments/worker-agnosticism.md:124`) | ~700 source, ~250 tests (estimate: `roles.spec.ts` has 12 mentions of 724 lines), and the `agent_cutover_moves` table with a new migration | A user-set configuration key, an MCP tool, and a CLI flag go; the config schema is a new major; PROP-0012's phase F needs an amendment. The rule says to list such candidates, not to remove them. Question 1 |
| O2 | **`experiments-core`, `evaluations-core`, `statistics`** are a defined seam, a verdict engine, and a statistics library with their suites, and nothing at runtime uses them: the `improve` template and `experiments_*` tools they serve are "planned" ([seam catalog](../architecture/plugin-model.md)) | `packages/evaluations-core/package.json:12`, `packages/statistics/package.json:12`, no import elsewhere in `packages/` or `scripts/` | 1,915 source, 698 tests, 1,309 conformance, 2,427 fixture lines if parked | PROP-0011 is **proposed**, ADR-0045 and ADR-0046 are accepted, and the conformance suites are contracts. Options: keep, merge the three into one `feedback-core` (saves about 100 lines of package scaffolding and one dependency edge), or move them out of this repository until the feedback loop is built. Question 3 |
| O3 | `models-core` merged into `models` | `models-core` has one importer (`models`), 133 source lines, 10 test lines | ~70 lines of scaffolding (`package.json` 15, README 33, manifest 19, `tsconfig` 1) | A seam is "complete with three roles" (plugin rule 2); merging puts its definition inside its only provider. Low value, listed for completeness. Question 4 |

## 3. Plugin boundaries

The rule (INV-10, [plugin model](../architecture/plugin-model.md)) is that a plugin exists only when
something can be swapped or scoped. Seven parts of the large packages were read against it. Two are
off by default and already have (or nearly have) a seam; the rest are engine parts and stay.

### 3.1 Parts of the large packages

| Part | Size | Today | Verdict |
|---|---:|---|---|
| `workflow/src/advisor.ts`, the two dispatch-advisor **providers** (`LocalAdvisor`, a logistic regression fitted on the host's outcomes; `ModelAdvisor`, a prompt to a model Worker) | 563 lines, 254 test, 94 conformance | The seam `dispatchAdvisor` exists in `decision-core` with a conformance suite, and the engine already consumes a provider registered there (workflow contract 1.12). The default provider is `none`; the advisor "never changes a choice" | **Extract the two providers** to `dispatch-advisor-local` and `dispatch-advisor-model` (or one `dispatch-advisor` with two rows). `adviseInShadow`, `recordOutcome`, and `OutcomeHistory` (the engine's half) stay. ~350 lines leave `workflow` |
| `workflow/src/scheduled-review.ts`, the daily review of existing code | 642 lines, 416 test | Off by default (`scheduledReview.enabled`); its template is already provided by `profile-software-development` | **Move to the profile** (a workflow-family plugin). Same contract for the user if the configuration key stays on the `workflow` row, which needs the engine to read a section it does not own, so the key moves to the profile's row: a breaking configuration change (open question 5) |
| `workflow/src/dispatch.ts`, the dispatch pass | 1,343 lines, 1,227 test, 103 web-ui test, 237 crash | Public on `ctx.workflow` (`sweepDispatch`, `dispatchStatus`, `pauseDispatch`, `resumeDispatch`, contract 1.9 to 1.12) and in four MCP tools | Could be a plugin with its own seam, and would take 1.3k lines out of the engine. It reads the engine's task, run, and lease state, so it needs a small start/lookup API on `ctx.workflow` first. Cost is high (workflow contract, an ADR, MCP and web-ui re-pointing, the crash suite), gain is clarity only. **Last, optional** |
| `workflow/src/risk.ts`, process tiered by risk | 520 lines | Grows reviews, retires nodes, and decides acceptance inside the run's graph | **Stays**: it is the engine's graph growth, not a swappable policy; the policy that is swappable (`riskTiers`, `tierByRisk`) is already data in `approvals-core` |
| `workflow/src/teams.ts` (968), `review.ts`, `single-family.ts` | ~1,700 | [Plugin model](../architecture/plugin-model.md): `teams` is "not planned" as a seam; the `team` option is unrolled by the engine | **Stays** |
| `workflow/src/carries.ts` (492), `landings.ts` (851) | 1,343 | Already behind seams (`workers.carry`, `ctx.landing`); the engine halves that remain (decide at admission, rebase, run checks again) are ADR-0068's and "stay in the engine, the same for every provider" | **Stays** |
| `agent-workers` checks (`checks.ts`, `check-queue.ts`, `dependencies.ts`: 962), worktrees (`worktrees.ts`, `setup.ts`, `regenerate.ts`: 3,288), confinement and metering | 4,250 together | Checks, land, carry, and `changes` are four optional methods of the `workers` seam that the source holding the worktree answers. Runs, worktrees, and checks share tables (`agent_runs`, `agent_worktrees`) and one lease | **Not a plugin yet.** A second plugin would have to share those tables, which breaks one writer per subject (INV-15), or be reached through a new seam. Do the in-package split first (T14). Confinement (the sandbox and the read tools) is already its own package, `agent-runtime-core`, and metering is the `resources` seam's client code, so neither is a new boundary |

### 3.2 Parts that sit in the wrong package

- `libs/src/repositories.ts` (568 lines, 190 test) is the public-repository snapshot of a review's
  source step. Its only importer is `workflow/src/sources.ts`. It belongs in `workflow` (or the
  review's own module): `libs` shrinks from 3,046 to 2,478 lines and 14 names leave its public surface.
  The line total is unchanged. (T9)
- Other `libs` modules each have two or more importers (`quota`, `usage`, `draws`, `lessons`,
  `calibration`, `briefs`, `subjects`, `liveness`, `lead-tokens`) and stay.

### 3.3 Small packages that should merge

| Merge | Saves | Condition |
|---|---|---|
| `experiments-core` + `evaluations-core` + `statistics` into `feedback-core` | 2 packages, about 100 scaffolding lines, a dependency edge | Operator keeps them (O2). `statistics` is "pinned by version" in each experiment: its subpath keeps its `version` constant |
| `models-core` into `models` | 1 package, about 70 lines | O3; low value |
| `digest` and `digest-extractive` stay two rows and two packages (the swap is a documented operator action, Base exit criterion 6), but share one request engine in `digest-core` | the D6 lines | none beyond D6 |

`providers` (39 lines), `agent-runtimes` (141), `egress` (176), `landing-core`, and `landing-local` are
small and stay: each is a seam definition or a registry other plugins register into, or a guarantee
seam with a conformance suite.

### 3.4 Dependency direction after

Each change keeps the rule that a package imports from its own layer or a lower one (Q1), and the
list of seam edges that point up a layer in [packages](../architecture/packages.md) does not grow:

```text
libs  <-  *-core (definitions)  <-  plugins (providers)  <-  gateways (surfaces)

today                                       after
workflow -> libs (repositories, 568)        workflow owns repositories; libs does not
workflow -> advisor providers (in package)  dispatch-advisor-* -> decision-core only;
                                            workflow -> decision-core (the seam), no provider
workflow -> scheduled-review (in package)   profile-software-development -> workflow (template and pass)
digest, digest-extractive -> digest-core    digest, digest-extractive -> digest-core (shared engine)
                                            (same edge, less code in each provider)
approvals-core, libs, agent-workers,
agent-runtime-core: 5 glob matchers         4 of them -> libs' one `globMatches`
                                            (approvals-core gains an edge to libs, which
                                            approvals-core does not import today)
```

The only new edge is `approvals-core -> libs`. `libs` imports nothing in the workspace, so it
creates no cycle. The costs are in section 4 per task; the general ones are:

- a seam's contract version moves (`dispatchAdvisor` stays 1.0; `workflow` does not change its
  contract when a provider leaves, because the engine already takes one from the seam);
- each new package costs its scaffolding (`package.json`, `tsconfig.build.json`, manifest, README,
  bundle row), about 70 to 100 lines, which an extraction pays against what it removes;
- the manifest check (`check:manifests`) and the packages graph (`check:packages`) are regenerated
  (`pnpm gen:manifests`, `pnpm gen:packages`, `pnpm gen:reference`).

## 4. Ranked tasks

Each task is one concern, at most about 1,500 changed lines (added plus removed), with the guard the
change runs against. "Removes" is net source plus tests; an extraction removes from one package and
adds scaffolding to another, and says so. Every task runs `pnpm check` and `pnpm test:affected`, and
needs a changeset only if a user can see it.

Order: T1 first (the proof tool); T2 and T3 next (small, independent); T4 to T8 (the real removals);
T9 and T10 after T4 (they touch the same `libs` index); T11 to T13 are decisions or extractions
that need their own ADRs; T14 and T15 are structure only; T16 and T17 close.

| # | Task | Removes | Guard (tests that must stay green) | Needs first |
|---:|---|---|---|---|
| T1 | **A repeatable dead-export and unused-key check.** A script (`scripts/check-exports.ts`, run by `pnpm check`) that uses the TypeScript compiler API already in the repository (`typescript` is a dev dependency) to list each package's exports that no other package imports and each `Config` key no code reads, with a baseline file that may only shrink. Then, from its output, unexport or delete what it finds in the packages T245, T258, and T289 did not cover (`workflow`, `board`, `web-ui`, `turns`, `models`, `resources`, `notify`, `digest*`, `login`, `libs`), including X1 to X5. Split in two if the output is long | adds ~150 (script), removes an unmeasured number; X1 to X5 are about 25 lines | `scripts/architecture.spec.ts`, `check:manifests`, `check:packages`, each package's own suite; a new spec for the script | nothing |
| T2 | **Shared helpers in `libs`** (`text.ts`: `isRecord`, `clampText`, `sleep` with an abort signal; the Codex `canonical` becomes `canonicalJson`; one `unique`). Replace the 14 + 12 + 4 + 1 + 1 copies (D1 to D5) | about 70 net | the suites of every package touched (agent-runtime-core, approvals, board, resources, web-ui, the four runtimes, digest*, models, ui-ops, provider-core); `runtime-codex-sdk/tests/runtime.spec.ts` for the hook hash | T1 (to see the full list) |
| T3 | **Legacy vocabulary on the write side** (L1) and the `research-deep` stub (L3), if the operator confirms no run of it exists | about 11 source, 36 tests | `workflow/tests/review-severity.spec.ts`, `spec.spec.ts`, `profile-scientific-research/tests/profile.spec.ts` | question 2 |
| T4 | **One request engine for the digest providers** (D6): the durable request lifecycle in `digest-core` (a base class or a function set the providers pass their `draft` step to); each provider keeps its preamble, acceptance, and extract step | about 300 source, about 100 tests | `digest/tests/digest.spec.ts`, `digest-extractive/tests/{extractive,extract,conformance}.spec.ts`, `digest/tests/conformance.spec.ts`, `digest-core/tests/digests.spec.ts`, the swap record `system-bundle/tests/evolution/digest-swap.spec.ts` (Base exit criterion 6) | T2 |
| T5 | **One glob matcher** (D7): `approvals-core`, `libs/lessons`, and `agent-workers/setup` use `libs.globMatches` and one pattern validator; the confinement matcher in `agent-runtime-core` stays | about 90 | `approvals-core/tests/risk-tiers.spec.ts`, `check-risk-tiers` (`pnpm check:tiers`), `libs/tests/repositories.spec.ts`, `agent-workers/tests/lessons.spec.ts`, `agent-workers/tests/setup.spec.ts`, `regenerate.spec.ts` | T1 |
| T6 | **A shared test stack and race worker** (the four `stack.ts` and the two `race-worker.ts`) | about 150 | every spec that uses them; a spec that depended on a difference shows it | T2 |
| T7 | **The website drivers' shared base** (D8), after a measurement of what is identical | about 150 (estimate) | both drivers' suites and the fake sites, the `provider-core` conformance suites (`display`, `browser`, `providers`, `deletion`) | a count, as its first step |
| T8 | **Remove the hand-named agent Workers and the cutover** (O1) if the operator decides so, with a config major, a migration for `agent_cutover_moves`, the ADR note, and the runbook | about 700 source, about 250 tests, and docs | `agent-workers/tests/{roles,accounts,agent-workers}.spec.ts`, `cli/tests/cli.spec.ts`, `gateway-core/tests/roster.spec.ts`, `check:migrations`, `check:schemas` | question 1 |
| T9 | **Move `repositories.ts` into `workflow`** (3.2) | 0 lines; `libs` -568 | `libs/tests/repositories.spec.ts` moves with it, `workflow/tests/sources.spec.ts`, `scheduled-review.spec.ts` | T1 |
| T10 | **Extract the advisor providers** (3.1) to a plugin on the `dispatchAdvisor` seam, with its own row (off by default) | `workflow` -350; the new package +100 scaffolding | `decision-core/conformance/dispatch-advisor.ts` for each provider, `workflow/tests/advisor.spec.ts`, `report/tests/report.spec.ts` (the calibration), `check:manifests`. The configuration keys under `dispatch.advisor` move or stay: question 5 | question 5 |
| T11 | **Move the scheduled review to the profile** (3.1) | `workflow` -640; the profile +640; net ~0 | `workflow/tests/scheduled-review.spec.ts`, `profile-software-development/tests/*` | T10, question 5 |
| T12 | **Merge `experiments-core`, `evaluations-core`, `statistics` into `feedback-core`**, or park them (O2) | about 100 scaffolding, or 1,915 source and 698 tests when parked | their three suites and conformance; `check:packages` | question 3 |
| T13 | **Merge `models-core` into `models`** (O3) | about 70 | `models-core/tests/models.spec.ts`, `models/tests/models.spec.ts`, conformance | question 4; optional |
| T14 | **In-package splits of the files past 800 lines** (rule Q2), one task per package, no behaviour change, no removal: `agent-workers` (`index.ts` 3,398, `worktrees.ts` 2,112, `gate.ts` 1,521, `setup.ts` 1,029), `workflow` (`tasks.ts` 1,715, `dispatch.ts` 1,343, `engine.ts` 1,242, `spec.ts` 1,124, `teams.ts` 968, `types.ts` 881, `landings.ts` 851), `workers-core` (`index.ts` 1,000), `workers` (860), `gateway-core` (`roster.ts` 848), `board` (`index.ts` 2,402), `web-ui` (`assets.ts` 2,887, `index.ts` 1,098), `cli` (`index.ts` 1,462), `approvals` (`index.ts` 1,248), `turns` (`index.ts` 1,325), `runtime-claude-agent-sdk` (`index.ts` 1,058), the two drivers (about 830 each), and `agent-runtime-core` (`workspace-reads.ts` 1,625, `index.ts` 1,523). Each split is under 1,500 changed lines by taking one file per task | 0 (it can only add a few lines of imports) | each package's own suites, unchanged | T4 and T5 first, so a split does not move code about to be removed |
| T15 | **The web UI's client code out of a template string.** `web-ui/src/assets.ts` is 2,887 lines of JavaScript and CSS inside TypeScript strings, which the linter and the type checker cannot read, and where a dead function cannot be found. Move it to `.js` and `.css` files, read by the server, in three tasks of under 1,500 lines each | 0 | `web-ui/tests/*` (4,735 lines), `docs/design/web-ui-screenshots` | T14 for the server file |
| T16 | **An audit by mutation of the largest overlapping suites** (`workflow/tests/board.spec.ts` against `plugins/board/tests/board.spec.ts`, and `agent-workers/tests/gate.spec.ts`), removing a test only where no mutation of the code it names survives without it; and merging the five `replan*` files | unknown; the audit says | the suites themselves; `pnpm gen:traceability` must show every REQ covered | T4 to T8 |
| T17 | **Dispatch as a plugin** (3.1), only if the engine's size is still the concern after T4 to T16 | `workflow` -1,343; new package +1,343 and +100 | `workflow/tests/dispatch.spec.ts`, `web-ui/tests/dispatch.spec.ts`, `system-bundle/tests/crash/dispatch.crash.ts`, the workflow conformance suite | an ADR; optional |

What the list removes if every task is done: about 1,350 source lines and about 540 test lines from
T1 to T8 (T8 is about half of the source and nearly half of the tests; T16 may add to the tests),
570 lines moved out of `libs` (T9), 990 moved out of `workflow` (T10, T11), and 1,343 more if T17 is
done. The first seven tasks, which need no decision, remove about 650 source lines and 290 test
lines. That is about 1 % of 79,600, and it is the honest result: the cheap clean-up was done in
T245, T258, and T289, and what is left is mostly structure.

## 5. What stays

Not removed, with the reason:

- **Store migrations.** Every plugin with a table registers `ctx.store.migrate(...)` (about 17 packages: for
  example `agent-workers/src/index.ts:723`, `agent-workers/src/setup.ts:183`, `workflow/src/migrations.ts`,
  `digest/src/index.ts:122`). An existing store runs them in order; one removed leaves a store that
  cannot be opened. `pnpm check:migrations` guards the numbers. A table nothing writes (O1's
  `agent_cutover_moves`) goes only with a new migration that drops it.
- **Schemas and their older minor versions.** `schemas/*.v1.json` hold `assessment@1.0`,
  `workflow-node@1.0` to `1.2`, `brief@1.x`, `decision@1.x`, and the rest, and `schemas/examples/`
  holds a valid example per record, among them `agent-tool-event.denied-before-t207.json`. A record is
  never rewritten (INV-14), so a stored record of an old minor must still validate and be read:
  L2, L5, and the `typedBody` schema lookup in `profile-scientific-research/src/index.ts:186-187` are
  readers of stored records. Removing a field or narrowing an enum is a new major with a tested
  migration (`check:schemas`, `scripts/schema-snapshot.json`).
- **Conformance suites** (10,732 lines, 29 files) and their fakes (`FakeModels`, `FakeExperiments`,
  `FakeEvaluations`, the test displays). They are the seams' contracts (ADR-0037) and what
  `check:manifests` pins each provider's version against. The tests of a package that has no runtime
  consumer (O2) are still the suite of a defined seam.
- **Public contracts.** MCP tools (`docs/reference/mcp-tools.md`), CLI commands
  (`docs/reference/cli.md`), configuration keys (`docs/reference/configuration.md`), the web UI API,
  and the gateways' protocols. Items O1 and the configuration keys in 3.1 are listed for a decision,
  not removed.
- **Guarantee seams, whatever their size**: `egress` (176), `leases` (226), `store`, `artifacts`,
  `event-log`, `turn-receipts`, `landing-core`. A small guarantee seam is small on purpose.
- **The e2e (`*.e2e.ts`) and crash (`*.crash.ts`, `*-harness.mjs`) suites** (about 2,800 lines under
  `system-bundle/tests` and `cli/tests`): `vitest.e2e.config.ts` and `vitest.crash.config.ts` run
  them, and they test restart and live composition no unit test reaches (INV-4).
- **The experiment drivers and their records** (`scripts/experiments/*`, about 2,000 lines and
  their specs, and `docs/validation/experiments/records/`): the validation docs name them, and the records are
  pre-registered evidence. They are not code no one calls.
- **The `import type {} from '...'` lines** that pull in a `ctx.*` augmentation (X6).
- **Fallbacks that are current behaviour**: the claude runtime's unmasked sandbox proof (L7), the
  single-family fallback (`workflow/src/single-family.ts`, ADR-0029), and `ui-ops`'s `fallback`
  action (`ui-ops/src/map.ts:56`). They are specified, not legacy.
- **The guard for a removed team procedure** (L4) until a migration retires such runs.
- **Test coverage of a REQ.** `pnpm gen:traceability` must still show every REQ covered
  ([traceability](../validation/traceability.md)); a test that is the only citation of a REQ is moved,
  not deleted.
- **Tests with `describe.runIf`**: they skip where the host lacks a browser or a display, and they are
  the only evidence of the browser layer. T16 may make the skip visible, never remove one.

## Alternatives considered

- **Run `knip` and delete what it lists.** Not available offline, and its list is a starting point
  with false positives here (the e2e and crash suites, the `ctx.*` augmentations); T1 builds the
  repository's own check on the compiler API so the result is a gate, not a one-time list.
- **Extract every large engine part as a plugin.** Rejected for `risk`, `teams`, `carries`, and
  `landings`: each is the engine's own graph logic, and a plugin boundary there would add a contract
  (and an ADR) for a thing that cannot be swapped. Two of seven parts are worth a plugin now (3.1).
- **Cut tests first.** Tests are 78 % of the source's size but are the guard for each removal here;
  cutting before the code goes removes the check that the behaviour did not change.
- **A rewrite of `agent-workers` as three packages.** The shared tables and the one lease make it a
  rewrite of its state ownership, not a move. Done in-package first (T14); then the question can be asked
  with the files already separate.

## Validation plan

Each task is accepted only if, on its exact tree: `pnpm check` passes (docs, secrets, schemas,
migrations, tiers, reference, packages, manifests, traceability, lint, typecheck, reviewer-eval), the
affected suites pass unchanged except the tests of what was removed (`pnpm test:affected`), the
crash suite passes for a change in `workflow`, `agent-workers`, `digest*`, or `turns`
(`pnpm test:crash`), and the task's own size is under about 1,500 changed lines. The review reads
that a removed test belonged to removed code, and that no gate or test was weakened.

## Rollout and rollback

One task at a time, each its own change on `dev`; each is reverted as one commit. T1 first, because
without it a task's claim "no consumer" rests on a search by eye. T8, T10, T11, T12, and T17 change a
configuration key, an MCP tool, a seam, or a package name and so follow their own ADR and the
operator's decision; none starts without it.

## Observability and operations

None change, apart from the runbook entries that name a removed command (O1:
`docs/operations/runbooks.md`, 17 mentions) and the generated reference (`pnpm gen:reference`,
`pnpm gen:packages`, `pnpm gen:manifests`) that each package change regenerates.

## Security and privacy

No trust boundary moves. Two items touch one: the glob matchers (D7) include the path rules of the
risk tiers and the generated-file rule, and the confinement matcher (`workspace-reads.ts`) is
deliberately left out of the merge; T5 must keep each existing pattern test, and any difference
between matchers it finds is named and kept, never merged silently (INV-2, fail closed).

## Compatibility and migration

Nothing here is kept for a legacy path the current specification does not need: L1 and L3 go (after
the operator's answer), and L2, L4, and L5 stay only because a stored record can still hold what they
read (INV-14). O1 removes a compatibility path outright, which is why it waits for the operator.

## Open questions

1. **O1.** Has every live install applied the cutover (`system account migrate --apply`), so that the
   `workers` key, `planMigration`, and `account_migrate` can go (T8)? The worker-agnosticism record
   says the pilot's did. If another install holds hand-named rows, T8 waits for its cutover.
2. **L3.** Does any store hold a run of the `research-deep` template, or a typed result of the
   evidence table's older schema? If not, T3 removes both.
3. **O2.** Keep `experiments-core`, `evaluations-core`, and `statistics` where they are (until
   PROP-0011's `improve` template is built), merge them into `feedback-core`, or move them out?
4. **O3.** Is a seam definition inside its only provider's package acceptable for `models`?
5. **Configuration keys that would move with an extraction** (`dispatch.advisor.*`,
   `scheduledReview.*`): keep them on the `workflow` row and have the new plugin read them (no user
   change, but the engine owns a section it does not use), or move them to the new rows as a new
   configuration major?

## Decision

Pending the operator's review. On acceptance the lead files T1 to T17 from the list (T1 first), and
those marked with a question wait for its answer.

## Implementation

None yet. When tasks land, each links its commit here and updates the canonical docs it names
(READMEs, the generated reference, and the seam catalog for T10 to T13 and T17).
