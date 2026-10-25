---
"@tsuuanmi/system-libs": minor
"@tsuuanmi/system-workers-core": minor
"@tsuuanmi/system-workers": minor
"@tsuuanmi/system-resources-core": minor
"@tsuuanmi/system-resources": minor
"@tsuuanmi/system-approvals-core": minor
"@tsuuanmi/system-approvals": minor
"@tsuuanmi/system-board": patch
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-web-ui": minor
"@tsuuanmi/system-cli": minor
---

System asks to start ready board tasks on free Workers chosen by quota (PROP-0014 increment D1, accepted with D61 to D66; ADR-0063):
- The workflow engine's dispatch pass (contract 1.9) looks every `dispatch.sweepSeconds` (60) and at start at the ready tasks of active projects, oldest first, and takes at most `maxPerPass` (2): for each, the Worker of its writing step is the first free one in `quota-score@1`'s order among those routing admits. Free means idle enough, every window of its account read recently with headroom above your reserve, and not metered (D65): an unknown or stale reading never counts.
- Under the new action class `dispatch` (the bundle's studio policy asks, by its default), each start is one request bound to the task, its attempt, and the Worker. Approve it on Home's **Waiting for your go** (the task, the Worker, each window as `5 h: used 12 % — reserve 20 % — resets 14:20`, and why that Worker), in the queue, or with MCP `approvals_decide`; the run starts at the next pass on exactly that Worker, while it is free (30 min hold). Denied or unanswered, dispatch does not ask again for that attempt. An attempt you already approved through the board's gate starts without a second button (D62). `forbid` dispatches nothing in a project; `auto` and `notify` dispatch nothing yet (D2).
- Bounds counted from records: one dispatched run per account, two per project, four per repository (D64), eight in all, four asks open, and four of `maxActiveRuns` kept for you and the lead. Every setting is validated when the row loads.
- `system dispatch [status|pause|resume]` (MCP `dispatch_status` for the lead, `dispatch_pause` and `dispatch_resume` for you) shows why each ready task did not start, and pauses or resumes dispatch, kept across restarts. `dispatch.enabled: false` turns it off.
- The resources row's `quota` (contract 1.2, `quota()`): `reservePercent` (20, D63: a share of every window kept for you; it gates starts only), `staleReadingSeconds` (1800), and the score's thresholds. The router gains the optional `candidates` (admission with nothing reserved), and `libs` the pure `quotaScoreOf` and `accountQuotaOf`.
- Every start choice is recorded (`dispatch.select`, `dispatch.choice`, the policy's verdict), named by the run's admission and shown first by `system explain`.

See the runbook "Let System start ready work".
