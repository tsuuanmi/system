---
"@tsuuanmi/system-approvals-core": minor
"@tsuuanmi/system-approvals": minor
"@tsuuanmi/system-workflow": minor
---

A merge always asks the operator (D56, ADR-0060): `merge` is in `ALWAYS_ASK`, so a configured autonomy policy, or a proposed policy change, that gives `merge` `auto` or `notify` is refused when loaded, with why (`policy studio: merge always asks; its rule may not say auto`); `forbid` still forbids. An accepted result lands in its repository only on the operator's `merge` approval: the workflow's landing no longer merges on `auto` or `notify`, and a verdict that gave one merges nothing and says to merge the branch by hand. A configuration that let merges run on their own must set `merge` to `ask` (or `forbid`) before upgrading.
