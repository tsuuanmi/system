---
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-profile-scientific-research": minor
"@tsuuanmi/system-web-ui": minor
---

A template node with `differentFrom` may set `diversity: preferred`: when no Worker of another provider family can take it (none admitted, or the one that took it stalled after the prompt, failed on the infrastructure, or answered with the site's own error), it runs once on the family it differs from, in a fresh conversation, never resent to the Worker that failed it. A `workflow.diversity` decision `single-family` records why, every later step's brief and the run's answer start with `Single family: …`, and the run's page in `/ui` shows a `single family` chip. `research` sets it on its second literature review and its critique (D89), so a run no longer fails or waits for Gemini; a run where both families answered is unchanged.
