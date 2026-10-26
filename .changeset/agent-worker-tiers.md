---
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-workers": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-approvals-core": minor
"@tsuuanmi/system-approvals": minor
"@tsuuanmi/system-provider-core": minor
"@tsuuanmi/system-runtime-claude-agent-sdk": minor
"@tsuuanmi/system-gateway-core": minor
"@tsuuanmi/system-gateway-anthropic": minor
"@tsuuanmi/system-cli": minor
"@tsuuanmi/system-web-ui": minor
"@tsuuanmi/system-libs": patch
"@tsuuanmi/system-digest": patch
"@tsuuanmi/system-digest-extractive": patch
"@tsuuanmi/system-gateway-turns": patch
"@tsuuanmi/system-runtime-antigravity-cli": patch
---

An agent role may give its Workers a model per tier on a runtime (`runtimes.<runtime>.tiers: { economy?, standard?, frontier? }`, each `{ model, tools?, maxTurns? }`) instead of one `tier` (ADR-0073). Each assigned account then gets one Worker, `agent:<accountId>/<role>`, that offers every tier (`capability-descriptor@1.10` `tiers`); capability stays the role's, and routing (`workers.route.deterministic` version 3) serves the Worker at the lowest offered tier within a step's bounds whose model's pool is open. The run records the tier and the model it ran on (`agent_runs.tier` and `configured_model`, `agent-result@1.4`, `brief@1.4`/`@1.5`), shown in `system explain`, the usage report, the roster, and `/ui`. A run whose Worker, after a restart, no longer offers its tier, or whose tier now runs another model, fails unsent as the new kind `worker_changed` (disposition `IMMEDIATE`), naming both tiers, and the engine routes it again: it never runs another model.

Quota per model: a provider entry's `modelPools: [{ model, pool, windows }]` gives a model one more pool per account, and the Claude Code usage report's per-model weekly windows are read (`model_scoped:<display name>`), so a frontier model's limit closes only the frontier tier; `quota-score@2` ranks a tier by its own pools. A provider that reports no window per model (Codex) shares the account's windows across its tiers, and the route decision says so.

Tier by risk: `autonomy-policy@1.2` adds `tierByRisk: { version, light?, normal?, heavy? }`, which raises (never lowers) a board task's step to a tier by its task's risk tier, recorded as a `workflow.tier-by-risk` decision; no map is set by default. The Anthropic gateway's default model-name map is now empty: model names are configuration only. A one-tier role is unchanged.
