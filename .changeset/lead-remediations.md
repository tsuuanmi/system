---
"@tsuuanmi/system-gateway-core": patch
"@tsuuanmi/system-approvals": patch
"@tsuuanmi/system-approvals-core": patch
"@tsuuanmi/system-board": patch
---

A project's lead may approve or deny two routine remediations on its own token: a fix of the blocking findings its run's own review found, and a retry of a step its host stopped. They are recognised by the request's own fields and the records they name, never its summary, and only on the lead's project. The fix's plan must be one its review grew for that run. A lost run counts as host-stopped only when the board marks it `reconciliation-failed:host-stopped`, which it does only when the run's lease was still live when the board last stopped cleanly and had expired by its next start. The board records its clean stop for this. A lost run without that mark (a holder that hung while the host ran, even if the host restarted before the board noticed; a lost run after a crash), a budget raise, a run that failed on its own, and another project's remediation are still refused for the lead token and stay the operator's.
