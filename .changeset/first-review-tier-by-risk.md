---
"@tsuuanmi/system-workflow": patch
---

A task's first review takes the policy's tier by risk too (T288). When an independent review step is first routed and the policy maps tiers by risk, the engine decides the risk tier of the change it reviews (develop's tree), a `workflow.risk-tier` decision under the review (worded for it, `outcome.detail.routed`, once per step), and sets the step's minimum tier from the policy's `tierByRisk`, recorded as a `tier` decision naming that risk decision. A heavy change's first review runs at frontier on a task's first attempt, as on later ones; a light change keeps the template's tier. A fix step after it reads the same risk, as a later attempt's steps do.
