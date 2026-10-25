---
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-gateway-core": minor
"@tsuuanmi/system-notify": minor
"@tsuuanmi/system-web-ui": minor
"@tsuuanmi/system-cli": minor
---

System starts ready work by itself where you let it (PROP-0014 increment D2; your go-ahead D70: using idle quota must be automatic; ADR-0064):
- Under a project policy whose `dispatch` mode is `auto`, the dispatch pass starts the chosen ready task's attempt with no approval request at all (nothing enters the queue): it records the same choice (`dispatch.select`, `dispatch.choice` with every Worker and why, the policy's verdict) and starts within every bound. `notify` starts it the same way and records a notice, which the notifier tells as `dispatch.started` (`notification@1.2`). `ask` is unchanged (one request, a button), and `forbid` starts nothing. The approval queue is not changed: it is simply not asked.
- Starts are bounded per rolling hour: `dispatch.maxPerHour` (6; 0 starts nothing) and `maxPerHourPerProject` (3), counted from the engine's rows, so a restart counts the same.
- Pause dispatch in one project: `system dispatch pause --project <id> [reason…]` and `system dispatch resume --project <id>` (MCP `dispatch_pause` and `dispatch_resume` take `projectId`), each your decision, kept across restarts.
- A board task's run says who started it (`task.startedBy`: `dispatch`, `lead`, or `operator`; workflow contract 1.10; Start on `/ui` says `operator`). The roster gives it on each step (`mcp-roster@1.8` `work[].startedBy`; the step's sentence ends "started by itself"), and the Workers tab shows a *started by itself* chip.
- Home lists **Started by itself**: what dispatch started in the last 24 h, one line each with its run's state as a chip, the task, the Worker, and how it was let start. `system dispatch` lists them too, with the hour's starts and each paused project.
- A restart in the middle of a start adopts the run already admitted: an attempt starts once.

See the runbook "Set dispatch to auto for a project".
