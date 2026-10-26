---
"@tsuuanmi/system-approvals-core": patch
"@tsuuanmi/system-approvals": patch
"@tsuuanmi/system-report": patch
---

Clean-up (T289), no behaviour change: exports nothing else imports are module-private. approvals-core: `RISK_MAP_BOUNDS`, `higher`, `INTELLIGENCE_TIERS`, `TIER_BY_RISK_BOUNDS`, `WEB_ACCESS_PROFILES`, `WEB_TOOLS`, `WEB_ACCESS_BOUNDS`. approvals: `MAX_SET`, `REPEATED_APPROVALS`, `REQUEST_STATES`, `DEFAULT_PAGE`, `MAX_PAGE`, `DEFAULT_CHANGES`, `MAX_CHANGES`, the `PolicySet` re-export, and the tools' `handlers`, `tool`, and `OutputCheck`. report: the `report`, `metrics`, and `registerTool` functions, `MetricsInput`, `MAX_EVENTS`, and the unused re-exports of its barrel (`KindCost`, `LevelReading`, `LineStatus`, `LEVEL_MIN_TASKS`, `MAX_COST_KINDS`, `READY_MOVES_READ`, `MAX_RUNS_READ`, `METRICS_DEFAULT_DAYS`, `metricValueText`, `DigestRead`, `MAX_DAYS`, `Scope`).
