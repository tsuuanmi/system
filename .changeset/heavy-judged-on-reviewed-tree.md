---
"@tsuuanmi/system-workflow": patch
---

A heavy result bound to an artifact is judged on the git tree its reviews judged (the last review's subject); one bound to a git tree is judged on that tree, as before. A result bound to a report artifact with approvals from two provider families on its tree is accepted, where before it was always rejected for lack of "approving reviews of its exact tree". When the last review did not approve, the rejection names that first (verdict, blocking findings, cycle of the bound), before any second-family reason. An empty subject of the second-family check throws (T280).
