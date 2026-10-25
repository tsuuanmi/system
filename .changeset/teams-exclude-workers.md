---
"@tsuuanmi/system-workflow": minor
---

The workflow's new `teams.excludeWorkers` keeps Workers out of brainstorm and review teams while they still take every other node (operator decision D58: teams run on ChatGPT web and the Gemini API while the Gemini website is unstable):
- Each entry is a Worker id or an account id, as `system roster` lists them. A Worker id leaves out that Worker with every other Worker on its account (a website account's other tiers, an agent account's other roles); an account id leaves out every Worker on that account.
- Every member, the first included, routes only to the Workers listed when it routes, less those. The member's route decision gives each one left out the reason `left out of teams by the operator's teams.excludeWorkers`.
- `allowSameFamily` never lifts it: its re-routes still lift only the family rule, then the distinct-account rule.
- A member that then finds no other provider family fails as `config_error` with nothing sent. When the exclusion leaves fewer families ready than the team has members, the message starts `team T needs N provider families, one per member; M is ready outside the operator's teams.excludeWorkers, which leaves K more out of teams (ADR-0027).`
- A member already in its conversation keeps it, so a team in flight finishes on the Workers it formed with.
- `system check` refuses an option under `teams` it does not know.

See the runbook "Keep a Worker out of teams".
