---
"@tsuuanmi/system-agent-workers": minor
"@tsuuanmi/system-agent-runtime-core": minor
"@tsuuanmi/system-approvals-core": minor
"@tsuuanmi/system-approvals": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-workers": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-profile-scientific-research": minor
"@tsuuanmi/system-runtime-claude-agent-sdk": minor
"@tsuuanmi/system-cli": minor
"@tsuuanmi/system-web-ui": minor
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-runtime-acp": patch
"@tsuuanmi/system-runtime-antigravity-cli": patch
"@tsuuanmi/system-runtime-codex-sdk": patch
---

A read-only research role on agent runtimes (ADR-0074, D91): an agent role or Worker with `research: true` reads its workspace and searches and fetches the web, and nothing else. Its tools, the role's and every tier's, are `Read`, `Grep`, `Glob`, `WebSearch`, and `WebFetch` only (all five by default); it is refused unless `read-only` and not a review member; it is on the standard tier when it gives no tier, and takes research work only (`kinds` default `[research]`). Its runs ask the runtime for web tools (`RunSpec.web`, `RuntimeEvidence.webTools`), which only Claude Code offers; Codex, the Antigravity CLI, and ACP refuse them, so the Worker is `unavailable` there. Its gate denies a write or a command (`research-role`, `agent-tool-event@1.2`). It proves `reason`, and `web-search` only by a web probe: one real search of a fixed query through its gate, recorded as an `agent-workers.web-probe` decision, valid 24 hours.

Routing: `work-requirement@1.3` adds `prefers`, capabilities a step would like and does not need. A Worker that proves all of them ranks first, after the quota reserve and before the tier, and one that does not is never refused; the route decision says why. `research`'s two literature reviews are of kind `research`, and `literature:2` prefers `web-search`, so it takes a research Worker of another family first, then a Worker that only reasons, and the single-family fallback last.

Web access: `autonomy-policy@1.3` adds `webAccess`, a versioned grant for the research profile (`tools`, `maxWebCallsPerRun` 1 to 200, 40 when unset, `maxClassification` at most `operator-shared`, `note`). It moves no mode, and `external-send` still always asks. The gate's rule `agent-workers.web-access` lets a research run's web call run unasked only when the grant names the tool, its query or URL names no local path and passes the egress check, and the run is within its bound. Calls are judged one at a time, a project's `forbid` binds, and a call its session was denied stays denied. Otherwise the call asks as before. Every call it judges is a `gate` decision holding the query or URL and an `agent-workers.tool.web` event. Only the studio policy grants, and a project's only narrows. A grant takes effect only through an approved `policy-change` request, whose consequences name it. `policies/system.json` (version 2) carries the system project's narrowing grant. `system explain` and the run's page on `/ui` list a run's web calls with their verdicts and egress outcomes.
