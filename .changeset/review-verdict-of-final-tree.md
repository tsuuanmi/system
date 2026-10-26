---
"@tsuuanmi/system-workflow": patch
---

A result's review verdict, which the board's acceptance gate and auto-accept read (`outcome.detail.review`), is the verdict of the last review of the result's final tree, never an earlier round's review or the verification gate that re-judged it. A run whose first round requested changes, and whose fixed tree was approved, now reads `approve` (T287).
