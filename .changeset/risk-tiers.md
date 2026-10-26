---
"@tsuuanmi/system-approvals-core": minor
"@tsuuanmi/system-approvals": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-board": minor
"@tsuuanmi/system-profile-software-development": minor
"@tsuuanmi/system-cli": minor
"@tsuuanmi/system-web-ui": minor
---

Process tiered by risk (PROP-0016 I2 part 1, D83, ADR-0071):
- `autonomy-policy@1.1` adds the optional path map `riskTiers` (its own version, rules of path patterns each with a tier, light, normal, or heavy, and why), validated when the policy loads. A path's tier is the highest of the rules that match it; an unmatched path, an unreadable change, or an unreadable policy is heavy; a change's tier is the highest of its paths'. With no map, nothing changes. The system repository's map is the `system` project's policy, `policies/system.json`, and `pnpm check` (`check:tiers`) refuses it unless it matches every tracked path and names every package directory.
- The workflow engine decides a board task's change's tier (`workflow.risk-tier`) when a review approves it and again before its acceptance. A heavy change grows a second review routed only to another provider family (`allowSameFamily` never lifts it), and its acceptance (`workflow.task-acceptance`, version 4, naming the tier) rejects it without approving reviews of its exact tree by two families. A light change skips a template step marked `riskSkip` (`algorithm-development`'s `validate:1`) once its required checks passed on its exact tree (`workflow.risk-skip`).
- The board never applies an acceptance of a heavy result unattended, by the auto-accept rule or by the policy: it holds it for the operator, reading the tier from the decision the acceptance names.
- `explain` gives the run's tier and why (`risk`); `system explain` prints it, and the run's page on `/ui` lists it under *What happened*.
