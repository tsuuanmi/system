---
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-board": patch
"@tsuuanmi/system-worker-sessions": patch
"@tsuuanmi/system-approvals": patch
"@tsuuanmi/system-report": patch
"@tsuuanmi/system-resources": patch
"@tsuuanmi/system-mcp-server": patch
---

A lead's token reaches only its own project (T285, ADR-0076). Every tool a lead token calls that names a project, board task, run, Worker session, or approval request is checked against the token's project, and another project's object is refused with the reason before anything is done or read: `run` with a `task`, `vote`, `result`, `explain`, `dossier_read`, `session_send`, `session_inbox`, the `board_*` tools, `approvals_get`, `approvals_list`, `approvals_policy`, `approvals_decide` (a merge included), `report`, `metrics`, and `resources_usage`. With no project named, `usage`, `board_projects`, `board_breakers`, `approvals_list`, `approvals_policy`, `report`, `metrics`, and `resources_usage` read the lead's project only. A run with no board task (`ask`, `research`, `brainstorm`, `review`) is tagged with the lead's project (`workflow_runs.project_id`, store migration 24), its `clientRequestId` is scoped to that project, and a run derived from a session (a Worker's wake, a compaction) belongs to the project of the run its session came from. Tools that name no project stay System-wide: `explain` of an artifact id, `digests_request`, `digests_get`, `dispatch_status`, `status`, `roster`, `resources_pools`, and `usage`'s quota draws. The operator's and the client token's calls are unchanged.
