---
"@tsuuanmi/system-workflow": patch
---

`teams.excludeWorkers` fixes (review of T148):
- A team that the exclusion leaves with fewer provider families than it has members now fails as `config_error` at its first member, before anything is sent. This holds for every member role and also with `allowSameFamily` on, so a team never runs on one family because of the exclusion. The message is `team T needs N provider families, one per member; M is ready outside the operator's teams.excludeWorkers, which leaves K more out of teams (ADR-0027, REQ-TEAM-8); nothing was sent for member mK`. When every Worker listed is left out, it says so instead. `allowSameFamily` still applies, with the exclusion kept, when the roster has too few families without it.
- A member that resumes its conversation on a Worker that is now left out keeps it only when the conversation belongs to its own team in the same run, for example when a run is continued after the option changed. Its route decision then says `… is kept as team T's own conversation in this run (Model A)`. A member resuming a session from another run on such a Worker is refused as `config_error`, with nothing sent.
- An account can be named as `<group>/<id>`, as `system roster` lists it. A bare account id that several groups use is refused, as is a named Worker whose siblings' descriptors name different accounts.
- When the distinct-account rule and the exclusion both apply, the route reason lists the Workers the exclusion refuses.
- Each Worker left out takes its whole account with it, repeated until nothing new is added. An account-id entry no longer pulls in the siblings of a Worker that happens to share the id.
- An entry that matches no Worker or account is recorded as a `workflow.team.unmatched-exclusions` event when a member routes.
- `system check` now also refuses a `teams` that is not an object, an `excludeWorkers` that is not a list, an entry with whitespace or longer than 200 characters, more than 64 entries, and an entry listed twice. It reports one line per problem, bounded.
- A member's family-shortage line counts against the Workers left out when that member was restricted, so it never blames the exclusion for a Worker described afterwards.
