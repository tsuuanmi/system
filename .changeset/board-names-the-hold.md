---
"@tsuuanmi/system-board": patch
"@tsuuanmi/system-web-ui": patch
---

The board names the real reason a held result cannot be accepted by a lead or a run owner: heavy (with its risk decision), the auto-accept rule (its reasons), the required checks pending or failed (named), or forbid, each with the autonomy decision. Before, every hold that was not the auto-accept rule's was reported as required checks not passed, even a heavy result whose checks had passed. The hold's decision records the same words (`outcome.detail.holdReason`), and `/ui` shows them on the review card ("Held for the operator: …"), so a heavy hold no longer reads as having no check pending. Who may accept is unchanged.
