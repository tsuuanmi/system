---
"@tsuuanmi/system-board-core": minor
"@tsuuanmi/system-board": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-report": patch
"@tsuuanmi/system-web-ui": patch
---

The operator's answers on a task's per-step budget (D31, 2026-10-24; T66). Each step of a board task's run is briefed with the budget left when that step starts, after the steps before it, instead of the budget at the run's admission. When a spent run blocks its task, the engine asks the ledger once more to release the holds no running step owns; those it still holds, which still count against the task's caps, are named in the funding request (its summary counts them, its consequences name each run, step, and expiry), in the run's failure, and in its view (`task.budget.unreleased`), instead of a request that names nothing. The `board` contract is at 1.3 (ADR-0054, accepted 2026-10-24): `block`'s optional `unreleased` on a `budget-spent` wait, checked and worded by `board-core`'s `unreleasedProblem` and `unreleasedText`, and the conformance scenario `board.budget-spent-names-unreleased`. The precedence of a sibling step's failure or questions over a budget refusal is unchanged and documented.
