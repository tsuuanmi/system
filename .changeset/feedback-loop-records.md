---
"@tsuuanmi/system-schemas": minor
"@tsuuanmi/system-approvals-core": minor
"@tsuuanmi/system-approvals": minor
"@tsuuanmi/system-board": minor
"@tsuuanmi/system-artifacts": patch
"@tsuuanmi/system-experiments-core": minor
"@tsuuanmi/system-evaluations-core": minor
---

The feedback loop's records and seam definitions (PROP-0011 F1). Nothing runs them yet: no provider, bundle row, or MCP tool.
- Five new schemas, each the body of an existing artifact kind: `objective-contract`, `hypothesis`, `experiment`, `evaluation`, and `lesson`. `decision@1.7` adds the experiment registry's `registration` and the evaluation engine's `verdict` decisions.
- A new action class, `promotion`, always asks: a policy that gives it `auto` or `notify` is refused when loaded. `approvals_policy` lists it, and `board_propose` accepts it.
- `experiments-core` and `evaluations-core` define the experiment registry and the evaluation engine seams at contract 1.0, with their conformance suites and fakes.
