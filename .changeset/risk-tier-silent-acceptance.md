---
"@tsuuanmi/system-board": patch
---

The board holds for the operator an accepting decision that names no risk tier (`outcome.detail.risk`) when a policy of the task's project carries a path map (`riskTiers`, ADR-0071). Before, such an acceptance was read as "tiering off", so one made outside the workflow engine's task acceptance could apply a heavy change under the policy alone. With no map, nothing changes (T264).
