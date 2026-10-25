---
"@tsuuanmi/system-web-ui": minor
"@tsuuanmi/system-gateway-core": minor
"@tsuuanmi/system-workflow": minor
---

UI/UX round 6, from the operator's walk-through (T141):
- Home's *Waiting for you* names each request, review, and run under its count, each linked to its card, with when it expires.
- A run's page is headed by its task's title and says under *What happened*, in plain words, whether it started from the work its previous attempt left or over and why (ADR-0061), which team member's answer was sent again once after a site's own error (ADR-0062), and where its accepted result stands (ADR-0060). A team's steps read by member, a failure's kind in words, and an earlier attempt's error as history, never as the step's failure.
- An accepted result's merge request says what approving and denying do in words and names the task that asks; its paths and hashes are folded.
- The Board: each project's state at a glance (waiting for you, working, ready, proposed), the request a card waits on approved or denied by the button on the card, who a ready card would likely go to, *Changed 4 min ago · read* in place of *read 4 min ago*, the project filter kept in the address, and *Waiting for you* first on a narrow screen.
- The Workers page: *Right now* by name (free, stalled, no quota left, cannot work), each step by its task's title, an account with no quota tracked said as such (Home's capacity line too), and **Kept out of teams by you** on a Worker the engine's `teams.excludeWorkers` leaves out of teams (D58).
- The roster (`mcp-roster@1.6`) adds each Worker's optional `teams`, read through the workflow engine's new read-only `teamExclusion()`; `system roster` prints it.
- Help's glossary adds team, started from earlier work, and sent again.
