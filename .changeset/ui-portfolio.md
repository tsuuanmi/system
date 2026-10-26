---
"@tsuuanmi/system-web-ui": minor
---

The operator's web UI across projects (T253, D88; rules in `docs/design/web-ui.md`):
- Home's "Needs your attention" is grouped by project. Each group is headed by the project's name and has its own count tiles (Approvals, Reviews, Runs needing attention). What is in no project has a group of its own, "Other". The most urgent group comes first: what expires within the hour, then the most that waits, then the earliest deadline.
- The cards below follow the same groups, each headed by the project's name. A batch of requests stays whole, in its first request's project. Each project's group has a closed "Reports" fold holding `system report --project <id>` (its weekly report) and `system metrics --project <id>`, each with a copy button.
- A project's name filters Home to that project, its recent runs too. The filter is kept in the address (`/ui/?project=<id>`) through a reload and Back, until "All projects".
- The Board shows one project at a time with its switcher. "All projects" shows only each project's counts card (state, Needs you · Working · Ready · Proposed, what needs you, moves), and each title opens that project's board. All projects is the default with several projects; with one project, that project is the default. The choice is kept in the address (`&project=<id>` or `&project=all`).
- The Workers page stays shared, and each step a Worker runs now names the project its run is for, or "no project".
